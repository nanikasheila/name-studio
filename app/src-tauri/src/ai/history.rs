//! Past conversations, kept as files of the app's own.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::session::write_file;

/// How many past conversations are kept (the oldest go first).
const KEEP_TALKS: usize = 300;

fn history_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("ai-history"))
}

/// A past conversation's file: its id is letters, digits, - and _ only.
fn talk_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("相談の id {id} は使えません"));
    }
    Ok(root.join(format!("{id}.json")))
}

/// Keep a conversation (as the palette has it, with its "id") for going on with it later.
pub fn save_talk(root: &Path, talk: &Value) -> Result<(), String> {
    let path = talk_file(root, talk["id"].as_str().unwrap_or_default())?;
    let text = serde_json::to_vec(talk).map_err(|error| error.to_string())?;
    // Written whole beside it, then moved in: a crash leaves the old one, not half of it.
    let part = path.with_extension("json.part");
    write_file(&part, &text)?;
    std::fs::rename(&part, &path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut all = list_talks(root);
    if all.len() > KEEP_TALKS {
        for old in all.split_off(KEEP_TALKS) {
            if let Ok(path) = talk_file(root, old["id"].as_str().unwrap_or_default()) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(())
}

/// The kept conversations, newest first, each without what was said (only its title and size).
pub fn list_talks(root: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let talk: Value = serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
            let id = talk["id"].as_str()?;
            Some(serde_json::json!({
                "id": id,
                "kind": talk["kind"],
                "name": talk["name"],
                "title": talk["title"],
                "created": talk["created"],
                "updated": talk["updated"],
                "count": talk["entries"].as_array().map_or(0, |entries| entries.iter().filter(|entry| entry["role"] == "user").count()),
            }))
        })
        .collect();
    out.sort_by(|a, b| {
        b["updated"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["updated"].as_f64().unwrap_or(0.0))
    });
    out
}

pub fn load_talk(root: &Path, id: &str) -> Result<Value, String> {
    let path = talk_file(root, id)?;
    let bytes = std::fs::read(&path).map_err(|_| "その相談は見つかりません（消されたかもしれません）".to_owned())?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))
}

#[tauri::command]
pub async fn ai_history_save(app: AppHandle, talk: Value) -> Result<(), String> {
    let root = history_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_talk(&root, &talk))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ai_history_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let root = history_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_talks(&root))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn ai_history_load(app: AppHandle, id: String) -> Result<Value, String> {
    let root = history_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_talk(&root, &id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn ai_history_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = talk_file(&history_root(&app)?, &id)?;
    match std::fs::remove_file(&path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {error}", path.display())),
        _ => Ok(()),
    }
}
