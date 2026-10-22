//! Build a project from a CSP name sheet (.clip).
//!
//! Each page cell of the sheet becomes a page. Like the Python split, the
//! cell's inner frame is mapped onto the page's basic frame (基本枠), centred
//! and scaled uniformly; cells without an inner frame fit the whole canvas.
//! - rectangles drawn inside a page (not part of the template) become panels;
//! - other vector objects become rough strokes;
//! - text blocks become lines (balloon outlines kept when there are some);
//! - raster layers are referenced as rough images (pixels stay in the sheet).

use clip_core::layout::{
    PageCell, ReadingOrder, Rect, as_rectangle, detect_page_cells, find_rectangles, template_rectangles,
};
use clip_core::{ClipDocument, ClipLayer, LayerKind, Result};

use crate::model::{BoxMm, Line, LineKind, Page, PageFormat, Panel, Project, RoughImage, SourceSheet, Stroke};

const MM_PER_INCH: f64 = 25.4;
const EDGE_TOLERANCE_PX: f64 = 3.0;

/// Sheet pixels → page millimetres: `mm = px * scale + d`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SheetToPage {
    pub scale: f64,
    pub dx: f64,
    pub dy: f64,
}

impl SheetToPage {
    pub fn point(&self, x: f64, y: f64) -> [f64; 2] {
        [x * self.scale + self.dx, y * self.scale + self.dy]
    }

    pub fn box_(&self, b: [f64; 4]) -> BoxMm {
        [
            b[0] * self.scale + self.dx,
            b[1] * self.scale + self.dy,
            b[2] * self.scale + self.dx,
            b[3] * self.scale + self.dy,
        ]
    }

    /// Uniformly scale `source` (px) onto `target` (mm), centred.
    pub fn fit(source: &Rect, target: BoxMm) -> Self {
        let (tw, th) = (target[2] - target[0], target[3] - target[1]);
        let scale = (tw / source.width()).min(th / source.height());
        let (sx, sy) = source.center();
        let (tx, ty) = ((target[0] + target[2]) / 2.0, (target[1] + target[3]) / 2.0);
        SheetToPage {
            scale,
            dx: tx - sx * scale,
            dy: ty - sy * scale,
        }
    }
}

/// The transform used for one page cell.
pub fn cell_transform(cell: &PageCell, format: &PageFormat) -> SheetToPage {
    match &cell.frame {
        Some(frame) => SheetToPage::fit(frame, format.basic_box()),
        None => SheetToPage::fit(&cell.rect, [0.0, 0.0, format.canvas_mm[0], format.canvas_mm[1]]),
    }
}

