//! Attributes of a CSP text layer (`TextLayerAttributes`).
//!
//! A little-endian TLV list (`u32 id, u32 size, bytes`). Observed ids:
//! 0x20 font size × 100 (pt), 0x2a bbox i32[4] (layer-local px),
//! 0x39 font name, 0x3f block size i32[2] (px), 0x40 quad i32[8] (1/100 px).
//! `TextLayerAttributesArray` repeats `u32 size + TLV list` per text block.

use crate::bytes::{le_i32, le_u16, le_u32};
use crate::error::{CspError, Result};
use crate::vector::BBox;

pub const ATTR_FONT_SIZE: u32 = 0x20;
pub const ATTR_BBOX: u32 = 0x2a;
pub const ATTR_FONT_NAME: u32 = 0x39;
pub const ATTR_BLOCK_SIZE: u32 = 0x3f;
pub const ATTR_QUAD: u32 = 0x40;
const FONT_SIZE_UNIT: f64 = 100.0;

/// The decoded subset of one text block's attributes.
#[derive(Debug, Clone, PartialEq)]
pub struct TextAttributes {
    pub bbox: Option<BBox>,
    pub font_size_pt: Option<f64>,
    pub font_name: Option<String>,
}

/// Split a TLV blob into `(id, value)` pairs, in order.
pub fn parse_tlv(blob: &[u8]) -> Result<Vec<(u32, &[u8])>> {
    let mut items = Vec::new();
    let mut position = 0;
    while position < blob.len() {
        if position + 8 > blob.len() {
            return Err(CspError::format(format!("Truncated text attribute at {position}")));
        }
        let id = le_u32(blob, position)?;
        let size = le_u32(blob, position + 4)? as usize;
        let start = position + 8;
        let value = blob
            .get(start..start + size)
            .ok_or_else(|| CspError::format(format!("Text attribute 0x{id:x} exceeds the blob")))?;
        items.push((id, value));
        position = start + size;
    }
    Ok(items)
}

/// Inverse of [`parse_tlv`].
pub fn build_tlv(items: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut blob = Vec::new();
    for (id, value) in items {
        blob.extend_from_slice(&id.to_le_bytes());
        blob.extend_from_slice(&(value.len() as u32).to_le_bytes());
        blob.extend_from_slice(value);
    }
    blob
}

fn unpack_bbox(value: &[u8]) -> Result<BBox> {
    Ok((
        le_i32(value, 0)?,
        le_i32(value, 4)?,
        le_i32(value, 8)?,
        le_i32(value, 12)?,
    ))
}

/// Decode the bbox, font size and font name of one text block.
pub fn parse_text_attributes(blob: &[u8]) -> Result<TextAttributes> {
    let items = parse_tlv(blob)?;
    // Later duplicates win, like building a dict from the pairs.
    let find = |id: u32| items.iter().rev().find(|(key, _)| *key == id).map(|(_, value)| *value);
    let bbox = match find(ATTR_BBOX) {
        Some(value) if value.len() == 16 => Some(unpack_bbox(value)?),
        _ => None,
    };
    let font_size_pt = match find(ATTR_FONT_SIZE) {
        Some(value) if value.len() == 4 => Some(le_i32(value, 0)? as f64 / FONT_SIZE_UNIT),
        _ => None,
    };
    Ok(TextAttributes {
        bbox,
        font_size_pt,
        font_name: find(ATTR_FONT_NAME).and_then(font_name),
    })
}

fn font_name(value: &[u8]) -> Option<String> {
    if value.len() < 4 {
        return None;
    }
    let length = le_u16(value, 2).ok()? as usize;
    value
        .get(4..4 + length)
        .map(|name| String::from_utf8_lossy(name).into_owned())
}

/// Split `TextLayerAttributesArray` into per-block TLV blobs.
pub fn split_attribute_array(blob: &[u8]) -> Result<Vec<&[u8]>> {
    let mut blocks = Vec::new();
    let mut position = 0;
    while position < blob.len() {
        let size = le_u32(blob, position).map_err(|_| CspError::format("Truncated text attribute array"))? as usize;
        let start = position + 4;
        blocks.push(
            blob.get(start..start + size)
                .ok_or_else(|| CspError::format("Text attribute array entry exceeds the blob"))?,
        );
        position = start + size;
    }
    Ok(blocks)
}

/// `blob` with its bbox mapped to `p * scale + d` and font size, block size
/// and quad scaled. Everything else is copied unchanged.
pub fn transform_text_attributes(blob: &[u8], scale: f64, dx: f64, dy: f64) -> Result<Vec<u8>> {
    if scale <= 0.0 {
        return Err(CspError::format("scale must be positive"));
    }
    let mut items = Vec::new();
    for (id, value) in parse_tlv(blob)? {
        let value = if id == ATTR_BBOX && value.len() == 16 {
            let (x0, y0, x1, y1) = unpack_bbox(value)?;
            [
                (x0 as f64 * scale + dx).floor() as i32,
                (y0 as f64 * scale + dy).floor() as i32,
                (x1 as f64 * scale + dx).ceil() as i32,
                (y1 as f64 * scale + dy).ceil() as i32,
            ]
            .iter()
            .flat_map(|number| number.to_le_bytes())
            .collect()
        } else if matches!(id, ATTR_FONT_SIZE | ATTR_BLOCK_SIZE | ATTR_QUAD)
            && !value.is_empty()
            && value.len() % 4 == 0
        {
            value
                .chunks_exact(4)
                .flat_map(|bytes| {
                    let number = i32::from_le_bytes(bytes.try_into().unwrap());
                    ((number as f64 * scale).round_ties_even() as i32).to_le_bytes()
                })
                .collect()
        } else {
            value.to_vec()
        };
        items.push((id, value));
    }
    Ok(build_tlv(&items))
}
