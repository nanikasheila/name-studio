//! Claude Code and Codex, run one turn at a time: their arguments, and what
//! they say turned into [`AiEvent`]s.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::paths::Chosen;

use super::programs::{command, program};
use super::session::SKILL_COMMAND;
use super::{AiEvent, AiKind, AiTurn};

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
    if let Some(effort) = effort_of(turn) {
        args.push("--effort".to_owned());
        args.push(effort.to_owned());
    }
    args
}

/// The turn's effort, when it is one word (it goes into a command line and a TOML value).
fn effort_of(turn: &AiTurn) -> Option<&str> {
    turn.effort.as_deref().filter(|effort| {
        !effort.is_empty()
            && effort
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    })
}

/// The arguments for a turn with Codex (exec mode, read-only, events as JSON lines).
pub fn codex_args(turn: &AiTurn) -> Vec<String> {
    codex_args_on(turn, cfg!(windows))
}

/// Which Windows sandbox Codex runs its commands in. "mxc" unless the settings
/// say otherwise: the "elevated" one fails to set itself up while the Codex
/// app runs (it cannot change the rights of a file that app holds open), and
/// then every command, even reading a file, is turned away.
fn windows_sandbox(turn: &AiTurn) -> Option<&str> {
    match turn.sandbox.as_deref().map(str::trim) {
        None | Some("") => Some("mxc"),
        Some("config") => None,
        Some(mode) => Some(mode).filter(|mode| mode.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')),
    }
}

pub(super) fn codex_args_on(turn: &AiTurn, windows: bool) -> Vec<String> {
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
    if let Some(effort) = effort_of(turn) {
        args.push("-c".to_owned());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    if let Some(mode) = windows_sandbox(turn).filter(|_| windows) {
        args.push("-c".to_owned());
        args.push(format!("windows.sandbox=\"{mode}\""));
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
    // `--image` takes any number of files: without `--` the prompt's `-`
    // would be one more picture (and the prompt never read from stdin).
    args.push("--".to_owned());
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
        Some("item.completed") if item["type"] == "command_execution" && sandbox_failed(&item.to_string()) => {
            vec![AiEvent::new(
                run,
                "tool",
                "Codex のサンドボックスがコマンドを動かせません（setup refresh had errors など）。ネームの要約は相談に付けてあるので話は続けられます。ファイルも読ませたいときは、「接続…」の「詳しく」でサンドボックスを変えてみてください。",
            )]
        }
        Some("item.started") if item["type"] == "command_execution" => {
            vec![AiEvent::new(
                run,
                "tool",
                format!("command: {}", item["command"].as_str().unwrap_or_default()),
            )]
        }
        // An "error" item is a warning that does not stop the turn (such as a
        // setting in ~/.codex/config.toml it does not know), said on every
        // turn: not shown. What stops it comes as turn.failed or error.
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

/// Whether Codex said its sandbox turned a command away before it ran.
fn sandbox_failed(text: &str) -> bool {
    [
        "setup refresh had errors",
        "Failed to create unified exec process",
        "CreateProcessAsUserW failed",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Run Claude Code or Codex for one turn, saying what it says through `emit`.
pub(super) fn run_process(
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
        for mut event in events {
            ended |= event.kind == "done" || event.kind == "error";
            if event.kind == "error" {
                event.text = with_hint(turn.kind, &event.text);
            }
            emit(event);
        }
    }
    // Waited for in short looks, so that 「止める」 is never kept waiting for the lock.
    let status = loop {
        match child.lock().map(|mut child| child.try_wait()) {
            Ok(Ok(Some(status))) => break Some(status),
            Ok(Ok(None)) => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
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
        emit(AiEvent::new(run, "error", with_hint(turn.kind, &why)));
    }
}

/// What failed, with what to do when it is the sign-in (it expires, and the
/// app cannot sign in for the user).
pub fn with_hint(kind: AiKind, why: &str) -> String {
    let lower = why.to_lowercase();
    let signed_out = [
        "authenticat",
        "login",
        "logged in",
        "log in",
        "sign in",
        "oauth",
        "api key",
        "401",
    ]
    .iter()
    .any(|word| lower.contains(word));
    match kind {
        AiKind::Claude if signed_out => {
            format!(
                "{why}\n\nClaude Code のサインインが切れているようです。ターミナルで claude を開いて /login してから、もう一度送ってください。"
            )
        }
        AiKind::Codex if signed_out => {
            format!(
                "{why}\n\nCodex のサインインが切れているようです。ターミナルで codex login をしてから、もう一度送ってください。"
            )
        }
        _ => why.to_owned(),
    }
}

pub(super) fn start_process(turn: &AiTurn, chosen: &Chosen) -> Result<Child, String> {
    let (name, args) = match turn.kind {
        AiKind::Claude => ("claude", claude_args(turn)),
        AiKind::Codex => ("codex", codex_args(turn)),
        AiKind::Local => return Err("ローカル LLM はプログラムではありません".to_owned()),
    };
    let path = program(name, turn.program.as_deref(), chosen)?;
    // In a group of its own: 「止める」 stops it with all it started (proctree.rs).
    let mut child = crate::proctree::own_group(&mut command(&path))
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
