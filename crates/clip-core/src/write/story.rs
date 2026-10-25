//! The texts of a page's story info layers: (作品情報) holds 作品名・話数・
//! サブタイトル in its first block, 作者名 and ページ番号 in the blocks of
//! its attributes array; (ノンブル) holds the ノンブル. CSP marks each block
//! with the part it is (TLV 0x2e) and draws them afresh from these blocks,
//! so a part's text, style run length and block width are written together.

use rusqlite::Connection;
use rusqlite::types::Value;

use super::page::{STORY_INFO, TextItems, canvas_value, drop_render_cache, has_column, is_spread, story_layers};
use crate::clip::round_half_even;
use crate::error::Result;
use crate::text::{ATTR_BBOX, ATTR_BLOCK_SIZE, ATTR_QUAD, build_tlv, parse_tlv, split_attribute_array};

/// TLV 0x2e: which part of the story info a block is.
pub(crate) const ATTR_STORY_PART: u32 = 0x2e;
/// TLV 0x0b: the style runs (a count, then per run its start and length).
const ATTR_RUNS: u32 = 0x0b;

/// A part of the story info texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    /// 作品名・話数・サブタイトル.
    Title,
    Author,
    /// ページ番号 (`7ページ`).
    PageNumber,
    Nombre,
}

impl Part {
    /// The TLV 0x2e value CSP gives the part (the hidden ノンブル is 32).
    pub(crate) fn code(self) -> i64 {
        match self {
            Part::Title => 1,
            Part::Author => 2,
            Part::PageNumber => 4,
            Part::Nombre => 16,
        }
    }

    fn of(items: &TextItems) -> Option<Part> {
        match item(items, ATTR_STORY_PART).map(i32s).as_deref() {
            Some([1]) => Some(Part::Title),
            Some([2]) => Some(Part::Author),
            Some([4]) => Some(Part::PageNumber),
            Some([16] | [32]) => Some(Part::Nombre),
            _ => None,
        }
    }

    /// The part of a block without a 0x2e mark, by where it is.
    fn by_place(info: i64, column: &str, block: Option<usize>) -> Part {
        if info != STORY_INFO {
            return Part::Nombre;
        }
        match (column, block) {
            ("TextLayerAttributesArray", Some(0)) | ("TextLayerAddAttributesV01", Some(1)) => Part::Author,
            ("TextLayerAttributesArray", Some(_)) | ("TextLayerAddAttributesV01", Some(_)) => Part::PageNumber,
            _ => Part::Title,
        }
    }
}

/// Which edge of a text block stays where it is when its text changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Align {
    Start,
    Middle,
    End,
}

impl Align {
    /// Of CSP's 作品情報 positions: 1 左下, 2 下, 3 右下.
    pub(crate) fn of_position(position: i64) -> Align {
        match position {
            2 => Align::Middle,
            3 => Align::End,
            _ => Align::Start,
        }
    }
}

const STORY_COLUMNS: [&str; 3] = [
    "TextLayerAttributes",
    "TextLayerAttributesArray",
    "TextLayerAddAttributesV01",
];

/// Apply `edit` to the TLV items of each block of one story info layer, with
/// the part the block is and whether its style runs count characters.
pub(crate) fn edit_story_blobs(
    db: &Connection,
    layer_id: i64,
    info: i64,
    edit: &dyn Fn(Part, bool, TextItems) -> Result<TextItems>,
) -> Result<()> {
    for column in STORY_COLUMNS {
        if !has_column(db, "Layer", column)? {
            continue;
        }
        let blob: Value = db.query_row(
            &format!("SELECT \"{column}\" FROM Layer WHERE MainId = ?1"),
            [layer_id],
            |row| row.get(0),
        )?;
        let Value::Blob(blob) = blob else { continue };
        // The add-attributes runs carry no character counts.
        let counted = column != "TextLayerAddAttributesV01";
        let one = |bytes: &[u8], block: Option<usize>| -> Result<Vec<u8>> {
            let items: TextItems = parse_tlv(bytes)?
                .into_iter()
                .map(|(tag, value)| (tag, value.to_vec()))
                .collect();
            let part = Part::of(&items).unwrap_or_else(|| Part::by_place(info, column, block));
            Ok(build_tlv(&edit(part, counted, items)?))
        };
        let value = if column == "TextLayerAttributes" {
            one(&blob, None)?
        } else {
            let mut joined = Vec::new();
            for (index, block) in split_attribute_array(&blob)?.into_iter().enumerate() {
                let block = one(block, Some(index))?;
                joined.extend((block.len() as u32).to_le_bytes());
                joined.extend(block);
            }
            joined
        };
        db.execute(
            &format!("UPDATE Layer SET \"{column}\" = ?1 WHERE MainId = ?2"),
            (value, layer_id),
        )?;
    }
    Ok(())
}

