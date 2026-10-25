//! Write one page .clip from a name sheet and its split plan.
//!
//! Each planned page becomes a .clip that keeps the sheet's layers: raster
//! parts are cropped and enlarged, vector and text layers are copied with
//! their coordinates moved and scaled. A CSP-made empty page of the same
//! work is the template; the sheet's schema (vector tables, extra layer
//! columns) and brush styles are added to it, then every planned content is
//! copied in sheet order, inside the same folders as on the sheet.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::editor::ClipEditor;
use super::schema::{column_names, merge_columns, merge_schema, table_names};
use super::story::{nombre_style, update_page_number};
use super::{Values, set_value, value_of};
use crate::clip::{ClipDocument, LayerKind, round_half_even};
use crate::error::Result;
use crate::plan::{CellTransform, PlannedContent, PlannedPage};
use crate::raster::{Filter, decode_png, resize};
use crate::text::{
    ATTR_BBOX, ATTR_BLOCK_SIZE, ATTR_QUAD, ATTR_RENDER_CACHE, build_tlv, parse_tlv, split_attribute_array,
    transform_text_attributes,
};
use crate::vector::{select_vector_objects, transform_vector_data};

/// Not Canvas: a spread sheet has ComicStory/NombreRightLayerCreated columns,
/// and a single right page that has them (as NULL) makes CSP rebuild its story
/// info layers and mark the page modified on opening. See [`CANVAS_COLUMNS`].
const SCHEMA_TABLES: [&str; 4] = ["Layer", "VectorObjectList", "BrushStyleManager", "BrushStyle"];
/// The Canvas columns a page does take: vector lines find their brush styles
/// through `Canvas.BrushStyleManager`, and without it CSP opens them empty.
const CANVAS_COLUMNS: [&str; 1] = ["BrushStyleManager"];
/// Vector objects refer to brush styles by id, so these rows keep their ids.
const SHARED_TABLES: [&str; 2] = ["BrushStyleManager", "BrushStyle"];
const TEXT_BLOBS: [&str; 1] = ["TextLayerAttributes"];
const TEXT_ARRAYS: [&str; 2] = ["TextLayerAttributesArray", "TextLayerAddAttributesV01"];
/// Style runs of a text: u32 count, then (u32 start, u32 length, ...).
const RUN_TAG: u32 = 0x0B;
/// CropFrameOptionFlag bits CSP sets for a single left / right page (a spread has 17).
pub(crate) const LEFT_PAGE_FLAG: i64 = 2;
pub(crate) const RIGHT_PAGE_FLAG: i64 = 4;
/// Layer.ComicStoryInfoType of the 作品情報 and (ノンブル) layers.
pub(crate) const STORY_INFO: i64 = 1;
pub(crate) const NOMBRE_INFO: i64 = 2;
/// Layer column of a spread's story info layers: 1 for the right page's.
pub(crate) const FOR_RIGHT_PAGE: &str = "ComicStoryInfoForRightPage";

/// The TLV items of one text attribute block, as edited in place.
pub(crate) type TextItems = Vec<(u32, Vec<u8>)>;

#[derive(Debug, Clone, PartialEq)]
pub struct PageResult {
    pub path: PathBuf,
    pub layer_ids: Vec<i64>,
    pub warnings: Vec<String>,
}

