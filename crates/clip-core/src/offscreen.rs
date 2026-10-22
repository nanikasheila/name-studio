//! Raster pixels stored in .clip offscreens.
//!
//! Pixels are split into 256x256 blocks, each zlib-compressed, inside an
//! external chunk. The offscreen's `Attribute` blob holds the size, block
//! grid and channel layout (see docs/formats/csp-file-format.md).
//!
//! A decompressed block holds `total_planes` planes of 256x256 bytes:
//! plane 0 is alpha, then BGRX interleaved (colour) or one gray plane.
//! Blocks are independent, so they are decompressed in parallel.

use std::io::Read;

use flate2::read::ZlibDecoder;
use rayon::prelude::*;

use crate::bytes::{be_u32, utf16_name};
use crate::error::{CspError, Result};

pub const BLOCK_SIZE: usize = 256;
pub const BLOCK_PLANE_BYTES: usize = BLOCK_SIZE * BLOCK_SIZE;
const BLOCK_RECORD_NAME: &str = "BlockDataBeginChunk";
const PARAMETER_SECTION_NAME: &str = "Parameter";
const ATTRIBUTE_HEADER_SIZE: usize = 16;
const PAYLOAD_HEADER_SIZE: usize = 8;

/// Geometry and channel layout of one offscreen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OffscreenParameters {
    pub width: u32,
    pub height: u32,
    pub blocks_x: u32,
    pub blocks_y: u32,
    pub pixel_kind: u32,
    pub alpha_planes: u32,
    pub color_planes: u32,
    pub total_planes: u32,
}

impl OffscreenParameters {
    pub fn parse(attribute: &[u8]) -> Result<Self> {
        let (name, offset) = utf16_name(attribute, ATTRIBUTE_HEADER_SIZE)?;
        if name != PARAMETER_SECTION_NAME {
            return Err(CspError::format(format!(
                "Unknown offscreen attribute section: {name:?}"
            )));
        }
        let value = |index: usize| be_u32(attribute, offset + 4 * index);
        let parameters = OffscreenParameters {
            width: value(0)?,
            height: value(1)?,
            blocks_x: value(2)?,
            blocks_y: value(3)?,
            pixel_kind: value(4)?,
            alpha_planes: value(5)?,
            color_planes: value(6)?,
            total_planes: value(7)?,
        };
        let expected = (parameters.width.div_ceil(256), parameters.height.div_ceil(256));
        if (parameters.blocks_x, parameters.blocks_y) != expected {
            return Err(CspError::format(format!(
                "Block grid does not match image size: {}x{} for {}x{}",
                parameters.blocks_x, parameters.blocks_y, parameters.width, parameters.height
            )));
        }
        Ok(parameters)
    }

    fn block_raw_size(&self) -> usize {
        BLOCK_PLANE_BYTES * self.total_planes as usize
    }
}

/// One block record of an external chunk; `compressed` is None for empty blocks.
#[derive(Debug, Clone, Copy)]
pub struct BlockRecord<'a> {
    pub index: u32,
    pub raw_size: u32,
    pub compressed: Option<&'a [u8]>,
}

/// List the block records without decompressing anything (cheap, so it can
/// find which blocks of a large name sheet hold pixels).
pub fn block_records(payload: &[u8]) -> Result<Vec<BlockRecord<'_>>> {
    let mut records = Vec::new();
    let mut position = PAYLOAD_HEADER_SIZE;
    while position + 8 <= payload.len() {
        let record_length = be_u32(payload, position)? as usize;
        // Trailing sections (BlockStatus, BlockCheckSum) use another layout.
        if be_u32(payload, position + 4)? as usize != BLOCK_RECORD_NAME.len() {
            break;
        }
        let (name, body) = utf16_name(payload, position + 4)?;
        if name != BLOCK_RECORD_NAME {
            break;
        }
        let index = be_u32(payload, body)?;
        let raw_size = be_u32(payload, body + 4)?;
        let mut compressed = None;
        if be_u32(payload, body + 16)? != 0 {
            let data_length = be_u32(payload, body + 20)? as usize;
            compressed = Some(
                payload
                    .get(body + 28..body + 24 + data_length)
                    .ok_or_else(|| CspError::format(format!("Block {index} overruns its chunk")))?,
            );
        }
        records.push(BlockRecord {
            index,
            raw_size,
            compressed,
        });
        if record_length == 0 {
            break;
        }
        position += record_length;
    }
    Ok(records)
}

fn inflate(index: u32, compressed: &[u8], expected: usize) -> Result<Vec<u8>> {
    let mut raw = Vec::with_capacity(expected);
    ZlibDecoder::new(compressed)
        .read_to_end(&mut raw)
        .map_err(|_| CspError::format(format!("Block {index} is not valid zlib data")))?;
    if raw.len() != expected {
        return Err(CspError::format(format!(
            "Block {index} has {} bytes, expected {expected}",
            raw.len()
        )));
    }
    Ok(raw)
}

