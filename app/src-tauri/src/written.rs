//! The files this app wrote outside the name data (the PDF, the ミニネーム,
//! page pictures and PSDs, the script), each with its size and time just
//! after it was written, kept in a file of the app's own between runs.
//!
//! An export asks before writing over a file only when it is not one of
//! these as written: one drawn on or annotated since (an editor's notes in
//! the PDF, a page painted in another tool), or one this app did not make.
//! Writing its own files again, as 前回と同じ設定で書き出す does, asks
//! nothing, so the question keeps its weight when it does come.
//!
//! Nothing is kept beside the files themselves (the CSP pages have their own
//! list, [`clip_core::write::manifest`], which セリフだけ反映 needs too).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::paths;

/// How many written files are remembered (the oldest go first).
const KEEP: usize = 4000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    /// The path as [`paths::key`] compares it.
    key: String,
    size: u64,
    modified_ms: u64,
}

/// The files written, oldest first.
#[derive(Debug, Default)]
pub struct Written {
    entries: Mutex<VecDeque<Entry>>,
    file: Option<PathBuf>,
}

/// Of the files about to be written, those already there, by file name.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WrittenCheck {
    /// Every one there (written over by the export).
    pub existing: Vec<String>,
    /// Written by this app and changed since (drawn on, annotated, replaced).
    pub changed: Vec<String>,
    /// Not written by this app (or before it kept this list).
    pub unknown: Vec<String>,
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((meta.len(), modified))
}

fn name_of(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

impl Written {
    /// The list kept in `file` (empty when it is missing or cannot be read:
    /// the files in it are then asked about once more, nothing worse).
    pub fn load(file: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            entries: Mutex::new(entries),
            file: Some(file),
        }
    }

    /// `path` was just written by this app.
    pub fn record(&self, path: &Path) {
        let Some((size, modified_ms)) = stamp(path) else { return };
        let Ok(mut entries) = self.entries.lock() else { return };
        let key = paths::key(path);
        entries.retain(|entry| entry.key != key);
        entries.push_back(Entry { key, size, modified_ms });
        while entries.len() > KEEP {
            entries.pop_front();
        }
        if let (Some(file), Ok(text)) = (&self.file, serde_json::to_string(&*entries)) {
            // Not kept (a full disk): the file is asked about next time, nothing worse.
            let _ = name_model::atomic::write(file, text.as_bytes());
        }
    }

    /// Which of `files` are there, and which of those are not this app's as it wrote them.
    pub(crate) fn check(&self, files: &[PathBuf]) -> WrittenCheck {
        let entries = self.entries.lock().map(|entries| entries.clone()).unwrap_or_default();
        let mut check = WrittenCheck::default();
        for path in files {
            // A folder (or anything not a file) in the way is "there" too: the write fails on it, never quietly.
            if std::fs::symlink_metadata(path).is_err() {
                continue;
            }
            let name = name_of(path);
            let key = paths::key(path);
            match (entries.iter().find(|entry| entry.key == key), stamp(path)) {
                (Some(entry), Some((size, modified_ms))) if entry.size == size && entry.modified_ms == modified_ms => {}
                (Some(_), _) => check.changed.push(name.clone()),
                (None, _) => check.unknown.push(name.clone()),
            }
            check.existing.push(name);
        }
        check
    }
}

/// Of `paths` (files an export is about to write), those already there, and
/// which of them this app did not write as they are now.
#[tauri::command]
pub(crate) async fn check_written_files(
    written: tauri::State<'_, Written>,
    paths: Vec<String>,
) -> Result<WrittenCheck, ()> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    Ok(written.check(&files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_own_files_as_written_are_not_asked_about_but_changed_or_strange_ones_are() {
        let folder = tempfile::tempdir().unwrap();
        let dir = folder.path().to_path_buf();
        let list = dir.join("written.json");
        let written = Written::load(list.clone());
        let ours = dir.join("第4話_001.png");
        let theirs = dir.join("第4話_002.png");
        let missing = dir.join("第4話_003.png");
        std::fs::write(&ours, b"page 1").unwrap();
        std::fs::write(&theirs, b"painted elsewhere").unwrap();
        written.record(&ours);
        let all = [ours.clone(), theirs.clone(), missing.clone()];
        let check = written.check(&all);
        assert_eq!(check.existing, ["第4話_001.png", "第4話_002.png"]);
        assert!(check.changed.is_empty());
        assert_eq!(check.unknown, ["第4話_002.png"]);
        // Kept between runs.
        let again = Written::load(list.clone());
        assert_eq!(again.check(&all), check);
        // Drawn on since: asked about.
        std::fs::write(&ours, b"page 1 with an editor's notes").unwrap();
        assert_eq!(again.check(&all).changed, ["第4話_001.png"]);
        // Written again by the app: its own once more.
        again.record(&ours);
        assert!(again.check(&all).changed.is_empty());
        // A list that cannot be read is an empty one: everything there is asked about.
        std::fs::write(&list, b"not json").unwrap();
        assert_eq!(Written::load(list).check(&all).unknown.len(), 2);
    }

    #[test]
    fn the_oldest_are_forgotten_first() {
        let folder = tempfile::tempdir().unwrap();
        let dir = folder.path().to_path_buf();
        let written = Written::default();
        let first = dir.join("first.png");
        std::fs::write(&first, b"1").unwrap();
        written.record(&first);
        for index in 0..KEEP {
            let other = dir.join(format!("{index}.png"));
            std::fs::write(&other, b"x").unwrap();
            written.record(&other);
        }
        assert_eq!(written.check(&[first]).unknown, ["first.png"]);
    }
}
