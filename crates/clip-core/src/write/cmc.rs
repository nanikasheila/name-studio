//! Write a CLIP STUDIO PAINT EX multi-page work (.cmc) for page files.
//!
//! The page .clip files only become one work in CSP EX once a .cmc next to
//! them lists them in order. A CSP-made .cmc of the same work is the
//! template, so every work-wide setting (binding, start page, story info,
//! default page) is kept. Its page list (`CanvasNode`, a linked list under
//! the root node) is replaced by one node per page file; page nodes copy the
//! template's first page node and then get the new link, order and size.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, Timelike};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::Values;
use super::editor::select_values;
use super::schema::{column_names, table_names};
use super::{int_value, set_value, value_of};
use crate::cmc::{PAGE_NODE_TYPE, SQLITE_MAGIC};
use crate::container::CsfContainer;
use crate::error::{CspError, Result};

/// What a page node records about its page file.
#[derive(Debug, Clone, PartialEq)]
pub struct PageLink {
    pub file_name: String,
    pub spread: bool,
    pub unit: i64,
    pub width: f64,
    pub height: f64,
    pub resolution: f64,
    pub modified: DateTime<Local>,
}

/// Read the size and modification time CSP caches for a page file.
pub fn page_link(path: &Path) -> Result<PageLink> {
    let database = CsfContainer::read(path)?.open_database()?;
    let row = select_values(&database, "SELECT * FROM Canvas", &[])?
        .ok_or_else(|| CspError::format(format!("Canvas row not found: {}", path.display())))?;
    let real = |column: &str| match value_of(&row, column) {
        Some(Value::Real(number)) => *number,
        Some(Value::Integer(number)) => *number as f64,
        _ => 0.0,
    };
    Ok(PageLink {
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        spread: int_value(value_of(&row, "CanvasDoublePage")) != 0,
        unit: int_value(value_of(&row, "CanvasUnit")),
        width: real("CanvasWidth"),
        height: real("CanvasHeight"),
        resolution: real("CanvasResolution"),
        modified: DateTime::<Local>::from(std::fs::metadata(path)?.modified()?),
    })
}

fn load_template(path: &Path) -> Result<Connection> {
    let data = std::fs::read(path)?;
    if !data.starts_with(SQLITE_MAGIC) {
        return Err(CspError::format(format!(
            "Not a .cmc (SQLite) file: {}",
            path.display()
        )));
    }
    let mut database = Connection::open_in_memory()?;
    database.deserialize_read_exact("main", data.as_slice(), data.len(), false)?;
    Ok(database)
}

/// The work settings a .cmc shares with its pages' Canvas rows.
///
/// Each page .clip keeps a copy of the work's story info (作品名, 話数, 作者名,
/// ノンブル); pages made from another episode's template would otherwise
/// show that episode.
pub fn work_canvas_values(path: &Path) -> Result<Values> {
    let database = load_template(path)?;
    let project = select_values(&database, "SELECT * FROM Project", &[])?
        .ok_or_else(|| CspError::format(format!("Project row not found: {}", path.display())))?;
    Ok(project
        .into_iter()
        .filter(|(column, _)| column.starts_with("ComicStory") || column == "ComicBindPosition")
        .collect())
}

/// Write `output` (.cmc) listing `pages` in order, with `template`'s settings.
///
/// Every page file must already exist in the folder of `output`, because
/// CSP resolves page links relative to the .cmc. `project_values` overrides
/// Project columns the template has (for example the 話数).
pub fn write_cmc(template: &Path, pages: &[PathBuf], output: &Path, project_values: &Values) -> Result<PathBuf> {
    if pages.is_empty() {
        return Err(CspError::format("A work needs at least one page"));
    }
    let folder = output
        .parent()
        .map(|parent| {
            if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            }
        })
        .unwrap_or(Path::new("."))
        .canonicalize()?;
    let mut links = Vec::with_capacity(pages.len());
    for page in pages {
        let page_folder = page.canonicalize()?.parent().map(Path::to_path_buf);
        if page_folder.as_deref() != Some(folder.as_path()) {
            return Err(CspError::format(format!(
                "Page {} must be in the folder of {}",
                page.display(),
                output.display()
            )));
        }
        links.push(page_link(page)?);
    }
    let database = load_template(template)?;
    replace_pages(&database, &links)?;
    let known = column_names(&database, "Project")?;
    for (column, value) in project_values {
        if known.contains(column) {
            database.execute(&format!("UPDATE Project SET \"{column}\" = ?1"), [value])?;
        }
    }
    let data = database.serialize("main")?;
    let temporary = output.with_extension("cmc.tmp");
    std::fs::write(&temporary, &*data)?;
    std::fs::rename(&temporary, output)?;
    Ok(output.to_path_buf())
}

