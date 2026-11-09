//! Which places on the disk the user chose, and the checks before a file is
//! written there.
//!
//! The screen asks for files to be written by path, and a command must not
//! write wherever a request says: what runs in the window is this app's own
//! code, but it shows text from name files, from CSP pages and from an AI,
//! and a mistake there must not become "write this file anywhere". So the
//! file dialogs are opened here ([`crate::dialogs`]), every place picked in
//! one is remembered ([`Chosen`]), and the commands that write a file of the
//! screen's making (a PDF, a picture, the script, a CSP sub tool) take only
//!
//! - a path of their own kind (a PDF ends in `.pdf`: never a program or a script),
//! - at a place that was picked in a dialog, now or in an earlier run (written
//!   again with 「前回と同じ設定で書き出す」), or named on the command line.
//!
//! A path that is refused only for not having been picked says so
//! ([`UNCHOSEN`]); the screen asks first (`place_chosen`) and opens the dialog
//! instead of writing to a place it only remembers.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// How the refusal of a place not picked in a dialog begins.
pub const UNCHOSEN: &str = "保存先を選び直してください";

/// How many picked places are remembered from run to run (the oldest go first).
const KEEP: usize = 400;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
struct Places {
    /// Files picked (to open or to save), oldest first.
    #[serde(default)]
    files: VecDeque<String>,
    /// Folders picked: everything under them counts as picked.
    #[serde(default)]
    folders: VecDeque<String>,
}

/// The places picked in a dialog, kept in a file of the app's own between runs.
#[derive(Debug, Default)]
pub struct Chosen {
    places: Mutex<Places>,
    /// Places good for this run only (the command line's), never written down.
    once: Mutex<Places>,
    file: Option<PathBuf>,
}

/// A path as compared: its parts joined one way, and without case on Windows
/// (where `C:\Out` and `c:/out` are one place).
fn key(path: &Path) -> String {
    let parts: PathBuf = path.components().collect();
    let text = parts.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { text.to_lowercase() } else { text }
}

fn remember(list: &mut VecDeque<String>, key: String) {
    list.retain(|kept| *kept != key);
    list.push_back(key);
    while list.len() > KEEP {
        list.pop_front();
    }
}

impl Places {
    fn holds(&self, key: &str) -> bool {
        self.files.iter().any(|file| file == key)
            || self.folders.iter().any(|folder| {
                key == folder
                    || key
                        .strip_prefix(folder.as_str())
                        .is_some_and(|rest| rest.starts_with('/') || folder.ends_with('/'))
            })
    }
}

impl Chosen {
    /// The places kept in `file` (none when it is missing or cannot be read: they are picked again).
    pub fn load(file: PathBuf) -> Self {
        let places = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            places: Mutex::new(places),
            once: Mutex::default(),
            file: Some(file),
        }
    }

    fn keep(&self, change: impl FnOnce(&mut Places)) {
        let Ok(mut places) = self.places.lock() else { return };
        change(&mut places);
        if let (Some(file), Ok(text)) = (&self.file, serde_json::to_string(&*places)) {
            // Not kept (a full disk): the place is asked for again next time, nothing worse.
            let _ = name_model::atomic::write(file, text.as_bytes());
        }
    }

    /// A file picked in a dialog.
    pub fn file(&self, path: &Path) {
        self.keep(|places| remember(&mut places.files, key(path)));
    }

    /// A folder picked in a dialog: it and all under it.
    pub fn folder(&self, path: &Path) {
        self.keep(|places| remember(&mut places.folders, key(path)));
    }

    /// A file named on the command line: good for this run.
    pub fn file_once(&self, path: &Path) {
        if let Ok(mut once) = self.once.lock() {
            remember(&mut once.files, key(path));
        }
    }

    /// Whether `path` was picked: itself, or a folder above it.
    pub fn holds(&self, path: &Path) -> bool {
        let key = key(path);
        [&self.places, &self.once]
            .into_iter()
            .any(|places| places.lock().is_ok_and(|places| places.holds(&key)))
    }

    /// `path` as a place to write a file of one of `kinds` (extensions, lower
    /// case): whole (no `..`), of that kind, and picked.
    pub fn writable(&self, path: &str, kinds: &[&str]) -> Result<PathBuf, String> {
        // What the command line named is the user's own word, whatever it ends in.
        let named = Path::new(path);
        if self.once.lock().is_ok_and(|once| once.files.contains(&key(named))) {
            return Ok(named.to_path_buf());
        }
        let path = of_kind(path, kinds)?;
        if !self.holds(&path) {
            return Err(format!(
                "{UNCHOSEN}（この場所はまだ選ばれていません）: {}",
                path.display()
            ));
        }
        Ok(path)
    }
}

