//! CSF chunk container ("CSFCHUNK") that wraps every .clip file.
//!
//! A .clip is not a plain database: it is a chunked container holding an
//! SQLite database (canvas and layer metadata) and external binary chunks
//! (compressed pixel blocks, vector data). The chunk headers are walked once
//! and the chunk positions are kept; the bytes are never modified.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::bytes::be_u64;
use crate::error::{CspError, Result};

pub const FILE_MAGIC: &[u8; 8] = b"CSFCHUNK";
const CHUNK_HEADER_SIZE: usize = 16;
const FILE_HEADER_SIZE: usize = 24;
pub const EXTERNAL_ID_LENGTH: usize = 40;

pub const CHUNK_EXTERNAL: &[u8; 8] = b"CHNKExta";
pub const CHUNK_SQLITE: &[u8; 8] = b"CHNKSQLi";
pub const CHUNK_FOOTER: &[u8; 8] = b"CHNKFoot";

/// Position of one chunk body inside the container file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkLocation {
    pub tag: String,
    pub header_offset: usize,
    pub body_offset: usize,
    pub body_length: usize,
}

/// Parsed CSF container: raw bytes plus the index of its chunks.
#[derive(Debug, Clone)]
pub struct CsfContainer {
    pub data: Vec<u8>,
    pub chunks: Vec<ChunkLocation>,
    external_chunks: HashMap<String, usize>,
}

impl CsfContainer {
    pub fn read(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let data = std::fs::read(path)
            .map_err(|error| CspError::format(format!("Cannot read {}: {error}", path.display())))?;
        Self::parse(data)
    }

    pub fn parse(data: Vec<u8>) -> Result<Self> {
        if data.len() < FILE_HEADER_SIZE || &data[..8] != FILE_MAGIC {
            return Err(CspError::format("Not a CLIP STUDIO file (missing CSFCHUNK header)"));
        }
        let declared_size = be_u64(&data, 8)? as usize;
        if declared_size != data.len() {
            return Err(CspError::format(format!(
                "File size mismatch: header says {declared_size}, actual {}",
                data.len()
            )));
        }
        let mut chunks = Vec::new();
        let mut externals = HashMap::new();
        let mut position = be_u64(&data, 16)? as usize;
        while position < data.len() {
            if position + CHUNK_HEADER_SIZE > data.len() {
                return Err(CspError::format(format!("Truncated chunk header at {position}")));
            }
            let tag = &data[position..position + 8];
            if !tag.starts_with(b"CHNK") {
                return Err(CspError::format(format!("Unexpected chunk tag at {position}")));
            }
            let length = be_u64(&data, position + 8)? as usize;
            let body_offset = position + CHUNK_HEADER_SIZE;
            if body_offset.checked_add(length).is_none_or(|end| end > data.len()) {
                return Err(CspError::format(format!("Chunk at {position} overruns the file")));
            }
            if tag == CHUNK_EXTERNAL {
                let id_start = body_offset + 8;
                let id = data
                    .get(id_start..id_start + EXTERNAL_ID_LENGTH)
                    .ok_or_else(|| CspError::format(format!("External chunk at {position} has no id")))?;
                externals.insert(String::from_utf8_lossy(id).into_owned(), chunks.len());
            }
            let is_footer = tag == CHUNK_FOOTER;
            chunks.push(ChunkLocation {
                tag: String::from_utf8_lossy(tag).into_owned(),
                header_offset: position,
                body_offset,
                body_length: length,
            });
            if is_footer {
                break;
            }
            position = body_offset + length;
        }
        Ok(CsfContainer {
            data,
            chunks,
            external_chunks: externals,
        })
    }

    fn body(&self, chunk: &ChunkLocation) -> &[u8] {
        &self.data[chunk.body_offset..chunk.body_offset + chunk.body_length]
    }

    /// The embedded SQLite database image.
    pub fn sqlite_bytes(&self) -> Result<&[u8]> {
        self.chunks
            .iter()
            .find(|chunk| chunk.tag.as_bytes() == CHUNK_SQLITE)
            .map(|chunk| self.body(chunk))
            .ok_or_else(|| CspError::format("SQLite chunk not found"))
    }

    /// Payload of an external chunk (after its id header), or None when the
    /// id is not stored (CSP does that for offscreens without pixels).
    pub fn external_payload(&self, external_id: &str) -> Option<&[u8]> {
        let chunk = &self.chunks[*self.external_chunks.get(external_id)?];
        // Body layout: u64 id length (40) + id + payload
        self.body(chunk).get(8 + EXTERNAL_ID_LENGTH..)
    }

    /// Open a read-only in-memory copy of the embedded database.
    pub fn open_database(&self) -> Result<Connection> {
        open_sqlite_bytes(self.sqlite_bytes()?)
    }
}

/// Open an SQLite database image as a read-only in-memory connection.
pub fn open_sqlite_bytes(database: &[u8]) -> Result<Connection> {
    let mut connection = Connection::open_in_memory_with_flags(OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.deserialize_read_exact("main", database, database.len(), true)?;
    Ok(connection)
}
