//! The fonts on this computer, for choosing what dialogue is set in.
//!
//! Font files in the system and user font folders are read only as far as
//! their table directory, `name` and `OS/2`: a folder of large Japanese
//! fonts lists in a moment. Names are taken as CLIP STUDIO PAINT shows them
//! (the full name, in Japanese when the font has one), with the family and
//! weight a web page needs to draw them and the PostScript name CSP keeps
//! next to the shown one in a text layer.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// One font face.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    /// Full name, as CSP lists it (`游明朝 Demibold`).
    pub name: String,
    /// Family names to draw it by, the Japanese one first.
    pub families: Vec<String>,
    pub postscript: String,
    /// `OS/2` weight class (400 regular, 700 bold).
    pub weight: u16,
    pub italic: bool,
    /// Has the Japanese code page (JIS).
    pub japanese: bool,
}

const JAPANESE: u16 = 0x0411;
const ENGLISH_US: u16 = 0x0409;
/// Name ids: family, full name, PostScript name, typographic family.
const FAMILY: u16 = 1;
const FULL_NAME: u16 = 4;
const POSTSCRIPT: u16 = 6;
const TYPOGRAPHIC_FAMILY: u16 = 16;

/// The fonts in the system and user font folders, by name.
#[tauri::command]
pub(crate) async fn list_fonts() -> Result<Vec<FontFace>, String> {
    tauri::async_runtime::spawn_blocking(|| faces_in(&font_folders()))
        .await
        .map_err(|error| error.to_string())
}

fn font_folders() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut folders = Vec::new();
    if cfg!(windows) {
        let windows = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        folders.push(windows.join("Fonts"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            folders.push(PathBuf::from(local).join(r"Microsoft\Windows\Fonts"));
        }
    } else if cfg!(target_os = "macos") {
        folders.extend(["/System/Library/Fonts", "/Library/Fonts"].map(PathBuf::from));
        folders.extend(home.iter().map(|home| home.join("Library/Fonts")));
    } else {
        folders.extend(["/usr/share/fonts", "/usr/local/share/fonts"].map(PathBuf::from));
        folders.extend(
            home.iter()
                .flat_map(|home| [home.join(".local/share/fonts"), home.join(".fonts")]),
        );
    }
    folders
}

/// Every face in the font files under `folders` (and their subfolders),
/// one per name, Japanese fonts first, then by name.
pub fn faces_in(folders: &[PathBuf]) -> Vec<FontFace> {
    let mut files = Vec::new();
    for folder in folders {
        collect_files(folder, 0, &mut files);
    }
    let mut faces: Vec<FontFace> = files
        .iter()
        .flat_map(|path| read_faces(path).unwrap_or_default())
        .collect();
    faces.sort_by(|a, b| b.japanese.cmp(&a.japanese).then_with(|| a.name.cmp(&b.name)));
    faces.dedup_by(|a, b| a.name == b.name);
    faces
}

fn collect_files(folder: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < 4 {
                collect_files(&path, depth + 1, files);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ["ttf", "otf", "ttc", "otc"].contains(&e.to_ascii_lowercase().as_str()))
        {
            files.push(path);
        }
    }
}

