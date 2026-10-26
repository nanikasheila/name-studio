//! Make a 見開き (spread) page template from a CSP-made single page.
//!
//! A CSP spread is one page file twice as wide (`CanvasDoublePage` = 1),
//! with the frame settings of a single page: the two pages' 仕上がり枠 meet
//! at the middle (the gutter), and the story info texts (作品情報 and the
//! hidden ノンブル) come twice, the right page's marked with
//! `ComicStoryInfoForRightPage` = 1. Everything sized by the canvas (render
//! offscreens, layer thumbnails' canvas size, the preview) is widened; see
//! docs/csp-spread-format.md.

use std::path::Path;

use rusqlite::Connection;
use rusqlite::types::Value;
use serde::Serialize;

use super::canvas::resize_offscreens;
use super::editor::ClipEditor;
use super::page::{
    FOR_RIGHT_PAGE, LEFT_PAGE_FLAG, NOMBRE_INFO, RIGHT_PAGE_FLAG, STORY_INFO, TextItems, canvas_value,
    drop_render_cache, edit_text_blocks, has_column, layer_offset_x, map_bbox_x, story_layers,
};
use super::{Values, set_value};
use crate::clip::{ClipDocument, round_half_even};
use crate::error::{CspError, Result};
use crate::offscreen::RgbaImage;
use crate::raster::{Filter, decode_png, resize};

/// CropFrameOptionFlag of the spreads CSP EX 5 makes (no page side bit).
const SPREAD_FRAME_FLAG: i64 = 17;
/// Canvas columns CSP sets once a spread has its right page's story info layers.
const SPREAD_CANVAS_FLAGS: [&str; 3] = [
    "ComicStoryRightLayerCreated",
    "ComicNombreRightLayerCreated",
    "ComicNombreLayerCreated",
];

/// Where single-page content goes on the spread, in template px.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadLayout {
    pub width_px: u32,
    pub height_px: u32,
    /// x of the gutter: the left page's trim ends and the right page's starts.
    pub gutter_px: f64,
    /// Added to the x of a single page's content for the left / right half.
    pub left_dx: f64,
    pub right_dx: f64,
}

/// The layout of a spread of `single` pages (CSP's rounding: the spread's
/// trim starts at the ceiling of its margin, a single page's at the floor).
pub fn spread_layout(single: &ClipDocument) -> Result<SpreadLayout> {
    let canvas = &single.canvas;
    let (trim, _) = canvas
        .crop_size_px
        .ok_or_else(|| CspError::format("見開きにするには、ひな形に仕上がり枠が要ります"))?;
    let width = spread_width_px(single.database())?;
    let single_x0 = (canvas.width_px - trim).div_euclid(2);
    let spread_x0 = (width - 2 * trim + 1).div_euclid(2);
    let gutter = spread_x0 + trim;
    Ok(SpreadLayout {
        width_px: width as u32,
        height_px: canvas.height_px as u32,
        gutter_px: gutter as f64,
        left_dx: (spread_x0 - single_x0) as f64,
        right_dx: (gutter - single_x0) as f64,
    })
}

