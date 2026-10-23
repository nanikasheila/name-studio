//! Bring changed dialogue into pages already being drawn in CSP.
//!
//! After the pages go to CSP the pen work starts in them, so writing them
//! again would lose it. Here only the dialogue is brought in: texts that are
//! still the same are left as they are (where they were moved to in CSP
//! too), texts that are gone or changed are hidden and renamed 「（旧）…」 so
//! they can be compared and deleted in CSP, and the new ones are added next
//! to them. Balloons (vector lines and the paper under them) that changed in
//! the name are swapped the same way. Nothing is deleted; the file as it was
//! is copied to a backup folder first.
//!
//! What was written last time (the export's manifest) tells the name's
//! changes from CSP's: a text retyped in CSP stays as it is while the name
//! still has the old words, and texts added in CSP are left alone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use serde::Serialize;

use super::editor::ClipEditor;
use super::manifest::PageRecord;
use super::raster_page::{Donors, PageLayer, PartDonors, add_text_layer, add_vector_layer, prepare_for};
use super::{Values, set_value};
use crate::clip::{ClipDocument, ClipLayer, LayerKind};
use crate::error::{CspError, Result};
use crate::raster::{Filter, resize};
use crate::text::NewText;
use crate::vector::{NewVectorLine, brush_style_of, shape_signature};

/// A layer to swap: its id, and the brush style of its lines (vector layers).
type OldLayer = (i64, Option<u32>);

/// What hidden layers are renamed with.
pub const RETIRED_PREFIX: &str = "（旧）";

/// The page's dialogue now, and the layers that go with it.
pub struct DialogueUpdate {
    pub texts: Vec<NewText>,
    /// Layers swapped (found by name) when the balloons changed in the
    /// name: the balloon lines, and the images that go with them (swapped
    /// with the lines, or with the dialogue when there are no lines).
    pub balloons: Vec<PageLayer>,
    /// What this tool wrote into the page last time, when known. Other texts
    /// there were added in CSP and are left alone; without it every plain
    /// text counts as this tool's.
    pub written: Option<PageRecord>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueUpdateReport {
    pub path: PathBuf,
    /// The page as it was, when it was changed.
    pub backup: Option<PathBuf>,
    /// Texts left as they were.
    pub kept: usize,
    /// Texts hidden as 「（旧）」.
    pub retired: Vec<String>,
    /// Texts added.
    pub added: Vec<String>,
    /// Texts there that this tool did not write (left alone).
    pub foreign: usize,
    /// Texts changed or deleted in CSP that the name still has as written
    /// last time: CSP's stands.
    pub left_as_in_csp: usize,
    /// Layers swapped, and those that were not found (renamed or deleted in CSP).
    pub replaced: Vec<String>,
    pub not_found: Vec<String>,
    /// Swapped layers that had been changed in CSP too (CSP's are hidden as 「（旧）」).
    pub conflicts: Vec<String>,
    /// What the page holds from this tool now, to record.
    #[serde(skip)]
    pub record: PageRecord,
    /// What the page read back does not hold as asked; empty when fine.
    pub problems: Vec<String>,
}

/// A text as compared: line breaks as `\n`, no space around.
pub fn text_key(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").trim().to_owned()
}

/// A dialogue text layer of the page: visible, plain (not the work info or
/// the page number), not one this tool already hid.
struct PageText {
    id: i64,
    name: String,
    key: String,
}

fn page_texts(document: &ClipDocument) -> Vec<PageText> {
    document
        .layers()
        .into_iter()
        .filter(|layer| layer.kind == LayerKind::Text && layer.visible && !layer.name.starts_with(RETIRED_PREFIX))
        .filter(|layer| {
            document
                .layer_row(layer.main_id)
                .is_some_and(|row| row.int("TextLayerType") == 0 && row.int("ComicStoryInfoType") == 0)
        })
        .map(|layer| PageText {
            id: layer.main_id,
            name: layer.name.clone(),
            key: text_key(&document.text_strings(layer).join("\n")),
        })
        .collect()
}

/// The parent of every layer.
fn parents(layer: &ClipLayer, result: &mut HashMap<i64, i64>) {
    for child in &layer.children {
        result.insert(child.main_id, layer.main_id);
        parents(child, result);
    }
}

/// The visible layer named `name` (not one already hidden by this tool).
fn named_layer<'a>(document: &'a ClipDocument, name: &str) -> Option<&'a ClipLayer> {
    document
        .layers()
        .into_iter()
        .find(|layer| layer.name == name && layer.visible)
}

