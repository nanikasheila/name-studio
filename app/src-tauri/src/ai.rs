//! AI に相談: talking a name over with Claude Code, Codex or a local LLM.
//!
//! Each conversation has a folder of its own (under the app's data) holding
//! what the AI is shown: a copy of the name, the name in words, pictures of
//! its pages, the instructions, and the name-studio Skill (its command line
//! reads the copy). Claude Code and Codex are run there one turn at a time,
//! in their print / exec modes, allowed to read but not to change anything
//! outside; what they propose comes back as 変更の案 in their reply, which the
//! app applies when the user says so. A local LLM is asked over its
//! OpenAI-compatible API.
//!
//! What a turn says comes to the front end as `ai-event`s ([`AiEvent`]). The
//! key for an API that needs one is kept in the system's credential store
//! (Windows 資格情報マネージャー), never in a file.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// The Skill, as the app carries it (built from app/src by `npm run build:skill`).
const SKILL_MD: &str = include_str!("../../../skills/name-studio/SKILL.md");
const SKILL_SCRIPT: &str = include_str!("../../../skills/name-studio/scripts/namestudio.mjs");
/// Where the command line is, from a conversation's folder.
pub const SKILL_COMMAND: &str = ".claude/skills/name-studio/scripts/namestudio.mjs";
/// Conversations' folders older than this are cleared away.
const KEEP_SESSIONS: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const KEY_SERVICE: &str = "Name Studio";
const KEY_USER: &str = "ai-api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiKind {
    Claude,
    Codex,
    Local,
}

/// The turns running now, to stop them.
#[derive(Default)]
pub struct AiRuns {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Running>>,
}

enum Running {
    Process(Arc<Mutex<Child>>),
    Request(Arc<AtomicBool>),
}

/// What a turn says, as it says it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEvent {
    pub run: u64,
    /// "session": the conversation's id (to go on with it); "delta": text as
    /// it comes; "text": a whole message; "tool": something the AI did (read
    /// a file, ran a command); "done": the turn ended; "error": it failed.
    pub kind: String,
    pub text: String,
}

impl AiEvent {
    fn new(run: u64, kind: &str, text: impl Into<String>) -> Self {
        Self {
            run,
            kind: kind.to_owned(),
            text: text.into(),
        }
    }
}

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
fn program(kind: &str, chosen: Option<&str>) -> Result<PathBuf, String> {
    if let Some(chosen) = chosen.map(str::trim).filter(|chosen| !chosen.is_empty()) {
        let path = PathBuf::from(chosen);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("設定の {kind} の場所 {chosen} にファイルがありません"))
        };
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
fn command(path: &Path) -> Command {
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

fn found(kind: &str, chosen: Option<&str>) -> Option<FoundTool> {
    let path = program(kind, chosen).ok()?;
    let version = version_of(&path)?;
    Some(FoundTool {
        path: path.display().to_string(),
        version,
    })
}

/// Which AI tools (and Node, for the Skill's command line) this computer has.
#[tauri::command]
pub async fn ai_detect(claude: Option<String>, codex: Option<String>) -> AiTools {
    tauri::async_runtime::spawn_blocking(move || AiTools {
        claude: found("claude", claude.as_deref()),
        codex: found("codex", codex.as_deref()),
        node: found("node", None),
    })
    .await
    .unwrap_or(AiTools {
        claude: None,
        codex: None,
        node: None,
    })
}

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
fn inside(dir: &Path, path: &str) -> Result<PathBuf, String> {
    let mut out = dir.to_path_buf();
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return Err(format!("ファイル名 {path} は使えません"));
        }
        out.push(part);
    }
    Ok(out)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
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

fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
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
pub async fn ai_install_skill(target: String, folder: Option<String>) -> Result<String, String> {
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

/// One message of a conversation with a local LLM (it keeps no history itself).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Pictures (files in the conversation's folder) shown with it.
    #[serde(default)]
    pub images: Vec<String>,
}

