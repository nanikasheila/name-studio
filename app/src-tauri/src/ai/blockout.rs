//! name-blockout (github.com/nanikasheila/name-blockout), run with Python:
//! its requirement check of a background request (what is missing or
//! contradicts, and the next one or two questions with choices). The request
//! is written into the background folder (`要求/点検/指示.json`, where
//! name-blockout keeps its requirement versions too) and only name-blockout's
//! `check` is run: Python found on this computer, name-blockout as installed
//! for it, or from a folder of its source the user picked.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::paths::Chosen;

use super::programs::{command, find_program};

/// Where the request is written to be checked, inside the background folder.
const CHECK_DIR: &str = "要求/点検";
const CHECK_FILE: &str = "指示.json";

/// Python and name-blockout as found.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockoutFound {
    pub python: String,
    /// What `name-blockout --version` says.
    pub version: String,
}

/// Python on this computer: `python` (not the Microsoft Store's stand-in, which only opens the Store), else `py -3`.
fn pythons() -> Vec<(PathBuf, Vec<String>)> {
    let mut out = Vec::new();
    if let Some(python) = find_program("python").filter(|path| !path.to_string_lossy().contains("WindowsApps")) {
        out.push((python, Vec::new()));
    }
    if let Some(py) = find_program("py") {
        out.push((py, vec!["-3".to_owned()]));
    }
    if let Some(python3) = find_program("python3") {
        out.push((python3, Vec::new()));
    }
    out
}

/// name-blockout's source folder (`<folder>/src` goes on Python's path), when one was picked.
fn source_dir(chosen: &Chosen, folder: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(folder) = folder.map(str::trim).filter(|folder| !folder.is_empty()) else {
        return Ok(None);
    };
    let dir = PathBuf::from(folder);
    if !dir.is_absolute() || !chosen.holds(&dir) {
        return Err(format!(
            "name-blockout のフォルダーは「選ぶ…」で選び直してください: {folder}"
        ));
    }
    let src = dir.join("src");
    if !src.join("name_blockout").is_dir() {
        return Err(format!("{folder} に name-blockout（src/name_blockout）がありません"));
    }
    Ok(Some(src))
}

/// Run `python -m name_blockout <args>`: its exit code, what it printed and what it said went wrong.
fn run(python: &(PathBuf, Vec<String>), src: Option<&Path>, args: &[&str]) -> Result<(i32, String, String), String> {
    let mut run = command(&python.0);
    run.args(&python.1)
        .arg("-X")
        .arg("utf8")
        .arg("-m")
        .arg("name_blockout")
        .args(args);
    if let Some(src) = src {
        let joined = match std::env::var_os("PYTHONPATH") {
            Some(old) if !old.is_empty() => {
                std::env::join_paths([src.as_os_str(), old.as_os_str()]).map_err(|e| e.to_string())?
            }
            _ => src.as_os_str().to_owned(),
        };
        run.env("PYTHONPATH", joined);
    }
    run.env("PYTHONIOENCODING", "utf-8");
    let output = run
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("{} を動かせません: {error}", python.0.display()))?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

/// The last lines of what went wrong (a Python traceback ends with the error).
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" / ")
}

/// The first Python that has name-blockout (installed, or from `src`), and its version.
fn find(src: Option<&Path>) -> Result<((PathBuf, Vec<String>), String), String> {
    let found = pythons();
    if found.is_empty() {
        return Err("Python が見つかりません（name-blockout は Python で動きます）".to_owned());
    }
    let mut last = String::new();
    for python in found {
        match run(&python, src, &["--version"]) {
            Ok((0, out, _)) => return Ok((python, out.trim().to_owned())),
            Ok((_, _, err)) => last = tail(&err),
            Err(error) => last = error,
        }
    }
    Err(if src.is_some() {
        format!("name-blockout を動かせません: {last}")
    } else {
        format!(
            "name-blockout が見つかりません（作画の設定で name-blockout のフォルダーを選ぶか、pip で入れてください）: {last}"
        )
    })
}