fn read_at(file: &mut File, offset: u64, length: usize) -> Option<Vec<u8>> {
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// The faces of one font file (several in a collection).
fn read_faces(path: &Path) -> Option<Vec<FontFace>> {
    let mut file = File::open(path).ok()?;
    let head = read_at(&mut file, 0, 12)?;
    let offsets: Vec<u64> = if &head[0..4] == b"ttcf" {
        let count = u32_at(&head, 8)?.min(64) as usize;
        let table = read_at(&mut file, 12, count * 4)?;
        (0..count)
            .filter_map(|i| u32_at(&table, i * 4).map(u64::from))
            .collect()
    } else {
        vec![0]
    };
    Some(
        offsets
            .into_iter()
            .filter_map(|offset| read_face(&mut file, offset))
            .collect(),
    )
}

fn read_face(file: &mut File, offset: u64) -> Option<FontFace> {
    let header = read_at(file, offset, 12)?;
    let tables = u16_at(&header, 4)? as usize;
    let directory = read_at(file, offset + 12, tables * 16)?;
    let table = |tag: &[u8; 4]| {
        (0..tables).find_map(|i| {
            let record = &directory[i * 16..i * 16 + 16];
            (&record[0..4] == tag).then(|| {
                (
                    u64::from(u32_at(record, 8).unwrap_or(0)),
                    u32_at(record, 12).unwrap_or(0) as usize,
                )
            })
        })
    };
    let (name_at, name_length) = table(b"name")?;
    let names = parse_names(&read_at(file, name_at, name_length.min(1 << 20))?);
    let (weight, italic, japanese) = match table(b"OS/2") {
        Some((at, length)) => read_at(file, at, length.min(100))
            .map(|os2| parse_os2(&os2))
            .unwrap_or((400, false, false)),
        None => (400, false, false),
    };
    let pick = |id: u16| {
        names
            .iter()
            .filter(|n| n.id == id)
            .max_by_key(|n| n.rank)
            .map(|n| n.text.clone())
    };
    let all = |id: u16| {
        let mut found: Vec<&Name> = names.iter().filter(|n| n.id == id).collect();
        found.sort_by_key(|n| std::cmp::Reverse(n.rank));
        found.into_iter().map(|n| n.text.clone()).collect::<Vec<_>>()
    };
    let name = pick(FULL_NAME).or_else(|| pick(FAMILY))?;
    let mut families = all(TYPOGRAPHIC_FAMILY);
    families.extend(all(FAMILY));
    families.dedup();
    let mut unique = Vec::new();
    for family in families {
        if !unique.contains(&family) {
            unique.push(family);
        }
    }
    // macOS keeps hidden system faces under names starting with a dot.
    if name.trim().is_empty() || name.starts_with('.') {
        return None;
    }
    let japanese = japanese || names.iter().any(|n| n.language == Some(JAPANESE));
    Some(FontFace {
        name,
        families: unique,
        postscript: pick(POSTSCRIPT).unwrap_or_default(),
        weight,
        italic,
        japanese,
    })
}

struct Name {
    id: u16,
    text: String,
    /// Windows Japanese over Windows English over other Windows names over Mac Roman.
    rank: u8,
    language: Option<u16>,
}

fn parse_names(table: &[u8]) -> Vec<Name> {
    let (Some(count), Some(storage)) = (u16_at(table, 2), u16_at(table, 4)) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for i in 0..count as usize {
        let at = 6 + i * 12;
        let fields: Option<Vec<u16>> = (0..6).map(|k| u16_at(table, at + k * 2)).collect();
        let Some(&[platform, encoding, language, id, length, offset]) = fields.as_deref() else {
            break;
        };
        if ![FAMILY, FULL_NAME, POSTSCRIPT, TYPOGRAPHIC_FAMILY].contains(&id) {
            continue;
        }
        let start = storage as usize + offset as usize;
        let Some(bytes) = table.get(start..start + length as usize) else {
            continue;
        };
        let (text, rank, language) = match (platform, encoding) {
            (3, 0 | 1 | 10) | (0, _) => {
                let units: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|&pair| u16::from_be_bytes(pair))
                    .collect();
                let rank = match language {
                    JAPANESE => 3,
                    ENGLISH_US => 2,
                    _ => 1,
                };
                (
                    String::from_utf16_lossy(&units),
                    rank,
                    (platform == 3).then_some(language),
                )
            }
            (1, 0) => (bytes.iter().map(|&b| b as char).collect(), 0, None),
            _ => continue,
        };
        let text = text.trim_matches(char::from(0)).trim().to_string();
        if !text.is_empty() {
            names.push(Name {
                id,
                text,
                rank,
                language,
            });
        }
    }
    names
}

