//! Name Studio desktop app: opens a CSP name sheet, shows it page by page
//! and writes it out as page files and a CSP EX work; edits the name data
//! (.namestudio) made from a sheet or from scratch.
//!
//! The sheet stays on the Rust side (in [`AppState`]); the front end gets a
//! [`sheet::SheetView`] once and asks for raster pixels as PNG when it needs
//! them. The name data is edited in the front end and checked here when it
//! is saved.

pub mod batch;
pub mod errorlog;
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
use clip_core::vector::{NewFrame, NewVectorLine};
use clip_core::write::raster_page::{
    PageLayer, RasterLayer, RasterWorkWriter, TemplateCanvas, WorkOptions, WorkReport,
};
use clip_core::write::split::{DEFAULT_NAME_PATTERN, SplitOptions, SplitReport, split_sheet};
use clip_core::write::spread::SpreadLayout;
use clip_core::write::verify::{self, ExpectedLayer, FileCheck};
use clip_core::write::{manifest, update};
use name_model::versions::{self, Recovery, VersionInfo, VersionKind, VersionStore};
use name_model::{PageFormat, Project};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Manager;
use tauri::ipc::Response;

struct AppState {
    document: Mutex<Option<ClipDocument>>,
    /// Pages of the name data being written for CSP, one call per page.
    name_export: Mutex<Option<RasterWorkWriter>>,
    /// A command-line export to run instead of the usual start (see [`batch`]).
    batch: Result<Option<batch::BatchExport>, String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            document: Mutex::default(),
            name_export: Mutex::default(),
            batch: batch::from_args(std::env::args()),
        }
    }
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = split_sheet(&options).map_err(|error| error.to_string())?;
        // 自己確認: read every page (and the work) back.
        for page in &mut report.pages {
            page.warnings.extend(
                verify::check_clip(&page.path)
                    .problems
                    .into_iter()
                    .map(|p| format!("自己確認: {p}")),
            );
        }
        if let Some(work) = &report.work {
            let pages: Vec<PathBuf> = report.pages.iter().map(|page| page.path.clone()).collect();
            report.warnings.extend(
                verify::verify_work(work, Some(&pages))
                    .problems
                    .into_iter()
                    .map(|problem| format!("自己確認（作品）: {problem}")),
            );
        }
        Ok(report)
    })
    .await
    .map_err(|error| error.to_string())?
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

/// The project file's text, checked; fields only the app knows stay as they are.
#[tauri::command]
async fn load_project(path: String) -> Result<Box<RawValue>, String> {
    blocking(move || Project::load_text(&path).and_then(raw_project)).await
}

fn raw_project(text: String) -> Result<Box<RawValue>, name_model::ProjectError> {
    RawValue::from_string(text).map_err(name_model::ProjectError::Json)
}

// --- saving, autosave and versions ---------------------------------------------

/// Autosave versions are kept at most this often (saves and restores aside).
const AUTO_VERSION_INTERVAL_MS: u64 = 5 * 60 * 1000;

