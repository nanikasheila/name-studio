//! Bounds-checked big / little endian reads.

use crate::error::{CspError, Result};

fn slice<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N]> {
    data.get(offset..offset + N)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| CspError::format(format!("Unexpected end of data at offset {offset}")))
}

pub fn be_u32(data: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(slice(data, offset)?))
}

pub fn be_i32(data: &[u8], offset: usize) -> Result<i32> {
    Ok(i32::from_be_bytes(slice(data, offset)?))
}

pub fn be_u64(data: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_be_bytes(slice(data, offset)?))
}

pub fn be_f64(data: &[u8], offset: usize) -> Result<f64> {
    Ok(f64::from_be_bytes(slice(data, offset)?))
}

pub fn le_u16(data: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(slice(data, offset)?))
}

pub fn le_u32(data: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(slice(data, offset)?))
}

pub fn le_i32(data: &[u8], offset: usize) -> Result<i32> {
    Ok(i32::from_le_bytes(slice(data, offset)?))
}

/// Read a u32 length-prefixed UTF-16BE string; return (text, next offset).
pub fn utf16_name(data: &[u8], offset: usize) -> Result<(String, usize)> {
    let length = be_u32(data, offset)? as usize;
    let start = offset + 4;
    let end = start + length * 2;
    let bytes = data
        .get(start..end)
        .ok_or_else(|| CspError::format(format!("String at offset {offset} overruns the data")))?;
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_be_bytes(*pair))
        .collect();
    Ok((String::from_utf16_lossy(&units), end))
}
