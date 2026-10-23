//! What an export wrote, kept next to it, so the next export into the same
//! folder can tell pages CSP has changed since (ペン入れ) from its own.
//!
//! The list is `.name-studio-export.json` in the folder: each written file's
//! name, size and modification time, and the dialogue it was written with
//! (so updating the dialogue later can tell its own texts from ones added in
//! CSP).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

pub const MANIFEST_NAME: &str = ".name-studio-export.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub written_ms: u64,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
    /// What was written into the page (none for the work, or from older versions).
    #[serde(flatten)]
    pub record: PageRecord,
}

/// What an export wrote into a page, to tell later what changed in CSP.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texts: Option<Vec<String>>,
    /// Each vector layer's [`crate::vector::shape_signature`], by layer name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vectors: BTreeMap<String, String>,
}

fn stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((meta.len(), modified))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record the files just written into `dir` (files elsewhere are left out),
/// each with what was written into it when known.
pub fn write_manifest(dir: &Path, files: &[(PathBuf, PageRecord)]) -> std::io::Result<()> {
    let files = files
        .iter()
        .filter(|(path, _)| path.parent() == Some(dir))
        .filter_map(|(path, record)| {
            let (size, modified_ms) = stamp(path)?;
            Some(ManifestFile {
                name: path.file_name()?.to_string_lossy().into_owned(),
                size,
                modified_ms,
                record: record.clone(),
            })
        })
        .collect();
    save(
        dir,
        &Manifest {
            written_ms: now_ms(),
            files,
        },
    )
}

fn save(dir: &Path, manifest: &Manifest) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(manifest).map_err(std::io::Error::other)?;
    std::fs::write(dir.join(MANIFEST_NAME), text)
}

fn load(dir: &Path) -> Option<Manifest> {
    std::fs::read_to_string(dir.join(MANIFEST_NAME))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// What the last export (or update) wrote into `page`, when recorded.
pub fn written(page: &Path) -> Option<PageRecord> {
    let name = page.file_name()?.to_string_lossy();
    Some(
        load(page.parent()?)?
            .files
            .into_iter()
            .find(|file| file.name == name)?
            .record,
    )
}

/// Record that `page` now holds `record` from this tool, leaving its size and
/// time as they were: the page still counts as changed in CSP.
pub fn record_page(page: &Path, record: PageRecord) -> std::io::Result<()> {
    let (Some(dir), Some(name)) = (page.parent(), page.file_name()) else {
        return Ok(());
    };
    let Some(mut manifest) = load(dir) else {
        return Ok(());
    };
    let name = name.to_string_lossy();
    if let Some(file) = manifest.files.iter_mut().find(|file| file.name == name) {
        file.record = record;
        save(dir, &manifest)?;
    }
    Ok(())
}

/// CSP files already in a folder an export would write into.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteCheck {
    /// Every .clip / .cmc there, sorted.
    pub existing: Vec<String>,
    /// Written by the last export and changed since (saved in CSP).
    pub changed: Vec<String>,
    /// Not from the last export (another tool, an older version, or by hand).
    pub unknown: Vec<String>,
    /// When the last export there was written.
    pub last_export_ms: Option<u64>,
}

/// What exporting into `dir` would overwrite.
pub fn check_overwrite(dir: &Path) -> OverwriteCheck {
    let mut check = OverwriteCheck::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return check;
    };
    let manifest = load(dir);
    check.last_export_ms = manifest.as_ref().map(|m| m.written_ms);
    let mut names: Vec<(String, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("clip") || ext.eq_ignore_ascii_case("cmc"))
        })
        .filter_map(|path| Some((path.file_name()?.to_string_lossy().into_owned(), path)))
        .collect();
    names.sort();
    for (name, path) in names {
        let recorded = manifest
            .as_ref()
            .and_then(|m| m.files.iter().find(|file| file.name == name));
        match (recorded, stamp(&path)) {
            (Some(file), Some((size, modified))) if file.size == size && file.modified_ms == modified => {}
            (Some(_), _) => check.changed.push(name.clone()),
            (None, _) => check.unknown.push(name.clone()),
        }
        check.existing.push(name);
    }
    check
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_changed_pages_from_its_own() {
        let dir = std::env::temp_dir().join(format!("manifest-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(check_overwrite(&dir), OverwriteCheck::default());
        let pages: Vec<PathBuf> = ["page0001.clip", "page0002.clip", "作品.cmc"]
            .iter()
            .map(|name| dir.join(name))
            .collect();
        for page in &pages {
            std::fs::write(page, b"written").unwrap();
        }
        let record = |text: &str| PageRecord {
            texts: Some(vec![text.to_owned()]),
            vectors: BTreeMap::from([("フキダシ".to_owned(), "1:0".to_owned())]),
        };
        let written_pages: Vec<(PathBuf, PageRecord)> =
            pages.iter().map(|page| (page.clone(), record("セリフ"))).collect();
        write_manifest(&dir, &written_pages).unwrap();
        assert_eq!(written(&pages[0]), Some(record("セリフ")));
        record_page(&pages[0], record("直したセリフ")).unwrap();
        assert_eq!(written(&pages[0]), Some(record("直したセリフ")));
        let check = check_overwrite(&dir);
        assert_eq!(check.existing.len(), 3);
        assert!(check.changed.is_empty() && check.unknown.is_empty());
        assert!(check.last_export_ms.is_some());
        // CSP saves page 2; a page from elsewhere turns up.
        std::fs::write(&pages[1], b"drawn over in CSP").unwrap();
        std::fs::write(dir.join("page0003.clip"), b"?").unwrap();
        std::fs::write(dir.join("notes.txt"), b"not a page").unwrap();
        let check = check_overwrite(&dir);
        assert_eq!(check.changed, ["page0002.clip"]);
        assert_eq!(check.unknown, ["page0003.clip"]);
        assert_eq!(check.existing.len(), 4);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