/// `path` when it is a whole path to a file of one of `kinds`.
pub fn of_kind(path: &str, kinds: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let whole = path.is_absolute() && !path.components().any(|part| matches!(part, Component::ParentDir));
    if !whole || path.file_name().is_none() {
        return Err(format!("書き出す場所が正しくありません: {}", path.display()));
    }
    let kind = path.extension().map(|kind| kind.to_string_lossy().to_lowercase());
    if !kind.as_deref().is_some_and(|kind| kinds.contains(&kind)) {
        return Err(format!(
            "この種類のファイルには書き出せません（{} だけ）: {}",
            kinds
                .iter()
                .map(|kind| format!(".{kind}"))
                .collect::<Vec<_>>()
                .join("・"),
            path.display()
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(tail: &str) -> String {
        if cfg!(windows) {
            format!("C:\\{}", tail.replace('/', "\\"))
        } else {
            format!("/{tail}")
        }
    }

    #[test]
    fn a_file_is_written_only_as_its_own_kind() {
        assert!(of_kind(&whole("out/name.pdf"), &["pdf"]).is_ok());
        assert!(of_kind(&whole("out/NAME.PDF"), &["pdf"]).is_ok());
        assert!(of_kind(&whole("out/start.bat"), &["pdf"]).is_err());
        assert!(of_kind(&whole("out/name.pdf.exe"), &["pdf"]).is_err());
        assert!(of_kind(&whole("out/name"), &["pdf"]).is_err());
    }

    #[test]
    fn a_path_must_be_whole() {
        assert!(of_kind("name.pdf", &["pdf"]).is_err());
        assert!(of_kind(&whole("out/../elsewhere/name.pdf"), &["pdf"]).is_err());
        assert!(of_kind("", &["pdf"]).is_err());
    }

    #[test]
    fn only_a_place_picked_is_written_to() {
        let chosen = Chosen::default();
        let pdf = whole("out/name.pdf");
        let refused = chosen.writable(&pdf, &["pdf"]).unwrap_err();
        assert!(refused.starts_with(UNCHOSEN), "{refused}");
        chosen.file(Path::new(&pdf));
        assert!(chosen.writable(&pdf, &["pdf"]).is_ok());
        // Another file beside it was not picked; one under a picked folder is.
        assert!(chosen.writable(&whole("out/other.pdf"), &["pdf"]).is_err());
        chosen.folder(Path::new(&whole("pages")));
        assert!(chosen.writable(&whole("pages/deep/mini.png"), &["png", "jpg"]).is_ok());
        assert!(chosen.writable(&whole("pages2/mini.png"), &["png"]).is_err());
        // Of the wrong kind it is refused as that, picked or not.
        chosen.file(Path::new(&whole("out/run.cmd")));
        assert!(
            !chosen
                .writable(&whole("out/run.cmd"), &["txt"])
                .unwrap_err()
                .starts_with(UNCHOSEN)
        );
    }

    #[test]
    fn the_command_lines_file_is_good_for_the_run_only() {
        let dir = tempfile::tempdir().unwrap();
        let kept = dir.path().join("chosen.json");
        let chosen = Chosen::load(kept.clone());
        let report = whole("out/report.json");
        chosen.file_once(Path::new(&report));
        chosen.file(Path::new(&whole("out/name.pdf")));
        assert!(chosen.holds(Path::new(&report)));
        let again = Chosen::load(kept);
        assert!(again.holds(Path::new(&whole("out/name.pdf"))));
        assert!(!again.holds(Path::new(&report)));
    }

    #[test]
    fn the_command_lines_file_is_written_whatever_it_ends_in() {
        let chosen = Chosen::default();
        let report = whole("out/report.log");
        assert!(chosen.writable(&report, &["txt", "json"]).is_err());
        chosen.file_once(Path::new(&report));
        assert!(chosen.writable(&report, &["txt", "json"]).is_ok());
    }

    #[test]
    fn the_oldest_places_go_first() {
        let chosen = Chosen::default();
        for i in 0..KEEP + 5 {
            chosen.file(Path::new(&whole(&format!("out/{i}.pdf"))));
        }
        assert!(!chosen.holds(Path::new(&whole("out/0.pdf"))));
        assert!(chosen.holds(Path::new(&whole(&format!("out/{}.pdf", KEEP + 4)))));
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_are_one_place_in_any_case_and_slash() {
        let chosen = Chosen::default();
        chosen.folder(Path::new("C:\\Out\\Pages"));
        assert!(chosen.holds(Path::new("c:/out/pages/1.png")));
    }
}
