//! Name Studio desktop app: opens a CSP name sheet and shows it page by page.
//!
//! The document stays on the Rust side (in [`AppState`]); the front end gets
//! a [`sheet::SheetView`] once and asks for raster pixels as PNG when it
//! needs them.

pub mod sheet;

use std::sync::Mutex;

use clip_core::ClipDocument;
use tauri::ipc::Response;

#[derive(Default)]
struct AppState {
    document: Mutex<Option<ClipDocument>>,
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![open_sheet, layer_overview, layer_region])
        .run(tauri::generate_context!())
        .expect("error while running Name Studio");
}
