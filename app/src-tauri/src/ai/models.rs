//! Which models each AI offers, asked of the tool itself.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::paths::Chosen;

use super::AiKind;
use super::local::ai_local_models;
use super::programs::command;

/// A model to choose, as the AI tool itself lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    /// What goes to `--model` ("": the tool's own default).
    pub value: String,
    pub label: String,
    pub description: String,
    /// The efforts it takes (none: it takes no effort).
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// The one used when none is chosen.
    pub is_default: bool,
}

/// The models in Claude Code's answer to `initialize` (its own list, with the efforts each takes).
pub fn claude_models(response: &Value) -> Vec<AiModel> {
    response["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let value = model["value"].as_str()?;
            let default = value == "default";
            let efforts = if model["supportsEffort"].as_bool() == Some(false) {
                Vec::new()
            } else {
                strings(&model["supportedEffortLevels"])
            };
            Some(AiModel {
                value: if default { String::new() } else { value.to_owned() },
                label: model["displayName"].as_str().unwrap_or(value).to_owned(),
                description: model["description"].as_str().unwrap_or_default().to_owned(),
                efforts,
                default_effort: None,
                is_default: default,
            })
        })
        .collect()
}

/// The models in Codex's answer to `model/list` (hidden ones left out).
pub fn codex_models(result: &Value) -> Vec<AiModel> {
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["hidden"].as_bool() != Some(true))
        .filter_map(|model| {
            let value = model["model"].as_str().or_else(|| model["id"].as_str())?;
            Some(AiModel {
                value: value.to_owned(),
                label: model["displayName"].as_str().unwrap_or(value).to_owned(),
                description: model["description"].as_str().unwrap_or_default().to_owned(),
                efforts: model["supportedReasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| effort["reasoningEffort"].as_str().map(str::to_owned))
                    .collect(),
                default_effort: model["defaultReasoningEffort"].as_str().map(str::to_owned),
                is_default: model["isDefault"].as_bool() == Some(true),
            })
        })
        .collect()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// Run `program args`, write `lines` to it, and give back the first line of its
/// output that `wanted` takes, then stop it (within `wait`).
fn ask_program(
    program: &Path,
    args: &[&str],
    lines: &[String],
    wait: Duration,
    mut wanted: impl FnMut(&Value) -> Option<Value>,
) -> Result<Value, String> {
    let mut child = crate::proctree::own_group(&mut command(program))
        .args(args)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{} を起動できません: {error}", program.display()))?;
    let mut stdin = child.stdin.take().ok_or("入力を渡せません")?;
    for line in lines {
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|error| format!("入力を渡せません: {error}"))?;
    }
    let stdout = child.stdout.take().ok_or("出力を読めません")?;
    let stderr = child.stderr.take().ok_or("出力を読めません")?;
    let (send, heard) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).take(16 * 1024).read_to_string(&mut text);
        text
    });
    let until = std::time::Instant::now() + wait;
    let found = loop {
        let left = until.saturating_duration_since(std::time::Instant::now());
        match heard.recv_timeout(left) {
            Ok(line) => {
                if let Some(found) = serde_json::from_str::<Value>(&line).ok().as_ref().and_then(&mut wanted) {
                    break Ok(found);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break Err("答えが来ません".to_owned()),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break Err(String::new()),
        }
    };
    drop(stdin);
    crate::proctree::kill_tree(&mut child);
    let _ = child.wait();
    found.map_err(|why| {
        let errors = errors.join().unwrap_or_default();
        let errors = errors.trim();
        match (why.is_empty(), errors.is_empty()) {
            (_, false) => errors.chars().take(1000).collect(),
            (false, true) => why,
            (true, true) => "一覧を返さずに終わりました".to_owned(),
        }
    })
}

/// Claude Code's own list of models (what its /model shows), without starting a conversation.
pub(super) fn list_claude_models(program: &Path) -> Result<Vec<AiModel>, String> {
    let initialize = r#"{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}"#;
    let response = ask_program(
        program,
        &[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
        ],
        &[initialize.to_owned()],
        Duration::from_secs(40),
        |value| {
            (value["type"] == "control_response" && value["response"]["request_id"] == "models").then(|| {
                if value["response"]["subtype"] == "error" {
                    Value::String(value["response"]["error"].as_str().unwrap_or("失敗しました").to_owned())
                } else {
                    value["response"]["response"].clone()
                }
            })
        },
    )?;
    if let Some(why) = response.as_str() {
        return Err(why.to_owned());
    }
    Ok(claude_models(&response))
}

/// Codex's own list of models, from its app server (`model/list`).
pub(super) fn list_codex_models(program: &Path) -> Result<Vec<AiModel>, String> {
    let lines = [
        r#"{"method":"initialize","id":1,"params":{"clientInfo":{"name":"name_studio","title":"Name Studio","version":"1"}}}"#,
        r#"{"method":"initialized"}"#,
        r#"{"method":"model/list","id":2,"params":{}}"#,
    ]
    .map(str::to_owned);
    let response = ask_program(program, &["app-server"], &lines, Duration::from_secs(40), |value| {
        (value["id"] == 2).then(|| value.clone())
    })?;
    if let Some(why) = response["error"]["message"].as_str() {
        return Err(why.to_owned());
    }
    Ok(codex_models(&response["result"]))
}

/// The models Claude Code, Codex or a local LLM offers, as each lists them
/// itself, so that a model or an effort cannot be mistyped.
#[tauri::command]
pub async fn ai_models(
    app: AppHandle,
    kind: AiKind,
    program: Option<String>,
    endpoint: Option<String>,
) -> Result<Vec<AiModel>, String> {
    if kind == AiKind::Local {
        let found = ai_local_models(endpoint.unwrap_or_default()).await?;
        return Ok(found
            .into_iter()
            .map(|id| AiModel {
                value: id.clone(),
                label: id,
                description: String::new(),
                efforts: Vec::new(),
                default_effort: None,
                is_default: false,
            })
            .collect());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = if kind == AiKind::Claude { "claude" } else { "codex" };
        let path = super::programs::program(name, program.as_deref(), &app.state::<Chosen>())?;
        let models = if kind == AiKind::Claude {
            list_claude_models(&path)
        } else {
            list_codex_models(&path)
        }?;
        if models.is_empty() {
            return Err("モデルの一覧が空でした".to_owned());
        }
        Ok(models)
    })
    .await
    .map_err(|error| error.to_string())?
}