/// One turn of a conversation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTurn {
    pub kind: AiKind,
    /// The conversation's folder ([`ai_prepare_session`]).
    pub dir: String,
    /// What the user says (Claude Code, Codex).
    #[serde(default)]
    pub prompt: String,
    /// The conversation to go on with (its "session" event).
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The program, when the settings name one.
    #[serde(default)]
    pub program: Option<String>,
    /// Pictures (in the folder) to show Codex with the prompt.
    #[serde(default)]
    pub images: Vec<String>,
    /// A local LLM's OpenAI-compatible API, such as http://localhost:11434/v1.
    #[serde(default)]
    pub endpoint: Option<String>,
    /// The whole conversation so far, for a local LLM.
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

/// The tools Claude Code may use without asking: reading, and the Skill's command line.
pub fn claude_allowed_tools() -> String {
    format!("Read,Glob,Grep,Bash(node {SKILL_COMMAND}:*)")
}

/// The arguments for a turn with Claude Code (print mode, events as JSON lines).
pub fn claude_args(turn: &AiTurn) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "default",
        "--allowedTools",
    ]
    .iter()
    .map(|arg| (*arg).to_owned())
    .collect();
    args.push(claude_allowed_tools());
    args.push("--disallowedTools".to_owned());
    args.push("Write,Edit,NotebookEdit,WebFetch,WebSearch".to_owned());
    args.push("--append-system-prompt-file".to_owned());
    args.push(Path::new(&turn.dir).join("SYSTEM.md").display().to_string());
    if let Some(id) = turn.resume.as_deref().filter(|id| !id.is_empty()) {
        args.push("--resume".to_owned());
        args.push(id.to_owned());
    }
    if let Some(model) = turn.model.as_deref().filter(|model| !model.is_empty()) {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }
    args
}

/// The arguments for a turn with Codex (exec mode, read-only, events as JSON lines).
pub fn codex_args(turn: &AiTurn) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".to_owned()];
    if let Some(id) = turn.resume.as_deref().filter(|id| !id.is_empty()) {
        args.push("resume".to_owned());
        args.push(id.to_owned());
        args.push("-c".to_owned());
        args.push("sandbox_mode=read-only".to_owned());
    } else {
        args.push("--sandbox".to_owned());
        args.push("read-only".to_owned());
        args.push("--cd".to_owned());
        args.push(turn.dir.clone());
    }
    args.push("--json".to_owned());
    args.push("--skip-git-repo-check".to_owned());
    if let Some(model) = turn.model.as_deref().filter(|model| !model.is_empty()) {
        args.push("--model".to_owned());
        args.push(model.to_owned());
    }
    for image in &turn.images {
        args.push("--image".to_owned());
        args.push(Path::new(&turn.dir).join(image).display().to_string());
    }
    args.push("-".to_owned());
    args
}

/// What one line of Claude Code's stream-json says, as events (`streamed`:
/// whether text came in pieces already, so the whole message is not said twice).
pub fn claude_events(run: u64, line: &str, streamed: &mut bool) -> Vec<AiEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    match value["type"].as_str() {
        Some("system") if value["subtype"] == "init" => {
            if let Some(id) = value["session_id"].as_str() {
                out.push(AiEvent::new(run, "session", id));
            }
        }
        Some("stream_event") => {
            let event = &value["event"];
            if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                if let Some(text) = event["delta"]["text"].as_str() {
                    *streamed = true;
                    out.push(AiEvent::new(run, "delta", text));
                }
            } else if event["type"] == "message_start" {
                *streamed = false;
            }
        }
        Some("assistant") => {
            for block in value["message"]["content"].as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("text") if !*streamed => {
                        out.push(AiEvent::new(run, "text", block["text"].as_str().unwrap_or_default()));
                    }
                    Some("tool_use") => {
                        out.push(AiEvent::new(run, "tool", tool_words(&block["name"], &block["input"])))
                    }
                    _ => {}
                }
            }
            if value["message"]["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "text"))
            {
                *streamed = false;
            }
        }
        Some("result") => {
            if value["is_error"].as_bool() == Some(true) {
                let why = value["result"].as_str().unwrap_or("Claude Code が失敗しました");
                out.push(AiEvent::new(run, "error", why));
            } else {
                out.push(AiEvent::new(run, "done", ""));
            }
        }
        _ => {}
    }
    out
}