/// Write `page` of `sheet` into a copy of `template` saved as `output`.
///
/// `page_index` is the 0-based position of the page in the work (CSP's
/// `ComicPageIndex`, used for the ノンブル); it defaults to `page.number - 1`.
/// `canvas_values` overrides Canvas columns the template has (for example
/// the work's `ComicStory*` settings from its .cmc).
pub fn write_page(
    template: &Path,
    sheet: &ClipDocument,
    page: &PlannedPage,
    output: &Path,
    page_index: Option<i64>,
    canvas_values: &Values,
) -> Result<PageResult> {
    let mut editor = ClipEditor::open(template)?;
    editor.renew_ids()?;
    apply_page_settings(&editor.db, page_index.unwrap_or(page.number - 1), canvas_values, None)?;
    let source = sheet.database();
    merge_page_schema(&editor.db, source)?;
    share_rows(&editor.db, source)?;
    let mut result = PageResult {
        path: output.to_path_buf(),
        layer_ids: Vec::new(),
        warnings: Vec::new(),
    };
    let payload = |id: &str| sheet.container.external_payload(id).map(<[u8]>::to_vec);
    let mut folders: HashMap<i64, i64> = HashMap::new();
    for content in &page.contents {
        let mut parent = editor.root_id;
        for folder_id in &content.folder_ids {
            let folder = match folders.get(folder_id) {
                Some(folder) => *folder,
                None => {
                    let folder = editor.add_layer(source, &payload, *folder_id, None, None)?;
                    editor.append_to_folder(parent, folder, None)?;
                    folders.insert(*folder_id, folder);
                    folder
                }
            };
            parent = folder;
        }
        let new_id = add_content(&mut editor, sheet, content, &page.transform, &mut result.warnings)?;
        editor.append_to_folder(parent, new_id, None)?;
        result.layer_ids.push(new_id);
    }
    update_preview(&editor.db, sheet, page)?;
    editor.save(output)?;
    Ok(result)
}

/// Set the page position in the work and the work's canvas settings (and
/// with them the episode number in the story information text).
///
/// `zero_left` is whether page index 0 is a left page; none keeps the
/// template's own parity. On a spread it tells which half has the page that
/// comes first in the book (the right one in a right-bound manga).
pub(crate) fn apply_page_settings(
    db: &Connection,
    page_index: i64,
    canvas_values: &Values,
    zero_left: Option<bool>,
) -> Result<()> {
    // Page `page_index` is on the left when page 0 is and the two are an even
    // number apart; the other half of a spread is the next page.
    let first_right = zero_left
        .map(|left| left != (page_index.rem_euclid(2) == 0))
        .unwrap_or(true);
    if is_spread(db)? {
        // A spread keeps its sides: the right half is the right page.
        if has_column(db, "Canvas", "ComicPageIndex")? {
            db.execute("UPDATE Canvas SET ComicPageIndex = ?1", [page_index])?;
        }
    } else {
        set_page_index(db, page_index, zero_left)?;
    }
    if !canvas_values.is_empty() {
        let old_index = canvas_value(db, "ComicStoryStoryIndex")?;
        set_canvas_values(db, canvas_values)?;
        if let (Some(Value::Integer(old)), Some(Value::Integer(new))) =
            (old_index, value_of(canvas_values, "ComicStoryStoryIndex"))
            && old != *new
        {
            replace_story_index(db, old, *new)?;
        }
    }
    update_page_number(db, first_right)?;
    update_nombre(db, first_right)
}

