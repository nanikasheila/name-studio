//! Pages and works made from settings, for writing without a CSP-made
//! template.
//!
//! The program carries three files saved by CLIP STUDIO PAINT EX 5.1.4
//! (assets/, see docs/builtin-template.md): an empty single page, a work
//! (.cmc) and a page with one vector line and one text to copy editable
//! layers from. A template is one of them with the canvas, frames, binding
//! and story info (作品名・話数・作者名・ノンブル) set from a [`PageSetup`].
//! Everything sized by the canvas is resized, and the 作品情報 / ノンブル
//! texts are placed where CSP puts them, relative to the frames.

use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};
use serde::{Deserialize, Serialize};

use super::canvas::{blank_preview, resize_offscreens, set_thumbnail_canvas};
use super::editor::ClipEditor;
use super::page::{
    LEFT_PAGE_FLAG, NOMBRE_INFO, RIGHT_PAGE_FLAG, STORY_INFO, TextItems, canvas_value, drop_render_cache, has_column,
    mirror_nombre, story_layers,
};
use super::schema::column_names;
use crate::clip::{round_half_even, to_pixels};
use crate::error::{CspError, Result};
use crate::raster::{Filter, resize};
use crate::text::{ATTR_BBOX, ATTR_BLOCK_SIZE, ATTR_FONT_NAME, ATTR_ORIGIN, ATTR_QUAD, FontName, build_tlv, parse_tlv};

/// An empty single page (A3 canvas, B4 仕上がり, 600 dpi, left page).
pub const BLANK_PAGE: &[u8] = include_bytes!("../../assets/blank-page.clip");
/// A page with one vector layer (a line) and one text layer, to copy from.
pub const BLANK_PARTS: &[u8] = include_bytes!("../../assets/blank-parts.clip");
/// A work listing one page.
pub const BLANK_WORK: &[u8] = include_bytes!("../../assets/blank-work.cmc");

/// File names of a built template, in its folder.
pub const PAGE_FILE: &str = "page.clip";
pub const PARTS_FILE: &str = "parts.clip";
pub const WORK_FILE: &str = "work.cmc";

/// The font of the 作品情報 and ノンブル texts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoryFont {
    /// As CSP shows it (`ＭＳ ゴシック`).
    pub name: String,
    pub postscript: String,
}

fn first_number() -> i64 {
    1
}

/// What a page and its work are made with. Lengths in mm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSetup {
    /// キャンバス (用紙) size.
    pub canvas_mm: [f64; 2],
    /// 解像度 (dpi).
    pub resolution: f64,
    /// 仕上がり (製本) size.
    pub trim_mm: [f64; 2],
    /// 裁ち落とし幅.
    pub bleed_mm: f64,
    /// 基本枠 size and its offset from the middle of the canvas.
    pub basic_mm: [f64; 2],
    #[serde(default)]
    pub basic_offset_mm: [f64; 2],
    /// 右綴じ (a manga) rather than 左綴じ.
    pub right_binding: bool,
    /// Whether the book's first page (index 0) is a left page.
    pub first_page_left: bool,
    /// 作品名.
    pub title: String,
    /// 話数; none leaves it out of the 作品情報.
    #[serde(default)]
    pub story_index: Option<i64>,
    /// 作者名.
    #[serde(default)]
    pub author: String,
    /// ノンブルの開始番号.
    #[serde(default = "first_number")]
    pub nombre_start: i64,
    /// None keeps the built-in one.
    #[serde(default)]
    pub font: Option<StoryFont>,
}

/// The largest side CSP takes, in px.
const MAX_SIDE_PX: i64 = 30_000;

