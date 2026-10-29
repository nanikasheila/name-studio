//! Files outside the name data: CSP's tools, the PDF, the ミニネーム picture and the script.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ipc::{raw_body, split_body};

/// Where CSP keeps its tools and materials on this computer, when found.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CspToolLocations {
    tools: Option<String>,
    materials: Option<String>,
}

#[tauri::command]
pub(crate) async fn csp_tool_locations() -> CspToolLocations {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return CspToolLocations {
            tools: None,
            materials: None,
        };
    };
    let (tools, materials) = clip_core::subtool::default_locations(Path::new(&appdata));
    CspToolLocations {
        tools: tools.is_file().then(|| tools.display().to_string()),
        materials: materials.is_dir().then(|| materials.display().to_string()),
    }
}

/// Pens and erasers of a .sut or of CSP's tool database (read from a copy).
#[tauri::command]
pub(crate) async fn read_csp_sub_tools(
    path: String,
    materials: Option<String>,
) -> Result<Vec<clip_core::subtool::SubTool>, String> {
    clip_core::subtool::read_sub_tools(&path, materials.as_deref().map(Path::new)).map_err(|error| error.to_string())
}

/// What writing a sub tool for CSP left out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WrittenSubTool {
    /// Materials (brush tips, paper) the settings use that were not found.
    missing_materials: Vec<String>,
}

/// A brush's CSP settings as a .sut for CSP's ツールの読み込み (CSP names
/// the tool after the file). `materials` is CSP's material folder, where
/// the tips and papers it uses are packed from.
#[tauri::command]
pub(crate) async fn write_csp_sub_tool(
    path: String,
    tool: name_model::CspToolData,
    name: String,
    materials: Option<String>,
) -> Result<WrittenSubTool, String> {
    let file = clip_core::subtool::sub_tool_file(&tool, &name, materials.as_deref().map(Path::new))
        .map_err(|error| error.to_string())?;
    name_model::atomic::write(Path::new(&path), &file.bytes).map_err(|error| error.to_string())?;
    Ok(WrittenSubTool {
        missing_materials: file.missing_materials,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfMeta {
    path: String,
    title: String,
    right_to_left: bool,
    /// 縦スクロール: one page under the other.
    #[serde(default)]
    scroll: bool,
    pages: Vec<PdfPageMeta>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfPageMeta {
    width_mm: f64,
    height_mm: f64,
    width_px: u32,
    height_px: u32,
    length: usize,
}

/// Write a PDF of page images (raw body: JSON, then the JPEGs in page order).
#[tauri::command]
pub(crate) async fn write_pdf(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (meta, mut rest) = split_body::<PdfMeta>(&body)?;
        let mut pages = Vec::new();
        for page in &meta.pages {
            let jpeg = rest.get(..page.length).ok_or("データが壊れています")?;
            rest = &rest[page.length..];
            pages.push(name_model::pdf::PdfImagePage {
                width_mm: page.width_mm,
                height_mm: page.height_mm,
                width_px: page.width_px,
                height_px: page.height_px,
                jpeg: jpeg.to_vec(),
            });
        }
        let layout = if meta.scroll {
            name_model::pdf::PdfLayout::Scroll
        } else if meta.right_to_left {
            name_model::pdf::PdfLayout::RightToLeft
        } else {
            name_model::pdf::PdfLayout::LeftToRight
        };
        let pdf = name_model::pdf::image_pdf(&meta.title, &pages, layout);
        write_through_temporary(Path::new(&meta.path), &pdf)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
pub(crate) struct BinaryMeta {
    path: String,
}

/// Write a file the page made (the ミニネーム picture; raw body: JSON with
/// the path, then the bytes).
#[tauri::command]
pub(crate) async fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let body = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (meta, bytes) = split_body::<BinaryMeta>(&body)?;
        if bytes.is_empty() {
            return Err("書き出す中身がありません".to_owned());
        }
        write_through_temporary(Path::new(&meta.path), bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Write a text file (the script) as UTF-8 with a byte order mark, which
/// Windows' Notepad and Excel read as UTF-8.
#[tauri::command]
pub(crate) async fn write_text_file(path: String, text: String) -> Result<(), String> {
    let mut bytes = "\u{FEFF}".as_bytes().to_vec();
    bytes.extend_from_slice(text.replace('\n', "\r\n").as_bytes());
    write_through_temporary(Path::new(&path), &bytes)
}

/// The record of セリフだけ反映 kept with the CSP pages, one entry per run.
pub(crate) const UPDATE_RECORD: &str = "name-studio-反映の記録.txt";

/// Adds `entry` to the record in the export folder `out_dir` (newest last,
/// as a log reads), so what each run changed can be looked at again later,
/// from this app or with Notepad.
#[tauri::command]
pub(crate) async fn record_dialogue_update(out_dir: String, entry: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || add_record(&Path::new(&out_dir).join(UPDATE_RECORD), &entry))
        .await
        .map_err(|error| error.to_string())?
}

fn add_record(file: &Path, entry: &str) -> Result<(), String> {
    let mut text = match std::fs::read_to_string(file) {
        Ok(text) => text.trim_start_matches('\u{FEFF}').replace("\r\n", "\n"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    if !text.is_empty() && !text.ends_with("\n\n") {
        text.push_str(if text.ends_with('\n') { "\n" } else { "\n\n" });
    }
    text.push_str(entry.trim_end());
    text.push('\n');
    let mut bytes = "\u{FEFF}".as_bytes().to_vec();
    bytes.extend_from_slice(text.replace('\n', "\r\n").as_bytes());
    write_through_temporary(file, &bytes)
}

fn write_through_temporary(path: &Path, bytes: &[u8]) -> Result<(), String> {
    name_model::atomic::write(path, bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_update_record_grows_one_entry_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(UPDATE_RECORD);
        add_record(&file, "2026-10-28 10:00 セリフだけ反映\n3 ページ: 足した 1\n").unwrap();
        add_record(&file, "2026-10-28 11:00 セリフだけ反映\n5 ページ: （旧）にして隠した 2").unwrap();
        let bytes = std::fs::read(&file).unwrap();
        // UTF-8 with a byte order mark and Windows line ends, as Notepad reads it.
        assert!(bytes.starts_with("\u{FEFF}".as_bytes()));
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(
            text.trim_start_matches('\u{FEFF}'),
            "2026-10-28 10:00 セリフだけ反映\r\n3 ページ: 足した 1\r\n\r\n2026-10-28 11:00 セリフだけ反映\r\n5 ページ: （旧）にして隠した 2\r\n"
        );
    }
}
