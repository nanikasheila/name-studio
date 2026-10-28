//! Updates, signed like any release: looking for a newer version on the
//! chosen channel (正式版, or 試験版 too), and 前の版に戻す, which installs a
//! chosen release, older ones too, from that release's latest.json.

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

const REPOSITORY: &str = "nanikasheila/name-studio";

/// The release whose latest.json always names the newest 試験版 (every
/// version CI let through). 正式版 are the releases promoted from those,
/// and GitHub's latest release is the newest of them.
const BETA_TAG: &str = "channel-beta";

/// The latest.json naming the newest version on `channel`.
fn channel_manifest(channel: &str) -> Result<tauri::Url, String> {
    let url = match channel {
        "stable" => format!("https://github.com/{REPOSITORY}/releases/latest/download/latest.json"),
        "beta" => format!("https://github.com/{REPOSITORY}/releases/download/{BETA_TAG}/latest.json"),
        _ => return Err(format!("更新の経路が正しくありません: {channel}")),
    };
    url.parse().map_err(|error| format!("{error}"))
}

/// A newer version found, as the updater's own `check` hands it to the front
/// end (`new Update(…)` there downloads and installs it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FoundUpdate {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Look for a version newer than this one on `channel` ("stable" or "beta").
#[tauri::command]
pub(crate) async fn check_update(
    webview: tauri::Webview,
    channel: String,
    timeout_ms: u64,
) -> Result<Option<FoundUpdate>, String> {
    let updater = webview
        .updater_builder()
        .endpoints(vec![channel_manifest(&channel)?])
        .map_err(|error| error.to_string())?
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let date = update
        .raw_json
        .get("pub_date")
        .and_then(|date| date.as_str())
        .map(str::to_owned);
    Ok(Some(FoundUpdate {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

/// The latest.json of release `version` (`0.2.59`).
fn release_manifest(version: &str) -> Result<tauri::Url, String> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(format!("版の番号が正しくありません: {version}"));
    }
    format!("https://github.com/{REPOSITORY}/releases/download/v{version}/latest.json")
        .parse()
        .map_err(|error| format!("{error}"))
}

/// Download and install release `version` (Windows closes the app for the installer).
#[tauri::command]
pub(crate) async fn install_release(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let manifest = release_manifest(&version)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest])
        .map_err(|error| error.to_string())?
        // Any release but the one running, older or newer.
        .version_comparator(|current, release| release.version != current)
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("{version} の版を読めませんでした: {error}"))?
        .ok_or_else(|| format!("{version} は今の版です"))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("{version} を入れられませんでした: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{channel_manifest, release_manifest};

    #[test]
    fn the_channels_read_the_latest_release_or_the_beta_one() {
        assert_eq!(
            channel_manifest("stable").unwrap().as_str(),
            "https://github.com/nanikasheila/name-studio/releases/latest/download/latest.json"
        );
        assert_eq!(
            channel_manifest("beta").unwrap().as_str(),
            "https://github.com/nanikasheila/name-studio/releases/download/channel-beta/latest.json"
        );
        assert!(channel_manifest("nightly").is_err());
    }

    #[test]
    fn a_release_is_named_by_its_three_numbers() {
        assert_eq!(
            release_manifest("0.2.59").unwrap().as_str(),
            "https://github.com/nanikasheila/name-studio/releases/download/v0.2.59/latest.json"
        );
        for bad in ["", "0.2", "0.2.x", "../0.2.1", "0.2.1/../../x", "v0.2.1"] {
            assert!(release_manifest(bad).is_err(), "{bad}");
        }
    }
}