impl PageSetup {
    /// Whether CSP can make a page like this; the reason when not.
    pub fn check(&self) -> Result<()> {
        let fail = |message: &str| Err(CspError::format(message.to_owned()));
        let positive = |values: &[f64]| values.iter().all(|value| value.is_finite() && *value > 0.0);
        if !positive(&[self.canvas_mm[0], self.canvas_mm[1]]) {
            return fail("キャンバスの幅と高さを入れてください");
        }
        if !(self.resolution.is_finite() && (72.0..=1200.0).contains(&self.resolution)) {
            return fail("解像度は 72〜1200 dpi にしてください");
        }
        if !positive(&[self.trim_mm[0], self.trim_mm[1]]) {
            return fail("仕上がりの幅と高さを入れてください");
        }
        if self.trim_mm[0] > self.canvas_mm[0] + 1e-9 || self.trim_mm[1] > self.canvas_mm[1] + 1e-9 {
            return fail("仕上がりがキャンバスより大きくなっています");
        }
        if !(self.bleed_mm.is_finite() && self.bleed_mm >= 0.0) {
            return fail("裁ち落とし幅は 0 以上にしてください");
        }
        if !positive(&[self.basic_mm[0], self.basic_mm[1]]) {
            return fail("基本枠の幅と高さを入れてください");
        }
        let [ox, oy] = self.basic_offset_mm;
        if !(ox.is_finite() && oy.is_finite())
            || self.basic_mm[0] / 2.0 + ox.abs() > self.canvas_mm[0] / 2.0 + 1e-9
            || self.basic_mm[1] / 2.0 + oy.abs() > self.canvas_mm[1] / 2.0 + 1e-9
        {
            return fail("基本枠がキャンバスからはみ出しています");
        }
        let (width, height) = self.canvas_px();
        if width > MAX_SIDE_PX || height > MAX_SIDE_PX {
            return fail("キャンバスが大きすぎます（解像度を下げてください）");
        }
        if self.title.trim().is_empty() {
            return fail("作品名を入れてください");
        }
        if self.story_index.is_some_and(|index| index < 0) || self.nombre_start < 0 {
            return fail("話数とノンブルの開始番号は 0 以上にしてください");
        }
        Ok(())
    }

    fn px(&self, mm: f64) -> i64 {
        to_pixels(mm, "mm", self.resolution)
    }

    pub fn canvas_px(&self) -> (i64, i64) {
        (self.px(self.canvas_mm[0]), self.px(self.canvas_mm[1]))
    }

    /// The 作品情報 line: 作品名 and 話数 as CSP writes them.
    pub fn story_line(&self) -> String {
        match self.story_index {
            Some(index) => format!("{} {index}話", self.title.trim()),
            None => self.title.trim().to_owned(),
        }
    }
}

/// Canvas size and frames in px, as CSP lays them out (centred, rounded down).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Frames {
    width: i64,
    height: i64,
    resolution: f64,
    trim: [i64; 4],
    basic: [i64; 4],
}

impl Frames {
    fn new(width: i64, height: i64, resolution: f64, trim: (i64, i64), basic: (i64, i64), offset: (i64, i64)) -> Self {
        let centred = |(w, h): (i64, i64), (dx, dy): (i64, i64)| {
            let x0 = (width - w).div_euclid(2) + dx;
            let y0 = (height - h).div_euclid(2) + dy;
            [x0, y0, x0 + w, y0 + h]
        };
        Frames {
            width,
            height,
            resolution,
            trim: centred(trim, (0, 0)),
            basic: centred(basic, offset),
        }
    }

    fn of_setup(setup: &PageSetup) -> Self {
        let (width, height) = setup.canvas_px();
        Frames::new(
            width,
            height,
            setup.resolution,
            (setup.px(setup.trim_mm[0]), setup.px(setup.trim_mm[1])),
            (setup.px(setup.basic_mm[0]), setup.px(setup.basic_mm[1])),
            (setup.px(setup.basic_offset_mm[0]), setup.px(setup.basic_offset_mm[1])),
        )
    }

    fn of_page(db: &Connection) -> Result<Self> {
        let real = |column: &str| -> Result<f64> {
            Ok(match canvas_value(db, column)? {
                Some(Value::Real(number)) => number,
                Some(Value::Integer(number)) => number as f64,
                _ => 0.0,
            })
        };
        let resolution = real("CanvasResolution")?;
        let px = |column: &str| -> Result<i64> { Ok(to_pixels(real(column)?, "mm", resolution)) };
        Ok(Frames::new(
            px("CanvasWidth")?,
            px("CanvasHeight")?,
            resolution,
            (px("CropFrameWidth")?, px("CropFrameHeight")?),
            (px("CropFrameInnerWidth")?, px("CropFrameInnerHeight")?),
            (px("CropFrameInnerOffsetX")?, px("CropFrameInnerOffsetY")?),
        ))
    }
}

