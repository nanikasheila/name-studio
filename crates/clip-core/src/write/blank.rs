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
    mirror_nombre, story_layers, update_nombre,
};
use super::schema::column_names;
use super::story::{
    ATTR_STORY_PART, Align, Part, array_parts, bytes, edit_story_blobs, em_px, i32s, item, page_number_text,
    resize_block, resolution, set_run_length, set_string_array, string_array, text_width,
};
use crate::clip::{round_half_even, to_pixels};
use crate::error::{CspError, Result};
use crate::raster::{Filter, resize};
use crate::text::{
    ATTR_BBOX, ATTR_BLOCK_SIZE, ATTR_COLOR, ATTR_FONT_NAME, ATTR_FONT_SIZE, ATTR_ORIGIN, ATTR_QUAD, FontName,
    split_attribute_array,
};

/// An empty single page (A3 canvas, B4 仕上がり, 600 dpi, left page).
pub const BLANK_PAGE: &[u8] = include_bytes!("../../assets/blank-page.clip");
/// A page with one vector layer (a line) and one text layer, to copy from.
pub const BLANK_PARTS: &[u8] = include_bytes!("../../assets/blank-parts.clip");
/// A work listing one page.
pub const BLANK_WORK: &[u8] = include_bytes!("../../assets/blank-work.cmc");
/// The layer effects CSP gave its (ノンブル) with フチ 0.5 mm at 600 dpi
/// (`LayerEffectInfo`: the フチ on, the other effects off).
const NOMBRE_EDGE: &[u8] = include_bytes!("../../assets/nombre-edge.bin");

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
    /// サブタイトル, where the 作品情報 go, ページ番号 and a shown ノンブル.
    #[serde(default)]
    pub story: StoryLayout,
}

/// Where a 作品情報 text goes under the 仕上がり: CSP's 左下・下・右下.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoryPosition {
    #[default]
    Left,
    Center,
    Right,
}

impl StoryPosition {
    /// `ComicStory*Position`.
    fn column(self) -> i64 {
        match self {
            StoryPosition::Left => 1,
            StoryPosition::Center => 2,
            StoryPosition::Right => 3,
        }
    }

    fn align(self) -> Align {
        Align::of_position(self.column())
    }
}

fn center() -> StoryPosition {
    StoryPosition::Center
}

fn right() -> StoryPosition {
    StoryPosition::Right
}

/// The rest of CSP's 作品情報 and ノンブル settings. The default is what
/// CSP's new works have: 作品名 左下, 作者名 下, no ページ番号, the hidden
/// ノンブル.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryLayout {
    /// サブタイトル, after 作品名 and 話数.
    #[serde(default)]
    pub subtitle: String,
    #[serde(default)]
    pub title_position: StoryPosition,
    #[serde(default = "center")]
    pub author_position: StoryPosition,
    /// ページ番号 in the 作品情報 (`7ページ`); none shows none.
    #[serde(default)]
    pub page_number: Option<PageNumber>,
    /// A ノンブル printed on the page, in place of the hidden one.
    #[serde(default)]
    pub nombre: Option<ShownNombre>,
}

