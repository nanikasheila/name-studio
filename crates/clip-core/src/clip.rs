//! Layer structure and raster pixels of a .clip file.
//!
//! The `Canvas` and `Layer` tables of the embedded database are read and the
//! tree is rebuilt from the first-child / next-sibling links:
//! `Canvas.CanvasRootFolder` is the root folder's `Layer.MainId`, and
//! `LayerFirstChildIndex` / `LayerNextIndex` hold MainIds (0 = none).
//! Siblings are listed bottom to top (the paper layer first).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::container::CsfContainer;
use crate::error::{CspError, Result};
use crate::offscreen::{self, OffscreenParameters, RgbaImage};
use crate::sql::{Row, select_rows, table_exists};
use crate::text::{TextAttributes, parse_text_attributes, split_attribute_array};
use crate::vector::{VectorObject, parse_vector_data};

const LAYER_TYPE_RASTER: i64 = 1;
const LAYER_TYPE_ROOT: i64 = 256;
const LAYER_TYPE_STORY_INFO: i64 = 800;
const LAYER_TYPE_PAPER: i64 = 1584;
const FULL_OPACITY: f64 = 256.0;
const MAX_LAYER_DEPTH: usize = 64;

/// An offscreen's `Attribute` blob and its external pixel payload (if stored).
type Offscreen<'a> = (Vec<u8>, Option<&'a [u8]>);

/// Python-compatible rounding (ties to even), so both implementations agree.
pub fn round_half_even(value: f64) -> i64 {
    value.round_ties_even() as i64
}

pub fn unit_name(code: i64) -> String {
    match code {
        0 => "px".into(),
        1 => "cm".into(),
        2 => "mm".into(),
        3 => "inch".into(),
        5 => "pt".into(),
        other => format!("unit{other}"),
    }
}

pub fn to_pixels(value: f64, unit: &str, resolution: f64) -> i64 {
    let per_inch = match unit {
        "mm" => 25.4,
        "cm" => 2.54,
        "inch" => 1.0,
        "pt" => 72.0,
        _ => return round_half_even(value),
    };
    round_half_even(value * resolution / per_inch)
}

/// Canvas (page) settings.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipCanvas {
    pub width: f64,
    pub height: f64,
    pub unit: String,
    pub resolution: f64,
    pub width_px: i64,
    pub height_px: i64,
    pub is_double_page: bool,
    /// Trim frame (仕上がり枠) of one page.
    pub crop_size_px: Option<(i64, i64)>,
    /// Basic frame (基本枠) of one page.
    pub basic_size_px: Option<(i64, i64)>,
    /// Offset of the basic frame from the trim frame's centre.
    pub basic_offset_px: (i64, i64),
}

impl ClipCanvas {
    fn from_row(row: &Row) -> Self {
        let unit = unit_name(row.int("CanvasUnit"));
        let width = row.real("CanvasWidth");
        let height = row.real("CanvasHeight");
        let resolution = row.real("CanvasResolution");
        let crop_unit = unit_name(row.int("CropFrameUnitKind"));
        let size = |width_column: &str, height_column: &str| {
            if !row.has(width_column) || !row.has(height_column) {
                return None;
            }
            let (w, h) = (row.real(width_column), row.real(height_column));
            (w > 0.0 && h > 0.0).then(|| {
                (
                    to_pixels(w, &crop_unit, resolution),
                    to_pixels(h, &crop_unit, resolution),
                )
            })
        };
        ClipCanvas {
            width_px: to_pixels(width, &unit, resolution),
            height_px: to_pixels(height, &unit, resolution),
            is_double_page: row.truthy("CanvasDoublePage"),
            crop_size_px: size("CropFrameWidth", "CropFrameHeight"),
            basic_size_px: size("CropFrameInnerWidth", "CropFrameInnerHeight"),
            basic_offset_px: (
                to_pixels(row.real("CropFrameInnerOffsetX"), &crop_unit, resolution),
                to_pixels(row.real("CropFrameInnerOffsetY"), &crop_unit, resolution),
            ),
            width,
            height,
            unit,
            resolution,
        }
    }

    /// Width of one page (half the canvas for a double page).
    pub fn single_page_width_px(&self) -> i64 {
        if self.is_double_page {
            to_pixels(self.width / 2.0, &self.unit, self.resolution)
        } else {
            self.width_px
        }
    }
}

/// What a layer is, as far as this tool cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerKind {
    Root,
    Paper,
    StoryInfo,
    Raster,
    Folder,
    FrameFolder,
    Text,
    Vector,
    Other,
}

