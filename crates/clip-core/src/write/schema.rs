//! Schema helpers for editing the SQLite database inside a .clip file.
//!
//! CSP creates tables and columns only when a file first needs them (an
//! empty page has no `VectorObjectList` table). Before a vector or text layer
//! is copied from a name sheet into a page template, the template gains the
//! same tables and columns, with their entries in CSP's own schema tables.
//! `ParamScheme` lists every column with its type and, for id columns, the
//! table it links to; `ElemScheme` keeps the highest `MainId` per table.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use crate::error::Result;

pub const PARAM_SCHEME: &str = "ParamScheme";
pub const ELEM_SCHEME: &str = "ElemScheme";
pub const OWNER_CANVAS: i64 = 2;
pub const OWNER_LAYER: i64 = 4;
/// Self-links (linked lists) that ParamScheme does not list as links.
const CHAIN_COLUMNS: [(&str, &str); 2] = [("MipmapInfo", "NextIndex"), ("BrushStyle", "NextIndex")];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnInfo {
    pub link_table: Option<String>,
    pub owner_type: i64,
}

pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::Text(text) => text.clone(),
        Value::Blob(blob) => String::from_utf8_lossy(blob).into_owned(),
        Value::Integer(number) => number.to_string(),
        Value::Real(number) => number.to_string(),
        Value::Null => String::new(),
    }
}

pub fn table_names(database: &Connection) -> Result<HashSet<String>> {
    let mut statement = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(names.collect::<std::result::Result<_, _>>()?)
}

pub fn column_names(database: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = database.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(names.collect::<std::result::Result<_, _>>()?)
}

/// ParamScheme information for the columns of `table`.
pub fn column_infos(database: &Connection, table: &str) -> Result<HashMap<String, ColumnInfo>> {
    let mut infos = HashMap::new();
    if table_names(database)?.contains(PARAM_SCHEME) {
        let mut statement = database.prepare(&format!(
            "SELECT LabelName, LinkTable, OwnerType FROM {PARAM_SCHEME} WHERE TableName = ?1"
        ))?;
        let rows = statement.query_map([table], |row| {
            Ok((
                row.get::<_, Value>(0)?,
                row.get::<_, Value>(1)?,
                row.get::<_, Value>(2)?,
            ))
        })?;
        for row in rows {
            let (label, link, owner) = row?;
            let label = text_of(&label);
            let mut link_table = Some(text_of(&link)).filter(|link| !link.is_empty() && link != "0");
            if CHAIN_COLUMNS.contains(&(table, label.as_str())) {
                link_table = Some(table.to_owned());
            }
            let owner_type = match owner {
                Value::Integer(number) => number,
                Value::Real(number) => number as i64,
                _ => 0,
            };
            infos.insert(label, ColumnInfo { link_table, owner_type });
        }
    }
    for (chain_table, label) in CHAIN_COLUMNS {
        if chain_table == table {
            infos.entry(label.to_owned()).or_insert(ColumnInfo {
                link_table: Some(table.to_owned()),
                owner_type: 0,
            });
        }
    }
    Ok(infos)
}

/// (table, column) pairs whose values are external chunk ids.
pub fn external_columns(database: &Connection) -> Result<HashSet<(String, String)>> {
    if !table_names(database)?.contains("ExternalTableAndColumnName") {
        return Ok(HashSet::new());
    }
    let mut statement = database.prepare("SELECT TableName, ColumnName FROM ExternalTableAndColumnName")?;
    let rows = statement.query_map([], |row| Ok((text_of(&row.get(0)?), text_of(&row.get(1)?))))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// Give `target` every table / column of `tables` that `source` has.
pub fn merge_schema(target: &Connection, source: &Connection, tables: &[&str]) -> Result<()> {
    let source_tables = table_names(source)?;
    for table in tables {
        if !source_tables.contains(*table) {
            continue;
        }
        if !table_names(target)?.contains(*table) {
            let sql: String = source.query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )?;
            target.execute(&sql, [])?;
            copy_scheme_rows(target, source, table, None)?;
            ensure_elem_scheme(target, source, table)?;
            continue;
        }
        merge_columns(target, source, table, None)?;
    }
    Ok(())
}

