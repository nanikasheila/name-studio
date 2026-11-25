//! What was drawn in CSP on pages this tool wrote, to take it back into the
//! name: every vector line (with its width along it and its colour), the
//! frames of the コマ枠フォルダー, and the image layers drawn on since.
//!
//! What the export (or the last take-back) recorded tells what is new:
//! a line whose shape was recorded is one the name has (or left in CSP); an
//! image layer whose pixels are as recorded was not drawn on. The name side
//! (app `domain/csptakeback.ts`) decides what each change means for the name.

use std::collections::BTreeMap;
use std::path::Path;

use csp_format::stroke::{Brush, brushes};
use csp_format::vector::VectorData;
use serde::Serialize;

use super::manifest::{LineRecord, PageRecord, line_signature, pixel_signature};
use super::update::{CspDialogue, RETIRED_PREFIX, read_dialogue};
use crate::RgbaImage;
use crate::clip::{ClipDocument, ClipLayer, LayerKind};
use crate::error::Result;
use crate::raster::{Filter, resize};

/// One line of a vector layer as CSP has it, in canvas px.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspLine {
    pub sig: String,
    /// `[x, y, width factor]`: the factor (0..1) is what the line's brush
    /// makes of the pen pressure (and speed) there.
    pub points: Vec<[f64; 3]>,
    /// Width where the factor is 1.
    pub width_px: f64,
    /// 8-bit RGB.
    pub color: [u8; 3],
    pub closed: bool,
}

/// A vector layer and its lines.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspVectorLayer {
    /// Its name, after the folders it is in (`folder/name`), as recorded.
    pub name: String,
    pub visible: bool,
    pub lines: Vec<CspLine>,
}

/// A frame of a コマ枠フォルダー: its outline in canvas px.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspFrame {
    pub sig: String,
    pub points: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspFrameFolder {
    pub name: String,
    pub frames: Vec<CspFrame>,
}

/// An image layer of the page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspRaster {
    pub id: i64,
    pub name: String,
    pub sig: String,
    /// Where it has visible pixels, in canvas px; none when it has none.
    pub bbox: Option<[i64; 4]>,
    pub visible: bool,
    /// 0..1.
    pub opacity: f64,
    /// A 下描き layer.
    pub draft: bool,
}

/// A page as CSP has it now, with what was recorded of it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CspPageContent {
    pub dialogue: CspDialogue,
    pub record: PageRecord,
    pub vectors: Vec<CspVectorLayer>,
    pub frames: Vec<CspFrameFolder>,
    pub rasters: Vec<CspRaster>,
    pub width_px: i64,
    pub height_px: i64,
}

/// Each layer with its name after its folders (`folder/name`), bottom first.
fn named_layers(document: &ClipDocument) -> Vec<(String, &ClipLayer)> {
    fn walk<'a>(layer: &'a ClipLayer, prefix: &str, out: &mut Vec<(String, &'a ClipLayer)>) {
        for child in &layer.children {
            let name = format!("{prefix}{}", child.name);
            out.push((name.clone(), child));
            if child.kind.is_folder() {
                walk(child, &format!("{name}/"), out);
            }
        }
    }
    let mut out = Vec::new();
    walk(&document.root, "", &mut out);
    out
}

/// Layers left out: ones this tool hid as 「（旧）」, and their insides.
fn retired(name: &str) -> bool {
    name.split('/').any(|part| part.starts_with(RETIRED_PREFIX))
}

/// The stored pixels of an image layer, block by block, at their canvas place.
fn tiles(document: &ClipDocument, layer: &ClipLayer) -> Result<Vec<((i64, i64), RgbaImage)>> {
    document
        .occupied_pixel_boxes(layer)?
        .into_iter()
        .map(|box_| Ok(((box_.0, box_.1), document.layer_pixels_in_box(layer, box_)?)))
        .collect()
}

/// Where `tiles` have visible pixels.
fn content_box(tiles: &[((i64, i64), RgbaImage)]) -> Option<[i64; 4]> {
    let mut bbox: Option<[i64; 4]> = None;
    for ((x0, y0), tile) in tiles {
        let width = tile.width.max(1) as usize;
        for (index, pixel) in tile.pixels.as_chunks::<4>().0.iter().enumerate() {
            if pixel[3] == 0 {
                continue;
            }
            let x = x0 + (index % width) as i64;
            let y = y0 + (index / width) as i64;
            bbox = Some(match bbox {
                None => [x, y, x + 1, y + 1],
                Some([a, b, c, d]) => [a.min(x), b.min(y), c.max(x + 1), d.max(y + 1)],
            });
        }
    }
    bbox
}

/// The pixel fingerprint of every image layer of `document` (see
/// [`pixel_signature`]), by name, for the record.
pub fn page_pixels(document: &ClipDocument) -> Result<BTreeMap<String, String>> {
    let mut pixels = BTreeMap::new();
    for (name, layer) in named_layers(document) {
        if layer.kind == LayerKind::Raster && !retired(&name) {
            let tiles = tiles(document, layer)?;
            pixels.insert(name, pixel_signature(tiles.iter().map(|(at, tile)| (*at, tile))));
        }
    }
    Ok(pixels)
}

