//! Name Studio desktop app: opens a CSP name sheet, shows it page by page
//! and writes it out as page files and a CSP EX work; edits the name data
//! (.namestudio) made from a sheet or from scratch.
//!
//! The sheet stays on the Rust side (in [`AppState`]); the front end gets a
//! [`sheet::SheetView`] once and asks for raster pixels as PNG when it needs
//! them. The name data is edited in the front end and checked here when it
//! is saved.
//!
//! Commands by what they are for: [`viewer`] (the open sheet), [`project_io`]
//! (loading, saving, autosave and versions), [`name_export`] (CSP pages and
//! works), [`files`] (CSP's tools, PDF and script), [`fonts`] (the fonts on
//! the computer); [`ipc`] reads the raw
//! request bodies they share.

pub mod batch;
pub mod errorlog;
mod files;
mod fonts;
mod ipc;
mod name_export;
mod project_io;
pub mod sheet;
mod updates;
mod viewer;

use std::path::Path;
use std::sync::Mutex;

use clip_core::ClipDocument;
use clip_core::write::raster_page::RasterWorkWriter;
use tauri::Manager;

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

impl AppState {
    /// `action` on a layer of the open sheet.
    fn with_layer<T>(
        &self,
        layer_id: i64,
        action: impl FnOnce(&ClipDocument, &clip_core::ClipLayer) -> clip_core::Result<T>,
    ) -> Result<T, String> {
        let guard = self.document.lock().map_err(ipc::lock_error)?;
        let document = guard.as_ref().ok_or("ファイルが開かれていません")?;
        let layer = document.find_layer(layer_id).map_err(|error| error.to_string())?;
        action(document, layer).map_err(|error| error.to_string())
    }

    /// The sheet at `path`, reading it unless it is the one already open.
    fn ensure_sheet(&self, path: &str) -> Result<(), String> {
        let mut guard = self.document.lock().map_err(ipc::lock_error)?;
        if guard.as_ref().is_some_and(|document| document.path == Path::new(path)) {
            return Ok(());
        }
        *guard = Some(ClipDocument::read(path).map_err(|error| format!("{path}: {error}"))?);
        Ok(())
    }
}

/// Whether this build came from the release workflow. Only those update
/// themselves; a build made on the PC to try a change is left as it is.
#[tauri::command]
fn is_release_build() -> bool {
    option_env!("NAME_STUDIO_RELEASE").is_some()
}

/// When the process began, for 動作の記録 (how long the start took).
static STARTED: std::sync::OnceLock<std::time::SystemTime> = std::sync::OnceLock::new();

/// When the process began, in ms since 1970.
#[tauri::command]
fn started_at() -> f64 {
    let started = *STARTED.get_or_init(std::time::SystemTime::now);
    started
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

/// Whether to start with the screen's look as it comes (設定 › 見た目 not
/// applied, nor the user's CSS): asked for with `--safe-look`, or by holding
/// Shift while the app starts (Windows), for when the user's CSS has broken
/// the screen. Only this start; what is kept is not changed.
static SAFE_LOOK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[tauri::command]
fn safe_look() -> bool {
    *SAFE_LOOK.get_or_init(|| false)
}

/// Whether Shift is down now (on Windows; elsewhere never).
fn shift_held() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
        // The high bit: down at this moment.
        (unsafe { GetAsyncKeyState(i32::from(VK_SHIFT)) } as u16) & 0x8000 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
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
    STARTED.get_or_init(std::time::SystemTime::now);
    SAFE_LOOK.get_or_init(|| std::env::args().any(|arg| arg == "--safe-look") || shift_held());
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
            viewer::open_sheet,
            viewer::layer_overview,
            viewer::layer_region,
            viewer::export_defaults,
            viewer::export_pages,
            viewer::import_project,
            viewer::rough_image,
            project_io::log_error,
            project_io::load_project,
            project_io::unknown_project_fields,
            project_io::save_project,
            project_io::load_series,
            project_io::save_series,
            project_io::autosave_project,
            project_io::list_versions,
            project_io::load_version,
            project_io::record_version,
            project_io::pending_recoveries,
            project_io::discard_recovery,
            project_io::remove_recovery,
            name_export::begin_name_export,
            name_export::export_name_page,
            name_export::update_name_dialogue,
            name_export::read_name_dialogue,
            name_export::adopt_name_dialogue,
            name_export::finish_name_export,
            name_export::cancel_name_export,
            name_export::check_export_target,
            name_export::prepare_builtin_template,
            files::write_pdf,
            files::write_binary_file,
            files::write_text_file,
            files::record_dialogue_update,
            files::csp_tool_locations,
            files::read_csp_sub_tools,
            files::write_csp_sub_tool,
            fonts::list_fonts,
            is_release_build,
            started_at,
            safe_look,
            updates::check_update,
            updates::install_release,
            batch_export_task,
            end_batch_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Name Studio");
}
