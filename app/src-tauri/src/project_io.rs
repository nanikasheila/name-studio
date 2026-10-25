//! Loading and saving the name data, autosave, versions and recovery.

use std::path::{Path, PathBuf};

use name_model::Project;
use name_model::versions::{self, Recovery, VersionInfo, VersionKind, VersionStore};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Manager;

use crate::errorlog;
use crate::ipc::project_body;

/// The project file's text, checked; fields only the app knows stay as they are.
#[tauri::command]
pub(crate) async fn load_project(path: String) -> Result<Box<RawValue>, String> {
    blocking(move || Project::load_text(&path).and_then(raw_project)).await
}

fn raw_project(text: String) -> Result<Box<RawValue>, name_model::ProjectError> {
    RawValue::from_string(text).map_err(name_model::ProjectError::Json)
}

// --- シリーズ ---------------------------------------------------------------------

/// The series file's text, checked; fields only the app knows stay as they are.
#[tauri::command]
pub(crate) async fn load_series(path: String) -> Result<Box<RawValue>, String> {
    blocking(move || name_model::Series::load_text(&path).and_then(raw_project)).await
}

/// Check and save a series file; nothing is written when it has problems.
#[tauri::command]
pub(crate) async fn save_series(path: String, text: String) -> Result<(), String> {
    blocking(move || name_model::Series::save_text(&path, &text).map(|_| ())).await
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMeta {
    path: String,
    /// Where the project was saved before (none when it never was, whose
    /// history then moves to `path`).
    previous_path: Option<String>,
}

/// Check and save the name data; nothing is written when it has problems.
/// The saved state is kept as a version, and the autosave copy is dropped.
#[tauri::command]
pub(crate) async fn save_project(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<VersionInfo>, String> {
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
pub(crate) struct AutosaveMeta {
    path: Option<String>,
    to_file: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutosaveResult {
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
pub(crate) async fn autosave_project(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<AutosaveResult, String> {
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
pub(crate) fn log_error(message: String) {
    errorlog::append(&message);
}

/// Versions of the project at `path` (or of the unsaved one), newest first.
#[tauri::command]
pub(crate) async fn list_versions(app: tauri::AppHandle, path: Option<String>) -> Result<Vec<VersionInfo>, String> {
    let root = data_root(&app)?;
    blocking(move || VersionStore::open(&root, path.as_deref().map(Path::new)).list()).await
}

#[tauri::command]
pub(crate) async fn load_version(
    app: tauri::AppHandle,
    path: Option<String>,
    id: String,
) -> Result<Box<RawValue>, String> {
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
pub(crate) struct RecordMeta {
    path: Option<String>,
    kind: VersionKind,
}

/// Keep the current state as a version (before an older one replaces it).
#[tauri::command]
pub(crate) async fn record_version(
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
pub(crate) async fn pending_recoveries(app: tauri::AppHandle) -> Result<Vec<Recovery>, String> {
    let root = data_root(&app)?;
    Ok(versions::recoveries(&root))
}

#[tauri::command]
pub(crate) async fn discard_recovery(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let root = data_root(&app)?;
    versions::clear_recovery(&root, path.as_deref().map(Path::new)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::split_project_body;

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
