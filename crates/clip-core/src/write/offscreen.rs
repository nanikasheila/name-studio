//! Encode raster pixels into the block payload of a .clip offscreen.
//!
//! Inverse of [`crate::offscreen`]. Each 256x256 block holds an alpha plane
//! followed by interleaved BGRX colour (or one gray plane). Blocks without a
//! visible pixel are stored without data. CSP compresses with zlib at the
//! fastest level, so the same level is used. The `BlockCheckSum` tail is the
//! Adler-32 of `u32le zlib length + zlib data` (0 for empty blocks).

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use rayon::prelude::*;

use crate::error::{CspError, Result};
use crate::offscreen::{BLOCK_PLANE_BYTES, BLOCK_SIZE, OffscreenParameters, RgbaImage};
use crate::raster::luma;

const BLOCK_BEGIN_NAME: &str = "BlockDataBeginChunk";
const BLOCK_END_NAME: &str = "BlockDataEndChunk";
const STATUS_NAME: &str = "BlockStatus";
const CHECKSUM_NAME: &str = "BlockCheckSum";
const TAIL_HEADER: u32 = 12;
const TAIL_ENTRY_SIZE: u32 = 4;

fn name(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut result = (units.len() as u32).to_be_bytes().to_vec();
    result.extend(units.iter().flat_map(|unit| unit.to_be_bytes()));
    result
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for byte in chunk {
            a += *byte as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// Encode planar blocks (None = empty) into a full payload.
pub fn encode_block_records(raw_blocks: &[Option<Vec<u8>>], raw_size: usize) -> Result<Vec<u8>> {
    if let Some(index) = raw_blocks
        .iter()
        .position(|raw| raw.as_ref().is_some_and(|raw| raw.len() != raw_size))
    {
        return Err(CspError::format(format!(
            "Block {index} does not have {raw_size} bytes"
        )));
    }
    let compressed: Vec<Option<Vec<u8>>> = raw_blocks
        .par_iter()
        .map(|raw| {
            raw.as_ref().map(|raw| {
                let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(1));
                encoder.write_all(raw).expect("writing to memory");
                encoder.finish().expect("writing to memory")
            })
        })
        .collect();
    let (begin, end) = (name(BLOCK_BEGIN_NAME), name(BLOCK_END_NAME));
    let mut content = Vec::new();
    let mut checksums = Vec::with_capacity(raw_blocks.len());
    for (index, data) in compressed.iter().enumerate() {
        let mut body = Vec::new();
        for value in [
            index as u32,
            raw_size as u32,
            BLOCK_SIZE as u32,
            BLOCK_SIZE as u32,
            data.is_some() as u32,
        ] {
            body.extend_from_slice(&value.to_be_bytes());
        }
        let mut checksum = 0;
        if let Some(data) = data {
            let mut stored = (data.len() as u32).to_le_bytes().to_vec();
            stored.extend_from_slice(data);
            checksum = adler32(&stored);
            body.extend_from_slice(&(stored.len() as u32).to_be_bytes());
            body.extend_from_slice(&stored);
        }
        let length = 4 + begin.len() + body.len() + end.len();
        content.extend_from_slice(&(length as u32).to_be_bytes());
        content.extend_from_slice(&begin);
        content.extend_from_slice(&body);
        content.extend_from_slice(&end);
        checksums.push(checksum);
    }
    let count = raw_blocks.len() as u32;
    for (tail, values) in [(STATUS_NAME, vec![1; raw_blocks.len()]), (CHECKSUM_NAME, checksums)] {
        content.extend_from_slice(&name(tail));
        for value in [TAIL_HEADER, count, TAIL_ENTRY_SIZE].into_iter().chain(values) {
            content.extend_from_slice(&value.to_be_bytes());
        }
    }
    let mut payload = (content.len() as u64).to_be_bytes().to_vec();
    payload.extend_from_slice(&content);
    Ok(payload)
}

/// Split an RGBA image into planar blocks for an offscreen of `parameters`.
///
/// The image is placed at the offscreen's top-left; parts outside it are
/// dropped. Fully transparent blocks become None.
pub fn image_to_blocks(image: &RgbaImage, parameters: &OffscreenParameters) -> Result<Vec<Option<Vec<u8>>>> {
    // A layer mask has no colour planes: its one plane is the alpha (255 shows).
    let (gray, mask) = match parameters.color_planes {
        4 => (false, false),
        1 => (true, false),
        0 => (false, true),
        planes => {
            return Err(CspError::format(format!(
                "Offscreens with {planes} colour planes are not supported"
            )));
        }
    };
    let count = (parameters.blocks_x * parameters.blocks_y) as usize;
    Ok((0..count)
        .into_par_iter()
        .map(|index| {
            let (row, column) = (
                index / parameters.blocks_x as usize,
                index % parameters.blocks_x as usize,
            );
            let (left, top) = (column * BLOCK_SIZE, row * BLOCK_SIZE);
            let color_size = if mask {
                0
            } else if gray {
                BLOCK_PLANE_BYTES
            } else {
                BLOCK_PLANE_BYTES * 4
            };
            let mut raw = vec![0u8; BLOCK_PLANE_BYTES + color_size];
            let mut visible = false;
            let (alpha, color) = raw.split_at_mut(BLOCK_PLANE_BYTES);
            for y in 0..BLOCK_SIZE {
                let source_y = top + y;
                if source_y >= image.height as usize {
                    break;
                }
                for x in 0..BLOCK_SIZE {
                    let source_x = left + x;
                    if source_x >= image.width as usize {
                        break;
                    }
                    let source = (source_y * image.width as usize + source_x) * 4;
                    let pixel = &image.pixels[source..source + 4];
                    let target = y * BLOCK_SIZE + x;
                    alpha[target] = pixel[3];
                    visible |= pixel[3] != 0;
                    if mask {
                        continue;
                    }
                    if gray {
                        color[target] = luma(pixel[0], pixel[1], pixel[2]);
                    } else {
                        color[target * 4..target * 4 + 3].copy_from_slice(&[pixel[2], pixel[1], pixel[0]]);
                    }
                }
            }
            visible.then_some(raw)
        })
        .collect())
}

/// Encode an RGBA image as the external payload of an offscreen.
pub fn encode_offscreen_image(image: &RgbaImage, parameters: &OffscreenParameters) -> Result<Vec<u8>> {
    let blocks = image_to_blocks(image, parameters)?;
    encode_block_records(&blocks, BLOCK_PLANE_BYTES * parameters.total_planes as usize)
}

/// The external payload of an offscreen of `parameters` with no pixels.
pub fn empty_offscreen(parameters: &OffscreenParameters) -> Result<Vec<u8>> {
    let blocks = vec![None; (parameters.blocks_x * parameters.blocks_y) as usize];
    encode_block_records(&blocks, BLOCK_PLANE_BYTES * parameters.total_planes as usize)
}
