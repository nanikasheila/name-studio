//! Writing the name data out as CSP pages and a work, one page per call, and
//! putting edited dialogue into pages written before.

use std::path::{Path, PathBuf};

use clip_core::RgbaImage;
use clip_core::raster::decode_png;
use clip_core::raster::{Filter, resize};
use clip_core::text::{FontName, NewText};
use clip_core::vector::{NewFrame, NewVectorLine};
use clip_core::write::raster_page::{
    PageLayer, RasterLayer, RasterWorkWriter, TemplateCanvas, WorkOptions, WorkReport,
};
use clip_core::write::split::DEFAULT_NAME_PATTERN;
use clip_core::write::spread::SpreadLayout;
use clip_core::write::verify::{self, ExpectedLayer, FileCheck};
use clip_core::write::{manifest, update};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::AppState;
use crate::ipc::{lock_error, raw_body, split_body};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameExportRequest {
    template: String,
    out_dir: String,
    work_template: Option<String>,
    work_name: Option<String>,
    story_index: Option<i64>,
    /// The name data and its source sheet: never overwritten.
    inputs: Vec<String>,
    /// .clip files (such as the name sheet) whose vector / text layers new
    /// editable layers are copied from, after the template.
    #[serde(default)]
    donors: Vec<String>,
    /// Layers (by name) written as 下描き layers at half opacity.
    #[serde(default)]
    draft_layers: Vec<String>,
    /// Look for a コマ枠フォルダー to copy, to write panels as frames.
    #[serde(default)]
    frame_folders: bool,
}

/// The template's canvas and which parts can be written as editable layers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameExportStart {
    #[serde(flatten)]
    canvas: TemplateCanvas,
    vector_layers: bool,
    text_layers: bool,
    /// Whether panels can be written as a コマ枠フォルダー (one was found to copy).
    frame_folders: bool,
    /// Whether the book's first page (index 0) is a left page.
    first_page_left: Option<bool>,
    /// Where pages go on a 見開き page, or why spreads cannot be written.
    spread: Option<SpreadLayout>,
    spread_problem: Option<String>,
}

/// Start writing the name data as CSP pages; returns the template's canvas.
#[tauri::command]
pub(crate) async fn begin_name_export(
    request: NameExportRequest,
    state: tauri::State<'_, AppState>,
) -> Result<NameExportStart, String> {
    let work = match (request.work_template, request.work_name) {
        (Some(template), Some(name)) if !name.trim().is_empty() => {
            Some((name.trim().to_owned(), PathBuf::from(template)))
        }
        _ => None,
    };
    let writer = RasterWorkWriter::new(WorkOptions {
        template: request.template.into(),
        out_dir: request.out_dir.into(),
        name_pattern: DEFAULT_NAME_PATTERN.to_owned(),
        work,
        story_index: request.story_index,
        inputs: request.inputs.into_iter().map(PathBuf::from).collect(),
        donor_sources: request.donors.into_iter().map(PathBuf::from).collect(),
        draft_layers: request.draft_layers,
        frame_folders: request.frame_folders,
    })
    .map_err(|error| error.to_string())?;
    let start = NameExportStart {
        canvas: writer.canvas,
        vector_layers: writer.donors.vector.is_some(),
        text_layers: writer.donors.text.is_some(),
        frame_folders: writer.donors.frame.is_some(),
        first_page_left: writer.first_page_left,
        spread: writer.spread.as_ref().ok().map(|(_, layout)| *layout),
        spread_problem: writer.spread.as_ref().err().cloned(),
    };
    *state.name_export.lock().map_err(lock_error)? = Some(writer);
    Ok(start)
}

/// A rough image of the source sheet and where it goes on the page (template px).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoughPlacement {
    layer_id: i64,
    sheet_crop: [f64; 4],
    target: [f64; 4],
}

/// A vector line in template px; `points` are `[x, y, width factor]`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LineMeta {
    points: Vec<[f64; 3]>,
    closed: bool,
    width_px: f64,
}

/// One panel of a コマ枠フォルダー in template px.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameMeta {
    points: Vec<[f64; 2]>,
    width_px: f64,
}

/// One layer of a page, bottom first.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum LayerMeta {
    /// A whole-page PNG of `length` bytes from the body (0 for a blank layer).
    Raster {
        name: String,
        length: usize,
    },
    Vector {
        name: String,
        lines: Vec<LineMeta>,
    },
    /// A コマ枠フォルダー: panel outlines in template px, `ink` an empty
    /// raster layer put inside it.
    #[serde(rename_all = "camelCase")]
    Frames {
        name: String,
        frames: Vec<FrameMeta>,
        #[serde(default)]
        ink: Option<String>,
    },
    /// A text in a frame in template px, its size in CSP pt.
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        frame: [f64; 4],
        font_size_pt: f64,
        vertical: bool,
        /// 8-bit RGB; absent keeps the template text's colour.
        #[serde(default)]
        color: Option<[u8; 3]>,
        /// Absent keeps the template text's font.
        #[serde(default)]
        font: Option<FontMeta>,
    },
}