/// RGBA image, 8 bits per channel, not premultiplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl RgbaImage {
    pub fn transparent(width: u32, height: u32) -> Self {
        RgbaImage {
            width,
            height,
            pixels: vec![0; width as usize * height as usize * 4],
        }
    }

    /// Bounding box of the pixels whose alpha is not zero, as (x0, y0, x1, y1)
    /// with exclusive ends, like Pillow's `getbbox()` on RGBA images.
    pub fn alpha_bbox(&self) -> Option<(u32, u32, u32, u32)> {
        let width = self.width as usize;
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
        for (row, line) in self.pixels.chunks_exact(width * 4).enumerate() {
            let opaque = |pixel: &[u8]| pixel[3] != 0;
            if let Some(first) = line.chunks_exact(4).position(opaque) {
                let last = line.chunks_exact(4).rposition(opaque).unwrap_or(first);
                x0 = x0.min(first);
                x1 = x1.max(last + 1);
                y0 = y0.min(row);
                y1 = row + 1;
            }
        }
        (x0 != usize::MAX).then_some((x0 as u32, y0 as u32, x1 as u32, y1 as u32))
    }

    /// Encode as PNG (for showing the image in the app).
    pub fn to_png(&self) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        let mut encoder = png::Encoder::new(&mut output, self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder
            .write_header()
            .map_err(|error| CspError::format(error.to_string()))?;
        writer
            .write_image_data(&self.pixels)
            .map_err(|error| CspError::format(error.to_string()))?;
        writer.finish().map_err(|error| CspError::format(error.to_string()))?;
        Ok(output)
    }

    /// Copy one decoded 256x256 block to (left, top), clipped to this image.
    fn paste_block(&mut self, block: &[u8], parameters: &OffscreenParameters, left: i64, top: i64) {
        let (alpha, color) = block.split_at(BLOCK_PLANE_BYTES);
        for y in 0..BLOCK_SIZE as i64 {
            let target_y = top + y;
            if target_y < 0 || target_y >= self.height as i64 {
                continue;
            }
            for x in 0..BLOCK_SIZE as i64 {
                let target_x = left + x;
                if target_x < 0 || target_x >= self.width as i64 {
                    continue;
                }
                let source = (y * BLOCK_SIZE as i64 + x) as usize;
                let target = ((target_y * self.width as i64 + target_x) * 4) as usize;
                let rgb = match parameters.color_planes {
                    4 => [color[source * 4 + 2], color[source * 4 + 1], color[source * 4]],
                    1 => [color[source]; 3],
                    // Mask offscreen: the single plane is the mask value itself.
                    _ => [0, 0, 0],
                };
                self.pixels[target..target + 3].copy_from_slice(&rgb);
                self.pixels[target + 3] = alpha[source];
            }
        }
    }
}

/// Decode the blocks of `payload` overlapping `box_` (offscreen pixels,
/// exclusive ends) into an image of the box's size.
fn decode_box(parameters: &OffscreenParameters, payload: &[u8], box_: (i64, i64, i64, i64)) -> Result<RgbaImage> {
    let (x0, y0, x1, y1) = box_;
    let mut image = RgbaImage::transparent((x1 - x0).max(1) as u32, (y1 - y0).max(1) as u32);
    let block_count = parameters.blocks_x * parameters.blocks_y;
    let expected = parameters.block_raw_size();
    let wanted: Vec<(u32, &[u8])> = block_records(payload)?
        .into_iter()
        .filter_map(|record| Some((record.index, record.compressed?)))
        .filter(|(index, _)| {
            let (left, top) = block_origin(parameters, *index);
            left < x1 && top < y1 && left + BLOCK_SIZE as i64 > x0 && top + BLOCK_SIZE as i64 > y0
        })
        .collect();
    if let Some((index, _)) = wanted.iter().find(|(index, _)| *index >= block_count) {
        return Err(CspError::format(format!(
            "Block index {index} outside grid of {block_count}"
        )));
    }
    let decoded: Vec<(u32, Vec<u8>)> = wanted
        .par_iter()
        .map(|(index, compressed)| inflate(*index, compressed, expected).map(|raw| (*index, raw)))
        .collect::<Result<_>>()?;
    for (index, raw) in decoded {
        let (left, top) = block_origin(parameters, index);
        image.paste_block(&raw, parameters, left - x0, top - y0);
    }
    Ok(image)
}

fn block_origin(parameters: &OffscreenParameters, index: u32) -> (i64, i64) {
    let row = index / parameters.blocks_x;
    let column = index % parameters.blocks_x;
    (column as i64 * BLOCK_SIZE as i64, row as i64 * BLOCK_SIZE as i64)
}