impl Default for StoryLayout {
    fn default() -> Self {
        StoryLayout {
            subtitle: String::new(),
            title_position: StoryPosition::Left,
            author_position: StoryPosition::Center,
            page_number: None,
            nombre: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageNumber {
    /// The first page's number.
    pub start: i64,
    #[serde(default = "right")]
    pub position: StoryPosition,
}

/// Where a shown ノンブル goes, from the 基本枠: above or below it, on the
/// binding side (内側), in the middle or on the other side (外側).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NombrePlace {
    TopInner,
    Top,
    TopOuter,
    BottomInner,
    Bottom,
    BottomOuter,
}

impl NombrePlace {
    /// `ComicStoryNombrePosition`.
    fn column(self) -> i64 {
        match self {
            NombrePlace::TopInner => 1,
            NombrePlace::Top => 2,
            NombrePlace::TopOuter => 3,
            NombrePlace::BottomInner => 4,
            NombrePlace::Bottom => 5,
            NombrePlace::BottomOuter => 6,
        }
    }

    fn top(self) -> bool {
        self.column() <= 3
    }

    fn align(self) -> Align {
        match self.column() {
            1 | 4 => Align::End,
            2 | 5 => Align::Middle,
            _ => Align::Start,
        }
    }
}

fn nombre_offset() -> [f64; 2] {
    [0.0, 5.0]
}

fn nombre_size() -> f64 {
    9.0
}

/// A ノンブル printed on the page (CSP's ノンブル, not the hidden one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShownNombre {
    pub place: NombrePlace,
    /// 白 rather than 黒.
    #[serde(default)]
    pub white: bool,
    /// フチ width (mm); none: no フチ.
    #[serde(default)]
    pub edge_mm: Option<f64>,
    /// フォーマット: the text before and after the number.
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    /// 基本枠との間隔: 横 (from the 基本枠's side, inwards) and 縦.
    #[serde(default = "nombre_offset")]
    pub offset_mm: [f64; 2],
    /// サイズ (pt).
    #[serde(default = "nombre_size")]
    pub size_pt: f64,
}

impl ShownNombre {
    fn text(&self, number: i64) -> String {
        format!("{}{number}{}", self.prefix, self.suffix)
    }
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
        if self.story.page_number.as_ref().is_some_and(|number| number.start < 0) {
            return fail("ページ番号の開始番号は 0 以上にしてください");
        }
        if let Some(nombre) = &self.story.nombre {
            if !(nombre.size_pt.is_finite() && (4.0..=72.0).contains(&nombre.size_pt)) {
                return fail("ノンブルの大きさは 4〜72 pt にしてください");
            }
            if nombre
                .edge_mm
                .is_some_and(|edge| !(edge.is_finite() && (0.0..=5.0).contains(&edge)))
            {
                return fail("ノンブルのフチは 0〜5 mm にしてください");
            }
            if !nombre
                .offset_mm
                .iter()
                .all(|offset| offset.is_finite() && offset.abs() <= 100.0)
            {
                return fail("ノンブルの基本枠との間隔は ±100 mm までにしてください");
            }
        }
        Ok(())
    }

    fn px(&self, mm: f64) -> i64 {
        to_pixels(mm, "mm", self.resolution)
    }

    pub fn canvas_px(&self) -> (i64, i64) {
        (self.px(self.canvas_mm[0]), self.px(self.canvas_mm[1]))
    }

