//! The name data the tool owns (正本). CSP files are only imported from and
//! exported to; panels, dialogue and story structure live here.
//!
//! Page coordinates are millimetres on the page canvas, origin at its top
//! left, so they do not depend on the resolution of the sheet or the page.
//! Story structure (scenes, characters, emotion values) is kept from the
//! first version so that overview views (構成, タイムライン, 感情曲線) can be
//! added later without changing the file format.

use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

pub type Point = [f64; 2];
/// `[x0, y0, x1, y1]` in millimetres.
pub type BoxMm = [f64; 4];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub format_version: u32,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_index: Option<u32>,
    #[serde(default)]
    pub author: String,
    pub binding: Binding,
    pub page_format: PageFormat,
    pub pages: Vec<Page>,
    #[serde(default)]
    pub characters: Vec<Character>,
    #[serde(default)]
    pub scenes: Vec<Scene>,
    #[serde(default)]
    pub emotions: Vec<EmotionPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceSheet>,
    /// Next number used by [`Project::new_id`]; ids are never reused.
    pub next_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Binding {
    /// 右綴じ (manga): pages run right to left.
    Right,
    Left,
}

/// Size of the manuscript page and its frames, in millimetres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageFormat {
    /// The page canvas (A3 in the user's manuscripts).
    pub canvas_mm: [f64; 2],
    /// 仕上がり枠 (trim), centred on the canvas.
    pub trim_mm: [f64; 2],
    /// 基本枠 (basic frame), centred on the canvas and moved by `basic_offset_mm`.
    pub basic_mm: [f64; 2],
    #[serde(default)]
    pub basic_offset_mm: [f64; 2],
}

impl Default for PageFormat {
    /// A3 canvas, B4 trim and a common 180 x 270 mm basic frame.
    fn default() -> Self {
        PageFormat {
            canvas_mm: [297.0, 420.0],
            trim_mm: [257.0, 364.0],
            basic_mm: [180.0, 270.0],
            basic_offset_mm: [0.0, 0.0],
        }
    }
}

impl PageFormat {
    fn centred(&self, size: [f64; 2], offset: [f64; 2]) -> BoxMm {
        let x0 = (self.canvas_mm[0] - size[0]) / 2.0 + offset[0];
        let y0 = (self.canvas_mm[1] - size[1]) / 2.0 + offset[1];
        [x0, y0, x0 + size[0], y0 + size[1]]
    }

    pub fn trim_box(&self) -> BoxMm {
        self.centred(self.trim_mm, [0.0, 0.0])
    }

    pub fn basic_box(&self) -> BoxMm {
        self.centred(self.basic_mm, self.basic_offset_mm)
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    #[serde(default)]
    pub memo: String,
    #[serde(default)]
    pub panels: Vec<Panel>,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub strokes: Vec<Stroke>,
    #[serde(default)]
    pub roughs: Vec<RoughImage>,
}

/// コマ: a polygon (usually a rectangle) in reading order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: String,
    pub shape: Vec<Point>,
    pub order: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    /// セリフ
    #[default]
    Speech,
    /// モノローグ・心の声
    Thought,
    /// ナレーション
    Narration,
    /// 描き文字・効果音
    Sfx,
}

/// セリフ and other text placed on a page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub kind: LineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    #[serde(rename = "box")]
    pub box_mm: BoxMm,
    pub font_size_pt: f64,
    pub vertical: bool,
    /// Balloon outline, when the line has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balloon: Option<Vec<Point>>,
}

/// A rough line (ラフ). Points are `[x, y, pressure]` with pressure 0..1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub id: String,
    pub points: Vec<[f64; 3]>,
    pub width_mm: f64,
    #[serde(default)]
    pub closed: bool,
}

/// Raster rough kept in the source sheet; the pixels are read from there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoughImage {
    pub id: String,
    pub layer_id: i64,
    pub layer_name: String,
    /// Crop of the sheet, in sheet pixels.
    pub sheet_crop: [f64; 4],
    /// Where the crop lands on the page, in millimetres.
    #[serde(rename = "box")]
    pub box_mm: BoxMm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// A scene: a run of pages, with its place in story time for the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub first_page: String,
    pub last_page: String,
    /// Label of when the scene happens in the story (e.g. "1日目 朝").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_time: Option<String>,
    /// Sort key in story time; differs from page order for flashbacks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub story_order: Option<f64>,
}

/// How a character feels at a page: -1 (negative) .. 1 (positive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmotionPoint {
    pub character: String,
    pub page: String,
    pub value: f64,
    #[serde(default)]
    pub note: String,
}

/// The name sheet a project was imported from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSheet {
    pub path: String,
    pub resolution: f64,
    /// Sheet pixels of each page cell, in page order.
    pub cells: Vec<[f64; 4]>,
}

impl Project {
    pub fn new(title: &str) -> Self {
        Project {
            format_version: FORMAT_VERSION,
            title: title.to_owned(),
            story_index: None,
            author: String::new(),
            binding: Binding::Right,
            page_format: PageFormat::default(),
            pages: Vec::new(),
            characters: Vec::new(),
            scenes: Vec::new(),
            emotions: Vec::new(),
            source: None,
            next_id: 1,
        }
    }

    /// A new id such as "page12" or "line40"; unique within the project.
    pub fn new_id(&mut self, prefix: &str) -> String {
        let id = format!("{prefix}{}", self.next_id);
        self.next_id += 1;
        id
    }

    pub fn page_number(&self, page_id: &str) -> Option<usize> {
        self.pages
            .iter()
            .position(|page| page.id == page_id)
            .map(|index| index + 1)
    }
}