fn add_content(
    editor: &mut ClipEditor,
    sheet: &ClipDocument,
    content: &PlannedContent,
    transform: &CellTransform,
    warnings: &mut Vec<String>,
) -> Result<i64> {
    let layer = sheet.find_layer(content.layer_id)?;
    let scale = transform.scale;
    let dx = transform.dx + layer.offset_x as f64 * scale;
    let dy = transform.dy + layer.offset_y as f64 * scale;
    let payload_hook = |table: &str, _column: &str, payload: Vec<u8>| -> Result<Vec<u8>> {
        if table != "VectorObjectList" {
            return Ok(payload);
        }
        let payload = if content.kind == LayerKind::Vector && !content.items.is_empty() {
            select_vector_objects(&payload, &content.items)?
        } else {
            payload
        };
        transform_vector_data(&payload, scale, dx, dy)
    };
    let mut array_warnings = Vec::new();
    let mut row_hook = |values: &mut Values| -> Result<()> {
        for column in TEXT_BLOBS {
            if let Some(Value::Blob(blob)) = value_of(values, column)
                && !blob.is_empty()
            {
                let moved = transform_text_attributes(blob, scale, dx, dy)?;
                set_value(values, column, Value::Blob(moved));
            }
        }
        for column in TEXT_ARRAYS {
            if let Some(Value::Blob(blob)) = value_of(values, column)
                && !blob.is_empty()
            {
                let moved = transform_array(blob, scale, dx, dy, column, &mut array_warnings);
                set_value(values, column, Value::Blob(moved));
            }
        }
        Ok(())
    };
    let payload = |id: &str| sheet.container.external_payload(id).map(<[u8]>::to_vec);
    let new_id = editor.add_layer(
        sheet.database(),
        &payload,
        layer.main_id,
        Some(&mut row_hook),
        Some(&payload_hook),
    )?;
    warnings.append(&mut array_warnings);
    if content.kind == LayerKind::Raster
        && let Some(crop) = content.crop
    {
        let (x0, y0, x1, y1) = (
            crop.0.floor() as i64,
            crop.1.floor() as i64,
            crop.2.ceil() as i64,
            crop.3.ceil() as i64,
        );
        let region = sheet.layer_pixels_in_box(layer, (x0, y0, x1, y1))?;
        if !region.is_transparent() {
            let (tx0, ty0, tx1, ty1) = transform.map_box((x0 as f64, y0 as f64, x1 as f64, y1 as f64));
            let width = round_half_even(tx1 - tx0).max(1) as u32;
            let height = round_half_even(ty1 - ty0).max(1) as u32;
            let scaled = resize(&region, width, height, Filter::Lanczos3);
            editor.set_layer_image(new_id, &scaled, (round_half_even(tx0), round_half_even(ty0)))?;
        }
    }
    if content.kind == LayerKind::Text && !content.items.is_empty() && sheet.text_blocks(layer)?.len() > 1 {
        warnings.push(format!(
            "テキストレイヤー「{}」はレイヤーごと写したため、ほかのページの文字も含まれます",
            layer.name
        ));
    }
    Ok(new_id)
}

fn transform_array(blob: &[u8], scale: f64, dx: f64, dy: f64, column: &str, warnings: &mut Vec<String>) -> Vec<u8> {
    let moved = split_attribute_array(blob).and_then(|blocks| {
        blocks
            .into_iter()
            .map(|block| transform_text_attributes(block, scale, dx, dy))
            .collect::<Result<Vec<_>>>()
    });
    match moved {
        Ok(blocks) => blocks
            .into_iter()
            .flat_map(|block| {
                let mut entry = (block.len() as u32).to_le_bytes().to_vec();
                entry.extend(block);
                entry
            })
            .collect(),
        Err(_) => {
            warnings.push(format!("{column} の形式が分からないため、そのまま写しました"));
            blob.to_vec()
        }
    }
}

pub(crate) fn has_column(db: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(column_names(db, table)?.iter().any(|name| name == column))
}

