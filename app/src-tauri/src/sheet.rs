//! What the viewer needs from a name sheet, in canvas pixels.
//!
//! Everything is converted to canvas coordinates here (layer offsets
//! applied), so the front end only has to draw. Raster pixels are sent
//! separately as PNG because they are large.

use clip_core::layout::{PageCell, ReadingOrder, detect_document_cells};
use clip_core::{ClipDocument, ClipLayer, LayerKind};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetView {
    pub path: String,
    pub file_name: String,
    pub canvas: CanvasView,
    pub cells: Vec<PageCell>,
    /// Layers in drawing order (bottom to top), folders included.
    pub layers: Vec<LayerView>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasView {
    pub width_px: i64,
    pub height_px: i64,
    pub resolution: f64,
    pub is_double_page: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerView {
    pub id: i64,
    pub parent: Option<i64>,
    pub depth: usize,
    pub name: String,
    pub kind: &'static str,
    pub visible: bool,
    pub opacity: f64,
    pub has_pixels: bool,
    /// Canvas position of the stored pixels' top-left corner.
    pub pixel_origin: [i64; 2],
    /// Size of the stored pixels (offscreen), when there are any.
    pub pixel_size: Option<[u32; 2]>,
    pub vectors: Vec<VectorView>,
    pub texts: Vec<TextView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorView {
    pub points: Vec<[f64; 2]>,
    pub closed: bool,
    pub brush_size: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextView {
    pub text: String,
    /// Canvas box of the text block. For blocks inside balloons the stored
    /// box is relative to the balloon, so it is re-centred on the balloon.
    pub bbox: Option<[f64; 4]>,
    pub font_size_px: f64,
    pub font_name: Option<String>,
    pub vertical: bool,
    pub in_balloon: bool,
}

pub fn build_view(document: &ClipDocument) -> Result<SheetView, String> {
    let mut warnings = Vec::new();
    let cells = detect_document_cells(document, ReadingOrder::RightToLeft).map_err(|error| error.to_string())?;
    if cells.is_empty() {
        warnings.push("ページ枠（繰り返し現れる四角形）が見つかりませんでした".to_owned());
    }
    let mut layers = Vec::new();
    for layer in &document.root.children {
        collect(document, layer, None, 0, &mut layers, &mut warnings)?;
    }
    let canvas = &document.canvas;
    Ok(SheetView {
        path: document.path.display().to_string(),
        file_name: document
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        canvas: CanvasView {
            width_px: canvas.width_px,
            height_px: canvas.height_px,
            resolution: canvas.resolution,
            is_double_page: canvas.is_double_page,
        },
        cells,
        layers,
        warnings,
    })
}

fn collect(
    document: &ClipDocument,
    layer: &ClipLayer,
    parent: Option<i64>,
    depth: usize,
    result: &mut Vec<LayerView>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let error = |error: clip_core::CspError| format!("{}: {error}", layer.name);
    let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
    let vectors: Vec<VectorView> = document
        .vector_objects(layer)
        .map_err(error)?
        .into_iter()
        .map(|object| VectorView {
            points: object.points.iter().map(|(x, y)| [x + dx, y + dy]).collect(),
            closed: object.closed(),
            brush_size: object.brush_size,
        })
        .collect();
    let texts = texts_of(document, layer, &vectors, warnings).map_err(error)?;
    let parameters = if layer.kind.is_folder() {
        None
    } else {
        document.layer_pixel_parameters(layer).map_err(error)?
    };
    result.push(LayerView {
        id: layer.main_id,
        parent,
        depth,
        name: layer.name.clone(),
        kind: layer.kind.as_str(),
        visible: layer.visible,
        opacity: layer.opacity,
        has_pixels: parameters.is_some() && layer.kind == LayerKind::Raster,
        pixel_origin: [layer.pixel_origin().0, layer.pixel_origin().1],
        pixel_size: parameters.map(|parameters| [parameters.width, parameters.height]),
        vectors,
        texts,
    });
    for child in &layer.children {
        collect(document, child, Some(layer.main_id), depth + 1, result, warnings)?;
    }
    Ok(())
}

fn texts_of(
    document: &ClipDocument,
    layer: &ClipLayer,
    balloons: &[VectorView],
    warnings: &mut Vec<String>,
) -> clip_core::Result<Vec<TextView>> {
    let blocks = document.text_blocks(layer)?;
    if blocks.is_empty() {
        return Ok(Vec::new());
    }
    let strings = document.text_strings(layer);
    let in_balloon = layer.kind == LayerKind::Text && !balloons.is_empty();
    if in_balloon && balloons.len() != blocks.len() {
        warnings.push(format!(
            "「{}」: フキダシと文字の数が合わないため、位置はおおよそです",
            layer.name
        ));
    }
    let resolution = document.canvas.resolution;
    let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
    Ok(blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let bbox = block.bbox.map(|(x0, y0, x1, y1)| {
                let (x0, y0, x1, y1) = (x0 as f64, y0 as f64, x1 as f64, y1 as f64);
                if in_balloon {
                    // Which balloon a block belongs to is not decoded yet
                    // (docs/formats/csp-file-format.md); pair them in order.
                    let balloon = &balloons[index.min(balloons.len() - 1)];
                    let (cx, cy) = center(&balloon.points);
                    let (w, h) = (x1 - x0, y1 - y0);
                    [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]
                } else {
                    [x0 + dx, y0 + dy, x1 + dx, y1 + dy]
                }
            });
            TextView {
                text: strings.get(index).cloned().unwrap_or_default(),
                vertical: bbox.is_none_or(|b| b[3] - b[1] >= b[2] - b[0]),
                bbox,
                font_size_px: block.font_size_pt.unwrap_or(10.0) * resolution / 72.0,
                font_name: block.font_name.clone(),
                in_balloon,
            }
        })
        .collect())
}

fn center(points: &[[f64; 2]]) -> (f64, f64) {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for [x, y] in points {
        x0 = x0.min(*x);
        y0 = y0.min(*y);
        x1 = x1.max(*x);
        y1 = y1.max(*y);
    }
    ((x0 + x1) / 2.0, (y0 + y1) / 2.0)
}
