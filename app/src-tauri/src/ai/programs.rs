//! Where Claude Code, Codex and Node are on this computer, and which of them may be run.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::paths::Chosen;

/// A program found on this computer, and what it says its version is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundTool {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTools {
    pub claude: Option<FoundTool>,
    pub codex: Option<FoundTool>,
    pub node: Option<FoundTool>,
}

/// Folders programs installed for the user are often in but a window started
/// from the desktop may not have on its PATH.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = &home {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".volta").join("bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(programs).join("nodejs"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs
}

/// `name` on the PATH (or in [`extra_dirs`]), as Windows would run it.
pub fn find_program(name: &str) -> Option<PathBuf> {
    let suffixes: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(extra_dirs())
        .flat_map(|dir| suffixes.iter().map(move |suffix| dir.join(format!("{name}{suffix}"))))
        .find(|candidate| candidate.is_file())
}

/// A program to run: the one the user named in the settings, else found by name.
///
/// A named one is run only when it was picked in a file dialog (now or in an
/// earlier run) or is the one found by name: a path that only a request names
/// is never started, whatever the request came from.
pub(super) fn program(kind: &str, named: Option<&str>, chosen: &Chosen) -> Result<PathBuf, String> {
    if let Some(named) = named.map(str::trim).filter(|named| !named.is_empty()) {
        let path = PathBuf::from(named);
        if !path.is_file() {
            return Err(format!("設定の {kind} の場所 {named} にファイルがありません"));
        }
        if !chosen.holds(&path) && find_program(kind).as_deref() != Some(path.as_path()) {
            return Err(format!(
                "設定の {kind} の場所 {named} は、「参照…」で選び直してください（選んだプログラムだけを動かします）"
            ));
        }
        return Ok(path);
    }
    find_program(kind).ok_or_else(|| match kind {
        "claude" => {
            "Claude Code（claude）が見つかりません。入れてから、設定 › AI 相談 で場所を指定してください".to_owned()
        }
        "codex" => "Codex（codex）が見つかりません。入れてから、設定 › AI 相談 で場所を指定してください".to_owned(),
        _ => format!("{kind} が見つかりません"),
    })
}

/// A command for `path` that opens no console window of its own.
pub(super) fn command(path: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn version_of(path: &Path) -> Option<String> {
    let output = command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !text.is_empty()).then(|| text.lines().next().unwrap_or_default().to_owned())
}

fn found(kind: &str, named: Option<&str>, chosen: &Chosen) -> Option<FoundTool> {
    let path = program(kind, named, chosen).ok()?;
    let version = version_of(&path)?;
    Some(FoundTool {
        path: path.display().to_string(),
        version,
    })
}

/// Which AI tools (and Node, for the Skill's command line) this computer has.
#[tauri::command]
pub async fn ai_detect(app: AppHandle, claude: Option<String>, codex: Option<String>) -> AiTools {
    tauri::async_runtime::spawn_blocking(move || {
        let chosen = app.state::<Chosen>();
        AiTools {
            claude: found("claude", claude.as_deref(), &chosen),
            codex: found("codex", codex.as_deref(), &chosen),
            node: found("node", None, &chosen),
        }
    })
    .await
    .unwrap_or(AiTools {
        claude: None,
        codex: None,
        node: None,
    })
}