/// Set the page position and side (left / right) on the copied canvas.
///
/// CSP numbers pages and places the ノンブル from these columns. The side
/// alternates with the index; `zero_left` (page 0 is a left page) gives the
/// parity, else the template's own pair does.
fn set_page_index(db: &Connection, index: i64, zero_left: Option<bool>) -> Result<()> {
    if !has_column(db, "Canvas", "ComicPageIndex")? || !has_column(db, "Canvas", "ComicIsLeftPage")? {
        return Ok(());
    }
    let (template_index, template_left): (Option<i64>, Option<i64>) =
        db.query_row("SELECT ComicPageIndex, ComicIsLeftPage FROM Canvas", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let left = match zero_left {
        Some(zero_left) => zero_left == index.rem_euclid(2).eq(&0),
        None => (template_left.unwrap_or(0) != 0) == (index - template_index.unwrap_or(0)).rem_euclid(2).eq(&0),
    };
    db.execute(
        "UPDATE Canvas SET ComicPageIndex = ?1, ComicIsLeftPage = ?2",
        (index, left as i64),
    )?;
    if let Some(Value::Integer(flag)) = canvas_value(db, "CropFrameOptionFlag")?
        && flag & (LEFT_PAGE_FLAG | RIGHT_PAGE_FLAG) != 0
    {
        let side = if left { LEFT_PAGE_FLAG } else { RIGHT_PAGE_FLAG };
        let flag = (flag & !(LEFT_PAGE_FLAG | RIGHT_PAGE_FLAG)) | side;
        db.execute("UPDATE Canvas SET CropFrameOptionFlag = ?1", [flag])?;
    }
    if (template_left.unwrap_or(0) != 0) != left {
        mirror_nombre(db)?;
    }
    Ok(())
}

/// The (ノンブル) layer of a single page. A spread has a second one for its
/// right page; only single pages are templates.
fn nombre_layer(db: &Connection) -> Result<Option<i64>> {
    let ids = story_layers(db, NOMBRE_INFO)?;
    Ok(if ids.len() == 1 { Some(ids[0].0) } else { None })
}

/// Story info layers of one kind as (id, for the right page of a spread).
pub(crate) fn story_layers(db: &Connection, info: i64) -> Result<Vec<(i64, bool)>> {
    if !has_column(db, "Layer", "ComicStoryInfoType")? {
        return Ok(Vec::new());
    }
    let side = if has_column(db, "Layer", FOR_RIGHT_PAGE)? {
        format!("IFNULL(\"{FOR_RIGHT_PAGE}\", 0)")
    } else {
        "0".to_owned()
    };
    let mut statement = db.prepare(&format!(
        "SELECT MainId, {side} FROM Layer WHERE ComicStoryInfoType = ?1 ORDER BY MainId"
    ))?;
    let ids = statement
        .query_map([info], |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ids)
}

pub(crate) fn is_spread(db: &Connection) -> Result<bool> {
    Ok(matches!(canvas_value(db, "CanvasDoublePage")?, Some(Value::Integer(flag)) if flag != 0))
}

pub(crate) fn canvas_width(db: &Connection) -> Result<i64> {
    let (width, resolution, unit): (f64, f64, i64) = db.query_row(
        "SELECT CanvasWidth, CanvasResolution, CanvasUnit FROM Canvas",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(round_half_even(canvas_width_px(width, resolution, unit)))
}

pub(crate) fn layer_offset_x(db: &Connection, layer_id: i64) -> Result<i64> {
    let offset: Option<i64> = db.query_row("SELECT LayerOffsetX FROM Layer WHERE MainId = ?1", [layer_id], |row| {
        row.get(0)
    })?;
    Ok(offset.unwrap_or(0))
}

/// Move the (ノンブル) to the other side of the page.
///
/// The hidden ノンブル sits at the binding edge, which is on the other side
/// for left and right pages. CSP moves it when it opens a page whose side
/// differs from where the template had it, and then marks the page as
/// modified. The text block's bbox is mirrored across the canvas width.
pub(crate) fn mirror_nombre(db: &Connection) -> Result<()> {
    let Some(layer_id) = nombre_layer(db)? else {
        return Ok(());
    };
    let width = canvas_width(db)?;
    let offset = layer_offset_x(db, layer_id)?;
    let mirror = |x0: i64, x1: i64| (width - (x1 + offset) - offset, width - (x0 + offset) - offset);
    edit_text_blocks(db, layer_id, &|items| map_bbox_x(items, &mirror))
}

/// Write the page's own number into the (ノンブル) text.
///
/// The template's ノンブル shows the template's page number; CSP writes
/// `ComicStoryNombreStart + ComicPageIndex` there (a shown ノンブル with the
/// work's prefix and suffix around it). The text and its style run
/// change, and the block widens or narrows by the template's width per
/// character, keeping the edge nearer to the page border (the binding edge).
pub(crate) fn update_nombre(db: &Connection, first_right: bool) -> Result<()> {
    if !has_column(db, "Canvas", "ComicPageIndex")? || !has_column(db, "Canvas", "ComicStoryNombreStart")? {
        return Ok(());
    }
    let (index, start): (Option<i64>, Option<i64>) =
        db.query_row("SELECT ComicPageIndex, ComicStoryNombreStart FROM Canvas", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let first = start.unwrap_or(1) + index.unwrap_or(0);
    // A shown ノンブル has the work's text around the number.
    let style = nombre_style(db)?;
    let text = |number: i64| match &style {
        Some(style) => format!("{}{number}{}", style.prefix, style.suffix),
        None => number.to_string(),
    };
    let centred = style.as_ref().is_some_and(|style| style.centred);
    if is_spread(db)? {
        for (layer_id, right) in story_layers(db, NOMBRE_INFO)? {
            let number = if right == first_right { first } else { first + 1 };
            set_nombre(db, layer_id, &text(number), centred)?;
        }
        return Ok(());
    }
    let Some(layer_id) = nombre_layer(db)? else {
        return Ok(());
    };
    set_nombre(db, layer_id, &text(first), centred)
}

/// Write `number` into one (ノンブル) layer.
fn set_nombre(db: &Connection, layer_id: i64, number: &str, centred: bool) -> Result<()> {
    let number = number.to_owned();
    let (string, attributes): (Value, Value) = db.query_row(
        "SELECT TextLayerString, TextLayerAttributes FROM Layer WHERE MainId = ?1",
        [layer_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let old = match string {
        Value::Blob(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Value::Text(text) => text,
        _ => String::new(),
    };
    if old.is_empty() || old == number {
        return Ok(());
    }
    let (old_length, new_length) = (old.chars().count() as i64, number.chars().count() as i64);
    let width = canvas_width(db)?;
    let offset = layer_offset_x(db, layer_id)?;
    let resize = |items: TextItems| -> TextItems {
        let Some(block) = items
            .iter()
            .find(|(tag, value)| *tag == ATTR_BLOCK_SIZE && value.len() == 8)
            .map(|(_, value)| value.clone())
        else {
            return items;
        };
        let [block_width, height] = i32_pair(&block);
        let new_width = round_half_even(block_width as f64 * new_length as f64 / old_length as f64).max(1);
        let grow = new_width - block_width as i64;
        let keep_border_edge = |x0: i64, x1: i64| {
            if centred {
                let x0 = (x0 + x1 - new_width).div_euclid(2);
                (x0, x0 + new_width)
            } else if x0 + offset < width - (x1 + offset) {
                (x0, x1 + grow)
            } else {
                (x0 - grow, x1)
            }
        };
        map_bbox_x(items, &keep_border_edge)
            .into_iter()
            .map(|(tag, mut value)| {
                if tag == ATTR_BLOCK_SIZE {
                    value = [new_width as i32, height]
                        .iter()
                        .flat_map(|n| n.to_le_bytes())
                        .collect();
                } else if tag == ATTR_QUAD && value.len() == 32 {
                    // The right-hand x of the quad, in 1/100 px.
                    for position in [2, 4] {
                        let at = position * 4;
                        let x = i32::from_le_bytes(value[at..at + 4].try_into().unwrap()) as i64 + grow * 100;
                        value[at..at + 4].copy_from_slice(&(x as i32).to_le_bytes());
                    }
                }
                (tag, value)
            })
            .collect()
    };
    db.execute(
        "UPDATE Layer SET TextLayerString = ?1 WHERE MainId = ?2",
        (number.as_bytes(), layer_id),
    )?;
    if let Value::Blob(attributes) = attributes {
        let moved = move_run_length(&attributes, new_length - old_length)?;
        db.execute(
            "UPDATE Layer SET TextLayerAttributes = ?1 WHERE MainId = ?2",
            (moved, layer_id),
        )?;
    }
    edit_text_blocks(db, layer_id, &resize)?;
    drop_render_cache(db, layer_id)
}

fn i32_pair(value: &[u8]) -> [i32; 2] {
    [
        i32::from_le_bytes(value[0..4].try_into().unwrap()),
        i32::from_le_bytes(value[4..8].try_into().unwrap()),
    ]
}

pub(crate) fn map_bbox_x(items: TextItems, change: &dyn Fn(i64, i64) -> (i64, i64)) -> TextItems {
    items
        .into_iter()
        .map(|(tag, value)| {
            if tag != ATTR_BBOX || value.len() != 16 {
                return (tag, value);
            }
            let number = |at: usize| i32::from_le_bytes(value[at..at + 4].try_into().unwrap());
            let (x0, x1) = change(number(0) as i64, number(8) as i64);
            let bbox: Vec<u8> = [x0 as i32, number(4), x1 as i32, number(12)]
                .iter()
                .flat_map(|n| n.to_le_bytes())
                .collect();
            (tag, bbox)
        })
        .collect()
}

/// Apply `edit` to the TLV items of every attribute blob of one text layer.
pub(crate) fn edit_text_blocks(db: &Connection, layer_id: i64, edit: &dyn Fn(TextItems) -> TextItems) -> Result<()> {
    let owned = |blob: &[u8]| -> Result<Vec<u8>> {
        let items = parse_tlv(blob)?
            .into_iter()
            .map(|(tag, value)| (tag, value.to_vec()))
            .collect();
        Ok(build_tlv(&edit(items)))
    };
    for column in TEXT_BLOBS.iter().chain(TEXT_ARRAYS.iter()) {
        if !has_column(db, "Layer", column)? {
            continue;
        }
        let blob: Value = db.query_row(
            &format!("SELECT \"{column}\" FROM Layer WHERE MainId = ?1"),
            [layer_id],
            |row| row.get(0),
        )?;
        let Value::Blob(blob) = blob else { continue };
        if blob.is_empty() {
            continue;
        }
        let value = if TEXT_BLOBS.contains(column) {
            owned(&blob)?
        } else {
            let mut joined = Vec::new();
            for block in split_attribute_array(&blob)? {
                let block = owned(block)?;
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

/// Make CSP draw a story info / ノンブル text anew instead of its cached
/// image: CSP shows the image the file caches for the text (TLV 0x32 →
/// Offscreen) rather than the text, so a changed text kept showing the
/// template's "… 3話" or page number.
pub(crate) fn drop_render_cache(db: &Connection, layer_id: i64) -> Result<()> {
    edit_text_blocks(db, layer_id, &|items| {
        items
            .into_iter()
            .map(|(tag, value)| {
                if tag == ATTR_RENDER_CACHE && value.len() == 4 {
                    (tag, vec![0; 4])
                } else {
                    (tag, value)
                }
            })
            .collect()
    })
}

fn set_canvas_values(db: &Connection, values: &Values) -> Result<()> {
    let known = column_names(db, "Canvas")?;
    for (column, value) in values {
        if known.contains(column) {
            db.execute(&format!("UPDATE Canvas SET \"{column}\" = ?1"), [value])?;
        }
    }
    Ok(())
}

pub(crate) fn canvas_value(db: &Connection, column: &str) -> Result<Option<Value>> {
    if !has_column(db, "Canvas", column)? {
        return Ok(None);
    }
    Ok(db
        .query_row(&format!("SELECT \"{column}\" FROM Canvas"), [], |row| row.get(0))
        .optional()?)
}

fn is_digit(character: char) -> bool {
    character.is_ascii_digit() || ('０'..='９').contains(&character)
}

/// Replace "<old>話" (not preceded by a digit) with "<new>話".
fn replace_episode(text: &str, old: i64, new: i64) -> String {
    let pattern = format!("{old}話");
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(position) = rest.find(&pattern) {
        let before = &rest[..position];
        let preceded = before
            .chars()
            .next_back()
            .or_else(|| result.chars().next_back())
            .is_some_and(is_digit);
        result.push_str(before);
        result.push_str(&if preceded { pattern.clone() } else { format!("{new}話") });
        rest = &rest[position + pattern.len()..];
    }
    result.push_str(rest);
    result
}

/// Change the episode number written in the template's 作品情報 text layer.
///
/// CSP shows the text stored in the story info layer (for example
/// "ユメノストラ 3話") rather than rebuilding it from the Canvas settings, so
/// a template from another episode would keep showing that episode. The
/// character count of its single style run (TLV 0x0b) follows the change,
/// and the cached rendering of the text (TLV 0x32) is cleared.
fn replace_story_index(db: &Connection, old: i64, new: i64) -> Result<()> {
    if !has_column(db, "Layer", "ComicStoryInfoType")? {
        return Ok(());
    }
    let rows: Vec<(i64, Value, Value)> = {
        let mut statement =
            db.prepare("SELECT MainId, TextLayerString, TextLayerAttributes FROM Layer WHERE ComicStoryInfoType = 1")?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?
    };
    for (layer_id, string, attributes) in rows {
        let (text, as_blob) = match string {
            Value::Blob(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), true),
            Value::Text(text) => (text, false),
            _ => continue,
        };
        let changed = replace_episode(&text, old, new);
        if changed == text {
            continue;
        }
        let stored = if as_blob {
            Value::Blob(changed.clone().into_bytes())
        } else {
            Value::Text(changed.clone())
        };
        db.execute(
            "UPDATE Layer SET TextLayerString = ?1 WHERE MainId = ?2",
            (stored, layer_id),
        )?;
        if let Value::Blob(attributes) = attributes {
            let delta = changed.chars().count() as i64 - text.chars().count() as i64;
            let moved = move_run_length(&attributes, delta)?;
            db.execute(
                "UPDATE Layer SET TextLayerAttributes = ?1 WHERE MainId = ?2",
                (moved, layer_id),
            )?;
        }
        drop_render_cache(db, layer_id)?;
    }
    Ok(())
}

pub(crate) fn move_run_length(blob: &[u8], delta: i64) -> Result<Vec<u8>> {
    if delta == 0 {
        return Ok(blob.to_vec());
    }
    let items: Vec<(u32, Vec<u8>)> = parse_tlv(blob)?
        .into_iter()
        .map(|(tag, value)| {
            let mut value = value.to_vec();
            if tag == RUN_TAG && value.len() >= 12 && u32::from_le_bytes(value[0..4].try_into().unwrap()) == 1 {
                let length = u32::from_le_bytes(value[8..12].try_into().unwrap()) as i64;
                value[8..12].copy_from_slice(&((length + delta).max(0) as u32).to_le_bytes());
            }
            (tag, value)
        })
        .collect();
    Ok(build_tlv(&items))
}

pub(crate) fn canvas_width_px(width: f64, resolution: f64, unit: i64) -> f64 {
    let per_inch = match unit {
        2 => 25.4,
        1 => 2.54,
        3 => 1.0,
        5 => 72.0,
        _ => return width,
    };
    width * resolution / per_inch
}

/// Draw the page's part of the sheet preview onto the page preview.
///
/// CSP shows `CanvasPreview` as the page thumbnail in a work's page list
/// without opening the page, and the template's preview is blank. The sheet
/// preview was rendered by CSP, so cropping the cell from it and placing it
/// with the cell transform gives a faithful thumbnail.
fn update_preview(db: &Connection, sheet: &ClipDocument, page: &PlannedPage) -> Result<()> {
    let Some(sheet_png) = &sheet.preview_png else {
        return Ok(());
    };
    if !table_names(db)?.contains("CanvasPreview") {
        return Ok(());
    }
    let row: Option<(i64, Option<Vec<u8>>)> = db
        .query_row(
            "SELECT rowid, ImageData FROM CanvasPreview ORDER BY rowid LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((row_id, Some(preview_png))) = row else {
        return Ok(());
    };
    let (width, resolution, unit): (f64, f64, i64) = db.query_row(
        "SELECT CanvasWidth, CanvasResolution, CanvasUnit FROM Canvas",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let (Ok(mut preview), Ok(source)) = (decode_png(&preview_png), decode_png(sheet_png)) else {
        return Ok(());
    };
    let page_width = canvas_width_px(width, resolution, unit);
    if page_width <= 0.0 || sheet.canvas.width_px <= 0 {
        return Ok(());
    }
    let to_preview = preview.width as f64 / page_width;
    let from_sheet = source.width as f64 / sheet.canvas.width_px as f64;
    let cell = &page.cell.rect;
    let crop = source.crop((
        round_half_even(cell.x0 * from_sheet),
        round_half_even(cell.y0 * from_sheet),
        round_half_even(cell.x1 * from_sheet),
        round_half_even(cell.y1 * from_sheet),
    ));
    let (x0, y0, x1, y1) = page.transform.map_box((cell.x0, cell.y0, cell.x1, cell.y1));
    let (x0, y0, x1, y1) = (x0 * to_preview, y0 * to_preview, x1 * to_preview, y1 * to_preview);
    let width = round_half_even(x1 - x0).max(1) as u32;
    let height = round_half_even(y1 - y0).max(1) as u32;
    preview.paste(
        &resize(&crop, width, height, Filter::Lanczos3),
        round_half_even(x0),
        round_half_even(y0),
    );
    db.execute(
        "UPDATE CanvasPreview SET ImageData = ?1 WHERE rowid = ?2",
        (preview.to_png()?, row_id),
    )?;
    Ok(())
}

/// Replace the page preview with `image` (the whole page) shrunk to its size.
pub(crate) fn replace_preview(db: &Connection, image: &crate::RgbaImage) -> Result<()> {
    if !table_names(db)?.contains("CanvasPreview") {
        return Ok(());
    }
    let row: Option<(i64, Option<Vec<u8>>)> = db
        .query_row(
            "SELECT rowid, ImageData FROM CanvasPreview ORDER BY rowid LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((row_id, Some(preview_png))) = row else {
        return Ok(());
    };
    let Ok(preview) = decode_png(&preview_png) else {
        return Ok(());
    };
    let shrunk = resize(image, preview.width, preview.height, Filter::Box);
    db.execute(
        "UPDATE CanvasPreview SET ImageData = ?1 WHERE rowid = ?2",
        (shrunk.to_png()?, row_id),
    )?;
    Ok(())
}

/// Give the page the tables and columns layers copied from `source` need.
pub(crate) fn merge_page_schema(target: &Connection, source: &Connection) -> Result<()> {
    merge_schema(target, source, &SCHEMA_TABLES)?;
    merge_columns(target, source, "Canvas", Some(&CANVAS_COLUMNS))
}

/// Copy brush styles (keeping ids) when the template has none.
pub(crate) fn share_rows(target: &Connection, source: &Connection) -> Result<()> {
    let (source_tables, target_tables) = (table_names(source)?, table_names(target)?);
    for table in SHARED_TABLES {
        if !source_tables.contains(table) || !target_tables.contains(table) {
            continue;
        }
        let count: i64 = target.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| row.get(0))?;
        if count > 0 {
            continue;
        }
        let target_columns = column_names(target, table)?;
        let columns: Vec<String> = column_names(source, table)?
            .into_iter()
            .filter(|column| column != "_PW_ID" && target_columns.contains(column))
            .collect();
        let names: Vec<String> = columns.iter().map(|column| format!("\"{column}\"")).collect();
        let marks = vec!["?"; columns.len()].join(", ");
        let rows: Vec<Vec<Value>> = {
            let mut statement = source.prepare(&format!("SELECT {} FROM \"{table}\"", names.join(", ")))?;
            statement
                .query_map([], |row| {
                    (0..columns.len()).map(|index| row.get::<_, Value>(index)).collect()
                })?
                .collect::<std::result::Result<_, _>>()?
        };
        let insert = format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", "));
        for row in rows {
            target.execute(&insert, params_from_iter(row.iter()))?;
        }
        let source_max: Option<i64> = source
            .query_row("SELECT MaxIndex FROM ElemScheme WHERE TableName = ?1", [table], |row| {
                row.get(0)
            })
            .optional()?;
        if let Some(source_max) = source_max {
            target.execute(
                "UPDATE ElemScheme SET MaxIndex = MAX(MaxIndex, ?1) WHERE TableName = ?2",
                (source_max, table),
            )?;
        }
    }
    if has_column(target, "Canvas", "BrushStyleManager")? && has_column(source, "Canvas", "BrushStyleManager")? {
        let manager: Value = source.query_row("SELECT BrushStyleManager FROM Canvas", [], |row| row.get(0))?;
        let current: Value = target.query_row("SELECT BrushStyleManager FROM Canvas", [], |row| row.get(0))?;
        if matches!(current, Value::Null | Value::Integer(0)) {
            target.execute("UPDATE Canvas SET BrushStyleManager = ?1", [manager])?;
        }
    }
    Ok(())
}
