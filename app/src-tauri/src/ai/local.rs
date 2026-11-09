//! A local LLM, asked over its OpenAI-compatible API, and the key for it.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::Value;

use super::session::inside;
use super::{AiEvent, AiTurn, ChatMessage};

/// Where the key is kept in the system's credential store.
const KEY_SERVICE: &str = "Name Studio";
const KEY_USER: &str = "ai-api-key";

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

pub(super) fn api_url(endpoint: &str, path: &str) -> String {
    format!("{}/{path}", endpoint.trim().trim_end_matches('/'))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())
}

pub(super) async fn chat(run: u64, turn: AiTurn, stop: Arc<AtomicBool>, emit: impl Fn(AiEvent)) -> Result<(), String> {
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