fn tool_words(name: &Value, input: &Value) -> String {
    let name = name.as_str().unwrap_or("?");
    let what = ["file_path", "command", "pattern", "path", "skill"]
        .iter()
        .find_map(|key| input[*key].as_str())
        .unwrap_or_default();
    let what = what
        .rsplit(['/', '\\'])
        .next()
        .filter(|_| name == "Read")
        .unwrap_or(what);
    if what.is_empty() {
        name.to_owned()
    } else {
        format!("{name}: {what}")
    }
}

/// What one line of `codex exec --json` says, as events.
pub fn codex_events(run: u64, line: &str) -> Vec<AiEvent> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let item = &value["item"];
    match value["type"].as_str() {
        Some("thread.started") => value["thread_id"]
            .as_str()
            .map(|id| vec![AiEvent::new(run, "session", id)])
            .unwrap_or_default(),
        Some("item.completed") if item["type"] == "agent_message" => {
            vec![AiEvent::new(run, "text", item["text"].as_str().unwrap_or_default())]
        }
        Some("item.started") if item["type"] == "command_execution" => {
            vec![AiEvent::new(
                run,
                "tool",
                format!("command: {}", item["command"].as_str().unwrap_or_default()),
            )]
        }
        Some("item.completed") if item["type"] == "error" => {
            vec![AiEvent::new(
                run,
                "tool",
                format!("注意: {}", item["message"].as_str().unwrap_or_default()),
            )]
        }
        Some("turn.completed") => vec![AiEvent::new(run, "done", "")],
        Some("turn.failed") => vec![AiEvent::new(
            run,
            "error",
            value["error"]["message"].as_str().unwrap_or("Codex が失敗しました"),
        )],
        Some("error") => vec![AiEvent::new(
            run,
            "error",
            value["message"].as_str().unwrap_or("Codex が失敗しました"),
        )],
        _ => Vec::new(),
    }
}

/// Run Claude Code or Codex for one turn, saying what it says through `emit`.
fn run_process(
    run: u64,
    turn: &AiTurn,
    child: Arc<Mutex<Child>>,
    stdout: impl Read,
    stderr: impl Read + Send + 'static,
    emit: &dyn Fn(AiEvent),
) {
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).take(64 * 1024).read_to_string(&mut text);
        text
    });
    let mut streamed = false;
    let mut ended = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let events = match turn.kind {
            AiKind::Claude => claude_events(run, &line, &mut streamed),
            _ => codex_events(run, &line),
        };
        for event in events {
            ended |= event.kind == "done" || event.kind == "error";
            emit(event);
        }
    }
    let status = child.lock().ok().and_then(|mut child| child.wait().ok());
    let errors = errors.join().unwrap_or_default();
    if !ended {
        let why = errors.trim();
        let why = if why.is_empty() {
            match status.and_then(|status| status.code()) {
                Some(code) => format!("終了コード {code} で止まりました"),
                None => "止めました".to_owned(),
            }
        } else {
            why.chars().take(2000).collect()
        };
        emit(AiEvent::new(run, "error", why));
    }
}