/// A font by the name CSP shows and its PostScript name.
#[derive(Deserialize)]
pub(crate) struct FontMeta {
    name: String,
    postscript: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageLayersMeta {
    layers: Vec<LayerMeta>,
    sheet: Option<String>,
    #[serde(default)]
    roughs: Vec<RoughPlacement>,
    /// Byte length of a PNG (after the layers' PNGs) of the lines and texts,
    /// drawn over the images for the page thumbnail; 0 for none.
    #[serde(default)]
    overlay_length: usize,
    /// Two pages of the book as one 見開き page (images at the spread's size).
    #[serde(default)]
    spread: bool,
}

/// Rough images from the source sheet, placed on one transparent page image.
fn rough_layer(
    state: &AppState,
    sheet: &str,
    roughs: &[RoughPlacement],
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    state.ensure_sheet(sheet)?;
    let mut page = RgbaImage::transparent(width, height);
    for rough in roughs {
        let [x0, y0, x1, y1] = rough.sheet_crop;
        let region = (x0.floor() as i64, y0.floor() as i64, x1.ceil() as i64, y1.ceil() as i64);
        let pixels = state.with_layer(rough.layer_id, |document, layer| {
            document.layer_pixels_in_box(layer, region)
        })?;
        let [tx0, ty0, tx1, ty1] = rough.target;
        let (w, h) = ((tx1 - tx0).round().max(1.0) as u32, (ty1 - ty0).round().max(1.0) as u32);
        page.blend_over(
            &resize(&pixels, w, h, Filter::Lanczos3),
            tx0.round() as i64,
            ty0.round() as i64,
        );
    }
    Ok(page)
}

/// One layer as sent (`take` gives the next PNG of the body) as clip-core's.
fn page_layer<'a>(
    layer: LayerMeta,
    take: &mut impl FnMut(usize) -> Result<&'a [u8], String>,
    width: u32,
    height: u32,
) -> Result<PageLayer, String> {
    Ok(match layer {
        LayerMeta::Raster { name, length } => {
            let png = take(length)?;
            let image = if png.is_empty() {
                RgbaImage::transparent(width, height)
            } else {
                decode_png(png).map_err(|error| error.to_string())?
            };
            PageLayer::Raster(RasterLayer { name, image })
        }
        LayerMeta::Vector { name, lines } => PageLayer::Vector {
            name,
            lines: lines
                .into_iter()
                .map(|line| NewVectorLine {
                    points: line.points.into_iter().map(|[x, y, w]| (x, y, w)).collect(),
                    closed: line.closed,
                    width_px: line.width_px,
                })
                .collect(),
        },
        LayerMeta::Frames { name, frames, ink } => PageLayer::Frames {
            name,
            frames: frames
                .into_iter()
                .map(|frame| NewFrame {
                    points: frame.points.into_iter().map(|[x, y]| (x, y)).collect(),
                    width_px: frame.width_px,
                })
                .collect(),
            ink,
        },
        LayerMeta::Text {
            text,
            frame,
            font_size_pt,
            vertical,
            color,
            font,
        } => PageLayer::Text(NewText {
            text,
            frame: frame.map(|value| value.round() as i32),
            font_size_pt,
            vertical,
            color,
            font: font.map(|font| FontName {
                name: font.name,
                postscript: font.postscript,
            }),
        }),
    })
}