fn canvas_size(db: &Connection) -> Result<(f64, f64, i64)> {
    Ok(db.query_row(
        "SELECT CanvasWidth, CanvasResolution, CanvasUnit FROM Canvas",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?)
}

/// The width in px of a canvas twice as wide as the single page's.
fn spread_width_px(db: &Connection) -> Result<i64> {
    let (width, resolution, unit) = canvas_size(db)?;
    Ok(round_half_even(super::page::canvas_width_px(
        2.0 * width,
        resolution,
        unit,
    )))
}

/// Write a spread template made from the single page `single` to `output`.
pub fn make_spread_template(single: &Path, output: &Path) -> Result<SpreadLayout> {
    let source = ClipDocument::read(single)?;
    if source.canvas.is_double_page {
        return Err(CspError::format(
            "ひな形がもう見開きです。単ページのひな形を選んでください",
        ));
    }
    let layout = spread_layout(&source)?;
    let (old_width, old_height) = (source.canvas.width_px, source.canvas.height_px);
    let mut editor = ClipEditor::open(single)?;
    editor.renew_ids()?;
    let was_left = matches!(canvas_value(&editor.db, "ComicIsLeftPage")?, Some(Value::Integer(1)));
    set_spread_canvas(&editor.db)?;
    widen_offscreens(&mut editor, (old_width, old_height), layout.width_px as i64)?;
    for column in ["ThumbnailCanvasWidth", "ThumbnailCanvasHeight"] {
        if has_column(&editor.db, "LayerThumbnail", column)? {
            let value = if column.ends_with("Width") {
                layout.width_px
            } else {
                layout.height_px
            };
            editor
                .db
                .execute(&format!("UPDATE LayerThumbnail SET \"{column}\" = ?1"), [value])?;
        }
    }
    widen_preview(&editor.db, old_width, layout.width_px as i64)?;
    add_right_story_layers(&mut editor, &source, old_width, was_left, &layout)?;
    editor.save(output)?;
    Ok(layout)
}

fn add_column(db: &Connection, table: &str, column: &str) -> Result<()> {
    if !has_column(db, table, column)? {
        db.execute(&format!("ALTER TABLE \"{table}\" ADD COLUMN \"{column}\""), [])?;
    }
    Ok(())
}

fn set_spread_canvas(db: &Connection) -> Result<()> {
    db.execute("UPDATE Canvas SET CanvasWidth = CanvasWidth * 2", [])?;
    add_column(db, "Canvas", "CanvasDoublePage")?;
    db.execute("UPDATE Canvas SET CanvasDoublePage = 1", [])?;
    if has_column(db, "Canvas", "ComicIsLeftPage")? {
        db.execute("UPDATE Canvas SET ComicIsLeftPage = 0", [])?;
    }
    if let Some(Value::Integer(flag)) = canvas_value(db, "CropFrameOptionFlag")? {
        let flag = (flag & !(LEFT_PAGE_FLAG | RIGHT_PAGE_FLAG)) | SPREAD_FRAME_FLAG;
        db.execute("UPDATE Canvas SET CropFrameOptionFlag = ?1", [flag])?;
    }
    if has_column(db, "Layer", "ComicStoryInfoType")? {
        for column in SPREAD_CANVAS_FLAGS {
            add_column(db, "Canvas", column)?;
            db.execute(&format!("UPDATE Canvas SET \"{column}\" = 1"), [])?;
        }
        add_column(db, "Layer", FOR_RIGHT_PAGE)?;
    }
    Ok(())
}

/// Widen every offscreen sized by the canvas to the spread. What an
/// offscreen showed is kept on the left and repeated on the right (a blank
/// paper stays blank on both pages).
fn widen_offscreens(editor: &mut ClipEditor, size: (i64, i64), new_width: i64) -> Result<()> {
    resize_offscreens(editor, size, (new_width, size.1), &|old, width, height| {
        let mut image = RgbaImage::transparent(width, height);
        if let Some(old) = old {
            image.paste(&old, 0, 0);
            image.paste(&old, old.width as i64, 0);
        }
        image
    })
}

/// A blank (white) preview as wide as the spread, at the template's scale.
fn widen_preview(db: &Connection, old_width: i64, new_width: i64) -> Result<()> {
    if !super::schema::table_names(db)?.contains("CanvasPreview") {
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
    let Ok(preview) = decode_png(&png) else {
        return Ok(());
    };
    let width = (preview.width as i64 * new_width / old_width.max(1)).max(1) as u32;
    let mut wide = RgbaImage {
        width,
        height: preview.height,
        pixels: [255, 255, 255, 255].repeat(width as usize * preview.height as usize),
    };
    wide.paste(&resize(&preview, preview.width, preview.height, Filter::Box), 0, 0);
    db.execute(
        "UPDATE CanvasPreview SET ImageData = ?1 WHERE rowid = ?2",
        (wide.to_png()?, row_id),
    )?;
    for (column, value) in [("ImageWidth", width), ("ImageHeight", preview.height)] {
        if has_column(db, "CanvasPreview", column)? {
            db.execute(
                &format!("UPDATE CanvasPreview SET \"{column}\" = ?1 WHERE rowid = ?2"),
                (value, row_id),
            )?;
        }
    }
    Ok(())
}

/// Move the template's 作品情報 / ノンブル to the left page and add a copy of
/// each for the right page, as CSP's own spreads have them.
fn add_right_story_layers(
    editor: &mut ClipEditor,
    source: &ClipDocument,
    page_width: i64,
    was_left: bool,
    layout: &SpreadLayout,
) -> Result<()> {
    let mut layers = story_layers(&editor.db, STORY_INFO)?;
    layers.extend(story_layers(&editor.db, NOMBRE_INFO)?);
    let payload = |id: &str| source.external_payload(id).map(<[u8]>::to_vec);
    for (layer_id, _) in layers {
        let nombre = matches!(
            layer_value(&editor.db, layer_id, "ComicStoryInfoType")?,
            Value::Integer(NOMBRE_INFO)
        );
        let original: Values = editor.layer_row(layer_id)?;
        let mut keep = |values: &mut Values| -> Result<()> {
            for column in [
                "LayerOffsetX",
                "LayerOffsetY",
                "LayerRenderOffscrOffsetX",
                "LayerRenderOffscrOffsetY",
            ] {
                if let Some((_, value)) = original.iter().find(|(name, _)| name == column) {
                    set_value(values, column, value.clone());
                }
            }
            set_value(values, FOR_RIGHT_PAGE, Value::Integer(1));
            Ok(())
        };
        // Its render offscreens (and thumbnail settings) are the text layer's own.
        let render_from = match layer_value(&editor.db, layer_id, "LayerRenderMipmap")? {
            Value::Integer(mipmap) if mipmap != 0 => layer_id,
            _ => editor.first_raster_layer()?,
        };
        let right = editor.add_layer_rendered_like(
            source.database(),
            &payload,
            layer_id,
            Some(&mut keep),
            None,
            render_from,
        )?;
        // The hidden ノンブル sits at the binding edge: the right edge of a
        // left page, the left edge of a right page.
        for (id, right_page) in [(layer_id, false), (right, true)] {
            let offset = layer_offset_x(&editor.db, id)?;
            let mirror = nombre && was_left == right_page;
            let dx = round_half_even(if right_page { layout.right_dx } else { layout.left_dx });
            let place = |x0: i64, x1: i64| {
                // CSP's right-page ノンブル starts where the left page's ends,
                // one pixel in from the edge.
                let (x0, x1) = if mirror {
                    (
                        page_width - 1 - (x1 + offset) - offset,
                        page_width - 1 - (x0 + offset) - offset,
                    )
                } else {
                    (x0, x1)
                };
                (x0 + dx, x1 + dx)
            };
            edit_text_blocks(&editor.db, id, &|items: TextItems| map_bbox_x(items, &place))?;
            drop_render_cache(&editor.db, id)?;
        }
        let folder = parent_of(editor, layer_id)?;
        editor.append_to_folder(folder, right, Some(layer_id))?;
    }
    Ok(())
}

fn layer_value(db: &Connection, layer_id: i64, column: &str) -> Result<Value> {
    Ok(db.query_row(
        &format!("SELECT \"{column}\" FROM Layer WHERE MainId = ?1"),
        [layer_id],
        |row| row.get(0),
    )?)
}

/// The folder whose children include `layer_id` (the root when none does).
fn parent_of(editor: &ClipEditor, layer_id: i64) -> Result<i64> {
    let folders: Vec<i64> = {
        let mut statement = editor
            .db
            .prepare("SELECT MainId FROM Layer WHERE LayerFirstChildIndex IS NOT NULL AND LayerFirstChildIndex != 0")?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?
    };
    for folder in folders {
        if editor.children(folder)?.contains(&layer_id) {
            return Ok(folder);
        }
    }
    Ok(editor.root_id)
}
