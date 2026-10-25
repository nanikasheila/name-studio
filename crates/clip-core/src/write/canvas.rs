//! Change the size of a page's canvas: the offscreens, thumbnails and
//! preview sized by it (see docs/csp-spread-format.md).

use rusqlite::Connection;
use rusqlite::types::Value;

use super::editor::ClipEditor;
use super::offscreen::encode_offscreen_image;
use super::page::has_column;
use super::schema::{table_names, text_of};
use crate::error::{CspError, Result};
use crate::offscreen::{BLOCK_SIZE, OffscreenParameters, RgbaImage, decode_offscreen_image};
use crate::raster::decode_png;

/// Mipmap level sizes from a base size: each level is half of the one
/// before, rounded down.
fn levels(base: i64) -> Vec<i64> {
    let mut result = vec![base];
    while result.len() < 16 && *result.last().unwrap() > 1 {
        result.push(result.last().unwrap() / 2);
    }
    result
}

fn padded(size: i64) -> i64 {
    (size + BLOCK_SIZE as i64 - 1) / BLOCK_SIZE as i64 * BLOCK_SIZE as i64
}

/// Makes an offscreen's new image (`width` × `height`) from what it showed
/// before (`None` when it had no visible pixels).
pub(crate) type Refill<'a> = dyn Fn(Option<RgbaImage>, u32, u32) -> RgbaImage + 'a;

/// Resize every offscreen sized by the canvas from `old` to `new` (px):
/// render mipmaps (the root's at the exact canvas size, the layers' padded
/// to whole blocks) at every level. Layer thumbnails and text render caches
/// keep their size. `refill` gives each one its new pixels.
pub(crate) fn resize_offscreens(
    editor: &mut ClipEditor,
    (width, height): (i64, i64),
    (new_width, new_height): (i64, i64),
    refill: &Refill,
) -> Result<()> {
    let families = [
        (levels(width), levels(height), levels(new_width), levels(new_height)),
        (
            levels(padded(width)),
            levels(padded(height)),
            levels(padded(new_width)),
            levels(padded(new_height)),
        ),
    ];
    let rows: Vec<(i64, Vec<u8>, Value)> = {
        let mut statement = editor
            .db
            .prepare("SELECT MainId, Attribute, BlockData FROM Offscreen")?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?
    };
    for (id, attribute, block) in rows {
        let Ok(parameters) = OffscreenParameters::parse(&attribute) else {
            continue;
        };
        let size = (parameters.width as i64, parameters.height as i64);
        let Some((target_width, target_height)) = families.iter().find_map(|(widths, heights, new_w, new_h)| {
            let count = widths.len().min(heights.len()).min(new_w.len()).min(new_h.len());
            (0..count)
                .find(|level| (widths[*level], heights[*level]) == size)
                .map(|level| (new_w[level], new_h[level]))
        }) else {
            continue;
        };
        let external = text_of(&block);
        let old = decode_offscreen_image(&attribute, editor.externals.get(&external))?;
        let resized = OffscreenParameters {
            width: target_width as u32,
            height: target_height as u32,
            blocks_x: (target_width as u32).div_ceil(BLOCK_SIZE as u32),
            blocks_y: (target_height as u32).div_ceil(BLOCK_SIZE as u32),
            ..parameters
        };
        let image = refill(old.filter(|old| !old.is_transparent()), resized.width, resized.height);
        let payload = encode_offscreen_image(&image, &resized)?;
        let attribute = resized_attribute(&attribute, &parameters, &resized, &payload)?;
        editor
            .db
            .execute("UPDATE Offscreen SET Attribute = ?1 WHERE MainId = ?2", (attribute, id))?;
        // CSP stores only some levels' pixels and makes the rest when it
        // opens the page; an offscreen stays without pixels when it had none.
        if editor.externals.get(&external).is_some() {
            editor.externals.insert(external, payload);
        }
    }
    Ok(())
}

/// The offscreen attribute starts with four u32: its own length, then the
/// lengths of the Parameter, InitColor and BlockSize sections.
const ATTRIBUTE_HEADER: usize = 16;
const BLOCK_SIZE_HEADER: u32 = 12;

