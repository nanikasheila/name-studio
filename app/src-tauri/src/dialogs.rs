//! The file dialogs, opened from here so that what is picked in them is
//! known on this side ([`crate::paths::Chosen`]): the commands that write
//! take only places picked. The options are the dialog plugin's own (the
//! screen calls these as it called the plugin).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Window};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

use crate::paths::Chosen;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenOptions {
    title: Option<String>,
    #[serde(default)]
    filters: Vec<FileFilter>,
    /// Several files at once.
    #[serde(default)]
    multiple: bool,
    /// A folder, not a file.
    #[serde(default)]
    directory: bool,
    default_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveOptions {
    title: Option<String>,
    #[serde(default)]
    filters: Vec<FileFilter>,
    default_path: Option<PathBuf>,
}

/// What was picked: nothing (the dialog was closed), one path or several.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum Picked {
    One(Option<String>),
    Many(Option<Vec<String>>),
}

/// Start the dialog at `path`: in its folder with its name filled in, or in it when it is a folder.
fn start_at(builder: FileDialogBuilder<tauri::Wry>, path: PathBuf) -> FileDialogBuilder<tauri::Wry> {
    // Windows wants its own separators (tauri-apps/tauri#8074).
    let path: PathBuf = path.components().collect();
    if path.is_dir() {
        return builder.set_directory(path);
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            let builder = if parent.components().count() > 0 {
                builder.set_directory(parent)
            } else {
                builder
            };
            builder.set_file_name(name.to_string_lossy())
        }
        _ => builder.set_directory(path),
    }
}

fn dialog(
    window: &Window,
    title: Option<String>,
    filters: Vec<FileFilter>,
    default_path: Option<PathBuf>,
) -> FileDialogBuilder<tauri::Wry> {
    let mut builder = window.app_handle().dialog().file().set_parent(window);
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    if let Some(path) = default_path {
        builder = start_at(builder, path);
    }
    for filter in filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(filter.name, &extensions);
    }
    builder
}

/// Ask for a file (or files, or a folder) to open.
#[tauri::command]
pub(crate) async fn choose_open(
    window: Window,
    chosen: tauri::State<'_, Chosen>,
    options: OpenOptions,
) -> Result<Picked, String> {
    let builder = dialog(&window, options.title, options.filters, options.default_path);
    if options.directory {
        let folder = builder
            .blocking_pick_folder()
            .and_then(|folder| folder.into_path().ok());
        if let Some(folder) = &folder {
            chosen.folder(folder);
        }
        return Ok(Picked::One(folder.map(|folder| folder.display().to_string())));
    }
    if options.multiple {
        let files: Option<Vec<PathBuf>> = builder
            .blocking_pick_files()
            .map(|files| files.into_iter().filter_map(|file| file.into_path().ok()).collect());
        for file in files.iter().flatten() {
            chosen.file(file);
        }
        return Ok(Picked::Many(
            files.map(|files| files.iter().map(|file| file.display().to_string()).collect()),
        ));
    }
    let file = builder.blocking_pick_file().and_then(|file| file.into_path().ok());
    if let Some(file) = &file {
        chosen.file(file);
    }
    Ok(Picked::One(file.map(|file| file.display().to_string())))
}

/// `file` with the first of `filters`' extensions when it has none of them (a
/// name typed without one where the dialog does not complete it).
fn with_extension(file: PathBuf, filters: &[FileFilter]) -> PathBuf {
    let extensions: Vec<&str> = filters
        .iter()
        .flat_map(|filter| filter.extensions.iter().map(String::as_str))
        .collect();
    let has = file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extensions.iter().any(|known| known.eq_ignore_ascii_case(extension)));
    match extensions.first() {
        Some(first) if !has && *first != "*" => {
            let mut name = file.clone().into_os_string();
            name.push(".");
            name.push(first);
            PathBuf::from(name)
        }
        _ => file,
    }
}

/// Ask where to save a file. The answer ends in one of the filters' extensions.
#[tauri::command]
pub(crate) async fn choose_save(
    window: Window,
    chosen: tauri::State<'_, Chosen>,
    options: SaveOptions,
) -> Result<Option<String>, String> {
    let file = dialog(&window, options.title, options.filters.clone(), options.default_path)
        .blocking_save_file()
        .and_then(|file| file.into_path().ok())
        .map(|file| with_extension(file, &options.filters));
    if let Some(file) = &file {
        chosen.file(file);
    }
    Ok(file.map(|file| file.display().to_string()))
}

/// Whether a place was picked in a dialog (now or in an earlier run): what
/// 「前回と同じ設定で書き出す」 asks before it writes there without a dialog.
#[tauri::command]
pub(crate) fn place_chosen(chosen: tauri::State<'_, Chosen>, path: String) -> bool {
    chosen.holds(std::path::Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters(extensions: &[&str]) -> Vec<FileFilter> {
        vec![FileFilter {
            name: "x".to_owned(),
            extensions: extensions.iter().map(|extension| (*extension).to_owned()).collect(),
        }]
    }

    #[test]
    fn a_name_typed_without_its_extension_gets_it() {
        let jpg = filters(&["jpg", "jpeg"]);
        assert_eq!(
            with_extension(PathBuf::from("/out/a"), &jpg),
            PathBuf::from("/out/a.jpg")
        );
        assert_eq!(
            with_extension(PathBuf::from("/out/a.JPEG"), &jpg),
            PathBuf::from("/out/a.JPEG")
        );
        assert_eq!(
            with_extension(PathBuf::from("/out/第1話.v2"), &filters(&["pdf"])),
            PathBuf::from("/out/第1話.v2.pdf")
        );
        assert_eq!(with_extension(PathBuf::from("/out/a"), &[]), PathBuf::from("/out/a"));
    }
}