/// Python and name-blockout on this computer (name-blockout from `folder`, a picked folder of its source, if given).
#[tauri::command]
pub async fn blockout_detect(
    chosen: tauri::State<'_, Chosen>,
    folder: Option<String>,
) -> Result<BlockoutFound, String> {
    let src = source_dir(&chosen, folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        find(src.as_deref()).map(|(python, version)| BlockoutFound {
            python: python.0.display().to_string(),
            version,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// name-blockout's check of a request (指示.json as text): its findings and the next `questions` questions, as the
/// JSON it prints. The request is written into the background folder `background` (a picked one, or the one beside
/// the name) first.
#[tauri::command]
pub async fn blockout_check(
    chosen: tauri::State<'_, Chosen>,
    background: String,
    folder: Option<String>,
    instruction: String,
    questions: u32,
) -> Result<String, String> {
    let dir = PathBuf::from(&background);
    if !dir.is_absolute() || !chosen.holds(&dir) {
        return Err(format!("{}: {background}", crate::paths::UNCHOSEN));
    }
    let src = source_dir(&chosen, folder.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || check(&dir, src.as_deref(), &instruction, questions))
        .await
        .map_err(|error| error.to_string())?
}

fn check(dir: &Path, src: Option<&Path>, instruction: &str, questions: u32) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(instruction)
        .map_err(|error| format!("指示書が JSON ではありません: {error}"))?;
    let check_dir = dir.join(CHECK_DIR);
    std::fs::create_dir_all(&check_dir).map_err(|error| format!("{}: {error}", check_dir.display()))?;
    let file = check_dir.join(CHECK_FILE);
    std::fs::write(&file, instruction).map_err(|error| format!("{}: {error}", file.display()))?;
    let (python, _) = find(src)?;
    let path = file.to_string_lossy().into_owned();
    let count = questions.clamp(1, 9).to_string();
    let (code, out, err) = run(&python, src, &["check", &path, "--json", "--questions", &count])?;
    // 0: nothing wrong, 1: errors found (the findings say which); anything else: it did not run.
    if (code == 0 || code == 1) && out.trim_start().starts_with('{') {
        Ok(out)
    } else {
        Err(format!(
            "name-blockout の点検が動きませんでした（{code}）: {}",
            tail(&err)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_lines() {
        assert_eq!(
            tail("Traceback\n  File x\n\nValueError: no\n"),
            "Traceback /   File x / ValueError: no"
        );
        assert_eq!(tail("a\nb\nc\nd\n"), "b / c / d");
    }

    #[test]
    fn a_source_folder_must_be_picked_and_hold_name_blockout() {
        let chosen = Chosen::load(std::env::temp_dir().join(format!("blockout-chosen-{}.json", std::process::id())));
        let root = std::env::temp_dir().join(format!("blockout-src-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src").join("name_blockout")).unwrap();
        let folder = root.to_string_lossy().into_owned();
        assert!(source_dir(&chosen, Some(&folder)).is_err(), "not picked");
        chosen.folder(&root);
        assert_eq!(source_dir(&chosen, Some(&folder)).unwrap(), Some(root.join("src")));
        assert_eq!(source_dir(&chosen, None).unwrap(), None);
        assert_eq!(source_dir(&chosen, Some("  ")).unwrap(), None);
        std::fs::remove_dir_all(&root).ok();
    }

    /// With name-blockout's source at NAME_BLOCKOUT_SRC (its folder), its check of an example runs and asks.
    #[test]
    fn check_runs_name_blockout_when_it_is_there() {
        let Some(folder) = std::env::var_os("NAME_BLOCKOUT_SRC") else {
            return;
        };
        let folder = PathBuf::from(folder);
        let example = std::fs::read_to_string(folder.join("examples/two-point/指示.json")).unwrap();
        let mut data: serde_json::Value = serde_json::from_str(&example).unwrap();
        data["shots"][0].as_object_mut().unwrap().remove("camera");
        let dir = std::env::temp_dir().join(format!("blockout-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = check(&dir, Some(&folder.join("src")), &data.to_string(), 2).unwrap();
        let result: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(result["questions"][0]["path"], "camera.heightM", "{out}");
        assert!(dir.join(CHECK_DIR).join(CHECK_FILE).is_file());
        std::fs::remove_dir_all(&dir).ok();
    }
}