/// Width factor of a point: what `brush` makes of its pressure (value 0)
/// and speed (value 2); a line of no known brush keeps its pressure.
fn width_factor(brush: Option<&Brush>, values: &[f32; 13]) -> f64 {
    match brush {
        Some(brush) => brush.size.factor(f64::from(values[0]), f64::from(values[2])),
        None => f64::from(values[0]).clamp(0.0, 1.0),
    }
    .clamp(0.0, 1.0)
}

/// Read what the page at `path` holds now (see the module notes).
pub fn read_page(path: &Path) -> Result<CspPageContent> {
    let document = ClipDocument::read(path)?;
    let styles = brushes(document.file())?;
    let mut content = CspPageContent {
        dialogue: read_dialogue(path)?,
        record: super::manifest::written(path).unwrap_or_default(),
        width_px: document.canvas.width_px,
        height_px: document.canvas.height_px,
        ..Default::default()
    };
    for (name, layer) in named_layers(&document) {
        if retired(&name) {
            continue;
        }
        let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
        match layer.kind {
            LayerKind::Vector => {
                let mut lines = Vec::new();
                for payload in document.vector_payloads(layer)? {
                    for object in VectorData::parse(payload)?.objects {
                        let brush = object.brush_styles().first().and_then(|id| styles.get(&i64::from(*id)));
                        let points: Vec<[f64; 3]> = (0..object.points.len())
                            .filter_map(|index| object.point(index))
                            .map(|point| [point.x + dx, point.y + dy, width_factor(brush, &point.values)])
                            .collect();
                        let xy: Vec<(f64, f64)> = object.coordinates();
                        lines.push(CspLine {
                            sig: line_signature(&xy),
                            points,
                            width_px: 2.0 * object.brush_size().unwrap_or(0.5),
                            color: object.main_color(),
                            closed: object.is_closed(),
                        });
                    }
                }
                content.vectors.push(CspVectorLayer {
                    name,
                    visible: layer.visible,
                    lines,
                });
            }
            LayerKind::FrameFolder => {
                let mut frames = Vec::new();
                for payload in document.vector_payloads(layer)? {
                    for object in VectorData::parse(payload)?.objects {
                        let xy = object.coordinates();
                        frames.push(CspFrame {
                            sig: line_signature(&xy),
                            points: xy.iter().map(|&(x, y)| [x + dx, y + dy]).collect(),
                        });
                    }
                }
                content.frames.push(CspFrameFolder { name, frames });
            }
            LayerKind::Raster => {
                let tiles = tiles(&document, layer)?;
                let draft = document
                    .layer_row(layer.main_id)
                    .is_some_and(|row| row.opt_int("DraftLayer").unwrap_or(0) != 0);
                content.rasters.push(CspRaster {
                    id: layer.main_id,
                    name,
                    sig: pixel_signature(tiles.iter().map(|(at, tile)| (*at, tile))),
                    bbox: content_box(&tiles),
                    visible: layer.visible,
                    opacity: layer.opacity,
                    draft,
                });
            }
            _ => {}
        }
    }
    Ok(content)
}

/// The pixels of image layer `id` of the page at `path` inside `bbox`
/// (canvas px), made no larger than `max_side` on their long side.
pub fn layer_image(path: &Path, id: i64, bbox: [i64; 4], max_side: u32) -> Result<RgbaImage> {
    let document = ClipDocument::read(path)?;
    let layer = document.find_layer(id)?;
    let image = document.layer_pixels_in_box(layer, (bbox[0], bbox[1], bbox[2], bbox[3]))?;
    let long = image.width.max(image.height);
    if long <= max_side.max(1) {
        return Ok(image);
    }
    let scale = f64::from(max_side) / f64::from(long);
    let width = ((f64::from(image.width) * scale).round() as u32).max(1);
    let height = ((f64::from(image.height) * scale).round() as u32).max(1);
    Ok(resize(&image, width, height, Filter::Box))
}

/// What a take-back makes the name's: per vector layer, its lines now and
/// what of the name each is; per image layer, its pixels now.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adoption {
    #[serde(default)]
    pub lines: BTreeMap<String, Vec<LineRecord>>,
    #[serde(default)]
    pub pixels: BTreeMap<String, String>,
    /// The name's pages the file holds now.
    #[serde(default)]
    pub page_ids: Option<Vec<String>>,
    /// Keys of what the take-back made in the name (see [`PageRecord::taken`]).
    #[serde(default)]
    pub made: Vec<String>,
}

/// Record `adoption` for the page at `path` (the layers it names; the rest
/// of the record stays): the next take-back starts from there.
pub fn adopt_page(path: &Path, adoption: &Adoption) -> Result<()> {
    let mut record = super::manifest::written(path).unwrap_or_default();
    if !adoption.made.is_empty() {
        record.taken = Some(super::manifest::Taken {
            keys: adoption.made.clone(),
            lines: record.lines.clone(),
            pixels: record.pixels.clone(),
        });
    }
    for (name, lines) in &adoption.lines {
        record.lines.insert(name.clone(), lines.clone());
    }
    for (name, sig) in &adoption.pixels {
        record.pixels.insert(name.clone(), sig.clone());
    }
    if let Some(ids) = &adoption.page_ids {
        record.page_ids = ids.clone();
    }
    super::manifest::record_page(path, record)?;
    Ok(())
}
