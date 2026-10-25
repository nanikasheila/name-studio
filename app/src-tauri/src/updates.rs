//! 前の版に戻す: install a chosen release, older ones too, the way the
//! updater installs a new one (signed, from that release's latest.json).

use tauri_plugin_updater::UpdaterExt;

const REPOSITORY: &str = "nanikasheila/name-studio";

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
    use super::release_manifest;

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