/// Hide a layer and mark it as the old one.
fn retire(editor: &ClipEditor, id: i64, name: &str) -> Result<()> {
    let visibility = super::int_value(super::value_of(&editor.layer_row(id)?, "LayerVisibility"));
    editor.update_layer(
        id,
        &[
            ("LayerVisibility", Value::Integer(visibility & !1)),
            ("LayerName", Value::Text(format!("{RETIRED_PREFIX}{name}"))),
        ],
    )
}

/// Put `id` right above `anchor` in `parent`.
fn place_above(editor: &ClipEditor, parent: i64, anchor: i64, id: i64) -> Result<()> {
    let siblings = editor.children(parent)?;
    let next = siblings
        .iter()
        .position(|sibling| *sibling == anchor)
        .and_then(|index| siblings.get(index + 1))
        .copied();
    editor.append_to_folder(parent, id, next)
}

/// Bring `update` into the page at `path` (see the module notes); the page
/// is left untouched when its dialogue is already the same. `fallback`
/// gives layers to copy when the page has none of a kind.
pub fn update_dialogue(
    path: &Path,
    update: &DialogueUpdate,
    fallback: &Donors,
    backup_dir: &Path,
) -> Result<DialogueUpdateReport> {
    let document = ClipDocument::read(path)?;
    let mut report = DialogueUpdateReport {
        path: path.to_path_buf(),
        ..Default::default()
    };
    let mut ours = page_texts(&document);
    // Texts written last time that are not on the page any more: changed or
    // deleted in CSP, which stands while the name still has them as written.
    let mut edited_in_csp: Vec<String> = Vec::new();
    if let Some(written) = update.written.as_ref().and_then(|record| record.texts.as_ref()) {
        // Only texts written last time (each once) are this tool's to change.
        let mut left: Vec<String> = written.iter().map(|text| text_key(text)).collect();
        ours.retain(|text| match left.iter().position(|key| *key == text.key) {
            Some(index) => {
                left.remove(index);
                true
            }
            None => {
                report.foreign += 1;
                false
            }
        });
        edited_in_csp = left;
    }
    let mut unmatched: Vec<&PageText> = ours.iter().collect();
    let mut added: Vec<&NewText> = Vec::new();
    for text in &update.texts {
        let key = text_key(&text.text);
        if let Some(index) = unmatched.iter().position(|old| old.key == key) {
            unmatched.remove(index);
            report.kept += 1;
        } else if let Some(index) = edited_in_csp.iter().position(|old| *old == key) {
            edited_in_csp.remove(index);
            report.left_as_in_csp += 1;
        } else {
            added.push(text);
        }
    }
    let texts_changed = !unmatched.is_empty() || !added.is_empty();
    // Balloon lines are swapped when the name's differ from what was written
    // (or, unrecorded, from what the page has); their images go with them.
    let mut swaps: Vec<&PageLayer> = Vec::new();
    let mut vectors = update
        .written
        .as_ref()
        .map(|record| record.vectors.clone())
        .unwrap_or_default();
    for layer in &update.balloons {
        if let PageLayer::Vector { name, lines } = layer {
            let points: Vec<Vec<(f64, f64)>> = lines.iter().map(NewVectorLine::xy).collect();
            let new = shape_signature(points.iter().map(Vec::as_slice));
            let on_page = named_layer(&document, name)
                .and_then(|old| document.vector_objects(old).ok())
                .map(|objects| shape_signature(objects.iter().map(|object| object.points.as_slice())));
            let recorded = vectors.get(name).cloned();
            if recorded.as_ref().or(on_page.as_ref()) != Some(&new) {
                if recorded.is_some() && on_page.is_some() && on_page != recorded {
                    report.conflicts.push(name.clone());
                }
                swaps.push(layer);
            }
            vectors.insert(name.clone(), new);
        }
    }
    let has_lines = update
        .balloons
        .iter()
        .any(|layer| matches!(layer, PageLayer::Vector { .. }));
    if if has_lines { !swaps.is_empty() } else { texts_changed } {
        swaps.extend(
            update
                .balloons
                .iter()
                .filter(|layer| matches!(layer, PageLayer::Raster(_))),
        );
    }
    report.record = PageRecord {
        texts: Some(update.texts.iter().map(|text| text.text.clone()).collect()),
        vectors,
    };
    if !texts_changed && swaps.is_empty() {
        return Ok(report);
    }

    std::fs::create_dir_all(backup_dir)?;
    let backup = backup_dir.join(path.file_name().ok_or_else(|| CspError::format("No file name"))?);
    std::fs::copy(path, &backup)?;
    report.backup = Some(backup);

    let mut parent_of = HashMap::new();
    parents(&document.root, &mut parent_of);
    let (width, height) = (document.canvas.width_px as u32, document.canvas.height_px as u32);
    let mut editor = ClipEditor::open(path)?;
    let root = editor.root_id;
    // New texts go above the topmost dialogue text (old or kept), else on top.
    let anchor = ours
        .last()
        .map(|text| (parent_of.get(&text.id).copied().unwrap_or(root), text.id));
    for old in &unmatched {
        retire(&editor, old.id, &old.name)?;
        report.retired.push(old.key.clone());
    }

    // The balloons: swapped in place of the layer of the same name.
    let balloons: Vec<(&PageLayer, Option<OldLayer>)> = update
        .balloons
        .iter()
        .filter(|layer| swaps.iter().any(|swap| std::ptr::eq(*swap, *layer)))
        .map(|layer| {
            let name = layer_name(layer);
            let found = named_layer(&document, name).map(|old| {
                let brush = document.vector_payloads(old).ok().and_then(|payloads| {
                    payloads
                        .first()
                        .and_then(|payload| brush_style_of(payload).ok().flatten())
                });
                (old.main_id, brush)
            });
            (layer, found)
        })
        .collect();
    // The page's own layers are copied first: what CSP saved there fits it.
    let mut own = PartDonors::find(document, true)?;
    let text_donor = if own.has_text() {
        &own
    } else {
        let donor = fallback
            .text
            .as_ref()
            .ok_or_else(|| CspError::format("No text layer to copy"))?;
        prepare_always(&editor, donor)?;
        donor
    };
    let mut new_texts = Vec::new();
    for text in &added {
        let id = add_text_layer(&mut editor, text_donor, text)?;
        editor.clear_layer_image(id)?;
        new_texts.push(id);
        report.added.push(text_key(&text.text));
    }
    // A changed text goes next to its old one, to compare; new ones above the topmost text.
    for (index, id) in new_texts.iter().enumerate().rev() {
        let next_to = unmatched
            .get(index)
            .map(|old| (parent_of.get(&old.id).copied().unwrap_or(root), old.id))
            .or(anchor);
        match next_to {
            Some((parent, anchor)) => place_above(&editor, parent, anchor, *id)?,
            None => editor.append_to_folder(root, *id, None)?,
        }
    }

    for (layer, found) in balloons {
        let name = layer_name(layer).to_owned();
        let Some((old, brush)) = found else {
            report.not_found.push(name);
            continue;
        };
        let parent = parent_of.get(&old).copied().unwrap_or(root);
        let id = match layer {
            PageLayer::Vector { name, lines } => {
                let donor = match brush {
                    Some(brush) => {
                        own.vector = Some((old, brush));
                        &own
                    }
                    None if own.has_vector() => &own,
                    None => {
                        let donor = fallback
                            .vector
                            .as_ref()
                            .ok_or_else(|| CspError::format("No vector layer to copy"))?;
                        prepare_always(&editor, donor)?;
                        donor
                    }
                };
                let id = add_vector_layer(&mut editor, donor, name, lines)?;
                editor.clear_layer_image(id)?;
                id
            }
            PageLayer::Raster(raster) => {
                let source = &own.source;
                let payload = |id: &str| source.container.external_payload(id).map(<[u8]>::to_vec);
                let mut rename = |values: &mut Values| -> Result<()> {
                    set_value(values, "LayerName", Value::Text(raster.name.clone()));
                    for (column, value) in [("LayerVisibility", 1), ("DraftLayer", 0), ("LayerLock", 0)] {
                        if super::value_of(values, column).is_some() {
                            set_value(values, column, Value::Integer(value));
                        }
                    }
                    Ok(())
                };
                let id = editor.add_layer(source.database(), &payload, old, Some(&mut rename), None)?;
                if raster.image.is_transparent() {
                    editor.clear_layer_image(id)?;
                } else {
                    let image = if (raster.image.width, raster.image.height) == (width, height) {
                        None
                    } else {
                        Some(resize(&raster.image, width, height, Filter::Lanczos3))
                    };
                    editor.set_layer_image(id, image.as_ref().unwrap_or(&raster.image), (0, 0))?;
                }
                id
            }
            _ => return Err(CspError::format("Only balloon lines and images are swapped")),
        };
        retire(&editor, old, &name)?;
        place_above(&editor, parent, old, id)?;
        report.replaced.push(name);
    }

    editor.save_with(path, true)?;
    report.problems = check_update(path, update, &report);
    Ok(report)
}