impl LayerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LayerKind::Root => "root",
            LayerKind::Paper => "paper",
            LayerKind::StoryInfo => "story_info",
            LayerKind::Raster => "raster",
            LayerKind::Folder => "folder",
            LayerKind::FrameFolder => "frame_folder",
            LayerKind::Text => "text",
            LayerKind::Vector => "vector",
            LayerKind::Other => "other",
        }
    }

    pub fn is_folder(self) -> bool {
        matches!(self, LayerKind::Folder | LayerKind::FrameFolder | LayerKind::Root)
    }
}

/// One layer or folder of the tree.
#[derive(Debug, Clone, PartialEq)]
pub struct ClipLayer {
    pub main_id: i64,
    pub name: String,
    pub kind: LayerKind,
    pub layer_type: i64,
    pub visible: bool,
    pub opacity: f64,
    pub composite: i64,
    pub offset_x: i64,
    pub offset_y: i64,
    pub clipping: bool,
    pub locked: bool,
    pub has_mask: bool,
    pub render_mipmap: i64,
    pub mask_mipmap: i64,
    pub text: Option<String>,
    pub children: Vec<ClipLayer>,
    pub render_offset_x: i64,
    pub render_offset_y: i64,
}

impl ClipLayer {
    /// Canvas position of the stored pixels' top-left corner. Observed:
    /// `LayerRenderOffscrOffset` is usually `-LayerOffset`; enlarged
    /// offscreens differ by whole blocks. The sum gives the origin.
    pub fn pixel_origin(&self) -> (i64, i64) {
        (
            self.offset_x + self.render_offset_x,
            self.offset_y + self.render_offset_y,
        )
    }

    fn collect<'a>(&'a self, result: &mut Vec<&'a ClipLayer>) {
        for child in &self.children {
            result.push(child);
            child.collect(result);
        }
    }
}

/// A parsed .clip file. Keeps the container bytes and an in-memory copy of
/// the database so pixels, vectors and text are decoded on demand.
pub struct ClipDocument {
    pub path: PathBuf,
    pub canvas: ClipCanvas,
    pub root: ClipLayer,
    pub preview_png: Option<Vec<u8>>,
    pub container: CsfContainer,
    database: Connection,
    layer_rows: HashMap<i64, Row>,
}

impl ClipDocument {
    pub fn read(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let container = CsfContainer::read(path)?;
        let database = container.open_database()?;
        let canvas_row = select_rows(&database, "SELECT * FROM Canvas", [])?
            .into_iter()
            .next()
            .ok_or_else(|| CspError::format(format!("Canvas row not found: {}", path.display())))?;
        let layer_rows: HashMap<i64, Row> = select_rows(&database, "SELECT * FROM Layer", [])?
            .into_iter()
            .map(|row| (row.int("MainId"), row))
            .collect();
        let vector_ids: HashSet<i64> = if table_exists(&database, "VectorObjectList")? {
            select_rows(&database, "SELECT LayerId FROM VectorObjectList", [])?
                .iter()
                .map(|row| row.int("LayerId"))
                .collect()
        } else {
            HashSet::new()
        };
        let root_id = canvas_row.int("CanvasRootFolder");
        if !layer_rows.contains_key(&root_id) {
            return Err(CspError::format(format!(
                "Root folder {root_id} not found in Layer table"
            )));
        }
        let mut seen = HashSet::from([root_id]);
        let root = build_layer(&layer_rows, &vector_ids, root_id, 0, &mut seen)?;
        let preview_png = if table_exists(&database, "CanvasPreview")? {
            select_rows(&database, "SELECT ImageData FROM CanvasPreview LIMIT 1", [])?
                .first()
                .and_then(|row| {
                    row.blob("ImageData")
                        .filter(|data| !data.is_empty())
                        .map(<[u8]>::to_vec)
                })
        } else {
            None
        };
        Ok(ClipDocument {
            path: path.to_path_buf(),
            canvas: ClipCanvas::from_row(&canvas_row),
            root,
            preview_png,
            container,
            database,
            layer_rows,
        })
    }

    /// All layers depth-first, bottom to top (root excluded).
    pub fn layers(&self) -> Vec<&ClipLayer> {
        let mut result = Vec::new();
        self.root.collect(&mut result);
        result
    }

    pub fn find_layer(&self, main_id: i64) -> Result<&ClipLayer> {
        self.layers()
            .into_iter()
            .find(|layer| layer.main_id == main_id)
            .ok_or_else(|| CspError::format(format!("Layer {main_id} not found")))
    }

    /// The full database row of a layer (for columns this crate does not model).
    pub fn layer_row(&self, main_id: i64) -> Option<&Row> {
        self.layer_rows.get(&main_id)
    }