fn start_process(turn: &AiTurn) -> Result<Child, String> {
    let (name, args) = match turn.kind {
        AiKind::Claude => ("claude", claude_args(turn)),
        AiKind::Codex => ("codex", codex_args(turn)),
        AiKind::Local => return Err("ローカル LLM はプログラムではありません".to_owned()),
    };
    let path = program(name, turn.program.as_deref())?;
    let mut child = command(&path)
        .args(&args)
        .current_dir(&turn.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{} を起動できません: {error}", path.display()))?;
    let mut stdin = child.stdin.take().ok_or("入力を渡せません")?;
    stdin
        .write_all(turn.prompt.as_bytes())
        .map_err(|error| format!("入力を渡せません: {error}"))?;
    drop(stdin);
    Ok(child)
}

/// The key for the local LLM's API, from the credential store.
fn saved_key() -> Option<String> {
    keyring::Entry::new(KEY_SERVICE, KEY_USER)
        .ok()?
        .get_password()
        .ok()
        .filter(|key| !key.is_empty())
}

/// Keep the key for a local LLM's API in the system's credential store (none forgets it).
#[tauri::command]
pub async fn ai_save_key(key: Option<String>) -> Result<(), String> {
    let entry = keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|error| error.to_string())?;
    match key.filter(|key| !key.trim().is_empty()) {
        Some(key) => entry.set_password(key.trim()).map_err(|error| error.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

/// Whether a key is kept (the key itself never goes back to the screen).
#[tauri::command]
pub async fn ai_has_key() -> bool {
    tauri::async_runtime::spawn_blocking(|| saved_key().is_some())
        .await
        .unwrap_or(false)
}

/// The body asking an OpenAI-compatible API for the next message, pictures as data URLs.
pub fn chat_body(model: &str, messages: &[ChatMessage], dir: &Path) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|message| {
            let pictures: Vec<Value> = message
                .images
                .iter()
                .filter_map(|image| {
                    let path = inside(dir, image).ok()?;
                    let bytes = std::fs::read(path).ok()?;
                    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                    Some(serde_json::json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{data}") } }))
                })
                .collect();
            if pictures.is_empty() {
                serde_json::json!({ "role": message.role, "content": message.content })
            } else {
                let mut parts = vec![serde_json::json!({ "type": "text", "text": message.content })];
                parts.extend(pictures);
                serde_json::json!({ "role": message.role, "content": parts })
            }
        })
        .collect();
    serde_json::json!({ "model": model, "messages": messages, "stream": true })
}

/// The text in one `data:` line of the API's server-sent events; `None` at `[DONE]`.
pub fn chat_delta(line: &str) -> Option<Option<String>> {
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return Some(None);
    }
    let value: Value = serde_json::from_str(data).ok()?;
    let text = value["choices"][0]["delta"]["content"]
        .as_str()
        .or_else(|| value["choices"][0]["message"]["content"].as_str())
        .unwrap_or_default();
    Some(Some(text.to_owned()))
}

fn api_url(endpoint: &str, path: &str) -> String {
    format!("{}/{path}", endpoint.trim().trim_end_matches('/'))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

async fn chat(run: u64, turn: AiTurn, stop: Arc<AtomicBool>, emit: impl Fn(AiEvent)) -> Result<(), String> {
    let endpoint = turn
        .endpoint
        .as_deref()
        .filter(|e| !e.trim().is_empty())
        .ok_or("ローカル LLM の場所（URL）がありません")?;
    let model = turn.model.clone().unwrap_or_default();
    let body = chat_body(&model, &turn.messages, Path::new(&turn.dir));
    let mut request = client()?.post(api_url(endpoint, "chat/completions")).json(&body);
    if let Some(key) = tauri::async_runtime::spawn_blocking(saved_key).await.ok().flatten() {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("{endpoint} につながりません: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{status}: {}", text.chars().take(1000).collect::<String>()));
    }
    let mut pending = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if stop.load(Ordering::Relaxed) {
            return Err("止めました".to_owned());
        }
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            match chat_delta(line.trim()) {
                Some(Some(text)) if !text.is_empty() => emit(AiEvent::new(run, "delta", text)),
                Some(None) => return Ok(()),
                _ => {}
            }
        }
    }
    Ok(())
}

/// The models a local LLM's API offers (also tells whether it is there).
#[tauri::command]
pub async fn ai_local_models(endpoint: String) -> Result<Vec<String>, String> {
    let mut request = client()?
        .get(api_url(&endpoint, "models"))
        .timeout(Duration::from_secs(15));
    if let Some(key) = tauri::async_runtime::spawn_blocking(saved_key).await.ok().flatten() {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("{endpoint} につながりません: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{endpoint}: {}", response.status()));
    }
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    Ok(value["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str().map(str::to_owned))
        .collect())
}