/// Where versions and autosave copies are kept (`%LOCALAPPDATA%\<app id>`).
fn data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map_err(|error| error.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, name_model::ProjectError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// A request whose body is the project as the app wrote it (see [`split_body`]):
/// the text is saved as it is, so it travels as bytes rather than as an
/// argument to parse and write again.
fn project_body<T: serde::de::DeserializeOwned>(request: &tauri::ipc::Request<'_>) -> Result<(T, String), String> {
    split_project_body(&raw_body(request)?)
}

fn split_project_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<(T, String), String> {
    let (meta, rest) = split_body::<T>(body)?;
    let text = String::from_utf8(rest.to_vec()).map_err(|error| error.to_string())?;
    Ok((meta, text))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMeta {
    path: String,
    /// Where the project was saved before (none when it never was, whose
    /// history then moves to `path`).
    previous_path: Option<String>,
}

/// Check and save the name data; nothing is written when it has problems.
/// The saved state is kept as a version, and the autosave copy is dropped.
#[tauri::command]
async fn save_project(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<VersionInfo>, String> {
    let (meta, text) = project_body::<SaveMeta>(&request)?;
    let root = data_root(&app)?;
    blocking(move || {
        let project = Project::save_text(&meta.path, &text)?;
        let path = Path::new(&meta.path);
        let previous = meta.previous_path.as_deref().map(Path::new);
        let store = if previous.is_none() {
            VersionStore::adopt(&root, None, path)?
        } else {
            VersionStore::open(&root, Some(path))
        };
        versions::clear_recovery(&root, Some(path))?;
        versions::clear_recovery(&root, previous)?;
        store.record_text(&text, &project, VersionKind::Saved, now_ms())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveMeta {
    path: Option<String>,
    to_file: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveResult {
    /// The project file itself was written (otherwise only the autosave copy).
    saved_to_file: bool,
    version: Option<VersionInfo>,
    /// What the check found wrong: the copy was kept anyway, the file was not written.
    problems: Vec<String>,
}

/// Autosave: write the project file when it has one and `to_file` is on,
/// otherwise a copy that is offered back after a crash; keep a version now
/// and then. A project the check finds problems with still gets its copy
/// (with the problems noted), so work is never left unkept.
#[tauri::command]
async fn autosave_project(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<AutosaveResult, String> {
    let (meta, text) = project_body::<AutosaveMeta>(&request)?;
    let root = data_root(&app)?;
    blocking(move || {
        let path = meta.path.as_deref().map(Path::new);
        let time = now_ms();
        if let Some(file) = path.filter(|_| meta.to_file) {
            match Project::save_text(file, &text) {
                Ok(project) => {
                    versions::clear_recovery(&root, Some(file))?;
                    let version = VersionStore::open(&root, path).record_auto_text(
                        &text,
                        &project,
                        time,
                        AUTO_VERSION_INTERVAL_MS,
                    )?;
                    return Ok(AutosaveResult {
                        saved_to_file: true,
                        version,
                        problems: Vec::new(),
                    });
                }
                Err(name_model::ProjectError::Invalid(_)) => {}
                Err(error) => return Err(error),
            }
        }
        let problems = versions::write_recovery_text(&root, path, &text, time)?;
        let version = if problems.is_empty() {
            let project = Project::from_json(&text)?;
            VersionStore::open(&root, path).record_auto_text(&text, &project, time, AUTO_VERSION_INTERVAL_MS)?
        } else {
            None
        };
        Ok(AutosaveResult {
            saved_to_file: false,
            version,
            problems,
        })
    })
    .await
}

/// Note an error the front end met (see [`errorlog`]).
#[tauri::command]
fn log_error(message: String) {
    errorlog::append(&message);
}

/// Versions of the project at `path` (or of the unsaved one), newest first.
#[tauri::command]
async fn list_versions(app: tauri::AppHandle, path: Option<String>) -> Result<Vec<VersionInfo>, String> {
    let root = data_root(&app)?;
    blocking(move || VersionStore::open(&root, path.as_deref().map(Path::new)).list()).await
}

#[tauri::command]
async fn load_version(app: tauri::AppHandle, path: Option<String>, id: String) -> Result<Box<RawValue>, String> {
    let root = data_root(&app)?;
    blocking(move || {
        VersionStore::open(&root, path.as_deref().map(Path::new))
            .load_text(&id)
            .and_then(raw_project)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordMeta {
    path: Option<String>,
    kind: VersionKind,
}

/// Keep the current state as a version (before an older one replaces it).
#[tauri::command]
async fn record_version(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<VersionInfo>, String> {
    let (meta, text) = project_body::<RecordMeta>(&request)?;
    let root = data_root(&app)?;
    blocking(move || {
        let project = Project::from_json(&text)?;
        VersionStore::open(&root, meta.path.as_deref().map(Path::new)).record_text(&text, &project, meta.kind, now_ms())
    })
    .await
}

/// Projects autosave kept that were never saved, newest first.
#[tauri::command]
async fn pending_recoveries(app: tauri::AppHandle) -> Result<Vec<Recovery>, String> {
    let root = data_root(&app)?;
    Ok(versions::recoveries(&root))
}

#[tauri::command]
async fn discard_recovery(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let root = data_root(&app)?;
    versions::clear_recovery(&root, path.as_deref().map(Path::new)).map_err(|error| error.to_string())
}

/// Where CSP keeps its tools and materials on this computer, when found.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CspToolLocations {
    tools: Option<String>,
    materials: Option<String>,
}

#[tauri::command]
async fn csp_tool_locations() -> CspToolLocations {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return CspToolLocations {
            tools: None,
            materials: None,
        };
    };
    let (tools, materials) = clip_core::subtool::default_locations(Path::new(&appdata));
    CspToolLocations {
        tools: tools.is_file().then(|| tools.display().to_string()),
        materials: materials.is_dir().then(|| materials.display().to_string()),
    }
}

/// Pens and erasers of a .sut or of CSP's tool database (read from a copy).
#[tauri::command]
async fn read_csp_sub_tools(
    path: String,
    materials: Option<String>,
) -> Result<Vec<clip_core::subtool::SubTool>, String> {
    clip_core::subtool::read_sub_tools(&path, materials.as_deref().map(Path::new)).map_err(|error| error.to_string())
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
struct NameExportStart {
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

/// One panel of a コマ枠フォルダー in template px.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameMeta {
    points: Vec<[f64; 2]>,
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
        } => PageLayer::Text(NewText {
            text,
            frame: frame.map(|value| value.round() as i32),
            font_size_pt,
            vertical,
            color,
        }),
    })
}

/// Write the next page from its layer images (raw body, see [`split_body`]),
/// then read it back to check it holds what was sent.
#[tauri::command]
async fn export_name_page(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<FileCheck, String> {
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
struct DialogueMeta {
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
async fn update_name_dialogue(
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
struct CspPageDialogue {
    path: PathBuf,
    /// None when the page's file is not there.
    dialogue: Option<update::CspDialogue>,
}

/// Read the dialogue of the next page the export wrote (a 見開き page when
/// `spread`), to take what was changed in CSP back into the name.
#[tauri::command]
async fn read_name_dialogue(app: tauri::AppHandle, spread: bool) -> Result<CspPageDialogue, String> {
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
async fn adopt_name_dialogue(paths: Vec<PathBuf>) -> Result<(), String> {
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
struct NameExportReport {
    #[serde(flatten)]
    report: WorkReport,
    /// The work read back (none without a work).
    work_check: Option<FileCheck>,
}

/// Finish: write the work (.cmc) around the pages written so far, and check it.
#[tauri::command]
async fn finish_name_export(state: tauri::State<'_, AppState>) -> Result<NameExportReport, String> {
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
async fn check_export_target(out_dir: String) -> manifest::OverwriteCheck {
    manifest::check_overwrite(Path::new(&out_dir))
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

/// Whether this build came from the release workflow. Only those update
/// themselves; a build made on the PC to try a change is left as it is.
#[tauri::command]
fn is_release_build() -> bool {
    option_env!("NAME_STUDIO_RELEASE").is_some()
}

/// The command-line export to run, if the app was started for one.
#[tauri::command]
fn batch_export_task(state: tauri::State<'_, AppState>) -> Result<Option<batch::BatchExport>, String> {
    state.batch.clone()
}

/// End a command-line export: close the app with this exit code.
#[tauri::command]
fn end_batch_export(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(|app| {
            if let Ok(root) = app.path().app_local_data_dir() {
                errorlog::init(&root, app.package_info().version.to_string());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_error,
            open_sheet,
            layer_overview,
            layer_region,
            export_defaults,
            export_pages,
            import_project,
            load_project,
            save_project,
            autosave_project,
            list_versions,
            load_version,
            record_version,
            pending_recoveries,
            discard_recovery,
            rough_image,
            begin_name_export,
            export_name_page,
            update_name_dialogue,
            read_name_dialogue,
            adopt_name_dialogue,
            finish_name_export,
            cancel_name_export,
            check_export_target,
            write_pdf,
            write_text_file,
            csp_tool_locations,
            is_release_build,
            read_csp_sub_tools,
            batch_export_task,
            end_batch_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Name Studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_body_is_meta_then_text() {
        let meta = br#"{"path":"a.namestudio","toFile":true}"#;
        let text = "{\"title\":\"第4話\"}";
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta);
        body.extend_from_slice(text.as_bytes());
        let (parsed, rest) = split_project_body::<AutosaveMeta>(&body).unwrap();
        assert_eq!(parsed.path.as_deref(), Some("a.namestudio"));
        assert!(parsed.to_file);
        assert_eq!(rest, text);
        assert!(split_project_body::<AutosaveMeta>(&body[..3]).is_err());
    }
}