/// Schema and shared rows for a donor from another file (always: the page
/// is not the template, whatever the donor is).
fn prepare_always(editor: &ClipEditor, donor: &PartDonors) -> Result<()> {
    if donor.is_template {
        super::page::merge_page_schema(&editor.db, donor.source.database())?;
        super::page::share_rows(&editor.db, donor.source.database())?;
        Ok(())
    } else {
        prepare_for(editor, donor)
    }
}

fn layer_name(layer: &PageLayer) -> &str {
    match layer {
        PageLayer::Raster(layer) => &layer.name,
        PageLayer::Vector { name, .. } | PageLayer::Frames { name, .. } => name,
        PageLayer::Text(text) => &text.text,
    }
}

/// Read the page back: every new text is there and visible, the old ones
/// hidden, each swapped layer there once.
fn check_update(path: &Path, update: &DialogueUpdate, report: &DialogueUpdateReport) -> Vec<String> {
    let document = match ClipDocument::read(path) {
        Ok(document) => document,
        Err(error) => return vec![format!("読み直せません: {error}")],
    };
    let mut problems = Vec::new();
    let mut visible: Vec<String> = page_texts(&document).into_iter().map(|text| text.key).collect();
    let mut missing = 0;
    for text in &update.texts {
        let key = text_key(&text.text);
        match visible.iter().position(|old| *old == key) {
            Some(index) => {
                visible.remove(index);
            }
            None => missing += 1,
        }
    }
    if missing > report.left_as_in_csp {
        problems.push(format!("セリフが {} 個足りません", missing - report.left_as_in_csp));
    }
    if visible.len() != report.foreign {
        problems.push(format!(
            "見えているテキストが {} 個多くあります",
            visible.len().saturating_sub(report.foreign)
        ));
    }
    for name in &report.replaced {
        let count = document
            .layers()
            .into_iter()
            .filter(|layer| layer.name == *name && layer.visible)
            .count();
        if count != 1 {
            problems.push(format!("「{name}」レイヤーが {count} 枚あります"));
        }
    }
    problems
}