/// Write the page, the parts page and the work for `setup` into `folder`.
pub fn write_builtin_template(setup: &PageSetup, folder: &Path) -> Result<BuiltTemplate> {
    setup.check()?;
    std::fs::create_dir_all(folder)?;
    let built = BuiltTemplate {
        page: folder.join(PAGE_FILE),
        parts: folder.join(PARTS_FILE),
        work: folder.join(WORK_FILE),
    };
    blank_page(setup)?.save(&built.page)?;
    let temporary = built.parts.with_extension("clip.tmp");
    std::fs::write(&temporary, BLANK_PARTS)?;
    std::fs::rename(&temporary, &built.parts)?;
    write_blank_work(setup, &built.work)?;
    Ok(built)
}

/// Where [`write_builtin_template`] put its files.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltTemplate {
    pub page: PathBuf,
    /// The vector and text layers to copy (a donor).
    pub parts: PathBuf,
    pub work: PathBuf,
}

/// The built-in empty page made for `setup`.
pub fn blank_page(setup: &PageSetup) -> Result<ClipEditor> {
    setup.check()?;
    let mut editor = ClipEditor::from_bytes(BLANK_PAGE.to_vec())?;
    editor.renew_ids()?;
    apply_setup(&mut editor, setup)?;
    Ok(editor)
}

/// Give a CSP-made empty single page (a left page) the canvas, frames,
/// binding and story info of `setup`.
pub fn apply_setup(editor: &mut ClipEditor, setup: &PageSetup) -> Result<()> {
    let db = &editor.db;
    if matches!(canvas_value(db, "CanvasDoublePage")?, Some(Value::Integer(flag)) if flag != 0) {
        return Err(CspError::format("見開きのページからはひな形を作れません"));
    }
    if !matches!(canvas_value(db, "ComicIsLeftPage")?, Some(Value::Integer(1))) {
        return Err(CspError::format("左ページのひな形が要ります"));
    }
    let old = Frames::of_page(db)?;
    let new = Frames::of_setup(setup);
    set_story_texts(db, setup)?;
    place_story_texts(db, &old, &new)?;
    drop_text_images(db)?;
    set_canvas(db, setup)?;
    if let Some(font) = &setup.font {
        set_story_font(db, font)?;
    }
    if (old.width, old.height) != (new.width, new.height) {
        // The empty page's offscreens hold one colour (the paper's white) or
        // nothing, so scaling keeps them as they are.
        resize_offscreens(
            editor,
            (old.width, old.height),
            (new.width, new.height),
            &|old, width, height| match old {
                Some(old) => resize(&old, width, height, Filter::Box),
                None => crate::RgbaImage::transparent(width, height),
            },
        )?;
        set_thumbnail_canvas(&editor.db, new.width, new.height)?;
        blank_preview(&editor.db, new.width, new.height)?;
    }
    if !setup.first_page_left {
        let db = &editor.db;
        db.execute("UPDATE Canvas SET ComicIsLeftPage = 0", [])?;
        if let Some(Value::Integer(flag)) = canvas_value(db, "CropFrameOptionFlag")? {
            let flag = (flag & !(LEFT_PAGE_FLAG | RIGHT_PAGE_FLAG)) | RIGHT_PAGE_FLAG;
            db.execute("UPDATE Canvas SET CropFrameOptionFlag = ?1", [flag])?;
        }
        mirror_nombre(db)?;
    }
    Ok(())
}

fn set_columns(db: &Connection, table: &str, values: &[(&str, Value)]) -> Result<()> {
    let known = column_names(db, table)?;
    for (column, value) in values {
        if known.iter().any(|name| name == column) {
            db.execute(&format!("UPDATE \"{table}\" SET \"{column}\" = ?1"), [value])?;
        }
    }
    Ok(())
}