/// Give `target`'s existing `table` the columns `source` has (only those in
/// `only`, when given), with their ParamScheme rows.
pub fn merge_columns(target: &Connection, source: &Connection, table: &str, only: Option<&[&str]>) -> Result<()> {
    if !table_names(source)?.contains(table) || !table_names(target)?.contains(table) {
        return Ok(());
    }
    let have: HashSet<String> = column_names(target, table)?.into_iter().collect();
    let mut statement = source.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let columns = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    for column in columns {
        let (name, declared_type, default) = column?;
        if have.contains(&name) || only.is_some_and(|only| !only.contains(&name.as_str())) {
            continue;
        }
        let mut definition = format!("\"{name}\" {declared_type}");
        if let Some(default) = default {
            definition += &format!(" DEFAULT {default}");
        }
        target.execute(&format!("ALTER TABLE \"{table}\" ADD COLUMN {definition}"), [])?;
        copy_scheme_rows(target, source, table, Some(&name))?;
    }
    Ok(())
}

/// A new `MainId` for `table`, recorded in ElemScheme.
pub fn allocate_id(database: &Connection, table: &str) -> Result<i64> {
    let recorded: Option<i64> = database
        .query_row(
            &format!("SELECT MaxIndex FROM {ELEM_SCHEME} WHERE TableName = ?1"),
            [table],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .map(Option::unwrap_or_default);
    let used: i64 = database.query_row(
        &format!("SELECT COALESCE(MAX(MainId), 0) FROM \"{table}\""),
        [],
        |row| row.get(0),
    )?;
    let new_id = recorded.unwrap_or(0).max(used) + 1;
    if recorded.is_none() {
        database.execute(
            &format!("INSERT INTO {ELEM_SCHEME} (TableName, ElemType, MaxIndex) VALUES (?1, 0, ?2)"),
            (table, new_id),
        )?;
    } else {
        database.execute(
            &format!("UPDATE {ELEM_SCHEME} SET MaxIndex = ?1 WHERE TableName = ?2"),
            (new_id, table),
        )?;
    }
    Ok(new_id)
}

fn copy_scheme_rows(target: &Connection, source: &Connection, table: &str, column: Option<&str>) -> Result<()> {
    let target_columns: HashSet<String> = column_names(target, PARAM_SCHEME)?.into_iter().collect();
    let common: Vec<String> = column_names(source, PARAM_SCHEME)?
        .into_iter()
        .filter(|name| name != "_PW_ID" && target_columns.contains(name))
        .collect();
    let Some(label_index) = common.iter().position(|name| name == "LabelName") else {
        return Ok(());
    };
    let quoted: Vec<String> = common.iter().map(|name| format!("\"{name}\"")).collect();
    let mut query = format!("SELECT {} FROM {PARAM_SCHEME} WHERE TableName = ?1", quoted.join(", "));
    let mut parameters = vec![table.to_owned()];
    if let Some(column) = column {
        query += " AND LabelName = ?2";
        parameters.push(column.to_owned());
    }
    let present: HashSet<String> = {
        let mut statement = target.prepare(&format!("SELECT LabelName FROM {PARAM_SCHEME} WHERE TableName = ?1"))?;
        let labels = statement.query_map([table], |row| Ok(text_of(&row.get(0)?)))?;
        labels.collect::<std::result::Result<_, _>>()?
    };
    let mut statement = source.prepare(&query)?;
    let rows: Vec<Vec<Value>> = statement
        .query_map(params_from_iter(parameters.iter()), |row| {
            (0..common.len()).map(|index| row.get::<_, Value>(index)).collect()
        })?
        .collect::<std::result::Result<_, _>>()?;
    let marks = vec!["?"; common.len()].join(", ");
    let insert = format!("INSERT INTO {PARAM_SCHEME} ({}) VALUES ({marks})", quoted.join(", "));
    for row in rows {
        if present.contains(&text_of(&row[label_index])) {
            continue;
        }
        target.execute(&insert, params_from_iter(row.iter()))?;
    }
    Ok(())
}

fn ensure_elem_scheme(target: &Connection, source: &Connection, table: &str) -> Result<()> {
    let query = format!("SELECT ElemType FROM {ELEM_SCHEME} WHERE TableName = ?1");
    if target.query_row(&query, [table], |_| Ok(())).optional()?.is_some() {
        return Ok(());
    }
    let element_type: i64 = source
        .query_row(&query, [table], |row| row.get::<_, Option<i64>>(0))
        .optional()?
        .flatten()
        .unwrap_or(0);
    target.execute(
        &format!("INSERT INTO {ELEM_SCHEME} (TableName, ElemType, MaxIndex) VALUES (?1, ?2, 0)"),
        (table, element_type),
    )?;
    Ok(())
}
