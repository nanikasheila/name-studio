//! Name Studio desktop app: opens a CSP name sheet, shows it page by page
//! and writes it out as page files and a CSP EX work; edits the name data
//! (.namestudio) made from a sheet or from scratch.
//!
//! The sheet stays on the Rust side (in [`AppState`]); the front end gets a
//! [`sheet::SheetView`] once and asks for raster pixels as PNG when it needs
//! them. The name data is edited in the front end and checked here when it
//! is saved.

pub mod sheet;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use clip_core::ClipDocument;
use clip_core::RgbaImage;
use clip_core::layout::ReadingOrder;
use clip_core::plan::Fit;
use clip_core::raster::decode_png;
use clip_core::raster::{Filter, resize};
use clip_core::text::NewText;
use clip_core::vector::NewVectorLine;
use clip_core::write::raster_page::{
    PageLayer, RasterLayer, RasterWorkWriter, TemplateCanvas, WorkOptions, WorkReport,
};
use clip_core::write::split::{DEFAULT_NAME_PATTERN, SplitOptions, SplitReport, split_sheet};
use name_model::{PageFormat, Project};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::ipc::Response;

#[derive(Default)]
struct AppState {
    document: Mutex<Option<ClipDocument>>,
    /// Pages of the name data being written for CSP, one call per page.
    name_export: Mutex<Option<RasterWorkWriter>>,
}

fn with_layer<T>(
    state: &AppState,
    layer_id: i64,
    action: impl FnOnce(&ClipDocument, &clip_core::ClipLayer) -> clip_core::Result<T>,
) -> Result<T, String> {
    let guard = state.document.lock().map_err(|_| "内部エラー（ロック）".to_owned())?;
    let document = guard.as_ref().ok_or("ファイルが開かれていません")?;
    let layer = document.find_layer(layer_id).map_err(|error| error.to_string())?;
    action(document, layer).map_err(|error| error.to_string())
}

/// Open a .clip name sheet; returns everything the viewer draws except pixels.
#[tauri::command]
async fn open_sheet(path: String, state: tauri::State<'_, AppState>) -> Result<sheet::SheetView, String> {
    let document = ClipDocument::read(&path).map_err(|error| error.to_string())?;
    let view = sheet::build_view(&document)?;
    *state.document.lock().map_err(|_| "内部エラー（ロック）".to_owned())? = Some(document);
    Ok(view)
}

/// A raster layer shrunk by `factor`, as PNG (empty when it stores no pixels).
#[tauri::command]
async fn layer_overview(layer_id: i64, factor: u32, state: tauri::State<'_, AppState>) -> Result<Response, String> {
    let image = with_layer(&state, layer_id, |document, layer| {
        document.render_layer_scaled(layer, factor)
    })?;
    let png = match image {
        Some(image) => image.to_png().map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    Ok(Response::new(png))
}

/// A raster layer's pixels inside a canvas box at full resolution, as PNG.
#[tauri::command]
async fn layer_region(layer_id: i64, region: [i64; 4], state: tauri::State<'_, AppState>) -> Result<Response, String> {
    let [x0, y0, x1, y1] = region;
    let image = with_layer(&state, layer_id, |document, layer| {
        document.layer_pixels_in_box(layer, (x0, y0, x1, y1))
    })?;
    Ok(Response::new(image.to_png().map_err(|error| error.to_string())?))
}

fn sheet_path(state: &AppState) -> Result<PathBuf, String> {
    let guard = state.document.lock().map_err(|_| "内部エラー（ロック）".to_owned())?;
    Ok(guard.as_ref().ok_or("ファイルが開かれていません")?.path.clone())
}

/// The only .cmc next to `sheet`, which is the work the sheet belongs to.
fn work_next_to(sheet: &Path) -> Option<PathBuf> {
    let folder = sheet.parent()?;
    let mut found: Vec<PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("cmc"))
        })
        .collect();
    found.sort();
    (found.len() == 1).then(|| found.remove(0))
}

/// Default settings for writing out the open sheet.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDefaults {
    work_template: Option<String>,
    work_name: String,
}