/// The work-wide story settings, as both a page's Canvas and a work's
/// Project row hold them.
fn story_values(setup: &PageSetup) -> Vec<(&'static str, Value)> {
    let mut values = vec![
        ("ComicStoryStoryName", Value::Text(setup.title.trim().to_owned())),
        (
            "ComicStoryUseStoryIndex",
            Value::Integer(setup.story_index.is_some() as i64),
        ),
        ("ComicStoryAuthorName", Value::Text(setup.author.trim().to_owned())),
        ("ComicStoryNombreStart", Value::Integer(setup.nombre_start)),
        ("ComicBindPosition", Value::Integer(bind_position(setup))),
    ];
    if let Some(index) = setup.story_index {
        values.push(("ComicStoryStoryIndex", Value::Integer(index)));
    }
    if let Some(font) = &setup.font {
        values.push(("ComicStoryNombreFont", Value::Text(font.name.clone())));
        values.push((
            "ComicStoryNombreFontPostScriptName",
            Value::Text(font.postscript.clone()),
        ));
    }
    values
}

/// `ComicBindPosition`: 1 in CSP's right-bound works.
fn bind_position(setup: &PageSetup) -> i64 {
    setup.right_binding as i64
}

fn set_canvas(db: &Connection, setup: &PageSetup) -> Result<()> {
    let real = Value::Real;
    let mut values = vec![
        ("CanvasUnit", Value::Integer(2)),
        ("CanvasWidth", real(setup.canvas_mm[0])),
        ("CanvasHeight", real(setup.canvas_mm[1])),
        ("CanvasResolution", real(setup.resolution)),
        ("CropFrameUnitKind", Value::Integer(2)),
        ("CropFrameWidth", real(setup.trim_mm[0])),
        ("CropFrameHeight", real(setup.trim_mm[1])),
        ("CropFrameDitch", real(setup.bleed_mm)),
        ("CropFrameInnerWidth", real(setup.basic_mm[0])),
        ("CropFrameInnerHeight", real(setup.basic_mm[1])),
        ("CropFrameInnerOffsetX", real(setup.basic_offset_mm[0])),
        ("CropFrameInnerOffsetY", real(setup.basic_offset_mm[1])),
        ("CropFrameShow", Value::Integer(1)),
        ("ComicPageIndex", Value::Integer(0)),
    ];
    values.extend(story_values(setup));
    set_columns(db, "Canvas", &values)
}

/// Write `output` (.cmc): the built-in work with `setup`'s settings and its
/// one page node (the page list is replaced when the pages are written).
pub fn write_blank_work(setup: &PageSetup, output: &Path) -> Result<()> {
    let mut database = Connection::open_in_memory()?;
    database.deserialize_read_exact("main", BLANK_WORK, BLANK_WORK.len(), false)?;
    let real = Value::Real;
    let mut values = vec![
        ("ComicStartPage", Value::Integer(start_page(setup))),
        ("DefaultPageUnit", Value::Integer(2)),
        ("DefaultPageWidth", real(setup.canvas_mm[0])),
        ("DefaultPageHeight", real(setup.canvas_mm[1])),
        ("DefaultPageResolution", real(setup.resolution)),
        ("DefaultPageUseCropFrame", Value::Integer(1)),
        ("DefaultPageCropWidth", real(setup.trim_mm[0])),
        ("DefaultPageCropHeight", real(setup.trim_mm[1])),
        ("DefaultPageCropDitch", real(setup.bleed_mm)),
        ("DefaultPageCropInnerWidth", real(setup.basic_mm[0])),
        ("DefaultPageCropInnerHeight", real(setup.basic_mm[1])),
        ("DefaultPageCropInnerOffsetX", real(setup.basic_offset_mm[0])),
        ("DefaultPageCropInnerOffsetY", real(setup.basic_offset_mm[1])),
    ];
    values.extend(story_values(setup));
    set_columns(&database, "Project", &values)?;
    let (width, height) = (setup.canvas_mm[0], setup.canvas_mm[1]);
    database.execute(
        "UPDATE CanvasNode SET LinkUnit = 2, LinkWidth = ?1, LinkHeight = ?2, LinkResolution = ?3 WHERE Type = 2",
        params_from_iter([width, height, setup.resolution]),
    )?;
    let data = database.serialize("main")?;
    let temporary = output.with_extension("cmc.tmp");
    std::fs::write(&temporary, &*data)?;
    std::fs::rename(&temporary, output)?;
    Ok(())
}