/// Import a name sheet into a new project.
pub fn import_sheet(document: &ClipDocument, format: PageFormat) -> Result<(Project, Vec<String>)> {
    let title = document
        .path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut project = Project::new(&title);
    project.page_format = format;
    let mut warnings = Vec::new();
    let rects = find_rectangles(document)?;
    let template = template_rectangles(&rects);
    let cells = detect_page_cells(
        &rects,
        document.canvas.width_px as f64,
        document.canvas.is_double_page,
        ReadingOrder::RightToLeft,
    );
    if cells.is_empty() {
        warnings.push("ページ枠（繰り返し現れる四角形）が見つかりませんでした".to_owned());
    }
    let transforms: Vec<SheetToPage> = cells.iter().map(|cell| cell_transform(cell, &format)).collect();
    for _ in &cells {
        let id = project.new_id("page");
        project.pages.push(Page { id, ..Page::default() });
    }
    let font_scale = |t: &SheetToPage| t.scale * document.canvas.resolution / MM_PER_INCH;
    let mut layers = Vec::new();
    leaf_layers(&document.root.children, true, &mut layers);
    // Panels first, so lines can refer to them.
    for layer in layers.iter().filter(|layer| layer.kind == LayerKind::Vector) {
        for object in document.vector_objects(layer)? {
            let Some(rect) = as_rectangle(&object).map(|r| shifted(&r, layer)) else {
                continue;
            };
            if template.iter().any(|t| near(t, &rect)) {
                continue;
            }
            let (cx, cy) = rect.center();
            if let Some(index) = cell_holding(&cells, cx, cy) {
                let t = transforms[index];
                let id = project.new_id("panel");
                let shape = vec![
                    t.point(rect.x0, rect.y0),
                    t.point(rect.x1, rect.y0),
                    t.point(rect.x1, rect.y1),
                    t.point(rect.x0, rect.y1),
                ];
                project.pages[index].panels.push(Panel { id, shape, order: 0 });
            }
        }
    }
    for page in &mut project.pages {
        order_panels(&mut page.panels);
    }
    for layer in &layers {
        match layer.kind {
            LayerKind::Vector => import_strokes(document, layer, &cells, &transforms, &mut project)?,
            LayerKind::Text => import_lines(
                document,
                layer,
                &cells,
                &transforms,
                font_scale,
                &mut project,
                &mut warnings,
            )?,
            LayerKind::Raster => {
                let boxes = document.occupied_pixel_boxes(layer)?;
                for (index, cell) in cells.iter().enumerate() {
                    let r = &cell.rect;
                    let touched = boxes.iter().any(|b| {
                        (b.0 as f64) < r.x1 && (b.2 as f64) > r.x0 && (b.1 as f64) < r.y1 && (b.3 as f64) > r.y0
                    });
                    if touched {
                        let crop = [r.x0, r.y0, r.x1, r.y1];
                        let id = project.new_id("rough");
                        project.pages[index].roughs.push(RoughImage {
                            id,
                            layer_id: layer.main_id,
                            layer_name: layer.name.clone(),
                            sheet_crop: crop,
                            box_mm: transforms[index].box_(crop),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    project.source = Some(SourceSheet {
        path: document.path.display().to_string(),
        resolution: document.canvas.resolution,
        cells: cells
            .iter()
            .map(|cell| [cell.rect.x0, cell.rect.y0, cell.rect.x1, cell.rect.y1])
            .collect(),
    });
    Ok((project, warnings))
}

/// Visible leaf layers, skipping the paper and the story information.
fn leaf_layers<'a>(layers: &'a [ClipLayer], visible: bool, result: &mut Vec<&'a ClipLayer>) {
    for layer in layers {
        if matches!(layer.kind, LayerKind::Paper | LayerKind::StoryInfo) {
            continue;
        }
        if layer.kind.is_folder() {
            leaf_layers(&layer.children, visible && layer.visible, result);
        } else if visible && layer.visible {
            result.push(layer);
        }
    }
}

fn shifted(rect: &Rect, layer: &ClipLayer) -> Rect {
    let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
    Rect::new(rect.x0 + dx, rect.y0 + dy, rect.x1 + dx, rect.y1 + dy)
}

fn near(a: &Rect, b: &Rect) -> bool {
    [(a.x0, b.x0), (a.y0, b.y0), (a.x1, b.x1), (a.y1, b.y1)]
        .iter()
        .all(|(p, q)| (p - q).abs() <= EDGE_TOLERANCE_PX)
}

fn cell_holding(cells: &[PageCell], x: f64, y: f64) -> Option<usize> {
    cells
        .iter()
        .position(|cell| cell.rect.x0 <= x && x < cell.rect.x1 && cell.rect.y0 <= y && y < cell.rect.y1)
}

/// Reading order of panels in a right-bound book: rows top to bottom (a
/// panel starts a new row when its top is below the current row's middle),
/// right to left inside a row.
fn order_panels(panels: &mut [Panel]) {
    let bounds = |panel: &Panel| {
        let xs = panel.shape.iter().map(|p| p[0]);
        let ys = panel.shape.iter().map(|p| p[1]);
        (
            xs.clone().fold(f64::MAX, f64::min),
            ys.clone().fold(f64::MAX, f64::min),
            xs.fold(f64::MIN, f64::max),
            ys.fold(f64::MIN, f64::max),
        )
    };
    panels.sort_by(|a, b| bounds(a).1.total_cmp(&bounds(b).1));
    let mut row_of = Vec::with_capacity(panels.len());
    let mut row = 0;
    let mut row_middle = f64::MIN;
    for panel in panels.iter() {
        let (_, y0, _, y1) = bounds(panel);
        if !row_of.is_empty() && y0 >= row_middle {
            row += 1;
        }
        if row_of.is_empty() || y0 >= row_middle {
            row_middle = (y0 + y1) / 2.0;
        }
        row_of.push(row);
    }
    let mut keyed: Vec<(usize, f64, Panel)> = panels
        .iter()
        .zip(row_of)
        .map(|(panel, row)| (row, -bounds(panel).2, panel.clone()))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    for (index, (_, _, mut panel)) in keyed.into_iter().enumerate() {
        panel.order = index as u32 + 1;
        panels[index] = panel;
    }
}

fn import_strokes(
    document: &ClipDocument,
    layer: &ClipLayer,
    cells: &[PageCell],
    transforms: &[SheetToPage],
    project: &mut Project,
) -> Result<()> {
    let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
    for object in document.vector_objects(layer)? {
        if as_rectangle(&object).is_some() {
            // Template frames are skipped; other rectangles became panels.
            continue;
        }
        let (b0, b1, b2, b3) = object.bbox;
        let (cx, cy) = ((b0 + b2) as f64 / 2.0 + dx, (b1 + b3) as f64 / 2.0 + dy);
        let Some(index) = cell_holding(cells, cx, cy) else {
            continue;
        };
        let t = transforms[index];
        let id = project.new_id("stroke");
        let points = object.points.iter().map(|(x, y)| {
            let [px, py] = t.point(x + dx, y + dy);
            [px, py, 1.0]
        });
        project.pages[index].strokes.push(Stroke {
            id,
            points: points.collect(),
            width_mm: object.brush_size * t.scale,
            closed: object.closed(),
            brush: None,
            cut: None,
        });
    }
    Ok(())
}

fn panel_holding(page: &Page, point: [f64; 2]) -> Option<String> {
    page.panels
        .iter()
        .find(|panel| {
            let xs = panel.shape.iter().map(|p| p[0]);
            let ys = panel.shape.iter().map(|p| p[1]);
            let (x0, x1) = (xs.clone().fold(f64::MAX, f64::min), xs.fold(f64::MIN, f64::max));
            let (y0, y1) = (ys.clone().fold(f64::MAX, f64::min), ys.fold(f64::MIN, f64::max));
            x0 <= point[0] && point[0] <= x1 && y0 <= point[1] && point[1] <= y1
        })
        .map(|panel| panel.id.clone())
}

fn import_lines(
    document: &ClipDocument,
    layer: &ClipLayer,
    cells: &[PageCell],
    transforms: &[SheetToPage],
    font_scale: impl Fn(&SheetToPage) -> f64,
    project: &mut Project,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let blocks = document.text_blocks(layer)?;
    let strings = document.text_strings(layer);
    let balloons: Vec<_> = document.vector_objects(layer)?;
    let (dx, dy) = (layer.offset_x as f64, layer.offset_y as f64);
    if !balloons.is_empty() && balloons.len() != blocks.len() {
        warnings.push(format!(
            "「{}」: フキダシと文字の数が合わないため、セリフとフキダシの対応はおおよそです",
            layer.name
        ));
    }
    for (index, block) in blocks.iter().enumerate() {
        let Some((x0, y0, x1, y1)) = block.bbox else { continue };
        let (w, h) = ((x1 - x0) as f64, (y1 - y0) as f64);
        // Blocks inside balloons store a box relative to the balloon (see the
        // format notes), so they are centred on the balloon paired by order.
        let balloon = balloons
            .get(index.min(balloons.len().saturating_sub(1)))
            .filter(|_| !balloons.is_empty());
        let sheet_box = match balloon {
            Some(object) => {
                let (b0, b1, b2, b3) = object.bbox;
                let (cx, cy) = ((b0 + b2) as f64 / 2.0 + dx, (b1 + b3) as f64 / 2.0 + dy);
                [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]
            }
            None => [x0 as f64 + dx, y0 as f64 + dy, x1 as f64 + dx, y1 as f64 + dy],
        };
        let (cx, cy) = ((sheet_box[0] + sheet_box[2]) / 2.0, (sheet_box[1] + sheet_box[3]) / 2.0);
        let Some(page_index) = cell_holding(cells, cx, cy) else {
            continue;
        };
        let t = transforms[page_index];
        let box_mm = t.box_(sheet_box);
        let id = project.new_id("line");
        let page = &project.pages[page_index];
        let panel = panel_holding(page, [(box_mm[0] + box_mm[2]) / 2.0, (box_mm[1] + box_mm[3]) / 2.0]);
        let line = Line {
            id,
            text: strings.get(index).cloned().unwrap_or_default(),
            kind: LineKind::Speech,
            speaker: None,
            panel,
            box_mm,
            font_size_pt: block.font_size_pt.unwrap_or(10.0) * font_scale(&t),
            vertical: h >= w,
            balloon: balloon.map(|object| object.points.iter().map(|(x, y)| t.point(x + dx, y + dy)).collect()),
        };
        project.pages[page_index].lines.push(line);
    }
    Ok(())
}
