//! 背景を頼む: the background folder, where a request's files are written
//! for the AI and where it puts what it draws (案/ and 背景.json), and
//! finding Blender. The folder is one the user picked, or the one beside the
//! name (made here, for a name opened or saved through a dialog); nothing is
//! read or written outside it. A turn that draws backgrounds may write there
//! (and run commands), the only turn that may (see [`super::cli`]).

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::paths::Chosen;

use super::session::{SessionFile, inside, write_file};

/// The largest picture read back from the folder (a page at 600 dpi is about 30 MB).
const MAX_READ: u64 = 96 * 1024 * 1024;

/// The folder beside a name: `<folder>/<name>_背景`.
pub fn beside(name: &Path) -> Option<PathBuf> {
    let stem = name.file_stem()?.to_str()?;
    Some(name.parent()?.join(format!("{stem}_背景")))
}

/// The background folder to use: `folder` when it was picked, else the one
/// beside `name` (a name picked in a dialog), made when it is not there.
pub fn background_folder(chosen: &Chosen, name: Option<&str>, folder: Option<&str>) -> Result<PathBuf, String> {
    let dir = match (folder.filter(|f| !f.is_empty()), name.filter(|n| !n.is_empty())) {
        (Some(folder), _) => {
            let dir = PathBuf::from(folder);
            if !dir.is_absolute() || !chosen.holds(&dir) {
                return Err(format!("{}: {folder}", crate::paths::UNCHOSEN));
            }
            dir
        }
        (None, Some(name)) => {
            let name = Path::new(name);
            if !name.is_absolute() || !chosen.holds(name) {
                return Err(format!("{}: {}", crate::paths::UNCHOSEN, name.display()));
            }
            let dir = beside(name).ok_or("ネームの場所から背景のフォルダーを決められません")?;
            // Made for this name: everything under it may be written from now on.
            chosen.folder(&dir);
            dir
        }
        (None, None) => {
            return Err("ネームを保存してから頼んでください（背景のフォルダーはネームの隣に作ります）".to_owned());
        }
    };
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

/// `folder` as a background folder: a whole path, picked (or made beside a name), there.
pub fn held_folder(chosen: &Chosen, folder: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(folder);
    if !dir.is_absolute() || !chosen.holds(&dir) {
        return Err(format!("{}: {folder}", crate::paths::UNCHOSEN));
    }
    if !dir.is_dir() {
        return Err(format!("背景のフォルダーがありません: {folder}"));
    }
    Ok(dir)
}

#[tauri::command]
pub fn bg_folder(
    chosen: tauri::State<'_, Chosen>,
    name: Option<String>,
    folder: Option<String>,
) -> Result<String, String> {
    background_folder(&chosen, name.as_deref(), folder.as_deref()).map(|dir| dir.display().to_string())
}

/// Write a request's files into the background folder.
#[tauri::command]
pub async fn bg_write(chosen: tauri::State<'_, Chosen>, folder: String, files: Vec<SessionFile>) -> Result<(), String> {
    let dir = held_folder(&chosen, &folder)?;
    tauri::async_runtime::spawn_blocking(move || write_files(&dir, &files))
        .await
        .map_err(|error| error.to_string())?
}

pub fn write_files(dir: &Path, files: &[SessionFile]) -> Result<(), String> {
    for file in files {
        let path = inside(dir, &file.path)?;
        let bytes = match (&file.text, &file.base64) {
            (Some(text), _) => text.clone().into_bytes(),
            (None, Some(data)) => base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| format!("{}: {error}", file.path))?,
            (None, None) => Vec::new(),
        };
        write_file(&path, &bytes)?;
    }
    Ok(())
}

/// A file of the background folder: its text (`text`) or bytes in base64; none when it is not there.
#[tauri::command]
pub async fn bg_read(
    chosen: tauri::State<'_, Chosen>,
    folder: String,
    path: String,
    text: bool,
) -> Result<Option<String>, String> {
    let dir = held_folder(&chosen, &folder)?;
    tauri::async_runtime::spawn_blocking(move || read_file(&dir, &path, text))
        .await
        .map_err(|error| error.to_string())?
}

