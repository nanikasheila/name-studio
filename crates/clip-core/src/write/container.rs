//! Write CSF chunk containers (.clip) from a database and external chunks.
//!
//! Observed layout (big endian):
//!
//! ```text
//! "CSFCHUNK" u64 file size  u64 24
//! CHNKHead  u64 40: u64 256, u64 offset of the CHNKSQLi chunk, u64 16, 16-byte file id
//! CHNKExta  u64 n:  u64 40, 40-char external id, payload   (repeated)
//! CHNKSQLi  u64 n:  SQLite database image
//! CHNKFoot  u64 0
//! ```
//!
//! `ExternalChunk.Offset` holds the file position of each CHNKExta header.
//! The external chunks come before the database, so their offsets do not
//! depend on the database size.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::container::{CHUNK_EXTERNAL, CHUNK_FOOTER, CHUNK_SQLITE, CsfContainer, EXTERNAL_ID_LENGTH};
use crate::error::{CspError, Result};

pub const CHUNK_HEAD: &[u8; 8] = b"CHNKHead";
const FILE_HEADER_SIZE: u64 = 24;
const CHUNK_HEADER_SIZE: u64 = 16;
const HEAD_VERSION: u64 = 256;
const HEAD_BODY_SIZE: u64 = 40;
pub const FILE_ID_LENGTH: usize = 16;

/// The 16-byte file id stored in a container's CHNKHead chunk.
pub fn head_file_id(container: &CsfContainer) -> Result<[u8; FILE_ID_LENGTH]> {
    let head = container
        .chunks
        .iter()
        .find(|chunk| chunk.tag.as_bytes() == CHUNK_HEAD && chunk.body_length == HEAD_BODY_SIZE as usize)
        .ok_or_else(|| CspError::format("Unexpected CHNKHead chunk"))?;
    let start = head.body_offset + 24;
    Ok(container.data[start..start + FILE_ID_LENGTH]
        .try_into()
        .expect("16 bytes"))
}

/// Build container bytes; updates the `ExternalChunk` offsets in `database`.
///
/// `externals` is written in the given order. `ExternalChunk` rows whose id
/// is not in `externals` are removed, new ids are added.
pub fn assemble_container(
    database: &Connection,
    externals: &[(&str, &[u8])],
    file_id: &[u8; FILE_ID_LENGTH],
) -> Result<Vec<u8>> {
    let mut offset = FILE_HEADER_SIZE + CHUNK_HEADER_SIZE + HEAD_BODY_SIZE;
    let mut chunks = Vec::new();
    let mut offsets = Vec::with_capacity(externals.len());
    for (id, payload) in externals {
        if id.len() != EXTERNAL_ID_LENGTH || !id.is_ascii() {
            return Err(CspError::format(format!(
                "External id must be {EXTERNAL_ID_LENGTH} characters: {id:?}"
            )));
        }
        let body_length = 8 + EXTERNAL_ID_LENGTH as u64 + payload.len() as u64;
        offsets.push((*id, offset));
        chunks.extend_from_slice(CHUNK_EXTERNAL);
        chunks.extend_from_slice(&body_length.to_be_bytes());
        chunks.extend_from_slice(&(EXTERNAL_ID_LENGTH as u64).to_be_bytes());
        chunks.extend_from_slice(id.as_bytes());
        chunks.extend_from_slice(payload);
        offset += CHUNK_HEADER_SIZE + body_length;
    }
    update_external_index(database, &offsets)?;
    let sqlite = database.serialize("main")?;
    let mut body = Vec::with_capacity(chunks.len() + sqlite.len() + 128);
    body.extend_from_slice(CHUNK_HEAD);
    body.extend_from_slice(&HEAD_BODY_SIZE.to_be_bytes());
    body.extend_from_slice(&HEAD_VERSION.to_be_bytes());
    body.extend_from_slice(&offset.to_be_bytes());
    body.extend_from_slice(&(FILE_ID_LENGTH as u64).to_be_bytes());
    body.extend_from_slice(file_id);
    body.extend_from_slice(&chunks);
    body.extend_from_slice(CHUNK_SQLITE);
    body.extend_from_slice(&(sqlite.len() as u64).to_be_bytes());
    body.extend_from_slice(&sqlite);
    body.extend_from_slice(CHUNK_FOOTER);
    body.extend_from_slice(&0u64.to_be_bytes());
    let mut data = Vec::with_capacity(body.len() + FILE_HEADER_SIZE as usize);
    data.extend_from_slice(crate::container::FILE_MAGIC);
    data.extend_from_slice(&(FILE_HEADER_SIZE + body.len() as u64).to_be_bytes());
    data.extend_from_slice(&FILE_HEADER_SIZE.to_be_bytes());
    data.extend_from_slice(&body);
    Ok(data)
}

fn update_external_index(database: &Connection, offsets: &[(&str, u64)]) -> Result<()> {
    let existing: HashSet<String> = {
        let mut statement = database.prepare("SELECT ExternalID FROM ExternalChunk")?;
        let ids = statement.query_map([], |row| {
            Ok(match row.get::<_, rusqlite::types::Value>(0)? {
                rusqlite::types::Value::Text(text) => text,
                rusqlite::types::Value::Blob(blob) => String::from_utf8_lossy(&blob).into_owned(),
                _ => String::new(),
            })
        })?;
        ids.collect::<std::result::Result<_, _>>()?
    };
    let wanted: HashSet<&str> = offsets.iter().map(|(id, _)| *id).collect();
    for id in existing.iter().filter(|id| !wanted.contains(id.as_str())) {
        database.execute("DELETE FROM ExternalChunk WHERE ExternalID = ?1", [id])?;
    }
    for (id, offset) in offsets {
        if existing.contains(*id) {
            database.execute(
                "UPDATE ExternalChunk SET Offset = ?1 WHERE ExternalID = ?2",
                (*offset as i64, id),
            )?;
        } else {
            database.execute(
                "INSERT INTO ExternalChunk (ExternalID, Offset) VALUES (?1, ?2)",
                (id, *offset as i64),
            )?;
        }
    }
    Ok(())
}