/// Start a turn; its events come as `ai-event` with the number this returns.
#[tauri::command]
pub async fn ai_turn(app: AppHandle, turn: AiTurn) -> Result<u64, String> {
    let runs = app.state::<AiRuns>();
    let run = runs.next.fetch_add(1, Ordering::Relaxed) + 1;
    let emitter = app.clone();
    let emit = move |event: AiEvent| {
        let _ = emitter.emit("ai-event", event);
    };
    if turn.kind == AiKind::Local {
        let stop = Arc::new(AtomicBool::new(false));
        runs.running
            .lock()
            .map_err(crate::ipc::lock_error)?
            .insert(run, Running::Request(stop.clone()));
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = chat(run, turn, stop, &emit).await;
            emit(match result {
                Ok(()) => AiEvent::new(run, "done", ""),
                Err(why) => AiEvent::new(run, "error", why),
            });
            if let Ok(mut running) = app.state::<AiRuns>().running.lock() {
                running.remove(&run);
            }
        });
        return Ok(run);
    }
    let mut child = start_process(&turn)?;
    let stdout = child.stdout.take().ok_or("出力を読めません")?;
    let stderr = child.stderr.take().ok_or("出力を読めません")?;
    let child = Arc::new(Mutex::new(child));
    runs.running
        .lock()
        .map_err(crate::ipc::lock_error)?
        .insert(run, Running::Process(child.clone()));
    let app = app.clone();
    std::thread::spawn(move || {
        run_process(run, &turn, child, stdout, stderr, &emit);
        if let Ok(mut running) = app.state::<AiRuns>().running.lock() {
            running.remove(&run);
        }
    });
    Ok(run)
}