/// `ComicStartPage`: 0 in CSP's right-bound works whose first page is a
/// left page (the usual manga).
fn start_page(setup: &PageSetup) -> i64 {
    (!setup.first_page_left) as i64
}

/// The parts of the 作品情報 text layer: its first block (作品名 and 話数)
/// and the second (作者名).
#[derive(Clone, Copy, PartialEq)]
enum Part {
    Title,
    Author,
    Nombre,
}

/// One text attribute blob of a story info layer and the part it is for:
/// (column, block index or none for a single block, part).
type Blob = (&'static str, Option<usize>, Part);

fn blobs(info: i64) -> Vec<Blob> {
    if info == STORY_INFO {
        vec![
            ("TextLayerAttributes", None, Part::Title),
            ("TextLayerAttributesArray", Some(0), Part::Author),
            ("TextLayerAddAttributesV01", Some(0), Part::Title),
            ("TextLayerAddAttributesV01", Some(1), Part::Author),
        ]
    } else {
        vec![
            ("TextLayerAttributes", None, Part::Nombre),
            ("TextLayerAddAttributesV01", Some(0), Part::Nombre),
        ]
    }
}

/// Apply `edit` to the TLV items of each blob of one story info layer.
fn edit_story_blobs(
    db: &Connection,
    layer_id: i64,
    info: i64,
    edit: &dyn Fn(Part, bool, TextItems) -> Result<TextItems>,
) -> Result<()> {
    for (column, block, part) in blobs(info) {
        if !has_column(db, "Layer", column)? {
            continue;
        }
        let blob: Value = db.query_row(
            &format!("SELECT \"{column}\" FROM Layer WHERE MainId = ?1"),
            [layer_id],
            |row| row.get(0),
        )?;
        let Value::Blob(blob) = blob else { continue };
        let owned = |bytes: &[u8]| -> Result<TextItems> {
            Ok(parse_tlv(bytes)?
                .into_iter()
                .map(|(tag, value)| (tag, value.to_vec()))
                .collect())
        };
        // The add-attributes runs carry no character counts.
        let counted = column != "TextLayerAddAttributesV01";
        let value = match block {
            None => build_tlv(&edit(part, counted, owned(&blob)?)?),
            Some(index) => {
                let mut blocks: Vec<Vec<u8>> = crate::text::split_attribute_array(&blob)?
                    .into_iter()
                    .map(<[u8]>::to_vec)
                    .collect();
                let Some(target) = blocks.get_mut(index) else { continue };
                *target = build_tlv(&edit(part, counted, owned(target)?)?);
                blocks
                    .into_iter()
                    .flat_map(|block| {
                        let mut entry = (block.len() as u32).to_le_bytes().to_vec();
                        entry.extend(block);
                        entry
                    })
                    .collect()
            }
        };
        db.execute(
            &format!("UPDATE Layer SET \"{column}\" = ?1 WHERE MainId = ?2"),
            (value, layer_id),
        )?;
    }
    Ok(())
}

fn i32s(value: &[u8]) -> Vec<i64> {
    value
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| i32::from_le_bytes(*bytes) as i64)
        .collect()
}

fn bytes(values: &[i64]) -> Vec<u8> {
    values.iter().flat_map(|value| (*value as i32).to_le_bytes()).collect()
}

fn item(items: &TextItems, tag: u32) -> Option<&[u8]> {
    items
        .iter()
        .find(|(id, _)| *id == tag)
        .map(|(_, value)| value.as_slice())
}