    pub fn database(&self) -> &Connection {
        &self.database
    }

    /// (Attribute, external payload) of a mipmap's 100% level.
    fn base_offscreen(&self, mipmap_id: i64) -> Result<Option<Offscreen<'_>>> {
        if mipmap_id == 0 {
            return Ok(None);
        }
        let rows = select_rows(
            &self.database,
            "SELECT o.Attribute AS Attribute, o.BlockData AS BlockData FROM Mipmap m \
             JOIN MipmapInfo i ON i.MainId = m.BaseMipmapInfo \
             JOIN Offscreen o ON o.MainId = i.Offscreen WHERE m.MainId = ?1",
            [mipmap_id],
        )?;
        let row = rows
            .first()
            .ok_or_else(|| CspError::format(format!("Mipmap {mipmap_id} has no base offscreen")))?;
        let attribute = row.blob("Attribute").unwrap_or_default().to_vec();
        let external_id = row.text("BlockData").unwrap_or_default();
        Ok(Some((attribute, self.container.external_payload(&external_id))))
    }

    /// Stored pixels of a layer, or None. Vector and text layers usually have
    /// none: CSP redraws them from their own data.
    pub fn render_layer_pixels(&self, layer: &ClipLayer) -> Result<Option<RgbaImage>> {
        match self.base_offscreen(layer.render_mipmap)? {
            Some((attribute, payload)) => offscreen::decode_offscreen_image(&attribute, payload),
            None => Ok(None),
        }
    }

    /// Stored pixels shrunk by an integer factor (for overviews of a whole sheet).
    pub fn render_layer_scaled(&self, layer: &ClipLayer, factor: u32) -> Result<Option<RgbaImage>> {
        match self.base_offscreen(layer.render_mipmap)? {
            Some((attribute, payload)) => offscreen::decode_offscreen_scaled(&attribute, payload, factor),
            None => Ok(None),
        }
    }

    pub fn layer_pixel_parameters(&self, layer: &ClipLayer) -> Result<Option<OffscreenParameters>> {
        self.base_offscreen(layer.render_mipmap)?
            .map(|(attribute, _)| OffscreenParameters::parse(&attribute))
            .transpose()
    }

    /// Layer pixels inside a canvas box (transparent where none are stored).
    pub fn layer_pixels_in_box(&self, layer: &ClipLayer, box_: (i64, i64, i64, i64)) -> Result<RgbaImage> {
        let (origin_x, origin_y) = layer.pixel_origin();
        let (x0, y0, x1, y1) = box_;
        match self.base_offscreen(layer.render_mipmap)? {
            Some((attribute, payload)) => offscreen::decode_offscreen_region(
                &attribute,
                payload,
                (x0 - origin_x, y0 - origin_y, x1 - origin_x, y1 - origin_y),
            ),
            None => Ok(RgbaImage::transparent((x1 - x0).max(1) as u32, (y1 - y0).max(1) as u32)),
        }
    }

    /// Canvas boxes of the 256 px blocks that store pixels, found without
    /// decoding anything (a 14031x9921 name sheet is over 500 MB as RGBA).
    pub fn occupied_pixel_boxes(&self, layer: &ClipLayer) -> Result<Vec<(i64, i64, i64, i64)>> {
        let Some((attribute, Some(payload))) = self.base_offscreen(layer.render_mipmap)? else {
            return Ok(Vec::new());
        };
        let (origin_x, origin_y) = layer.pixel_origin();
        Ok(offscreen::occupied_blocks(&attribute, payload)?
            .into_iter()
            .map(|(x0, y0, x1, y1)| (x0 + origin_x, y0 + origin_y, x1 + origin_x, y1 + origin_y))
            .collect())
    }

    /// Raw `VectorData` payloads of a vector layer or a text layer's balloons.
    pub fn vector_payloads(&self, layer: &ClipLayer) -> Result<Vec<&[u8]>> {
        if !matches!(layer.kind, LayerKind::Vector | LayerKind::Text)
            || !table_exists(&self.database, "VectorObjectList")?
        {
            return Ok(Vec::new());
        }
        let rows = select_rows(
            &self.database,
            "SELECT VectorData FROM VectorObjectList WHERE LayerId = ?1",
            [layer.main_id],
        )?;
        Ok(rows
            .iter()
            .filter_map(|row| row.blob("VectorData"))
            .filter_map(|id| self.container.external_payload(&String::from_utf8_lossy(id)))
            .filter(|payload| !payload.is_empty())
            .collect())
    }

    /// Vector objects of a layer (layer-local coordinates).
    pub fn vector_objects(&self, layer: &ClipLayer) -> Result<Vec<VectorObject>> {
        let mut objects = Vec::new();
        for payload in self.vector_payloads(layer)? {
            objects.extend(parse_vector_data(payload)?);
        }
        Ok(objects)
    }

    /// Text blocks of a text layer: `TextLayerAttributes` first, then one per
    /// `TextLayerAttributesArray` entry (balloons).
    pub fn text_blocks(&self, layer: &ClipLayer) -> Result<Vec<TextAttributes>> {
        if !matches!(layer.kind, LayerKind::Text | LayerKind::StoryInfo) {
            return Ok(Vec::new());
        }
        let Some(row) = self.layer_rows.get(&layer.main_id) else {
            return Ok(Vec::new());
        };
        let Some(attributes) = row.blob("TextLayerAttributes") else {
            return Ok(Vec::new());
        };
        let mut blobs = vec![attributes];
        if let Some(array) = row.blob("TextLayerAttributesArray") {
            blobs.extend(split_attribute_array(array)?);
        }
        blobs.into_iter().map(parse_text_attributes).collect()
    }
}

