//! Files outside the name data: CSP's tools, the PDF and the script.

use std::path::{Path, PathBuf};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfMeta {
    path: String,
    title: String,
    right_to_left: bool,
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
        let pdf = name_model::pdf::image_pdf(&meta.title, &pages, meta.right_to_left);
        write_through_temporary(Path::new(&meta.path), &pdf)
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

fn write_through_temporary(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}
