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
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|bytes| {
                    let number = i32::from_le_bytes(*bytes);
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

/// Vertical writing bit of `ATTR_DIRECTION` (observed `0x10` for 縦書き).
pub const ATTR_DIRECTION: u32 = 0x21;
/// Character count of the text, `u32` + `u32` 0.
pub const ATTR_LENGTH: u32 = 0x27;
/// Offset of the text from its frame, `i32` × 2 (block width for 縦書き).
pub const ATTR_ORIGIN: u32 = 0x48;
/// `MainId` of the Offscreen holding CSP's rendering of the text (`u32`).
/// A copied layer must not point at the donor's id, which in the new file is
/// missing or belongs to another layer; 0 makes CSP render the text afresh.
pub const ATTR_RENDER_CACHE: u32 = 0x32;
const VERTICAL_BIT: u32 = 0x10;
/// Style-run tags: `u32` run count, then per run `u32` start, `u32` length,
/// a `u32` and the run's data. The `u32` is the data size, except for
/// [`ATTR_FONT_RUNS`]. A plain one-style text has one run each.
const RUN_TAGS: [u32; 8] = [ATTR_FONT_RUNS, 0x1a, 0x0c, 0x0d, 0x1d, 0x41, 0x1e, 0x12];
/// Font runs: the `u32` is a set of flags and the data is 16 bytes, then a
/// `u16` count of UTF-16 units of the font name and the name.
const ATTR_FONT_RUNS: u32 = 0x0b;
/// Run tags a plain text leaves empty (seen set on parts of a text CSP
/// styled differently); a new text drops them.
const EXTRA_RUN_TAGS: [u32; 10] = [0x0e, 0x0f, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16, 0x1b, 0x1c];

/// One style run: start, length, the `u32` after them and the data.
type Run<'a> = (u32, u32, u32, &'a [u8]);

/// The per-run data of a run tag in `TextLayerAddAttributesV01`: `u32`
/// count, then per run a `u32` size and the data. Kept if `value` is
/// exactly such a list.
fn parse_add_runs(value: &[u8]) -> Option<Vec<&[u8]>> {
    let count = le_u32(value, 0).ok()?;
    let mut runs = Vec::new();
    let mut offset = 4;
    for _ in 0..count {
        let size = le_u32(value, offset).ok()? as usize;
        runs.push(value.get(offset + 4..offset + 4 + size)?);
        offset += 4 + size;
    }
    (offset == value.len()).then_some(runs)
}

/// The first run of an add-attributes run list on its own.
fn single_add_run(id: u32, value: &[u8]) -> Result<Vec<u8>> {
    let runs = parse_add_runs(value)
        .ok_or_else(|| CspError::format(format!("Added text attribute 0x{id:x} is not a run list")))?;
    let Some(data) = runs.first() else {
        return Ok(value.to_vec());
    };
    let mut out = Vec::with_capacity(8 + data.len());
    for number in [1, data.len() as u32] {
        out.extend_from_slice(&number.to_le_bytes());
    }
    out.extend_from_slice(data);
    Ok(out)
}

/// The runs of run tag `id`, if `value` is exactly a run list.
fn parse_runs(id: u32, value: &[u8]) -> Option<Vec<Run<'_>>> {
    let count = le_u32(value, 0).ok()?;
    let mut runs = Vec::new();
    let mut offset = 4;
    for _ in 0..count {
        let start = le_u32(value, offset).ok()?;
        let length = le_u32(value, offset + 4).ok()?;
        let field = le_u32(value, offset + 8).ok()?;
        let data_at = offset + 12;
        let size = if id == ATTR_FONT_RUNS {
            let name = value.get(data_at + 16..data_at + 18)?;
            18 + 2 * u16::from_le_bytes([name[0], name[1]]) as usize
        } else {
            field as usize
        };
        runs.push((start, length, field, value.get(data_at..data_at + size)?));
        offset = data_at + size;
    }
    (offset == value.len()).then_some(runs)
}