/// Font size in px of a story text (TLV 0x20 is pt × 100 at the canvas resolution).
fn em_px(items: &TextItems, resolution: f64) -> f64 {
    let points = item(items, crate::text::ATTR_FONT_SIZE)
        .filter(|value| value.len() == 4)
        .map(|value| i32::from_le_bytes(value.try_into().unwrap()) as f64 / 100.0)
        .unwrap_or(6.0);
    points * resolution / 72.0
}

/// The width CSP gives a story text: a full-width character is one em; the
/// space, digits and other ASCII are narrower (as measured on CSP's own).
fn text_width(text: &str, em: f64) -> i64 {
    let ems: f64 = text
        .chars()
        .map(|character| match character {
            ' ' => 0.26,
            character if character.is_ascii() => 0.62,
            _ => 1.0,
        })
        .sum();
    round_half_even(ems * em).max(1)
}

/// Write the 作品名・話数 and 作者名 into the 作品情報 layer: the strings,
/// their style runs' lengths and the blocks' widths (the 作品名 keeps its
/// left edge, the 作者名 its middle). CSP draws them afresh.
fn set_story_texts(db: &Connection, setup: &PageSetup) -> Result<()> {
    let resolution = match canvas_value(db, "CanvasResolution")? {
        Some(Value::Real(number)) => number,
        Some(Value::Integer(number)) => number as f64,
        _ => return Err(CspError::format("Canvas has no resolution")),
    };
    let title = setup.story_line();
    let author = setup.author.trim().to_owned();
    for (layer_id, _) in story_layers(db, STORY_INFO)? {
        db.execute(
            "UPDATE Layer SET TextLayerString = ?1 WHERE MainId = ?2",
            (title.as_bytes(), layer_id),
        )?;
        if has_column(db, "Layer", "TextLayerStringArray")? {
            let mut array = (author.len() as u32).to_le_bytes().to_vec();
            array.extend(author.as_bytes());
            db.execute(
                "UPDATE Layer SET TextLayerStringArray = ?1 WHERE MainId = ?2 AND TextLayerStringArray IS NOT NULL",
                (array, layer_id),
            )?;
        }
        edit_story_blobs(db, layer_id, STORY_INFO, &|part, counted, items| {
            let text = if part == Part::Author { &author } else { &title };
            let units = text.encode_utf16().count() as u32;
            let width = text_width(text, em_px(&items, resolution));
            Ok(items
                .into_iter()
                .map(|(tag, mut value)| {
                    if tag == 0x0b && counted && value.len() >= 12 && value[0..4] == 1u32.to_le_bytes() {
                        value[8..12].copy_from_slice(&units.to_le_bytes());
                    }
                    (tag, value)
                })
                .map(|(tag, value)| resize_block(tag, value, width, part == Part::Author))
                .collect())
        })?;
        drop_render_cache(db, layer_id)?;
    }
    Ok(())
}

