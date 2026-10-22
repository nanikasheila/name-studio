//! Rows read with `SELECT *`: CSP creates columns only when it needs them,
//! so readers look columns up by name and treat missing ones as absent.

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{Connection, Params};

use crate::error::Result;

#[derive(Debug, Clone, Default)]
pub struct Row(HashMap<String, Value>);

impl Row {
    pub fn get(&self, column: &str) -> Option<&Value> {
        self.0.get(column)
    }

    pub fn has(&self, column: &str) -> bool {
        self.0.contains_key(column)
    }

    /// Integer value; NULL, missing and non-numeric columns read as 0.
    pub fn int(&self, column: &str) -> i64 {
        match self.get(column) {
            Some(Value::Integer(value)) => *value,
            Some(Value::Real(value)) => *value as i64,
            _ => 0,
        }
    }

    pub fn real(&self, column: &str) -> f64 {
        match self.get(column) {
            Some(Value::Integer(value)) => *value as f64,
            Some(Value::Real(value)) => *value,
            _ => 0.0,
        }
    }

    /// Text value (UTF-8 blobs are decoded too); None when NULL or missing.
    pub fn text(&self, column: &str) -> Option<String> {
        match self.get(column) {
            Some(Value::Text(value)) => Some(value.clone()),
            Some(Value::Blob(value)) => Some(String::from_utf8_lossy(value).into_owned()),
            Some(Value::Integer(value)) => Some(value.to_string()),
            Some(Value::Real(value)) => Some(value.to_string()),
            _ => None,
        }
    }

    pub fn blob(&self, column: &str) -> Option<&[u8]> {
        match self.get(column) {
            Some(Value::Blob(value)) => Some(value),
            _ => None,
        }
    }

    /// Whether the column holds something other than NULL / 0 / empty.
    pub fn truthy(&self, column: &str) -> bool {
        match self.get(column) {
            Some(Value::Integer(value)) => *value != 0,
            Some(Value::Real(value)) => *value != 0.0,
            Some(Value::Text(value)) => !value.is_empty(),
            Some(Value::Blob(value)) => !value.is_empty(),
            _ => false,
        }
    }
}

pub fn select_rows(connection: &Connection, sql: &str, params: impl Params) -> Result<Vec<Row>> {
    let mut statement = connection.prepare(sql)?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let rows = statement.query_map(params, |row| {
        let mut values = HashMap::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            values.insert(name.clone(), row.get::<_, Value>(index)?);
        }
        Ok(Row(values))
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn table_exists(connection: &Connection, table: &str) -> Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