/// Write the next page from its layer images (raw body, see [`split_body`]),
/// then read it back to check it holds what was sent.
#[tauri::command]
pub(crate) async fn export_name_page(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<FileCheck, String> {
    let body = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (meta, mut rest) = split_body::<PageLayersMeta>(&body)?;
        let mut writer = state
            .name_export
            .lock()
            .map_err(lock_error)?
            .take()
            .ok_or("書き出しが始まっていません")?;
        let result = (|| {
            let canvas = if meta.spread {
                writer.spread_canvas().ok_or("見開きページを作れません")?
            } else {
                writer.canvas
            };
            let (width, height) = (canvas.width_px, canvas.height_px);
            let mut layers = Vec::new();
            if let Some(sheet) = meta.sheet.as_deref().filter(|_| !meta.roughs.is_empty()) {
                layers.push(PageLayer::Raster(RasterLayer {
                    name: "ラフ（ネーム用紙）".to_owned(),
                    image: rough_layer(&state, sheet, &meta.roughs, width, height)?,
                }));
            }
            let mut take = |length: usize| -> Result<&[u8], String> {
                let png = rest.get(..length).ok_or("データが壊れています")?;
                rest = &rest[length..];
                Ok(png)
            };
            for layer in meta.layers {
                layers.push(page_layer(layer, &mut take, width, height)?);
            }
            let overlay = match take(meta.overlay_length)? {
                [] => None,
                png => Some(decode_png(png).map_err(|error| error.to_string())?),
            };
            let expected: Vec<ExpectedLayer> = layers
                .iter()
                .map(|layer| ExpectedLayer::of(layer, width, height))
                .collect();
            let path = writer
                .write_page(&layers, overlay.as_ref(), meta.spread)
                .map_err(|error| error.to_string())?;
            Ok(verify::verify_page(&path, &expected, &canvas))
        })();
        *state.name_export.lock().map_err(lock_error)? = Some(writer);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DialogueMeta {
    /// The page's texts (`LayerMeta::Text`) and balloons (vector / raster).
    texts: Vec<LayerMeta>,
    balloons: Vec<LayerMeta>,
    /// The memos layer (`LayerMeta::Raster`, its PNG after the balloons'), if written.
    #[serde(default)]
    notes: Option<LayerMeta>,
    #[serde(default)]
    spread: bool,
    /// Folder name under `name-studio-backup` for the pages as they were.
    backup: String,
}

/// Bring the dialogue of the next page (raw body: JSON, then the balloon
/// images) into the page the export wrote there, keeping what was drawn in CSP.
#[tauri::command]
pub(crate) async fn update_name_dialogue(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<update::DialogueUpdateReport, String> {
    let body = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (meta, mut rest) = split_body::<DialogueMeta>(&body)?;
        let mut writer = state
            .name_export
            .lock()
            .map_err(lock_error)?
            .take()
            .ok_or("書き出しが始まっていません")?;
        let result = (|| {
            let canvas = if meta.spread {
                writer.spread_canvas().ok_or("見開きページを作れません")?
            } else {
                writer.canvas
            };
            let (width, height) = (canvas.width_px, canvas.height_px);
            let path = writer.next_page_path(meta.spread);
            if !path.exists() {
                return Ok(update::DialogueUpdateReport {
                    path,
                    not_found: vec!["ページのファイル".to_owned()],
                    ..Default::default()
                });
            }
            let mut take = |length: usize| -> Result<&[u8], String> {
                let png = rest.get(..length).ok_or("データが壊れています")?;
                rest = &rest[length..];
                Ok(png)
            };
            let mut texts = Vec::new();
            for layer in meta.texts {
                if let PageLayer::Text(text) = page_layer(layer, &mut take, width, height)? {
                    texts.push(text);
                }
            }
            let mut balloons = Vec::new();
            for layer in meta.balloons {
                balloons.push(page_layer(layer, &mut take, width, height)?);
            }
            let notes = match meta.notes {
                Some(layer) => match page_layer(layer, &mut take, width, height)? {
                    PageLayer::Raster(notes) => Some(notes),
                    _ => None,
                },
                None => None,
            };
            let update = update::DialogueUpdate {
                texts,
                balloons,
                notes,
                written: manifest::written(&path),
            };
            let backup = writer.out_dir().join("name-studio-backup").join(&meta.backup);
            let report = update::update_dialogue(&path, &update, &writer.donors, &backup)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            // What the page now holds from the name, for the next update.
            let _ = manifest::record_page(&path, report.record.clone());
            Ok(report)
        })();
        *state.name_export.lock().map_err(lock_error)? = Some(writer);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The dialogue of the next page as CSP has it now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CspPageDialogue {
    path: PathBuf,
    /// None when the page's file is not there.
    dialogue: Option<update::CspDialogue>,
}

/// Read the dialogue of the next page the export wrote (a 見開き page when
/// `spread`), to take what was changed in CSP back into the name.
#[tauri::command]
pub(crate) async fn read_name_dialogue(app: tauri::AppHandle, spread: bool) -> Result<CspPageDialogue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut guard = state.name_export.lock().map_err(lock_error)?;
        let writer = guard.as_mut().ok_or("書き出しが始まっていません")?;
        let path = writer.next_page_path(spread);
        let dialogue = if path.exists() {
            Some(update::read_dialogue(&path).map_err(|error| format!("{}: {error}", path.display()))?)
        } else {
            None
        };
        Ok(CspPageDialogue { path, dialogue })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Record the dialogue of these pages as CSP has it now as the name's (taken back into it).
#[tauri::command]
pub(crate) async fn adopt_name_dialogue(paths: Vec<PathBuf>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            update::adopt_dialogue(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameExportReport {
    #[serde(flatten)]
    report: WorkReport,
    /// The work read back (none without a work).
    work_check: Option<FileCheck>,
}

/// Finish: write the work (.cmc) around the pages written so far, and check it.
#[tauri::command]
pub(crate) async fn finish_name_export(state: tauri::State<'_, AppState>) -> Result<NameExportReport, String> {
    let writer = state
        .name_export
        .lock()
        .map_err(lock_error)?
        .take()
        .ok_or("書き出しが始まっていません")?;
    tauri::async_runtime::spawn_blocking(move || {
        let report = writer.finish().map_err(|error| error.to_string())?;
        // What was written, so the next export here can tell pages changed in CSP.
        if let Some(dir) = report.pages.first().and_then(|page| page.parent()) {
            let written: Vec<(PathBuf, manifest::PageRecord)> = report
                .pages
                .iter()
                .cloned()
                .zip(report.records.iter().cloned())
                .chain(report.work.iter().map(|work| (work.clone(), Default::default())))
                .collect();
            let _ = manifest::write_manifest(dir, &written);
        }
        let work_check = report
            .work
            .as_ref()
            .map(|work| verify::verify_work(work, Some(&report.pages)));
        Ok(NameExportReport { report, work_check })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// CSP files an export into `out_dir` would overwrite, and which of them were changed after the last export.
#[tauri::command]
pub(crate) async fn check_export_target(out_dir: String) -> manifest::OverwriteCheck {
    manifest::check_overwrite(Path::new(&out_dir))
}

#[tauri::command]
pub(crate) async fn cancel_name_export(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.name_export.lock().map_err(lock_error)? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page the way nameexport.ts sends it: meta, then the PNGs in layer order.
    fn page_json() -> &'static str {
        r#"{
            "layers": [
                {"kind": "raster", "name": "ラフ", "length": 0},
                {"kind": "raster", "name": "塗り", "length": LENGTH},
                {"kind": "vector", "name": "コマ枠", "lines": [{"points": [[1, 2, 0.5], [3, 4, 1]], "closed": true, "widthPx": 6}]},
                {"kind": "frames", "name": "コマ", "frames": [{"points": [[0, 0], [10, 0], [10, 10]], "widthPx": 8}], "ink": "ペン入れ"},
                {"kind": "text", "text": "セリフ", "frame": [10.4, 20.6, 30.5, 40], "fontSizePt": 9.5, "vertical": true, "color": [255, 255, 255]}
            ],
            "sheet": null,
            "spread": true
        }"#
    }

    #[test]
    fn a_page_from_the_front_end_becomes_clip_core_layers() {
        let png = RgbaImage::transparent(4, 3).to_png().unwrap();
        let json = page_json().replace("LENGTH", &png.len().to_string());
        let meta: PageLayersMeta = serde_json::from_str(&json).unwrap();
        assert!(meta.spread);
        assert!(meta.roughs.is_empty());
        assert_eq!(meta.overlay_length, 0);

        let mut rest: &[u8] = &png;
        let mut take = |length: usize| -> Result<&[u8], String> {
            let part = rest.get(..length).ok_or("データが壊れています")?;
            rest = &rest[length..];
            Ok(part)
        };
        let layers: Vec<PageLayer> = meta
            .layers
            .into_iter()
            .map(|layer| page_layer(layer, &mut take, 4, 3))
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(rest.is_empty());

        match &layers[..] {
            [
                PageLayer::Raster(blank),
                PageLayer::Raster(fill),
                PageLayer::Vector { name, lines },
                PageLayer::Frames { frames, ink, .. },
                PageLayer::Text(text),
            ] => {
                assert_eq!(
                    (blank.name.as_str(), blank.image.width, blank.image.height),
                    ("ラフ", 4, 3)
                );
                assert_eq!(
                    (fill.name.as_str(), fill.image.width, fill.image.height),
                    ("塗り", 4, 3)
                );
                assert_eq!(name, "コマ枠");
                assert_eq!(lines[0].points, vec![(1.0, 2.0, 0.5), (3.0, 4.0, 1.0)]);
                assert!(lines[0].closed);
                assert_eq!(frames[0].points, vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]);
                assert_eq!(ink.as_deref(), Some("ペン入れ"));
                assert_eq!(text.frame, [10, 21, 31, 40]);
                assert_eq!(text.color, Some([255, 255, 255]));
                assert!(text.vertical);
            }
            other => panic!("unexpected layers: {}", other.len()),
        }
    }

    #[test]
    fn a_page_shorter_than_its_images_is_refused() {
        let json = page_json().replace("LENGTH", "100");
        let meta: PageLayersMeta = serde_json::from_str(&json).unwrap();
        let mut rest: &[u8] = &[0; 10];
        let mut take = |length: usize| -> Result<&[u8], String> {
            let part = rest.get(..length).ok_or("データが壊れています")?;
            rest = &rest[length..];
            Ok(part)
        };
        let result: Result<Vec<PageLayer>, String> = meta
            .layers
            .into_iter()
            .map(|layer| page_layer(layer, &mut take, 4, 3))
            .collect();
        assert!(result.is_err());
    }
}