/// One item of a text block `width` px wide: its bbox (keeping the left
/// edge, or the middle with `centred`), block size and quad.
fn resize_block(tag: u32, value: Vec<u8>, width: i64, centred: bool) -> (u32, Vec<u8>) {
    match tag {
        ATTR_BBOX if value.len() == 16 => {
            let [x0, y0, x1, y1] = i32s(&value)[..] else {
                unreachable!()
            };
            let x0 = if centred { (x0 + x1 - width).div_euclid(2) } else { x0 };
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

fn layer_offset(db: &Connection, layer_id: i64) -> Result<(i64, i64)> {
    let (x, y): (Option<i64>, Option<i64>) = db.query_row(
        "SELECT LayerOffsetX, LayerOffsetY FROM Layer WHERE MainId = ?1",
        [layer_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((x.unwrap_or(0), y.unwrap_or(0)))
}

/// Move the story info texts from the template's frames to the new ones,
/// scaled by the change of resolution: the 作品情報 below the 仕上がり (the
/// 作品名 from its left edge, the 作者名 from its middle), the hidden ノンブル
/// at the binding edge of the 仕上がり, level with the bottom of the 基本枠.
fn place_story_texts(db: &Connection, old: &Frames, new: &Frames) -> Result<()> {
    let scale = new.resolution / old.resolution;
    let at = |anchor_old: i64, anchor_new: i64, value: i64| {
        anchor_new + round_half_even((value - anchor_old) as f64 * scale)
    };
    for info in [STORY_INFO, NOMBRE_INFO] {
        for (layer_id, _) in story_layers(db, info)? {
            let (dx, dy) = layer_offset(db, layer_id)?;
            edit_story_blobs(db, layer_id, info, &|part, _, items| {
                Ok(items
                    .into_iter()
                    .map(|(tag, value)| match tag {
                        ATTR_BBOX if value.len() == 16 => {
                            let [x0, y0, x1, y1] = i32s(&value)[..] else {
                                unreachable!()
                            };
                            let (x0, y0, x1, y1) = (x0 + dx, y0 + dy, x1 + dx, y1 + dy);
                            let width = round_half_even((x1 - x0) as f64 * scale);
                            let height = round_half_even((y1 - y0) as f64 * scale);
                            let (x0, y0) = match part {
                                Part::Title => (at(old.trim[0], new.trim[0], x0), at(old.trim[3], new.trim[3], y0)),
                                Part::Author => {
                                    let (old_mid, new_mid) =
                                        ((old.trim[0] + old.trim[2]) / 2, (new.trim[0] + new.trim[2]) / 2);
                                    let middle = at(old_mid, new_mid, (x0 + x1) / 2);
                                    (middle - width / 2, at(old.trim[3], new.trim[3], y0))
                                }
                                // A left page: the binding edge is on the right.
                                Part::Nombre => (
                                    at(old.trim[2], new.trim[2], x1) - width,
                                    at(old.basic[3], new.basic[3], y1) - height,
                                ),
                            };
                            (tag, bytes(&[x0 - dx, y0 - dy, x0 + width - dx, y0 + height - dy]))
                        }
                        ATTR_BLOCK_SIZE | ATTR_QUAD | ATTR_ORIGIN if value.len() % 4 == 0 && scale != 1.0 => {
                            let scaled: Vec<i64> = i32s(&value)
                                .into_iter()
                                .map(|number| round_half_even(number as f64 * scale))
                                .collect();
                            (tag, bytes(&scaled))
                        }
                        _ => (tag, value),
                    })
                    .collect())
            })?;
            drop_render_cache(db, layer_id)?;
        }
    }
    Ok(())
}

/// Remove the images CSP drew of the story info texts (TLV 0x32, cleared
/// above): offscreens of those layers that no mipmap or thumbnail uses.
/// They showed the template's texts.
fn drop_text_images(db: &Connection) -> Result<()> {
    let mut layers = story_layers(db, STORY_INFO)?;
    layers.extend(story_layers(db, NOMBRE_INFO)?);
    for (layer_id, _) in layers {
        db.execute(
            "DELETE FROM Offscreen WHERE LayerId = ?1 \
             AND MainId NOT IN (SELECT Offscreen FROM MipmapInfo WHERE Offscreen IS NOT NULL) \
             AND MainId NOT IN (SELECT ThumbnailOffscreen FROM LayerThumbnail WHERE ThumbnailOffscreen IS NOT NULL)",
            [layer_id],
        )?;
    }
    Ok(())
}

/// TLV 0x1f: the font name CSP shows, in UTF-8.
const ATTR_FONT_LABEL: u32 = 0x1f;

/// Set the font of the 作品情報 and ノンブル texts.
fn set_story_font(db: &Connection, font: &StoryFont) -> Result<()> {
    let attribute = FontName {
        name: font.name.clone(),
        postscript: font.postscript.clone(),
    }
    .to_attribute();
    for info in [STORY_INFO, NOMBRE_INFO] {
        for (layer_id, _) in story_layers(db, info)? {
            edit_story_blobs(db, layer_id, info, &|_, _, items| {
                Ok(items
                    .into_iter()
                    .map(|(tag, value)| match tag {
                        ATTR_FONT_LABEL if !value.is_empty() => (tag, font.name.as_bytes().to_vec()),
                        ATTR_FONT_NAME if !value.is_empty() => (tag, attribute.clone()),
                        _ => (tag, value),
                    })
                    .collect())
            })?;
        }
    }
    Ok(())
}