pub fn read_file(dir: &Path, path: &str, text: bool) -> Result<Option<String>, String> {
    let file = inside(dir, path)?;
    let Ok(meta) = std::fs::metadata(&file) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_READ {
        return Err(format!(
            "{path} は大きすぎて読めません（{} MB）",
            meta.len() / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&file).map_err(|error| format!("{path}: {error}"))?;
    Ok(Some(if text {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }))
}

/// Blender on this computer, the newest found: on the PATH, or (Windows) in Program Files.
#[tauri::command]
pub async fn bg_blender() -> Option<String> {
    tauri::async_runtime::spawn_blocking(find_blender)
        .await
        .ok()
        .flatten()
        .map(|path| path.display().to_string())
}

fn find_blender() -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    for root in ["ProgramFiles", "ProgramW6432"].iter().filter_map(std::env::var_os) {
        let foundation = PathBuf::from(root).join("Blender Foundation");
        let Ok(entries) = std::fs::read_dir(&foundation) else {
            continue;
        };
        for entry in entries.flatten() {
            let exe = entry.path().join("blender.exe");
            if exe.is_file() {
                found.push(exe);
            }
        }
    }
    // "Blender 5.2" after "Blender 4.5": the newest last.
    found.sort_by_key(|path| version_of(path));
    found.pop().or_else(|| super::programs::find_program("blender"))
}

fn version_of(path: &Path) -> Vec<u32> {
    path.parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .map(|name| {
            name.split(|c: char| !c.is_ascii_digit())
                .filter_map(|part| part.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_folder_is_beside_the_name_or_one_picked() {
        let root = std::env::temp_dir().join(format!("bg-folder-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let name = root.join("第4話.namestudio");
        let chosen = Chosen::default();
        assert!(background_folder(&chosen, Some(name.to_str().unwrap()), None).is_err());
        assert!(background_folder(&chosen, None, None).is_err());
        chosen.file(&name);
        let dir = background_folder(&chosen, Some(name.to_str().unwrap()), None).unwrap();
        assert_eq!(dir, root.join("第4話_背景"));
        assert!(dir.is_dir());
        // Made beside the name: it may be written to and read from now.
        let files = vec![SessionFile {
            path: "依頼/1/依頼.md".to_owned(),
            text: Some("頼む".to_owned()),
            base64: None,
        }];
        write_files(&held_folder(&chosen, dir.to_str().unwrap()).unwrap(), &files).unwrap();
        assert_eq!(
            read_file(&dir, "依頼/1/依頼.md", true).unwrap().as_deref(),
            Some("頼む")
        );
        assert_eq!(
            read_file(&dir, "依頼/1/依頼.md", false).unwrap().as_deref(),
            Some("6aC844KA")
        );
        assert_eq!(read_file(&dir, "案/なし.png", false).unwrap(), None);
        assert!(read_file(&dir, "../第4話.namestudio", true).is_err());
        let other = root.join("ほか");
        std::fs::create_dir_all(&other).unwrap();
        assert!(held_folder(&chosen, other.to_str().unwrap()).is_err());
        assert!(background_folder(&chosen, None, Some(other.to_str().unwrap())).is_err());
        chosen.folder(&other);
        assert_eq!(
            background_folder(&chosen, None, Some(other.to_str().unwrap())).unwrap(),
            other
        );
        assert!(held_folder(&chosen, "相対/のフォルダー").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn blender_versions_sort_by_number() {
        let a = PathBuf::from("C:/Program Files/Blender Foundation/Blender 4.10/blender.exe");
        let b = PathBuf::from("C:/Program Files/Blender Foundation/Blender 5.2/blender.exe");
        assert!(version_of(&a) < version_of(&b));
    }
}