    /// The 作品情報 line: 作品名, 話数 and サブタイトル as CSP writes them.
    pub fn story_line(&self) -> String {
        let mut line = self.title.trim().to_owned();
        if let Some(index) = self.story_index {
            line.push_str(&format!(" {index}話"));
        }
        let subtitle = self.story.subtitle.trim();
        if !subtitle.is_empty() {
            line.push(' ');
            line.push_str(subtitle);
        }
        line
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
    if setup.story.page_number.is_some() {
        add_page_number(db)?;
    }
    if let Some(nombre) = &setup.story.nombre {
        show_nombre(db, nombre, setup.nombre_start, setup.resolution)?;
    }
    set_story_texts(db, setup)?;
    place_story_texts(db, &old, &new, setup)?;
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
    // The page is the first one: its ノンブル is the start number.
    update_nombre(&editor.db, !setup.first_page_left)?;
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
    let story = &setup.story;
    values.extend([
        ("ComicStorySubTitle", Value::Text(story.subtitle.trim().to_owned())),
        ("ComicStoryStoryPosition", Value::Integer(story.title_position.column())),
        (
            "ComicStoryAuthorPosition",
            Value::Integer(story.author_position.column()),
        ),
        (
            "ComicStoryUsePageNumber",
            Value::Integer(story.page_number.is_some() as i64),
        ),
        (
            "ComicStoryUseShownNombre",
            Value::Integer(story.nombre.is_some() as i64),
        ),
        (
            "ComicStoryUseHiddenNombre",
            Value::Integer(story.nombre.is_none() as i64),
        ),
    ]);
    if let Some(number) = &story.page_number {
        values.push(("ComicStoryPageNumberStart", Value::Integer(number.start)));
        values.push(("ComicStoryPageNumberPosition", Value::Integer(number.position.column())));
    }
    if let Some(nombre) = &story.nombre {
        values.extend([
            ("ComicStoryNombrePosition", Value::Integer(nombre.place.column())),
            ("ComicStoryNombrePrefix", Value::Text(nombre.prefix.clone())),
            ("ComicStoryNombreSuffix", Value::Text(nombre.suffix.clone())),
            ("ComicStoryNombreColor", Value::Integer(nombre.white as i64)),
            (
                "ComicStoryNombreUseEdge",
                Value::Integer(nombre.edge_mm.is_some() as i64),
            ),
            ("ComicStoryNombreFontSize", Value::Real(nombre.size_pt)),
            ("ComicStoryXPageNombreOffset", Value::Real(nombre.offset_mm[0])),
            ("ComicStoryXPageNombreOffsetUnit", Value::Integer(2)),
            ("ComicStoryYPageNombreOffset", Value::Real(nombre.offset_mm[1])),
            ("ComicStoryYPageNombreOffsetUnit", Value::Integer(2)),
        ]);
        if let Some(edge) = nombre.edge_mm {
            values.push(("ComicStoryNombreEdgeWidth", Value::Real(edge)));
            values.push(("ComicStoryNombreEdgeUnit", Value::Integer(2)));
        }
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

/// Rewrite the blocks of one attributes array column.
fn edit_array(db: &Connection, layer_id: i64, column: &str, edit: &dyn Fn(&mut Vec<TextItems>)) -> Result<()> {
    if !has_column(db, "Layer", column)? {
        return Ok(());
    }
    let blob: Value = db.query_row(
        &format!("SELECT \"{column}\" FROM Layer WHERE MainId = ?1"),
        [layer_id],
        |row| row.get(0),
    )?;
    let Value::Blob(blob) = blob else { return Ok(()) };
    let mut blocks: Vec<TextItems> = Vec::new();
    for block in split_attribute_array(&blob)? {
        blocks.push(
            crate::text::parse_tlv(block)?
                .into_iter()
                .map(|(tag, value)| (tag, value.to_vec()))
                .collect(),
        );
    }
    edit(&mut blocks);
    let joined: Vec<u8> = blocks
        .iter()
        .flat_map(|items| {
            let block = crate::text::build_tlv(items);
            let mut entry = (block.len() as u32).to_le_bytes().to_vec();
            entry.extend(block);
            entry
        })
        .collect();
    db.execute(
        &format!("UPDATE Layer SET \"{column}\" = ?1 WHERE MainId = ?2"),
        (joined, layer_id),
    )?;
    Ok(())
}

fn with_part(items: &TextItems, part: Part) -> TextItems {
    items
        .iter()
        .map(|(tag, value)| match *tag {
            ATTR_STORY_PART => (*tag, bytes(&[part.code()])),
            _ => (*tag, value.clone()),
        })
        .collect()
}

/// Give the 作品情報 a ページ番号: a block after the 作者名's, like it, as CSP
/// adds it (its text and place are set with the others).
fn add_page_number(db: &Connection) -> Result<()> {
    for (layer_id, _) in story_layers(db, STORY_INFO)? {
        if array_parts(db, layer_id)?.contains(&Part::PageNumber) {
            continue;
        }
        for column in ["TextLayerAttributesArray", "TextLayerAddAttributesV01"] {
            edit_array(db, layer_id, column, &|blocks| {
                let author = blocks.iter().rposition(|items| {
                    item(items, ATTR_STORY_PART).map(i32s).as_deref() == Some(&[Part::Author.code()])
                });
                if let Some(author) = author.or(blocks.len().checked_sub(1)) {
                    let block = with_part(&blocks[author], Part::PageNumber);
                    blocks.push(block);
                }
            })?;
        }
        if let Some(mut strings) = string_array(db, layer_id)? {
            strings.push(String::new());
            set_string_array(db, layer_id, &strings)?;
        }
    }
    Ok(())
}

/// Make the hidden ノンブル a shown one: its part, size and colour, with the
/// first page's text (placed with the others).
fn show_nombre(db: &Connection, nombre: &ShownNombre, start: i64, page_resolution: f64) -> Result<()> {
    let resolution = resolution(db)?;
    let text = nombre.text(start);
    let units = text.encode_utf16().count();
    let size = round_half_even(nombre.size_pt * 100.0);
    for (layer_id, _) in story_layers(db, NOMBRE_INFO)? {
        db.execute(
            "UPDATE Layer SET TextLayerString = ?1 WHERE MainId = ?2",
            (text.as_bytes(), layer_id),
        )?;
        edit_story_blobs(db, layer_id, NOMBRE_INFO, &|_, counted, items| {
            let old = item(&items, ATTR_FONT_SIZE)
                .map(i32s)
                .and_then(|values| values.first().copied())
                .filter(|old| *old > 0)
                .unwrap_or(600);
            let ratio = size as f64 / old as f64;
            let scale = |values: Vec<i64>| -> Vec<u8> {
                bytes(
                    &values
                        .into_iter()
                        .map(|value| round_half_even(value as f64 * ratio))
                        .collect::<Vec<_>>(),
                )
            };
            let items: TextItems = items
                .into_iter()
                .map(|(tag, value)| match tag {
                    ATTR_STORY_PART => (tag, bytes(&[Part::Nombre.code()])),
                    ATTR_FONT_SIZE if value.len() == 4 => (tag, bytes(&[size])),
                    ATTR_COLOR if value.len() == 12 => (tag, vec![if nombre.white { 0xff } else { 0 }; 12]),
                    ATTR_BLOCK_SIZE | ATTR_QUAD | ATTR_ORIGIN if value.len() % 4 == 0 => (tag, scale(i32s(&value))),
                    ATTR_BBOX if value.len() == 16 => {
                        let [x0, y0, x1, y1] = i32s(&value)[..] else {
                            unreachable!()
                        };
                        (
                            tag,
                            bytes(&[x0, y0, x1, y0 + round_half_even((y1 - y0) as f64 * ratio)]),
                        )
                    }
                    _ => (tag, value),
                })
                .collect();
            let width = text_width(&text, em_px(&items, resolution));
            Ok(set_run_length(items, units, counted)
                .into_iter()
                .map(|(tag, value)| resize_block(tag, value, width, Align::Start))
                .collect())
        })?;
        drop_render_cache(db, layer_id)?;
        if let Some(edge) = nombre.edge_mm {
            // In px of the page made (the template's resolution changes after this).
            set_edge(db, layer_id, edge / 25.4 * page_resolution, nombre.white)?;
        }
    }
    Ok(())
}

/// Give a layer CSP's フチ (a layer effect, not a text attribute): `width`
/// px, black around white text and white around black.
fn set_edge(db: &Connection, layer_id: i64, width: f64, white_text: bool) -> Result<()> {
    let mut info = NOMBRE_EDGE.to_vec();
    // After the size, the count and the name `EffectEdge`: on, width, colour.
    let at = 4 + 4 + 4 + "EffectEdge".len() * 2;
    if info.get(at..at + 4) != Some(&[0, 0, 0, 1]) {
        return Err(CspError::format("Unexpected layer effect template"));
    }
    info[at + 4..at + 12].copy_from_slice(&width.to_be_bytes());
    let channel: u32 = if white_text { 0 } else { 255 };
    for index in 0..3 {
        let start = at + 12 + index * 4;
        info[start..start + 4].copy_from_slice(&channel.to_be_bytes());
    }
    let mut values: Vec<(&str, Value)> = [
        "EffectLayerRenderType",
        "EffectRenderType",
        "EffectReferAreaType",
        "EffectSetUpdateRectType",
        "EffectOffscreenFixType",
        "EffectOffscreenMoveType",
    ]
    .into_iter()
    .map(|column| (column, Value::Integer(10)))
    .collect();
    values.push(("LayerEffectAttached", Value::Integer(1)));
    values.push(("LayerEffectEdgeNewRender", Value::Integer(1)));
    values.push(("LayerEffectInfo", Value::Blob(info)));
    for (column, value) in values {
        if !has_column(db, "Layer", column)? {
            db.execute(&format!("ALTER TABLE Layer ADD COLUMN \"{column}\""), [])?;
        }
        db.execute(
            &format!("UPDATE Layer SET \"{column}\" = ?1 WHERE MainId = ?2"),
            (value, layer_id),
        )?;
    }
    Ok(())
}

/// Write the 作品名・話数・サブタイトル, 作者名 and ページ番号 into the 作品情報
/// layer: the strings, their style runs' lengths and the blocks' widths.
/// CSP draws them afresh.
fn set_story_texts(db: &Connection, setup: &PageSetup) -> Result<()> {
    let resolution = resolution(db)?;
    let title = setup.story_line();
    let author = setup.author.trim().to_owned();
    // The page is the first one.
    let page = setup
        .story
        .page_number
        .as_ref()
        .map(|number| page_number_text(number.start));
    for (layer_id, _) in story_layers(db, STORY_INFO)? {
        db.execute(
            "UPDATE Layer SET TextLayerString = ?1 WHERE MainId = ?2",
            (title.as_bytes(), layer_id),
        )?;
        if let Some(mut strings) = string_array(db, layer_id)? {
            let parts = array_parts(db, layer_id)?;
            strings.resize(parts.len().max(strings.len()), String::new());
            for (index, part) in parts.iter().enumerate() {
                match (part, &page) {
                    (Part::Author, _) => strings[index] = author.clone(),
                    (Part::PageNumber, Some(page)) => strings[index] = page.clone(),
                    _ => {}
                }
            }
            set_string_array(db, layer_id, &strings)?;
        }
        edit_story_blobs(db, layer_id, STORY_INFO, &|part, counted, items| {
            let text = match (part, &page) {
                (Part::Title, _) => &title,
                (Part::Author, _) => &author,
                (Part::PageNumber, Some(page)) => page,
                _ => return Ok(items),
            };
            let width = text_width(text, em_px(&items, resolution));
            Ok(set_run_length(items, text.encode_utf16().count(), counted)
                .into_iter()
                .map(|(tag, value)| resize_block(tag, value, width, Align::Start))
                .collect())
        })?;
        drop_render_cache(db, layer_id)?;
    }
    Ok(())
}

fn layer_offset(db: &Connection, layer_id: i64) -> Result<(i64, i64)> {
    let (x, y): (Option<i64>, Option<i64>) = db.query_row(
        "SELECT LayerOffsetX, LayerOffsetY FROM Layer WHERE MainId = ?1",
        [layer_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((x.unwrap_or(0), y.unwrap_or(0)))
}

/// Where a 作品情報 part goes: its position and its row there (items at one
/// position stack up: ページ番号, 作品名, 作者名), and how many rows the
/// tallest stack has.
fn story_rows(story: &StoryLayout) -> (impl Fn(Part) -> Option<(StoryPosition, i64)>, i64) {
    let order = [
        (
            Part::PageNumber,
            story.page_number.as_ref().map(|number| number.position),
        ),
        (Part::Title, Some(story.title_position)),
        (Part::Author, Some(story.author_position)),
    ];
    let row = move |part: Part| {
        let at = order.iter().position(|(one, _)| *one == part)?;
        let position = order[at].1?;
        let above = order[..at].iter().filter(|(_, other)| *other == Some(position)).count();
        Some((position, above as i64))
    };
    let rows = order
        .iter()
        .filter_map(|(_, position)| *position)
        .map(|position| order.iter().filter(|(_, other)| *other == Some(position)).count())
        .max()
        .unwrap_or(1) as i64;
    (row, rows)
}

/// Move the story info texts from the template's frames to the new ones,
/// scaled by the change of resolution: the 作品情報 under the 仕上がり (at its
/// left edge, middle or right edge), the hidden ノンブル at the binding edge
/// of the 仕上がり, level with the bottom of the 基本枠, and a shown one above
/// or below the 基本枠.
fn place_story_texts(db: &Connection, old: &Frames, new: &Frames, setup: &PageSetup) -> Result<()> {
    let scale = new.resolution / old.resolution;
    let at = |anchor_old: i64, anchor_new: i64, value: i64| {
        anchor_new + round_half_even((value - anchor_old) as f64 * scale)
    };
    let px = |mm: f64| to_pixels(mm, "mm", new.resolution);
    // CSP puts the first row about 6 mm under the 仕上がり (its pages of A3/B4
    // and A4/B5 agree), a row a line high. When the canvas has no room there
    // (a canvas of 仕上がり + 裁ち落とし), they go up, inside the canvas, so they
    // can be seen.
    let margin = round_half_even(STORY_MARGIN_MM / 25.4 * new.resolution);
    let (row_of, rows) = story_rows(&setup.story);
    let below = |y0: i64, height: i64, row: i64| {
        let first = at(old.trim[3], new.trim[3], y0);
        let lift = (first + rows * height - (new.height - margin)).max(0);
        first + row * height - lift
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
                            let along = |align: Align, from: i64, to: i64| match align {
                                Align::Start => from,
                                Align::Middle => (from + to) / 2 - width / 2,
                                Align::End => to - width,
                            };
                            let (x0, y0) = match (part, &setup.story.nombre) {
                                (Part::Nombre, None) => (
                                    // A left page: the binding edge is on the right.
                                    at(old.trim[2], new.trim[2], x1) - width,
                                    at(old.basic[3], new.basic[3], y1) - height,
                                ),
                                (Part::Nombre, Some(nombre)) => {
                                    // 内側 is the binding side: the right of a left page.
                                    let [across, apart] = [px(nombre.offset_mm[0]), px(nombre.offset_mm[1])];
                                    let x = match nombre.place.align() {
                                        Align::Start => new.basic[0] + across,
                                        Align::Middle => along(Align::Middle, new.basic[0], new.basic[2]),
                                        Align::End => new.basic[2] - across - width,
                                    };
                                    let y = if nombre.place.top() {
                                        new.basic[1] - apart - height
                                    } else {
                                        new.basic[3] + apart
                                    };
                                    (x, y)
                                }
                                (part, _) => match row_of(part) {
                                    Some((position, row)) => (
                                        along(position.align(), new.trim[0], new.trim[2]),
                                        below(y0, height, row),
                                    ),
                                    None => (at(old.trim[0], new.trim[0], x0), below(y0, height, 0)),
                                },
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

/// The least room left under 作品名 and 作者名, from the canvas edge.
const STORY_MARGIN_MM: f64 = 0.5;

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
