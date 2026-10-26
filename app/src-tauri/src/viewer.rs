//! The name sheet open on the Rust side: its layers as PNG, splitting it into
//! page files, and name data made from it.

use std::path::{Path, PathBuf};

use clip_core::ClipDocument;
use clip_core::layout::ReadingOrder;
use clip_core::plan::Fit;
use clip_core::raster::{Filter, resize};
use clip_core::write::split::{DEFAULT_NAME_PATTERN, SplitOptions, SplitReport, split_sheet};
use clip_core::write::verify;
use name_model::{PageFormat, Project};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;

use crate::AppState;
use crate::ipc::lock_error;
use crate::sheet;

/// Open a .clip name sheet; returns everything the viewer draws except pixels.
#[tauri::command]
pub(crate) async fn open_sheet(path: String, state: tauri::State<'_, AppState>) -> Result<sheet::SheetView, String> {
    let document = ClipDocument::read(&path).map_err(|error| error.to_string())?;
    let view = sheet::build_view(&document)?;
    *state.document.lock().map_err(lock_error)? = Some(document);
    Ok(view)
}

/// A raster layer shrunk by `factor`, as PNG (empty when it stores no pixels).
#[tauri::command]
pub(crate) async fn layer_overview(
    layer_id: i64,
    factor: u32,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    let image = state.with_layer(layer_id, |document, layer| document.render_layer_scaled(layer, factor))?;
    let png = match image {
        Some(image) => image.to_png().map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    Ok(Response::new(png))
}

/// A raster layer's pixels inside a canvas box at full resolution, as PNG.
#[tauri::command]
pub(crate) async fn layer_region(
    layer_id: i64,
    region: [i64; 4],
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    let [x0, y0, x1, y1] = region;
    let image = state.with_layer(layer_id, |document, layer| {
        document.layer_pixels_in_box(layer, (x0, y0, x1, y1))
    })?;
    Ok(Response::new(image.to_png().map_err(|error| error.to_string())?))
}

fn sheet_path(state: &AppState) -> Result<PathBuf, String> {
    let guard = state.document.lock().map_err(lock_error)?;
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
pub(crate) struct ExportDefaults {
    work_template: Option<String>,
    work_name: String,
}

#[tauri::command]
pub(crate) async fn export_defaults(state: tauri::State<'_, AppState>) -> Result<ExportDefaults, String> {
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
pub(crate) struct ExportRequest {
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
pub(crate) async fn export_pages(
    request: ExportRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SplitReport, String> {
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

#[derive(Serialize)]
pub(crate) struct ImportResult {
    project: Project,
    warnings: Vec<String>,
}

/// Make name data from a name sheet; the sheet stays open for its roughs.
#[tauri::command]
pub(crate) async fn import_project(path: String, state: tauri::State<'_, AppState>) -> Result<ImportResult, String> {
    state.ensure_sheet(&path)?;
    let guard = state.document.lock().map_err(lock_error)?;
    let document = guard.as_ref().ok_or("ファイルが開かれていません")?;
    let (project, warnings) =
        clip_core::import::import_sheet(document, PageFormat::default()).map_err(|error| error.to_string())?;
    Ok(ImportResult { project, warnings })
}

/// Part of a raster layer of the source sheet, at most `max_height` pixels high, as PNG.
#[tauri::command]
pub(crate) async fn rough_image(
    sheet: String,
    layer_id: i64,
    crop: [f64; 4],
    max_height: u32,
    state: tauri::State<'_, AppState>,
) -> Result<Response, String> {
    state.ensure_sheet(&sheet)?;
    let region = (
        crop[0].floor() as i64,
        crop[1].floor() as i64,
        crop[2].ceil() as i64,
        crop[3].ceil() as i64,
    );
    let image = state.with_layer(layer_id, |document, layer| document.layer_pixels_in_box(layer, region))?;
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
