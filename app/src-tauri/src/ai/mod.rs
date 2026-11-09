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
//!
//! The parts: [`programs`] finds the tools and says which may be run,
//! [`session`] makes a conversation's folder, [`cli`] runs Claude Code and
//! Codex and reads what they say, [`local`] asks a local LLM, [`models`] lists
//! what each offers, [`history`] keeps past conversations. Here: what they
//! share, and starting and stopping a turn.

pub mod cli;
pub mod history;
pub mod local;
pub mod models;
pub mod programs;
pub mod session;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::paths::Chosen;

use cli::{run_process, start_process};
use local::chat;
use session::{inside, sessions_root};

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

impl Running {
    fn stop(&self) {
        match self {
            Self::Process(child) => {
                if let Ok(mut child) = child.lock() {
                    crate::proctree::kill_tree(&mut child);
                }
            }
            Self::Request(stop) => stop.store(true, Ordering::Relaxed),
        }
    }
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
    /// How hard it thinks (Claude Code `--effort`, Codex `model_reasoning_effort`), one its model offers.
    #[serde(default)]
    pub effort: Option<String>,
    /// The program, when the settings name one.
    #[serde(default)]
    pub program: Option<String>,
    /// Codex's Windows sandbox (`windows.sandbox`): none for "mxc", "config"
    /// for what ~/.codex/config.toml says, or a mode by name.
    #[serde(default)]
    pub sandbox: Option<String>,
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

/// A turn's folder and pictures as this side made them: the folder one of the
/// conversations' ([`prepare_session`]), the pictures files inside it.
pub fn check_turn(root: &Path, turn: &AiTurn) -> Result<(), String> {
    let dir = Path::new(&turn.dir);
    if dir.parent() != Some(root) || !dir.is_dir() {
        return Err("相談のフォルダーが違います".to_owned());
    }
    for image in &turn.images {
        inside(dir, image)?;
    }
    Ok(())
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
    check_turn(&sessions_root(&app)?, &turn)?;
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
    let mut child = start_process(&turn, &app.state::<Chosen>())?;
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
    if let Some(running) = runs.running.lock().map_err(crate::ipc::lock_error)?.get(&run) {
        running.stop();
    }
    Ok(())
}

/// Stop every turn that is running (the app is closing).
pub fn stop_all(runs: &AiRuns) {
    if let Ok(running) = runs.running.lock() {
        for running in running.values() {
            running.stop();
        }
    }
}