/// The offscreen attribute for the new size: the Parameter section's size
/// and block grid, and the BlockSize section (block count, then each block
/// record's length in the payload) rebuilt for `payload`.
fn resized_attribute(
    attribute: &[u8],
    old: &OffscreenParameters,
    new: &OffscreenParameters,
    payload: &[u8],
) -> Result<Vec<u8>> {
    let malformed = || CspError::format("オフスクリーンの属性の形式が分かりません");
    let be = |at: usize| -> Result<u32> {
        Ok(u32::from_be_bytes(
            attribute.get(at..at + 4).ok_or_else(malformed)?.try_into().unwrap(),
        ))
    };
    if be(0)? as usize != ATTRIBUTE_HEADER {
        return Err(malformed());
    }
    let (parameter_length, init_length, block_length) = (be(4)? as usize, be(8)? as usize, be(12)? as usize);
    let block_start = ATTRIBUTE_HEADER + parameter_length + init_length;
    if block_start + block_length != attribute.len() {
        return Err(malformed());
    }
    let mut result = attribute[..block_start].to_vec();
    // Parameter: name, then width, height, blocks_x, blocks_y, ...
    let (_, values) = crate::bytes::utf16_name(attribute, ATTRIBUTE_HEADER)?;
    for (index, value) in [new.width, new.height, new.blocks_x, new.blocks_y]
        .into_iter()
        .enumerate()
    {
        result[values + 4 * index..values + 4 * index + 4].copy_from_slice(&value.to_be_bytes());
    }
    // BlockSize: name, then 12, the block count, 4, and one u32 per block.
    let section = &attribute[block_start..];
    let (name, after_name) = crate::bytes::utf16_name(section, 0)?;
    let count = (old.blocks_x * old.blocks_y) as usize;
    let field = |at: usize| {
        section
            .get(at..at + 4)
            .map(|bytes| u32::from_be_bytes(bytes.try_into().unwrap()))
    };
    if name != "BlockSize"
        || field(after_name) != Some(BLOCK_SIZE_HEADER)
        || field(after_name + 4) != Some(count as u32)
        || section.len() != after_name + 12 + 4 * count
    {
        return Err(malformed());
    }
    let sizes = record_lengths(payload)?;
    if sizes.len() != (new.blocks_x * new.blocks_y) as usize {
        return Err(malformed());
    }
    let mut block = section[..after_name].to_vec();
    block.extend(BLOCK_SIZE_HEADER.to_be_bytes());
    block.extend((sizes.len() as u32).to_be_bytes());
    block.extend(4u32.to_be_bytes());
    for size in &sizes {
        block.extend(size.to_be_bytes());
    }
    result[12..16].copy_from_slice(&(block.len() as u32).to_be_bytes());
    result.extend(block);
    Ok(result)
}

/// The length of each block record of an offscreen payload, in order.
fn record_lengths(payload: &[u8]) -> Result<Vec<u32>> {
    let records = crate::offscreen::block_records(payload)?;
    let mut lengths = Vec::with_capacity(records.len());
    let mut at = 8;
    for _ in &records {
        let length = u32::from_be_bytes(
            payload
                .get(at..at + 4)
                .ok_or_else(|| CspError::format("block record overruns the payload"))?
                .try_into()
                .unwrap(),
        );
        lengths.push(length);
        at += length as usize;
    }
    Ok(lengths)
}

/// Record the canvas size (px) the layer thumbnails were drawn for.
pub(crate) fn set_thumbnail_canvas(db: &Connection, width: i64, height: i64) -> Result<()> {
    for (column, value) in [("ThumbnailCanvasWidth", width), ("ThumbnailCanvasHeight", height)] {
        if has_column(db, "LayerThumbnail", column)? {
            db.execute(&format!("UPDATE LayerThumbnail SET \"{column}\" = ?1"), [value])?;
        }
    }
    Ok(())
}

/// CSP keeps the page preview at an eighth of the canvas.
const PREVIEW_SCALE: f64 = 8.0;

/// A blank (white) preview for a canvas of `width` × `height` px, at the
/// size CSP gives it.
pub(crate) fn blank_preview(db: &Connection, width: i64, height: i64) -> Result<()> {
    if !table_names(db)?.contains("CanvasPreview") {
        return Ok(());
    }
    let row: Option<(i64, Option<Vec<u8>>)> = db
        .query_row(
            "SELECT rowid, ImageData FROM CanvasPreview ORDER BY rowid LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((row_id, Some(png))) = row else {
        return Ok(());
    };
    if decode_png(&png).is_err() {
        return Ok(());
    }
    let size = |pixels: i64| ((pixels as f64 / PREVIEW_SCALE).round() as u32).max(1);
    let (preview_width, preview_height) = (size(width), size(height));
    let preview = RgbaImage {
        width: preview_width,
        height: preview_height,
        pixels: [255, 255, 255, 255].repeat(preview_width as usize * preview_height as usize),
    };
    db.execute(
        "UPDATE CanvasPreview SET ImageData = ?1 WHERE rowid = ?2",
        (preview.to_png()?, row_id),
    )?;
    for (column, value) in [("ImageWidth", preview_width), ("ImageHeight", preview_height)] {
        if has_column(db, "CanvasPreview", column)? {
            db.execute(
                &format!("UPDATE CanvasPreview SET \"{column}\" = ?1 WHERE rowid = ?2"),
                (value, row_id),
            )?;
        }
    }
    Ok(())
}