fn replace_pages(database: &Connection, links: &[PageLink]) -> Result<()> {
    let project = select_values(database, "SELECT * FROM Project", &[])?
        .ok_or_else(|| CspError::format("Project row not found in the template .cmc"))?;
    let root_id = int_value(value_of(&project, "ProjectRootCanvasNode"));
    let base = select_values(
        database,
        "SELECT * FROM CanvasNode WHERE Type = ?1 ORDER BY MainId LIMIT 1",
        &[Value::Integer(PAGE_NODE_TYPE)],
    )?
    .unwrap_or_default();
    database.execute("DELETE FROM CanvasNode WHERE MainId != ?1", [root_id])?;
    let node_ids: Vec<i64> = (1..=links.len() as i64 + 1)
        .filter(|id| *id != root_id)
        .take(links.len())
        .collect();
    let columns = column_names(database, "CanvasNode")?;
    for (position, (node_id, link)) in node_ids.iter().zip(links).enumerate() {
        let mut values = base.clone();
        for (column, value) in node_values(link) {
            set_value(&mut values, column, value);
        }
        let next = node_ids.get(position + 1).copied().unwrap_or(0);
        for (column, value) in [
            ("_PW_ID", Value::Integer(*node_id)),
            ("MainId", Value::Integer(*node_id)),
            ("Type", Value::Integer(PAGE_NODE_TYPE)),
            ("NextIndex", Value::Integer(next)),
        ] {
            set_value(&mut values, column, value);
        }
        let kept: Vec<&(String, Value)> = values.iter().filter(|(column, _)| columns.contains(column)).collect();
        let names: Vec<String> = kept.iter().map(|(column, _)| format!("[{column}]")).collect();
        let marks = vec!["?"; kept.len()].join(", ");
        database.execute(
            &format!("INSERT INTO CanvasNode ({}) VALUES ({marks})", names.join(", ")),
            params_from_iter(kept.iter().map(|(_, value)| value)),
        )?;
    }
    for column in ["FirstChildIndex", "SelectedIndex"] {
        if columns.iter().any(|name| name == column) {
            database.execute(
                &format!("UPDATE CanvasNode SET \"{column}\" = ?1 WHERE MainId = ?2"),
                (node_ids[0], root_id),
            )?;
        }
    }
    if table_names(database)?.contains("ElemScheme") {
        let top = node_ids.iter().copied().chain([root_id]).max().unwrap_or(root_id);
        database.execute(
            "UPDATE ElemScheme SET MaxIndex = ?1 WHERE TableName = 'CanvasNode'",
            [top],
        )?;
    }
    if project.iter().any(|(column, _)| column == "MaxCanvasFileIndex") {
        database.execute("UPDATE Project SET MaxCanvasFileIndex = ?1", [max_file_index(links)])?;
    }
    let _ = database.query_row("SELECT 1", [], |_| Ok(())).optional()?;
    Ok(())
}

fn node_values(link: &PageLink) -> Vec<(&'static str, Value)> {
    let stamp = link.modified;
    let integer = |value: i64| Value::Integer(value);
    vec![
        ("FirstChildIndex", integer(0)),
        ("SelectedIndex", integer(0)),
        ("CanvasIndex", integer(0)),
        ("PageFlag", integer(link.spread as i64)),
        ("Memo", Value::Text(String::new())),
        ("BookBindMemo", Value::Text(String::new())),
        ("LinkPath", Value::Text(format!(".:{}", link.file_name))),
        ("LinkWriteYear", integer(stamp.year() as i64)),
        ("LinkWriteMonth", integer(stamp.month() as i64)),
        ("LinkWriteDay", integer(stamp.day() as i64)),
        ("LinkWriteHour", integer(stamp.hour() as i64)),
        ("LinkWriteMinute", integer(stamp.minute() as i64)),
        ("LinkWriteSecond", integer(stamp.second() as i64)),
        ("LinkIsFolder", integer(0)),
        ("LinkUnit", integer(link.unit)),
        ("LinkWidth", Value::Real(link.width)),
        ("LinkHeight", Value::Real(link.height)),
        ("LinkResolution", Value::Real(link.resolution)),
    ]
}

/// The highest number in the page file names (`page0012.clip` → 12).
fn max_file_index(links: &[PageLink]) -> i64 {
    let numbers: Vec<i64> = links
        .iter()
        .filter_map(|link| {
            let lower = link.file_name.to_lowercase();
            let stem = lower.strip_suffix(".clip")?;
            let digits: String = stem.chars().rev().take_while(char::is_ascii_digit).collect();
            digits.chars().rev().collect::<String>().parse().ok()
        })
        .collect();
    numbers.into_iter().max().unwrap_or(links.len() as i64)
}
