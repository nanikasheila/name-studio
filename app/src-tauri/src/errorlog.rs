//! エラーの記録: each error the app meets (from the front end, or a panic
//! here) is appended to `logs/name-studio.log` in the app's local data folder,
//! so a problem seen once can be looked into later. The log is kept small:
//! past [`MAX_BYTES`] it moves to `name-studio.old.log` and starts again.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_BYTES: u64 = 1024 * 1024;

/// The log file and the app's version.
static LOG: OnceLock<(PathBuf, String)> = OnceLock::new();

/// Log into `root/logs`, and note panics there too.
pub fn init(root: &Path, version: String) {
    let _ = LOG.set((root.join("logs").join("name-studio.log"), version));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append(&format!("panic: {info}"));
        previous(info);
    }));
}

/// Append one entry (with the time and the app version); errors writing it are ignored.
pub fn append(message: &str) {
    if let Some((path, version)) = LOG.get() {
        let _ = append_to(path, version, message, now_secs());
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn append_to(path: &Path, version: &str, message: &str, time_secs: u64) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        std::fs::rename(path, path.with_extension("old.log"))?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "[{time_secs}] v{version} {}", message.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_rolls_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("name-studio.log");
        append_to(&path, "0.2.9", "first\n", 1).unwrap();
        append_to(&path, "0.2.9", "second", 2).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("[1] v0.2.9 first"));
        assert!(text.contains("first\n[2]"));
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        append_to(&path, "0.2.9", "third", 3).unwrap();
        assert!(path.with_extension("old.log").exists());
        assert!(std::fs::read_to_string(&path).unwrap().contains("third"));
    }
}