/// Assemble the full image of an offscreen; None when it stores no pixels.
pub fn decode_offscreen_image(attribute: &[u8], payload: Option<&[u8]>) -> Result<Option<RgbaImage>> {
    let Some(payload) = payload else { return Ok(None) };
    let parameters = OffscreenParameters::parse(attribute)?;
    let box_ = (0, 0, parameters.width as i64, parameters.height as i64);
    decode_box(&parameters, payload, box_).map(Some)
}

/// Decode only the blocks overlapping `box_` (offscreen pixels). A name sheet
/// layer is about 14000x10000 px, while a page needs only its own cell.
pub fn decode_offscreen_region(
    attribute: &[u8],
    payload: Option<&[u8]>,
    box_: (i64, i64, i64, i64),
) -> Result<RgbaImage> {
    let Some(payload) = payload else {
        return Ok(RgbaImage::transparent(
            (box_.2 - box_.0).max(1) as u32,
            (box_.3 - box_.1).max(1) as u32,
        ));
    };
    decode_box(&OffscreenParameters::parse(attribute)?, payload, box_)
}

/// Canvas-independent boxes (offscreen pixels) of the blocks that store data.
pub fn occupied_blocks(attribute: &[u8], payload: &[u8]) -> Result<Vec<(i64, i64, i64, i64)>> {
    let parameters = OffscreenParameters::parse(attribute)?;
    Ok(block_records(payload)?
        .into_iter()
        .filter(|record| record.compressed.is_some())
        .map(|record| {
            let (left, top) = block_origin(&parameters, record.index);
            (left, top, left + BLOCK_SIZE as i64, top + BLOCK_SIZE as i64)
        })
        .collect())
}

/// Decode an offscreen shrunk by the integer `factor` (box filter on
/// premultiplied colour), without ever holding the full-size image: a whole
/// name sheet is over 500 MB as RGBA, its overview at factor 4 about 35 MB.
pub fn decode_offscreen_scaled(attribute: &[u8], payload: Option<&[u8]>, factor: u32) -> Result<Option<RgbaImage>> {
    let Some(payload) = payload else { return Ok(None) };
    let parameters = OffscreenParameters::parse(attribute)?;
    let factor = factor.max(1) as usize;
    let width = (parameters.width as usize).div_ceil(factor);
    let height = (parameters.height as usize).div_ceil(factor);
    // Premultiplied sums per output pixel: r, g, b, a, sample count.
    let mut sums = vec![[0u32; 5]; width * height];
    let expected = parameters.block_raw_size();
    let records: Vec<(u32, &[u8])> = block_records(payload)?
        .into_iter()
        .filter_map(|record| Some((record.index, record.compressed?)))
        .collect();
    // Decode in batches so that only a bounded number of raw blocks is alive.
    for batch in records.chunks(64) {
        let decoded: Vec<(u32, Vec<u8>)> = batch
            .par_iter()
            .map(|(index, compressed)| inflate(*index, compressed, expected).map(|raw| (*index, raw)))
            .collect::<Result<_>>()?;
        for (index, raw) in decoded {
            let (left, top) = block_origin(&parameters, index);
            let (alpha, color) = raw.split_at(BLOCK_PLANE_BYTES);
            for y in 0..BLOCK_SIZE {
                let source_y = top as usize + y;
                if source_y >= parameters.height as usize {
                    break;
                }
                let row = &mut sums[(source_y / factor) * width..(source_y / factor + 1) * width];
                for x in 0..BLOCK_SIZE {
                    let source_x = left as usize + x;
                    if source_x >= parameters.width as usize {
                        break;
                    }
                    let source = y * BLOCK_SIZE + x;
                    let a = alpha[source] as u32;
                    let rgb = match parameters.color_planes {
                        4 => [color[source * 4 + 2], color[source * 4 + 1], color[source * 4]],
                        1 => [color[source]; 3],
                        _ => [0, 0, 0],
                    };
                    let cell = &mut row[source_x / factor];
                    cell[0] += rgb[0] as u32 * a;
                    cell[1] += rgb[1] as u32 * a;
                    cell[2] += rgb[2] as u32 * a;
                    cell[3] += a;
                }
            }
        }
    }
    let mut image = RgbaImage::transparent(width as u32, height as u32);
    for (index, cell) in sums.iter().enumerate() {
        if cell[3] == 0 {
            continue;
        }
        let row = index / width;
        let column = index % width;
        // Samples of this output pixel that lie inside the offscreen.
        let samples_x = factor.min(parameters.width as usize - column * factor) as u32;
        let samples_y = factor.min(parameters.height as usize - row * factor) as u32;
        let pixel = &mut image.pixels[index * 4..index * 4 + 4];
        pixel[0] = (cell[0] / cell[3]) as u8;
        pixel[1] = (cell[1] / cell[3]) as u8;
        pixel[2] = (cell[2] / cell[3]) as u8;
        pixel[3] = (cell[3] / (samples_x * samples_y)) as u8;
    }
    Ok(Some(image))
}