pub(crate) fn i32s(value: &[u8]) -> Vec<i64> {
    value
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| i32::from_le_bytes(*bytes) as i64)
        .collect()
}

pub(crate) fn bytes(values: &[i64]) -> Vec<u8> {
    values.iter().flat_map(|value| (*value as i32).to_le_bytes()).collect()
}

pub(crate) fn item(items: &TextItems, tag: u32) -> Option<&[u8]> {
    items
        .iter()
        .find(|(id, _)| *id == tag)
        .map(|(_, value)| value.as_slice())
}

/// Font size in px of a story text (TLV 0x20 is pt × 100 at the canvas resolution).
pub(crate) fn em_px(items: &TextItems, resolution: f64) -> f64 {
    let points = item(items, crate::text::ATTR_FONT_SIZE)
        .filter(|value| value.len() == 4)
        .map(|value| i32::from_le_bytes(value.try_into().unwrap()) as f64 / 100.0)
        .unwrap_or(6.0);
    points * resolution / 72.0
}

/// The width of a story text's block: a full-width character is one em, the
/// space, digits and other ASCII narrower. CSP does not lay the block out
/// again when it opens the page, and breaks a text wider than its block
/// (a shown ノンブル `- 1 -` lost its last ` -`), so the narrow characters are
/// given as much as the widest fonts take (half an em for the space and
/// punctuation, CSP's own `作品名 1話` in ＭＳ ゴシック is 0.26 em for the space).
pub(crate) fn text_width(text: &str, em: f64) -> i64 {
    let ems: f64 = text
        .chars()
        .map(|character| match character {
            ' ' | '.' | ',' | '-' | ':' => 0.5,
            character if character.is_ascii() => 0.62,
            _ => 1.0,
        })
        .sum();
    round_half_even(ems * em).max(1)
}

/// `items` with its one style run `units` UTF-16 units long (counted runs only).
pub(crate) fn set_run_length(items: TextItems, units: usize, counted: bool) -> TextItems {
    items
        .into_iter()
        .map(|(tag, mut value)| {
            if tag == ATTR_RUNS && counted && value.len() >= 12 && value[0..4] == 1u32.to_le_bytes() {
                value[8..12].copy_from_slice(&(units as u32).to_le_bytes());
            }
            (tag, value)
        })
        .collect()
}

/// One item of a text block made `width` px wide: its bbox (keeping the
/// edge or middle `align` says), block size and quad.
pub(crate) fn resize_block(tag: u32, value: Vec<u8>, width: i64, align: Align) -> (u32, Vec<u8>) {
    match tag {
        ATTR_BBOX if value.len() == 16 => {
            let [x0, y0, x1, y1] = i32s(&value)[..] else {
                unreachable!()
            };
            let x0 = match align {
                Align::Start => x0,
                Align::Middle => (x0 + x1 - width).div_euclid(2),
                Align::End => x1 - width,
            };
            (tag, bytes(&[x0, y0, x0 + width, y1]))
        }
        ATTR_BLOCK_SIZE if value.len() == 8 => (tag, bytes(&[width, i32s(&value)[1]])),
        ATTR_QUAD if value.len() == 32 => {
            let mut quad = i32s(&value);
            for index in [2, 4] {
                quad[index] = quad[0] + width * 100;
            }
            (tag, bytes(&quad))
        }
        _ => (tag, value),
    }
}

/// Write `text` into one part's block(s): its style run and width.
pub(crate) fn write_part(
    db: &Connection,
    layer_id: i64,
    info: i64,
    part: Part,
    text: &str,
    align: Align,
) -> Result<()> {
    let resolution = resolution(db)?;
    let units = text.encode_utf16().count();
    edit_story_blobs(db, layer_id, info, &|found, counted, items| {
        if found != part {
            return Ok(items);
        }
        let width = text_width(text, em_px(&items, resolution));
        Ok(set_run_length(items, units, counted)
            .into_iter()
            .map(|(tag, value)| resize_block(tag, value, width, align))
            .collect())
    })
}

pub(crate) fn resolution(db: &Connection) -> Result<f64> {
    match canvas_value(db, "CanvasResolution")? {
        Some(Value::Real(number)) => Ok(number),
        Some(Value::Integer(number)) => Ok(number as f64),
        _ => Err(crate::error::CspError::format("Canvas has no resolution")),
    }
}

/// The strings of a layer's TextLayerStringArray.
pub(crate) fn string_array(db: &Connection, layer_id: i64) -> Result<Option<Vec<String>>> {
    if !has_column(db, "Layer", "TextLayerStringArray")? {
        return Ok(None);
    }
    let value: Value = db.query_row(
        "SELECT TextLayerStringArray FROM Layer WHERE MainId = ?1",
        [layer_id],
        |row| row.get(0),
    )?;
    let Value::Blob(blob) = value else { return Ok(None) };
    Ok(Some(
        split_attribute_array(&blob)?
            .into_iter()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect(),
    ))
}