/// Weight class, italic (fsSelection bit 0) and the JIS code page (ulCodePageRange1 bit 17).
fn parse_os2(table: &[u8]) -> (u16, bool, bool) {
    let weight = u16_at(table, 4).unwrap_or(400);
    let italic = u16_at(table, 62).is_some_and(|flags| flags & 1 != 0);
    let japanese = u16_at(table, 0).is_some_and(|version| version >= 1)
        && u32_at(table, 78).is_some_and(|pages| pages & (1 << 17) != 0);
    (weight, italic, japanese)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A font file with only `name` and `OS/2`: enough to be listed.
    fn tiny_font(names: &[(u16, u16, u16, &str)], weight: u16) -> Vec<u8> {
        let mut strings = Vec::new();
        let mut records = Vec::new();
        for &(platform, language, id, text) in names {
            let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
            for value in [platform, 1, language, id, bytes.len() as u16, strings.len() as u16] {
                records.extend(value.to_be_bytes());
            }
            strings.extend(bytes);
        }
        let mut name = Vec::new();
        for value in [0u16, names.len() as u16, 6 + records.len() as u16] {
            name.extend(value.to_be_bytes());
        }
        name.extend(records);
        name.extend(strings);
        let mut os2 = vec![0u8; 86];
        os2[0..2].copy_from_slice(&1u16.to_be_bytes());
        os2[4..6].copy_from_slice(&weight.to_be_bytes());
        os2[78..82].copy_from_slice(&(1u32 << 17).to_be_bytes());
        let tables: [(&[u8; 4], &Vec<u8>); 2] = [(b"OS/2", &os2), (b"name", &name)];
        let mut font = Vec::new();
        font.extend(0x0001_0000u32.to_be_bytes());
        font.extend(2u16.to_be_bytes());
        font.extend([0u8; 6]);
        let mut offset = 12 + 16 * tables.len();
        for (tag, data) in tables {
            font.extend(*tag);
            font.extend(0u32.to_be_bytes());
            font.extend((offset as u32).to_be_bytes());
            font.extend((data.len() as u32).to_be_bytes());
            offset += data.len();
        }
        for (_, data) in tables {
            font.extend(data.iter());
        }
        font
    }

    #[test]
    fn lists_faces_by_their_japanese_full_name() {
        let folder = tempfile::tempdir().unwrap();
        let mincho = tiny_font(
            &[
                (3, ENGLISH_US, FAMILY, "Yu Mincho Demibold"),
                (3, JAPANESE, FAMILY, "游明朝 Demibold"),
                (3, ENGLISH_US, FULL_NAME, "Yu Mincho Demibold"),
                (3, JAPANESE, FULL_NAME, "游明朝 Demibold"),
                (3, ENGLISH_US, POSTSCRIPT, "YuMin-Demibold"),
                (3, ENGLISH_US, TYPOGRAPHIC_FAMILY, "Yu Mincho"),
                (3, JAPANESE, TYPOGRAPHIC_FAMILY, "游明朝"),
            ],
            600,
        );
        std::fs::write(folder.path().join("yumin.ttf"), mincho).unwrap();
        std::fs::write(folder.path().join("readme.txt"), "not a font").unwrap();
        std::fs::write(folder.path().join("broken.otf"), [0u8; 5]).unwrap();
        let faces = faces_in(&[folder.path().to_path_buf()]);
        assert_eq!(faces.len(), 1);
        let face = &faces[0];
        assert_eq!(face.name, "游明朝 Demibold");
        assert_eq!(face.postscript, "YuMin-Demibold");
        assert_eq!(
            face.families,
            ["游明朝", "Yu Mincho", "游明朝 Demibold", "Yu Mincho Demibold"]
        );
        assert_eq!(face.weight, 600);
        assert!(face.japanese && !face.italic);
    }
}