#[tauri::command]
async fn export_defaults(state: tauri::State<'_, AppState>) -> Result<ExportDefaults, String> {
    let sheet = sheet_path(&state)?;
    Ok(ExportDefaults {
        work_template: work_next_to(&sheet).map(|path| path.display().to_string()),
        work_name: sheet
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    template: String,
    out_dir: String,
    fit: Fit,
    /// Writes `<work_name>.cmc` from this template when both are given.
    work_template: Option<String>,
    work_name: Option<String>,
    story_index: Option<i64>,
}

/// Write the open sheet as one .clip per page (and a .cmc work).
#[tauri::command]
async fn export_pages(request: ExportRequest, state: tauri::State<'_, AppState>) -> Result<SplitReport, String> {
    let sheet = sheet_path(&state)?;
    let work = match (request.work_template, request.work_name) {
        (Some(template), Some(name)) if !name.trim().is_empty() => {
            Some((name.trim().to_owned(), PathBuf::from(template)))
        }
        _ => None,
    };
    let options = SplitOptions {
        sheet,
        template: request.template.into(),
        out_dir: request.out_dir.into(),
        pages: None,
        fit: request.fit,
        order: ReadingOrder::RightToLeft,
        first_page: 1,
        name_pattern: DEFAULT_NAME_PATTERN.to_owned(),
        work,
        story_index: request.story_index,
    };
    tauri::async_runtime::spawn_blocking(move || split_sheet(&options))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// The sheet at `path`, reading it unless it is the one already open.
fn ensure_sheet(state: &AppState, path: &str) -> Result<(), String> {
    let mut guard = state.document.lock().map_err(|_| "内部エラー（ロック）".to_owned())?;
    if guard.as_ref().is_some_and(|document| document.path == Path::new(path)) {
        return Ok(());
    }
    *guard = Some(ClipDocument::read(path).map_err(|error| format!("{path}: {error}"))?);
    Ok(())
}

#[derive(Serialize)]
struct ImportResult {
    project: Project,
    warnings: Vec<String>,
}

/// Make name data from a name sheet; the sheet stays open for its roughs.
#[tauri::command]
async fn import_project(path: String, state: tauri::State<'_, AppState>) -> Result<ImportResult, String> {
    ensure_sheet(&state, &path)?;
    let guard = state.document.lock().map_err(|_| "内部エラー（ロック）".to_owned())?;
    let document = guard.as_ref().ok_or("ファイルが開かれていません")?;
    let (project, warnings) =
        name_model::import::import_sheet(document, PageFormat::default()).map_err(|error| error.to_string())?;
    Ok(ImportResult { project, warnings })
}

#[tauri::command]
async fn load_project(path: String) -> Result<Project, String> {
    Project::load(&path).map_err(|error| error.to_string())
}

/// Check and save the name data; nothing is written when it has problems.
#[tauri::command]
async fn save_project(path: String, project: Project) -> Result<(), String> {
    project.save(&path).map_err(|error| error.to_string())
}

/// Part of a raster layer of the source sheet, at most `max_height` pixels high, as PNG.
#[tauri::command]
async fn rough_image(
    sheet: String,
    layer_id: i64,
    crop: [f64; 4],
    max_height: u32,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    ensure_sheet(&state, &sheet)?;
    let region = (
        crop[0].floor() as i64,
        crop[1].floor() as i64,
        crop[2].ceil() as i64,
        crop[3].ceil() as i64,
    );
    let image = with_layer(&state, layer_id, |document, layer| {
        document.layer_pixels_in_box(layer, region)
    })?;
    let image = if image.height > max_height.max(1) {
        let width = (image.width as f64 * max_height as f64 / image.height as f64)
            .round()
            .max(1.0) as u32;
        resize(&image, width, max_height, Filter::Box)
    } else {
        image
    };
    Ok(Response::new(image.to_png().map_err(|error| error.to_string())?))
}

// --- writing the name data out -----------------------------------------------

fn lock_error<T>(_: T) -> String {
    "内部エラー（ロック）".to_owned()
}

/// A request body of `[u32 little-endian JSON length][JSON][binary parts...]`:
/// large images travel as raw bytes, not as JSON number arrays.
fn split_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<(T, &[u8]), String> {
    let length = body
        .get(..4)
        .map(|bytes| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
        .ok_or("データが壊れています")?;
    let json = body.get(4..4 + length).ok_or("データが壊れています")?;
    let meta = serde_json::from_slice(json).map_err(|error| error.to_string())?;
    Ok((meta, &body[4 + length..]))
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(_) => Err("データの形式が違います".to_owned()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameExportRequest {
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
}

/// The template's canvas and which parts can be written as editable layers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NameExportStart {
    #[serde(flatten)]
    canvas: TemplateCanvas,
    vector_layers: bool,
    text_layers: bool,
}

/// Start writing the name data as CSP pages; returns the template's canvas.
#[tauri::command]
async fn begin_name_export(
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
    })
    .map_err(|error| error.to_string())?;
    let start = NameExportStart {
        canvas: writer.canvas,
        vector_layers: writer.donors.vector.is_some(),
        text_layers: writer.donors.text.is_some(),
    };
    *state.name_export.lock().map_err(lock_error)? = Some(writer);
    Ok(start)
}

/// A rough image of the source sheet and where it goes on the page (template px).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoughPlacement {
    layer_id: i64,
    sheet_crop: [f64; 4],
    target: [f64; 4],
}

/// A vector line in template px; `points` are `[x, y, width factor]`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineMeta {
    points: Vec<[f64; 3]>,
    closed: bool,
    width_px: f64,
}

/// One layer of a page, bottom first.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LayerMeta {
    /// A whole-page PNG of `length` bytes from the body (0 for a blank layer).
    Raster {
        name: String,
        length: usize,
    },
    Vector {
        name: String,
        lines: Vec<LineMeta>,
    },
    /// A text in a frame in template px, its size in CSP pt.
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        frame: [f64; 4],
        font_size_pt: f64,
        vertical: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageLayersMeta {
    layers: Vec<LayerMeta>,
    sheet: Option<String>,
    #[serde(default)]
    roughs: Vec<RoughPlacement>,
    /// Byte length of a PNG (after the layers' PNGs) of the lines and texts,
    /// drawn over the images for the page thumbnail; 0 for none.
    #[serde(default)]
    overlay_length: usize,
}

/// Rough images from the source sheet, placed on one transparent page image.
fn rough_layer(
    state: &AppState,
    sheet: &str,
    roughs: &[RoughPlacement],
    width: u32,
    height: u32,
) -> Result<RgbaImage, String> {
    ensure_sheet(state, sheet)?;
    let mut page = RgbaImage::transparent(width, height);
    for rough in roughs {
        let [x0, y0, x1, y1] = rough.sheet_crop;
        let region = (x0.floor() as i64, y0.floor() as i64, x1.ceil() as i64, y1.ceil() as i64);
        let pixels = with_layer(state, rough.layer_id, |document, layer| {
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

/// Write the next page from its layer images (raw body, see [`split_body`]).
#[tauri::command]
async fn export_name_page(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
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
            let (width, height) = (writer.canvas.width_px, writer.canvas.height_px);
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
                layers.push(match layer {
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
                    LayerMeta::Text {
                        text,
                        frame,
                        font_size_pt,
                        vertical,
                    } => PageLayer::Text(NewText {
                        text,
                        frame: frame.map(|value| value.round() as i32),
                        font_size_pt,
                        vertical,
                    }),
                });
            }
            let overlay = match take(meta.overlay_length)? {
                [] => None,
                png => Some(decode_png(png).map_err(|error| error.to_string())?),
            };
            writer
                .write_page(&layers, overlay.as_ref())
                .map(|path| path.display().to_string())
                .map_err(|error| error.to_string())
        })();
        *state.name_export.lock().map_err(lock_error)? = Some(writer);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Finish: write the work (.cmc) around the pages written so far.
#[tauri::command]
async fn finish_name_export(state: tauri::State<'_, AppState>) -> Result<WorkReport, String> {
    let writer = state
        .name_export
        .lock()
        .map_err(lock_error)?
        .take()
        .ok_or("書き出しが始まっていません")?;
    tauri::async_runtime::spawn_blocking(move || writer.finish().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn cancel_name_export(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.name_export.lock().map_err(lock_error)? = None;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfMeta {
    path: String,
    title: String,
    right_to_left: bool,
    pages: Vec<PdfPageMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfPageMeta {
    width_mm: f64,
    height_mm: f64,
    width_px: u32,
    height_px: u32,
    length: usize,
}

/// Write a PDF of page images (raw body: JSON, then the JPEGs in page order).
#[tauri::command]
async fn write_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (meta, mut rest) = split_body::<PdfMeta>(&body)?;
        let mut pages = Vec::new();
        for page in &meta.pages {
            let jpeg = rest.get(..page.length).ok_or("データが壊れています")?;
            rest = &rest[page.length..];
            pages.push(name_model::pdf::PdfImagePage {
                width_mm: page.width_mm,
                height_mm: page.height_mm,
                width_px: page.width_px,
                height_px: page.height_px,
                jpeg: jpeg.to_vec(),
            });
        }
        let pdf = name_model::pdf::image_pdf(&meta.title, &pages, meta.right_to_left);
        write_through_temporary(Path::new(&meta.path), &pdf)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write a text file (the script) as UTF-8 with a byte order mark, which
/// Windows' Notepad and Excel read as UTF-8.
#[tauri::command]
async fn write_text_file(path: String, text: String) -> Result<(), String> {
    let mut bytes = "\u{FEFF}".as_bytes().to_vec();
    bytes.extend_from_slice(text.replace('\n', "\r\n").as_bytes());
    write_through_temporary(Path::new(&path), &bytes)
}

fn write_through_temporary(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_sheet,
            layer_overview,
            layer_region,
            export_defaults,
            export_pages,
            import_project,
            load_project,
            save_project,
            rough_image,
            begin_name_export,
            export_name_page,
            finish_name_export,
            cancel_name_export,
            write_pdf,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Name Studio");
}