pub(crate) fn set_string_array(db: &Connection, layer_id: i64, strings: &[String]) -> Result<()> {
    let mut blob = Vec::new();
    for string in strings {
        blob.extend((string.len() as u32).to_le_bytes());
        blob.extend(string.as_bytes());
    }
    db.execute(
        "UPDATE Layer SET TextLayerStringArray = ?1 WHERE MainId = ?2",
        (blob, layer_id),
    )?;
    Ok(())
}

/// The parts of the blocks of a layer's attributes array, in order.
pub(crate) fn array_parts(db: &Connection, layer_id: i64) -> Result<Vec<Part>> {
    if !has_column(db, "Layer", "TextLayerAttributesArray")? {
        return Ok(Vec::new());
    }
    let value: Value = db.query_row(
        "SELECT TextLayerAttributesArray FROM Layer WHERE MainId = ?1",
        [layer_id],
        |row| row.get(0),
    )?;
    let Value::Blob(blob) = value else {
        return Ok(Vec::new());
    };
    split_attribute_array(&blob)?
        .into_iter()
        .enumerate()
        .map(|(index, block)| {
            let items: TextItems = parse_tlv(block)?
                .into_iter()
                .map(|(tag, value)| (tag, value.to_vec()))
                .collect();
            Ok(Part::of(&items).unwrap_or_else(|| Part::by_place(STORY_INFO, "TextLayerAttributesArray", Some(index))))
        })
        .collect()
}

fn canvas_int(db: &Connection, column: &str) -> Result<Option<i64>> {
    Ok(match canvas_value(db, column)? {
        Some(Value::Integer(number)) => Some(number),
        Some(Value::Real(number)) => Some(number as i64),
        _ => None,
    })
}

fn canvas_text(db: &Connection, column: &str) -> Result<String> {
    Ok(match canvas_value(db, column)? {
        Some(Value::Text(text)) => text,
        Some(Value::Blob(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    })
}

/// The ページ番号 text of the 作品情報.
pub(crate) fn page_number_text(number: i64) -> String {
    format!("{number}ページ")
}

/// Write the page's own ページ番号 into its 作品情報, when the work shows one:
/// `ComicStoryPageNumberStart + ComicPageIndex` (and the next one for the
/// right page of a spread that starts on the left, and so on).
pub(crate) fn update_page_number(db: &Connection, first_right: bool) -> Result<()> {
    if canvas_int(db, "ComicStoryUsePageNumber")? != Some(1) {
        return Ok(());
    }
    let first =
        canvas_int(db, "ComicStoryPageNumberStart")?.unwrap_or(1) + canvas_int(db, "ComicPageIndex")?.unwrap_or(0);
    let align = Align::of_position(canvas_int(db, "ComicStoryPageNumberPosition")?.unwrap_or(3));
    let spread = is_spread(db)?;
    for (layer_id, right) in story_layers(db, STORY_INFO)? {
        let number = if spread && right != first_right {
            first + 1
        } else {
            first
        };
        let text = page_number_text(number);
        let Some(mut strings) = string_array(db, layer_id)? else {
            continue;
        };
        let Some(index) = array_parts(db, layer_id)?
            .iter()
            .position(|part| *part == Part::PageNumber)
        else {
            continue;
        };
        if strings.get(index).is_none_or(|old| *old == text) {
            continue;
        }
        strings[index] = text.clone();
        set_string_array(db, layer_id, &strings)?;
        write_part(db, layer_id, STORY_INFO, Part::PageNumber, &text, align)?;
        drop_render_cache(db, layer_id)?;
    }
    Ok(())
}

/// How the work shows its ノンブル: the text around the number, and whether
/// it stays centred (上部 / 下部) as the number changes.
pub(crate) struct NombreStyle {
    pub prefix: String,
    pub suffix: String,
    pub centred: bool,
}

/// The ノンブル style of the page's work (none for the hidden ノンブル).
pub(crate) fn nombre_style(db: &Connection) -> Result<Option<NombreStyle>> {
    if canvas_int(db, "ComicStoryUseShownNombre")? != Some(1) {
        return Ok(None);
    }
    let position = canvas_int(db, "ComicStoryNombrePosition")?.unwrap_or(5);
    Ok(Some(NombreStyle {
        prefix: canvas_text(db, "ComicStoryNombrePrefix")?,
        suffix: canvas_text(db, "ComicStoryNombreSuffix")?,
        centred: matches!(position, 2 | 5),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_a_text_room_enough_not_to_break() {
        // ＭＳ ゴシック: ASCII is half an em; `- 1 -` at 9 pt (75 px at 600 dpi).
        assert!(text_width("- 1 -", 75.0) >= 188);
        // Full-width characters are an em each.
        assert_eq!(text_width("作品名", 50.0), 150);
    }
}
