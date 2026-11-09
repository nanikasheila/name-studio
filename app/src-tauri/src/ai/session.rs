//! A conversation's folder: what the AI is shown there, and the name-studio Skill.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::paths::Chosen;

/// The Skill, as the app carries it (built from app/src by `npm run build:skill`).
const SKILL_MD: &str = include_str!("../../../../skills/name-studio/SKILL.md");
const SKILL_SCRIPT: &str = include_str!("../../../../skills/name-studio/scripts/namestudio.mjs");
/// Where the command line is, from a conversation's folder.
pub const SKILL_COMMAND: &str = ".claude/skills/name-studio/scripts/namestudio.mjs";
/// Conversations' folders older than this are cleared away.
pub(super) const KEEP_SESSIONS: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// A file of a conversation's folder: text, or bytes in base64.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    /// Inside the folder, `/` between folders.
    pub path: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub base64: Option<String>,
}

/// `path` inside `dir`, refusing anything that would lead out of it.
pub(super) fn inside(dir: &Path, path: &str) -> Result<PathBuf, String> {
    let mut out = dir.to_path_buf();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return Err(format!("ファイル名 {path} は使えません"));
        }
        out.push(part);
    }
    Ok(out)
}

pub(super) fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(path, bytes).map_err(|error| format!("{}: {error}", path.display()))
}

/// The Skill (SKILL.md and its command line) into `dir`.
pub fn write_skill(dir: &Path) -> Result<(), String> {
    write_file(&dir.join("SKILL.md"), SKILL_MD.as_bytes())?;
    write_file(&dir.join("scripts").join("namestudio.mjs"), SKILL_SCRIPT.as_bytes())
}

/// Folders of conversations under `root` last changed before `before`, cleared away.
fn clear_old(root: &Path, before: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified < before);
        if old && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

pub(super) fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("ai-sessions"))
}

/// Make (or with `dir`, bring up to date) a conversation's folder with these
/// files and the Skill where Claude Code and Codex look for one. Returns the folder.
pub fn prepare_session(
    root: &Path,
    dir: Option<&str>,
    files: &[SessionFile],
    now: SystemTime,
) -> Result<PathBuf, String> {
    let dir = match dir {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            // Only a folder this made: one directly under the root.
            if dir.parent() != Some(root) {
                return Err("相談のフォルダーが違います".to_owned());
            }
            dir
        }
        None => {
            clear_old(root, now.checked_sub(KEEP_SESSIONS).unwrap_or(SystemTime::UNIX_EPOCH));
            let stamp = now
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |since| since.as_millis());
            root.join(format!("session-{stamp}"))
        }
    };
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for file in files {
        let path = inside(&dir, &file.path)?;
        let bytes = match (&file.text, &file.base64) {
            (Some(text), _) => text.clone().into_bytes(),
            (None, Some(data)) => base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| format!("{}: {error}", file.path))?,
            (None, None) => Vec::new(),
        };
        write_file(&path, &bytes)?;
    }
    write_skill(&dir.join(".claude").join("skills").join("name-studio"))?;
    write_skill(&dir.join(".agents").join("skills").join("name-studio"))?;
    Ok(dir)
}

#[tauri::command]
pub async fn ai_prepare_session(
    app: AppHandle,
    dir: Option<String>,
    files: Vec<SessionFile>,
) -> Result<String, String> {
    let root = sessions_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        prepare_session(&root, dir.as_deref(), &files, SystemTime::now()).map(|dir| dir.display().to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Put the Skill where Claude Code ("claude": ~/.claude/skills) or Codex
/// ("codex": ~/.agents/skills) finds it for every folder, or into `folder`.
#[tauri::command]
pub async fn ai_install_skill(
    chosen: tauri::State<'_, Chosen>,
    target: String,
    folder: Option<String>,
) -> Result<String, String> {
    // A folder of the user's is written to only when it was picked in the dialog.
    if let Some(folder) = folder.as_deref().filter(|_| target == "folder")
        && !chosen.holds(Path::new(folder))
    {
        return Err(format!("{}: {folder}", crate::paths::UNCHOSEN));
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("ホームフォルダーが分かりません")?;
    let dir = match (target.as_str(), folder) {
        ("claude", _) => home.join(".claude").join("skills").join("name-studio"),
        ("codex", _) => home.join(".agents").join("skills").join("name-studio"),
        ("folder", Some(folder)) => PathBuf::from(folder).join("name-studio"),
        _ => return Err(format!("入れ先 {target} は分かりません")),
    };
    write_skill(&dir)?;
    Ok(dir.display().to_string())
}