/// One run over the whole text, styled like the first run of `value`.
fn single_run(id: u32, value: &[u8], length: u32) -> Result<Vec<u8>> {
    let runs =
        parse_runs(id, value).ok_or_else(|| CspError::format(format!("Text attribute 0x{id:x} is not a run list")))?;
    let Some((_, _, field, data)) = runs.first() else {
        return Ok(value.to_vec());
    };
    let mut out = Vec::with_capacity(16 + data.len());
    for number in [1, 0, length, *field] {
        out.extend_from_slice(&number.to_le_bytes());
    }
    out.extend_from_slice(data);
    Ok(out)
}

/// A new text block, in layer-local pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct NewText {
    pub text: String,
    /// Frame `[x0, y0, x1, y1]`; 縦書き starts at its top right.
    pub frame: [i32; 4],
    pub font_size_pt: f64,
    pub vertical: bool,
}

impl NewText {
    /// CSP stores line breaks as CRLF and counts UTF-16 units.
    pub fn stored_text(&self) -> String {
        self.text.replace("\r\n", "\n").replace('\n', "\r\n")
    }

    fn length(&self) -> u32 {
        self.stored_text().encode_utf16().count() as u32
    }
}

fn i32s(values: &[i32]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// `blob` (the attributes of a CSP-made single-run text) rewritten for `text`:
/// character counts, size, direction and geometry. A text styled in parts
/// becomes one run styled like its first part.
pub fn retarget_text_attributes(blob: &[u8], text: &NewText) -> Result<Vec<u8>> {
    retarget(blob, text, true)
}

/// `TextLayerAddAttributesV01` (`u32` length + attributes per block) for one
/// block: the first entry of `blob`, with size, direction and geometry as in
/// [`retarget_text_attributes`]. Its style runs carry no character counts;
/// they are cut to the first run too, or CSP rewrites them on opening and
/// marks the page changed.
pub fn retarget_add_attributes(blob: &[u8], text: &NewText) -> Result<Vec<u8>> {
    let first = split_attribute_array(blob)?
        .into_iter()
        .next()
        .ok_or_else(|| CspError::format("Empty TextLayerAddAttributesV01"))?;
    let entry = retarget(first, text, false)?;
    let mut result = (entry.len() as u32).to_le_bytes().to_vec();
    result.extend(entry);
    Ok(result)
}

fn retarget(blob: &[u8], text: &NewText, counted_runs: bool) -> Result<Vec<u8>> {
    let length = text.length();
    let [x0, y0, x1, y1] = text.frame;
    let (width, height) = (x1 - x0, y1 - y0);
    let quad = if text.vertical {
        [-width * 100, 0, 0, 0, 0, height * 100, -width * 100, height * 100]
    } else {
        [0, 0, width * 100, 0, width * 100, height * 100, 0, height * 100]
    };
    let mut items = Vec::new();
    for (id, value) in parse_tlv(blob)? {
        let mut value = value.to_vec();
        if RUN_TAGS.contains(&id) {
            if !value.is_empty() {
                value = if counted_runs {
                    single_run(id, &value, length)?
                } else {
                    single_add_run(id, &value)?
                };
            }
        } else if EXTRA_RUN_TAGS.contains(&id) {
            value.clear();
        } else {
            match id {
                ATTR_FONT_SIZE if value.len() == 4 => {
                    value = ((text.font_size_pt * FONT_SIZE_UNIT).round() as i32)
                        .to_le_bytes()
                        .to_vec();
                }
                ATTR_DIRECTION if value.len() == 4 => {
                    let flags = le_u32(&value, 0)?;
                    let flags = if text.vertical {
                        flags | VERTICAL_BIT
                    } else {
                        flags & !VERTICAL_BIT
                    };
                    value = flags.to_le_bytes().to_vec();
                }
                ATTR_LENGTH if value.len() >= 4 => value[0..4].copy_from_slice(&length.to_le_bytes()),
                ATTR_BBOX if value.len() == 16 => value = i32s(&text.frame),
                ATTR_BLOCK_SIZE if value.len() == 8 => value = i32s(&[width, height]),
                ATTR_QUAD if value.len() == 32 => value = i32s(&quad),
                ATTR_RENDER_CACHE if value.len() == 4 => value = 0u32.to_le_bytes().to_vec(),
                ATTR_ORIGIN if value.len() == 8 => value = i32s(&[if text.vertical { width } else { 0 }, 0]),
                _ => {}
            }
        }
        items.push((id, value));
    }
    Ok(build_tlv(&items))
}