/// Stop a turn that is running.
#[tauri::command]
pub fn ai_stop(runs: tauri::State<'_, AiRuns>, run: u64) -> Result<(), String> {
    match runs.running.lock().map_err(crate::ipc::lock_error)?.get(&run) {
        Some(Running::Process(child)) => {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
        Some(Running::Request(stop)) => stop.store(true, Ordering::Relaxed),
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(kind: AiKind) -> AiTurn {
        AiTurn {
            kind,
            dir: "/tmp/session-1".to_owned(),
            prompt: "こんにちは".to_owned(),
            resume: None,
            model: None,
            program: None,
            images: vec!["pages/p001.png".to_owned()],
            endpoint: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn claude_reads_but_does_not_write() {
        let mut first = turn(AiKind::Claude);
        let args = claude_args(&first);
        assert_eq!(&args[..3], ["-p", "--output-format", "stream-json"]);
        let allowed = &args[args.iter().position(|arg| arg == "--allowedTools").unwrap() + 1];
        assert_eq!(
            allowed,
            "Read,Glob,Grep,Bash(node .claude/skills/name-studio/scripts/namestudio.mjs:*)"
        );
        assert!(
            args.iter()
                .any(|arg| arg == "Write,Edit,NotebookEdit,WebFetch,WebSearch")
        );
        assert!(!args.contains(&"--resume".to_owned()));
        first.resume = Some("abc".to_owned());
        first.model = Some("sonnet".to_owned());
        let args = claude_args(&first);
        assert!(args.windows(2).any(|pair| pair == ["--resume", "abc"]));
        assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
    }

    #[test]
    fn codex_runs_read_only_and_goes_on_with_its_thread() {
        let mut first = turn(AiKind::Codex);
        let args = codex_args(&first);
        assert_eq!(args[0], "exec");
        assert!(args.windows(2).any(|pair| pair == ["--sandbox", "read-only"]));
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--image" && pair[1].ends_with("p001.png"))
        );
        assert_eq!(args.last().unwrap(), "-");
        first.resume = Some("019c".to_owned());
        let args = codex_args(&first);
        assert_eq!(&args[..5], ["exec", "resume", "019c", "-c", "sandbox_mode=read-only"]);
        assert!(!args.contains(&"--cd".to_owned()));
    }

    #[test]
    fn claude_stream_becomes_events() {
        let mut streamed = false;
        let lines = [
            r#"{"type":"system","subtype":"init","session_id":"s-1"}"#,
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"こん"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:\\x\\ネーム.md"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"全部"}]}}"#,
            r#"{"type":"result","is_error":false,"result":"全部"}"#,
        ];
        let events: Vec<(String, String)> = lines
            .iter()
            .flat_map(|line| claude_events(7, line, &mut streamed))
            .map(|event| (event.kind, event.text))
            .collect();
        let pairs: Vec<(&str, &str)> = events.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert_eq!(
            pairs,
            [
                ("session", "s-1"),
                ("delta", "こん"),
                ("tool", "Read: ネーム.md"),
                ("text", "全部"),
                ("done", "")
            ]
        );
        let failed = claude_events(
            7,
            r#"{"type":"result","is_error":true,"result":"Not logged in"}"#,
            &mut streamed,
        );
        assert_eq!(
            (failed[0].kind.as_str(), failed[0].text.as_str()),
            ("error", "Not logged in")
        );
    }

    #[test]
    fn codex_stream_becomes_events() {
        let kinds: Vec<(String, String)> = [
            r#"{"type":"thread.started","thread_id":"019c"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"案です"}}"#,
            r#"{"type":"turn.completed","usage":{}}"#,
            r#"{"type":"turn.failed","error":{"message":"quota"}}"#,
        ]
        .iter()
        .flat_map(|line| codex_events(1, line))
        .map(|event| (event.kind, event.text))
        .collect();
        let pairs: Vec<(&str, &str)> = kinds.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert_eq!(
            pairs,
            [
                ("session", "019c"),
                ("tool", "command: bash -lc ls"),
                ("text", "案です"),
                ("done", ""),
                ("error", "quota")
            ]
        );
    }

    #[test]
    fn local_llm_body_and_stream() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("pages")).unwrap();
        std::fs::write(dir.path().join("pages").join("p001.png"), [1, 2, 3]).unwrap();
        let messages = vec![
            ChatMessage {
                role: "system".to_owned(),
                content: "相談相手".to_owned(),
                images: Vec::new(),
            },
            ChatMessage {
                role: "user".to_owned(),
                content: "見て".to_owned(),
                images: vec!["pages/p001.png".to_owned(), "../secret.png".to_owned()],
            },
        ];
        let body = chat_body("llama3", &messages, dir.path());
        assert_eq!(body["model"], "llama3");
        assert_eq!(body["messages"][0]["content"], "相談相手");
        let parts = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2, "the picture inside the folder only");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AQID");
        assert_eq!(
            chat_delta(r#"data: {"choices":[{"delta":{"content":"や"}}]}"#),
            Some(Some("や".to_owned()))
        );
        assert_eq!(chat_delta("data: [DONE]"), Some(None));
        assert_eq!(chat_delta(": keep-alive"), None);
        assert_eq!(
            api_url("http://localhost:11434/v1/", "models"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn a_session_folder_holds_its_files_and_the_skill_and_nothing_outside() {
        let root = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let files = vec![
            SessionFile {
                path: "ネーム.md".to_owned(),
                text: Some("# ネーム".to_owned()),
                base64: None,
            },
            SessionFile {
                path: "pages/p001.png".to_owned(),
                text: None,
                base64: Some("AQID".to_owned()),
            },
        ];
        let dir = prepare_session(root.path(), None, &files, now).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("ネーム.md")).unwrap(), "# ネーム");
        assert_eq!(std::fs::read(dir.join("pages").join("p001.png")).unwrap(), [1, 2, 3]);
        assert!(dir.join(SKILL_COMMAND).is_file());
        assert!(dir.join(".agents/skills/name-studio/SKILL.md").is_file());
        // Brought up to date in the same folder.
        let again = prepare_session(root.path(), Some(&dir.display().to_string()), &files[..1], now).unwrap();
        assert_eq!(again, dir);
        for bad in ["../x.md", "a/../../x", "C:/x", "/x", "a\\b"] {
            let file = SessionFile {
                path: bad.to_owned(),
                text: Some(String::new()),
                base64: None,
            };
            assert!(
                prepare_session(root.path(), Some(&dir.display().to_string()), &[file], now).is_err(),
                "{bad}"
            );
        }
        assert!(prepare_session(root.path(), Some("/tmp"), &[], now).is_err());
        // Old ones go when a new one is made.
        let later = now + KEEP_SESSIONS + Duration::from_secs(60);
        let newer = prepare_session(root.path(), None, &[], later).unwrap();
        assert!(!dir.exists());
        assert!(newer.exists());
    }

    /// One real turn and its follow-up with the AI named by `NAME_STUDIO_AI_LIVE`
    /// ("claude" or "codex", installed and signed in), through the same
    /// folder, arguments and reading of its output as the app. Not run by
    /// default: `NAME_STUDIO_AI_LIVE=codex cargo test -p name-studio-app --lib ai::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore = "talks to a real Claude Code / Codex"]
    fn live() {
        let kind = match std::env::var("NAME_STUDIO_AI_LIVE").as_deref() {
            Ok("claude") => AiKind::Claude,
            Ok("codex") => AiKind::Codex,
            _ => panic!("NAME_STUDIO_AI_LIVE=claude か codex"),
        };
        let root = tempfile::tempdir().unwrap();
        let brief = "# ネーム「屋上」\n\n## ページ\n### p1\n- コマ1\n  - [line9] ミカ「星、見えないね」\n";
        let files = vec![
            SessionFile { path: "ネーム.md".to_owned(), text: Some(brief.to_owned()), base64: None },
            SessionFile {
                path: "SYSTEM.md".to_owned(),
                text: Some("あなたは漫画のネームの相談相手です。変更の案は ```namestudio-ops のブロックに JSON 配列で書きます。".to_owned()),
                base64: None,
            },
        ];
        let dir = prepare_session(root.path(), None, &files, SystemTime::now()).unwrap();
        let mut session = None;
        for (number, prompt) in [
            "ネーム.md を読んで、line9 のセリフを少し寂しげにする変更の案を 1 つだけ出してください。",
            "いまの案の文だけを、もう一度ひとことで。",
        ]
        .into_iter()
        .enumerate()
        {
            let turn = AiTurn {
                kind,
                dir: dir.display().to_string(),
                prompt: prompt.to_owned(),
                resume: session.clone(),
                model: std::env::var("NAME_STUDIO_AI_MODEL").ok(),
                program: None,
                images: Vec::new(),
                endpoint: None,
                messages: Vec::new(),
            };
            let mut child = start_process(&turn).unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let events = Mutex::new(Vec::new());
            run_process(1, &turn, Arc::new(Mutex::new(child)), stdout, stderr, &|event| {
                println!("{}: {}", event.kind, event.text);
                events.lock().unwrap().push(event);
            });
            let events = events.into_inner().unwrap();
            let said: String = events
                .iter()
                .filter(|event| event.kind == "delta" || event.kind == "text")
                .map(|event| event.text.as_str())
                .collect();
            assert_eq!(
                events.last().map(|event| event.kind.as_str()),
                Some("done"),
                "turn {number}"
            );
            assert!(!said.trim().is_empty(), "turn {number} said nothing");
            if number == 0 {
                assert!(said.contains("namestudio-ops"), "no 変更の案: {said}");
                session = events
                    .iter()
                    .find(|event| event.kind == "session")
                    .map(|event| event.text.clone());
                assert!(session.is_some(), "no session id");
            }
        }
        assert!(!dir.join("ネーム.md").metadata().unwrap().permissions().readonly());
        assert_eq!(
            std::fs::read_to_string(dir.join("ネーム.md")).unwrap(),
            brief,
            "the AI wrote a file"
        );
    }
}