impl ClipDocument {
    /// Text of each text block, in the order of [`ClipDocument::text_blocks`]:
    /// `TextLayerString` first, then the `TextLayerStringArray` entries
    /// (`u32` little-endian length + UTF-8, like the attribute array).
    pub fn text_strings(&self, layer: &ClipLayer) -> Vec<String> {
        let Some(row) = self.layer_rows.get(&layer.main_id) else {
            return Vec::new();
        };
        let mut strings: Vec<String> = row.text("TextLayerString").into_iter().collect();
        if let Some(array) = row.blob("TextLayerStringArray")
            && let Ok(entries) = split_attribute_array(array)
        {
            strings.extend(
                entries
                    .into_iter()
                    .map(|entry| String::from_utf8_lossy(entry).into_owned()),
            );
        }
        strings
    }
}

fn classify(row: &Row, vector_ids: &HashSet<i64>) -> LayerKind {
    match row.int("LayerType") {
        LAYER_TYPE_ROOT => LayerKind::Root,
        LAYER_TYPE_PAPER => LayerKind::Paper,
        LAYER_TYPE_STORY_INFO => LayerKind::StoryInfo,
        LAYER_TYPE_RASTER => LayerKind::Raster,
        _ if row.int("LayerFolder") & 1 != 0 => {
            if row.truthy("ComicFrameLineMipmap") {
                LayerKind::FrameFolder
            } else {
                LayerKind::Folder
            }
        }
        _ if row
            .get("TextLayerString")
            .is_some_and(|value| *value != rusqlite::types::Value::Null) =>
        {
            LayerKind::Text
        }
        _ if vector_ids.contains(&row.int("MainId")) => LayerKind::Vector,
        _ => LayerKind::Other,
    }
}

fn build_layer(
    rows: &HashMap<i64, Row>,
    vector_ids: &HashSet<i64>,
    main_id: i64,
    depth: usize,
    seen: &mut HashSet<i64>,
) -> Result<ClipLayer> {
    if depth > MAX_LAYER_DEPTH {
        return Err(CspError::format("Layer tree is nested too deeply"));
    }
    let row = &rows[&main_id];
    let mut children = Vec::new();
    let mut child_id = row.int("LayerFirstChildIndex");
    while child_id != 0 {
        if !seen.insert(child_id) || !rows.contains_key(&child_id) {
            return Err(CspError::format(format!("Broken layer link to {child_id}")));
        }
        children.push(build_layer(rows, vector_ids, child_id, depth + 1, seen)?);
        child_id = rows[&child_id].int("LayerNextIndex");
    }
    Ok(ClipLayer {
        main_id,
        name: row.text("LayerName").unwrap_or_default(),
        kind: classify(row, vector_ids),
        layer_type: row.int("LayerType"),
        visible: row.int("LayerVisibility") & 1 != 0,
        opacity: row.int("LayerOpacity") as f64 / FULL_OPACITY,
        composite: row.int("LayerComposite"),
        offset_x: row.int("LayerOffsetX"),
        offset_y: row.int("LayerOffsetY"),
        clipping: row.truthy("LayerClip"),
        locked: row.truthy("LayerLock"),
        has_mask: row.truthy("LayerLayerMaskMipmap"),
        render_mipmap: row.int("LayerRenderMipmap"),
        mask_mipmap: row.int("LayerLayerMaskMipmap"),
        text: row.text("TextLayerString"),
        children,
        render_offset_x: row.int("LayerRenderOffscrOffsetX"),
        render_offset_y: row.int("LayerRenderOffscrOffsetY"),
    })
}
