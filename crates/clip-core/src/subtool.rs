//! Sub tools (サブツール: pens, erasers, brushes) saved by CSP, as the
//! name tool draws with them.
//!
//! csp-assets reads an exported sub tool (.sut) and CSP's own tool database
//! (`Tool/EditImageTool.todb`): the tool tree, each sub tool's settings
//! (`Variant`), its 影響元設定 and material lists, and the materials a .sut
//! carries. This module picks the pens and erasers and turns their settings
//! into what the app draws with.
//!
//! Settings that matter for drawing lines:
//! - `BrushSize` with `BrushSizeUnit` (0 = pixels of the canvas, 2 = mm).
//! - `BrushSizeEffector`, `BrushOpacityEffector`, `BrushFlowEffector`: how pen
//!   pressure and the like change the value; see [`Dynamics::parse`].
//! - `Opacity` (%), `BrushHardness` (%), `AntiAlias` (0..3),
//!   `FlickerReduction` (手ブレ補正, 0..100), `FlickerReductionBySpeed` (速度による手ブレ補正),
//!   `BrushUseRevision` with `BrushRevision` (後補正 and its strength, 0..100).
//! - `BrushUseIn` / `BrushUseOut` with `BrushInLength`, `BrushOutLength` and
//!   their units: 入り抜き (tapering at both ends).
//! - `BrushInterval` (% of the size between stamps), `BrushThickness`
//!   (% of the width kept for the height of the tip), `BrushRotation` (°).
//! - `BrushPatternImageArray`: the tip materials, see [`pattern_paths`].
//!   Tools in the database refer to installed materials, which live under
//!   `CLIPStudioCommon/Material/<a>/<b>/<uuid>/` with a thumbnail of the tip.
//! - `CompositeMode` 27 is "erase"; `BrushUseVectorEraser` with
//!   `BrushVectorEraserType` (0 touched part, 1 up to intersections,
//!   2 whole line) is how it erases vector lines.

use std::path::{Path, PathBuf};

use csp_assets::subtool::blob::{
    Effector, INPUT_PRESSURE, INPUT_RANDOM, INPUT_TILT, INPUT_VELOCITY, MaterialList, Records,
};
use csp_assets::subtool::{Cells, MaterialFile, Node, SubToolDb, SutParts};
use name_model::{CspMaterial, CspToolData, CspValue};
use rusqlite::types::Value;
use serde::Serialize;

use crate::RgbaImage;
use crate::error::{CspError, Result};
use crate::raster::{Filter, decode_png, luma, resize};
use csp_format::database::Row;

/// Largest side of the tip mask handed to the app.
pub const TIP_SIZE: u32 = 128;
/// `CompositeMode` of erasers.
const COMPOSITE_ERASE: i64 = 27;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubToolKind {
    Pen,
    Eraser,
    /// Fills, selections, rulers and the like.
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LengthUnit {
    /// Pixels of the canvas the tool draws on.
    Px,
    Mm,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Length {
    pub value: f64,
    pub unit: LengthUnit,
}

impl Length {
    fn from_row(row: &Row, value: &str, unit: &str) -> Option<Length> {
        if !present(row, value) {
            return None;
        }
        let unit = match row.int(unit) {
            2 => LengthUnit::Mm,
            _ => LengthUnit::Px,
        };
        Some(Length {
            value: row.real(value),
            unit,
        })
    }

    pub fn to_mm(self, dpi: f64) -> f64 {
        match self.unit {
            LengthUnit::Mm => self.value,
            LengthUnit::Px => self.value * 25.4 / dpi,
        }
    }
}

/// What changes a setting while drawing (影響元設定): which inputs are on
/// (pen pressure, tilt, speed, random), the value at their lightest touch and
/// their graphs. Graph points are control points: CSP draws a smooth curve
/// through the ends that bends towards the points in between.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dynamics {
    pub pressure: bool,
    /// Value at the lightest pressure, 0..1 of the setting.
    pub pressure_min: f64,
    /// Pressure graph; empty when it is the straight line.
    pub pressure_curve: Vec<[f64; 2]>,
    pub tilt: bool,
    pub tilt_min: f64,
    pub tilt_curve: Vec<[f64; 2]>,
    pub velocity: bool,
    pub velocity_min: f64,
    pub velocity_curve: Vec<[f64; 2]>,
    pub random: bool,
    pub random_min: f64,
}

impl Dynamics {
    /// From an `…Effector` blob (csp-assets reads it); None when it is not one.
    pub fn parse(blob: &[u8]) -> Option<Dynamics> {
        let effector = Effector::parse(blob).ok()?;
        let min = |index: usize| (effector.minimum[index] as f64 / 100.0).clamp(0.0, 1.0);
        Some(Dynamics {
            pressure: effector.uses(INPUT_PRESSURE),
            pressure_min: min(0),
            pressure_curve: graph_points(effector.pressure_graph.as_ref()),
            tilt: effector.uses(INPUT_TILT),
            tilt_min: min(1),
            tilt_curve: graph_points(effector.tilt_graph.as_ref()),
            velocity: effector.uses(INPUT_VELOCITY),
            velocity_min: min(2),
            // Without a speed graph CSP thins the line as the pen speeds up:
            // the graph CSP itself saves for its own brushes (水彩丸筆,
            // にじみ墨...) is this straight line down.
            velocity_curve: match &effector.velocity_graph {
                Some(graph) => graph_points(Some(graph)),
                None => vec![[0.0, 1.0], [1.0, 0.0]],
            },
            random: effector.uses(INPUT_RANDOM),
            random_min: min(3),
        })
    }
}

/// The points of one graph, in 0..1; empty for none or the straight line.
fn graph_points(graph: Option<&Records>) -> Vec<[f64; 2]> {
    let points: Vec<[f64; 2]> = graph
        .map(|graph| {
            graph
                .points()
                .into_iter()
                .map(|[x, y]| [x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)])
                .collect()
        })
        .unwrap_or_default();
    if points == [[0.0, 0.0], [1.0, 1.0]] {
        Vec::new()
    } else {
        points
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VectorErase {
    /// 触れた部分: cut away what the eraser touches.
    Touched,
    /// 交点まで: up to where the line crosses other lines.
    Intersection,
    /// 線全体: the whole line.
    Whole,
}

/// A brush tip picture: white, with the tip's coverage in alpha.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipImage {
    pub width: u32,
    pub height: u32,
    /// PNG, base64.
    pub png_base64: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTool {
    pub name: String,
    /// Tool and group names above it (empty in a .sut).
    pub group: Vec<String>,
    pub kind: SubToolKind,
    pub size: Option<Length>,
    pub size_dynamics: Option<Dynamics>,
    /// 0..1.
    pub opacity: f64,
    pub opacity_dynamics: Option<Dynamics>,
    /// ブラシ濃度, 0..1.
    pub flow: f64,
    pub flow_dynamics: Option<Dynamics>,
    /// 0..1; 1 is a hard edge.
    pub hardness: f64,
    pub anti_alias: i64,
    /// 手ブレ補正, 0..100.
    pub stabilization: f64,
    /// 速度による手ブレ補正: steadier the faster the pen moves.
    pub stabilization_by_speed: bool,
    /// 後補正: the strength the line is smoothed with once drawn (0 when off).
    pub post_correction: f64,
    pub taper_in: Option<Length>,
    pub taper_out: Option<Length>,
    /// Stamp spacing in % of the size.
    pub interval: f64,
    /// Tip height in % of its width.
    pub thickness: f64,
    /// Tip rotation in degrees.
    pub rotation: f64,
    /// Material path of the first tip picture, as CSP stores it.
    pub tip_material: Option<String>,
    pub tip: Option<TipImage>,
    pub vector_erase: Option<VectorErase>,
    /// Every setting as CSP keeps it, to edit and to write back as a .sut
    /// ([`sub_tool_file`]); `dpi` is left for the app to fill in.
    pub csp: CspToolData,
}

/// Where CSP keeps its tools and materials on Windows, under `%APPDATA%`.
pub fn default_locations(appdata: &Path) -> (PathBuf, PathBuf) {
    let celsys = appdata.join("CELSYSUserData").join("CELSYS");
    (
        celsys
            .join("CLIPStudioPaintVer1_5_0")
            .join("Tool")
            .join("EditImageTool.todb"),
        celsys.join("CLIPStudioCommon").join("Material"),
    )
}

/// Read every drawing sub tool (pens, brushes, erasers) of a .sut or of CSP's
/// tool database. `material_root` resolves tips the database refers to.
pub fn read_sub_tools(path: impl AsRef<Path>, material_root: Option<&Path>) -> Result<Vec<SubTool>> {
    // Open a copy: CSP may hold the database open, and nothing is written back.
    let bytes = std::fs::read(path.as_ref())?;
    read_sub_tools_from_bytes(&bytes, material_root)
}

pub fn read_sub_tools_from_bytes(bytes: &[u8], material_root: Option<&Path>) -> Result<Vec<SubTool>> {
    if !csp_assets::subtool::looks_like(bytes) {
        return Err(CspError::format(
            "CSP のサブツール（.sut）でもツールのデータベースでもありません",
        ));
    }
    let db =
        SubToolDb::from_bytes(bytes).map_err(|error| CspError::format(format!("サブツールを読めません: {error}")))?;
    let mut tools = Vec::new();
    for entry in db.sub_tools() {
        let node = &db.nodes[entry.node];
        let Some(variant) = db.variant(node.variant_id) else {
            continue;
        };
        let kind = kind_of(node, variant);
        // Not "has BrushSize": a .sut keeps only the columns its tool sets, and
        // ドットペン leaves its size to the tool above it.
        if kind == SubToolKind::Other {
            continue;
        }
        let parts = db
            .sut_parts(entry.node)
            .map_err(|error| CspError::format(format!("サブツールを読めません: {error}")))?;
        let mut tool = sub_tool(node, variant, entry.path, kind, &db.materials, material_root);
        tool.csp = csp_rows(&parts);
        tools.push(tool);
    }
    Ok(tools)
}

/// Materials a .sut carries are kept with the brush up to this size in all.
const KEEP_MATERIALS_BYTES: usize = 2 << 20;

/// One value as the name data keeps it.
fn csp_value(value: &Value) -> Option<CspValue> {
    match value {
        Value::Null => None,
        Value::Integer(v) => Some(CspValue::Number(*v as f64)),
        Value::Real(v) => Some(CspValue::Number(*v)),
        Value::Text(v) => Some(CspValue::Text(v.clone())),
        Value::Blob(v) => Some(CspValue::Blob { blob: base64(v) }),
    }
}

fn csp_map(cells: &Cells, leave_out: &[&str]) -> std::collections::BTreeMap<String, CspValue> {
    cells
        .iter()
        .filter(|(name, _)| !leave_out.contains(&name.as_str()))
        .filter_map(|(name, value)| Some((name.clone(), csp_value(value)?)))
        .collect()
}

/// A sub tool's rows as the name data keeps them: the settings, the node
/// without its place in the tree, the manager without what names the tree,
/// and the materials the file carries when they are small.
fn csp_rows(parts: &SutParts) -> CspToolData {
    let materials: Vec<CspMaterial> = parts
        .materials
        .iter()
        .map(|material| CspMaterial {
            original_path: material.original_path.trim_end_matches('\0').to_owned(),
            catalog_path: material.catalog_path.clone(),
            install_folder: material.install_folder,
            data: base64(&material.file_data),
        })
        .collect();
    let size: usize = parts.materials.iter().map(|m| m.file_data.len()).sum();
    CspToolData {
        settings: parts
            .variants
            .first()
            .map(|row| csp_map(row, &["VariantID"]))
            .unwrap_or_default(),
        node: csp_map(
            &parts.node,
            &[
                "NodeUuid",
                "NodeNextUuid",
                "NodeFirstChildUuid",
                "NodeSelectedUuid",
                "NodeVariantID",
                "NodeInitVariantID",
            ],
        ),
        manager: csp_map(
            &parts.manager,
            &["RootUuid", "CurrentNodeUuid", "MaxVariantID", "ObjectNodeUuid"],
        ),
        dpi: 0.0,
        materials: if size <= KEEP_MATERIALS_BYTES {
            materials
        } else {
            Vec::new()
        },
    }
}

/// A value of the name data as SQLite keeps it (whole numbers as integers;
/// CSP's column types turn them into reals where it keeps reals).
fn sql_value(value: &CspValue) -> Result<Value> {
    Ok(match value {
        CspValue::Number(v) if v.fract() == 0.0 && v.abs() < 9.0e15 => Value::Integer(*v as i64),
        CspValue::Number(v) => Value::Real(*v),
        CspValue::Text(v) => Value::Text(v.clone()),
        CspValue::Blob { blob } => Value::Blob(
            unbase64(blob).ok_or_else(|| CspError::format("サブツールの設定に読めない値があります（base64）"))?,
        ),
    })
}

fn sql_cells(map: &std::collections::BTreeMap<String, CspValue>) -> Result<Cells> {
    map.iter()
        .map(|(name, value)| Ok((name.clone(), sql_value(value)?)))
        .collect()
}

/// A .sut written by [`sub_tool_file`], and the materials it could not pack.
#[derive(Debug)]
pub struct SubToolFile {
    pub bytes: Vec<u8>,
    /// Names (or paths) of materials the settings use that were not found:
    /// CSP reads the sub tool, with its default tip or paper for these.
    pub missing_materials: Vec<String>,
}

/// Write a sub tool as a .sut for CSP's ツールの読み込み: the settings (also
/// as its initial settings), its node and manager rows, and the materials
/// its settings name, from the ones kept with it or else from CSP's
/// material folder (`material_root`). CSP names the tool after the file.
pub fn sub_tool_file(tool: &CspToolData, name: &str, material_root: Option<&Path>) -> Result<SubToolFile> {
    let mut node = sql_cells(&tool.node)?;
    for column in ["NodeInputOp", "NodeOutputOp"] {
        if !node.iter().any(|(n, _)| n == column) {
            return Err(CspError::format(format!("サブツールの種類（{column}）がありません")));
        }
    }
    let set = |cells: &mut Cells, column: &str, value: Value| match cells.iter_mut().find(|(n, _)| n == column) {
        Some(cell) => cell.1 = value,
        None => cells.push((column.to_owned(), value)),
    };
    set(
        &mut node,
        "NodeUuid",
        Value::Blob(uuid::Uuid::new_v4().as_bytes().to_vec()),
    );
    set(&mut node, "NodeName", Value::Text(name.to_owned()));
    set(&mut node, "NodeVariantID", Value::Integer(1));
    set(&mut node, "NodeInitVariantID", Value::Integer(2));
    let mut manager = sql_cells(&tool.manager)?;
    for (column, value) in [("ToolType", 0), ("Version", DEFAULT_SUT_VERSION)] {
        if !manager.iter().any(|(n, _)| n == column) {
            manager.push((column.to_owned(), Value::Integer(value)));
        }
    }
    let settings = sql_cells(&tool.settings)?;
    let mut variants = Vec::new();
    for id in [1, 2] {
        let mut row = settings.clone();
        set(&mut row, "VariantID", Value::Integer(id));
        variants.push(row);
    }
    let (materials, missing_materials) = pack_materials(tool, &settings, material_root)?;
    let bytes = csp_assets::subtool::build_sut(&SutParts {
        manager,
        node,
        variants,
        materials,
    })
    .map_err(|error| CspError::format(format!("サブツールを書けません: {error}")))?;
    Ok(SubToolFile {
        bytes,
        missing_materials,
    })
}

/// `Manager.Version` of the .sut files CSP EX 5 writes.
const DEFAULT_SUT_VERSION: i64 = 145;

/// The materials the settings name: kept ones first, then CSP's own folder.
fn pack_materials(
    tool: &CspToolData,
    settings: &Cells,
    material_root: Option<&Path>,
) -> Result<(Vec<MaterialFile>, Vec<String>)> {
    use csp_assets::subtool::blob::{BlobKind, kind_of_column};
    let mut refs = Vec::new();
    for (column, value) in settings {
        if kind_of_column(column) != BlobKind::MaterialList {
            continue;
        }
        if let Value::Blob(data) = value
            && let Ok(list) = MaterialList::parse(data)
        {
            refs.extend(list.materials);
        }
    }
    let mut index = None;
    let mut packed: Vec<MaterialFile> = Vec::new();
    let mut missing = Vec::new();
    for material in refs {
        let path = material.path.trim_end_matches('\0').to_owned();
        if packed.iter().any(|m| m.original_path == path) {
            continue;
        }
        if let Some(kept) = tool.materials.iter().find(|m| m.original_path == path) {
            packed.push(MaterialFile {
                original_path: path,
                catalog_path: kept.catalog_path.clone(),
                install_folder: kept.install_folder,
                file_data: unbase64(&kept.data)
                    .ok_or_else(|| CspError::format("取り込んだ素材が壊れています（base64）"))?,
            });
            continue;
        }
        let found = material_root.and_then(|root| {
            let index = index.get_or_insert_with(|| csp_assets::material::index_by_uuid(&[root.to_path_buf()]));
            let dir = csp_assets::material::resolve_ref(index, &path)?;
            csp_assets::material::sut_tar(&csp_assets::material::DirSource(dir))
                .ok()
                .flatten()
        });
        match found {
            Some(tar) => {
                let user = material.user_relative_path();
                let catalog = user.as_ref().map(|p| {
                    let parts: Vec<&str> = p.split('/').take(3).collect();
                    format!(".:{}", parts.join(":"))
                });
                packed.push(MaterialFile {
                    original_path: path,
                    catalog_path: catalog.unwrap_or_default(),
                    install_folder: if user.is_some() { 0 } else { 1 },
                    file_data: tar,
                });
            }
            None => missing.push(material.name.clone().filter(|n| !n.is_empty()).unwrap_or(path)),
        }
    }
    Ok((packed, missing))
}

fn kind_of(node: &Node, variant: &Row) -> SubToolKind {
    let (input, output) = (node.input_op, node.output_op);
    if input == 12 || output == 12 {
        return SubToolKind::Eraser;
    }
    if matches!(output, 10 | 11 | 14) && matches!(input, 10 | 11 | 14) {
        if variant.int("CompositeMode") == COMPOSITE_ERASE {
            return SubToolKind::Eraser;
        }
        return SubToolKind::Pen;
    }
    SubToolKind::Other
}

/// Whether the column exists and is not NULL.
fn present(row: &Row, column: &str) -> bool {
    row.get(column)
        .is_some_and(|value| !matches!(value, rusqlite::types::Value::Null))
}

fn real_or(row: &Row, column: &str, default: f64) -> f64 {
    if present(row, column) {
        row.real(column)
    } else {
        default
    }
}

fn percent(row: &Row, column: &str, default: f64) -> f64 {
    (real_or(row, column, default * 100.0) / 100.0).clamp(0.0, 1.0)
}

fn sub_tool(
    node: &Node,
    variant: &Row,
    group: Vec<String>,
    kind: SubToolKind,
    materials: &[MaterialFile],
    material_root: Option<&Path>,
) -> SubTool {
    let dynamics = |column: &str| variant.blob(column).and_then(Dynamics::parse);
    let taper = |use_column: &str, length: &str, unit: &str| {
        if variant.int(use_column) != 0 {
            Length::from_row(variant, length, unit)
        } else {
            None
        }
    };
    let tip_material = if variant.int("BrushUsePatternImage") != 0 {
        variant
            .blob("BrushPatternImageArray")
            .and_then(|blob| pattern_paths(blob).into_iter().next())
    } else {
        None
    };
    let tip = tip_material
        .as_deref()
        .and_then(|path| tip_picture(path, materials, material_root))
        .and_then(|png| tip_mask(&png).ok());
    let vector_erase = (kind == SubToolKind::Eraser).then(|| {
        if variant.int("BrushUseVectorEraser") == 0 {
            return VectorErase::Touched;
        }
        match variant.int("BrushVectorEraserType") {
            1 => VectorErase::Intersection,
            2 => VectorErase::Whole,
            _ => VectorErase::Touched,
        }
    });
    SubTool {
        name: node.name.clone(),
        group,
        kind,
        size: Length::from_row(variant, "BrushSize", "BrushSizeUnit"),
        size_dynamics: dynamics("BrushSizeEffector"),
        opacity: percent(variant, "Opacity", 1.0),
        opacity_dynamics: dynamics("BrushOpacityEffector"),
        flow: percent(variant, "BrushFlow", 1.0),
        flow_dynamics: dynamics("BrushFlowEffector"),
        hardness: percent(variant, "BrushHardness", 1.0),
        anti_alias: variant.int("AntiAlias"),
        stabilization: variant.real("FlickerReduction"),
        stabilization_by_speed: variant.int("FlickerReductionBySpeed") != 0,
        post_correction: if variant.int("BrushUseRevision") != 0 {
            variant.real("BrushRevision")
        } else {
            0.0
        },
        taper_in: taper("BrushUseIn", "BrushInLength", "BrushInLengthUnit"),
        taper_out: taper("BrushUseOut", "BrushOutLength", "BrushOutLengthUnit"),
        interval: real_or(variant, "BrushInterval", 10.0),
        thickness: real_or(variant, "BrushThickness", 100.0),
        rotation: variant.real("BrushRotation"),
        tip_material,
        tip,
        vector_erase,
        csp: CspToolData {
            settings: Default::default(),
            node: Default::default(),
            manager: Default::default(),
            dpi: 0.0,
            materials: Vec::new(),
        },
    }
}

/// Material paths in `BrushPatternImageArray` (csp-assets reads the list),
/// such as `.:91:20:<uuid>:data:material_0.layer` (an installed material) or
/// `.:Paint001:<uuid>:data:material.layer` (one that comes with CSP).
pub fn pattern_paths(blob: &[u8]) -> Vec<String> {
    MaterialList::parse(blob)
        .map(|list| {
            list.materials
                .into_iter()
                .map(|material| material.path.trim_end_matches('\0').to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Folders a tip path may be in, relative to the material root:
/// `.:91:20:<uuid>:data:material_0.layer` → `91/20/<uuid>` (downloaded), and
/// `.:Paint106:<uuid>:data:…` → `Install/Paint106/<uuid>` or `Install2/…`
/// (materials that come with CSP).
pub fn material_folders(path: &str) -> Vec<PathBuf> {
    let parts: Vec<&str> = path.trim_start_matches(".:").split(':').collect();
    let Some(data) = parts.iter().position(|part| *part == "data") else {
        return Vec::new();
    };
    let folder = &parts[..data];
    if folder.is_empty()
        || folder
            .iter()
            .any(|part| part.is_empty() || part.contains(['/', '\\']) || *part == "..")
    {
        return Vec::new();
    }
    let relative: PathBuf = folder.iter().collect();
    if folder[0].starts_with("Paint") {
        ["Install", "Install2"]
            .iter()
            .map(|root| Path::new(root).join(&relative))
            .collect()
    } else {
        vec![relative]
    }
}

/// PNG of the tip: from the .sut's own materials, else from the installed one.
fn tip_picture(path: &str, materials: &[MaterialFile], material_root: Option<&Path>) -> Option<Vec<u8>> {
    let embedded = materials
        .iter()
        .filter(|material| material.original_path == path)
        .find_map(MaterialFile::thumbnail);
    if embedded.is_some() {
        return embedded;
    }
    let root = material_root?;
    material_folders(path)
        .into_iter()
        .find_map(|folder| std::fs::read(root.join(folder).join("thumbnail").join("thumbnail.png")).ok())
}

/// Turn a tip picture into a white mask: coverage is alpha times darkness,
/// so black-on-white and black-on-transparent pictures both work. Trimmed to
/// what is drawn and shrunk to at most [`TIP_SIZE`].
pub fn tip_mask(png: &[u8]) -> Result<TipImage> {
    let image = decode_png(png)?;
    let mut mask = RgbaImage::new(image.width, image.height);
    for (source, target) in image
        .pixels
        .as_chunks::<4>()
        .0
        .iter()
        .zip(mask.pixels.as_chunks_mut::<4>().0)
    {
        let darkness = 255 - luma(source[0], source[1], source[2]) as u32;
        let coverage = (darkness * source[3] as u32 / 255) as u8;
        target.copy_from_slice(&[255, 255, 255, coverage]);
    }
    let mask = match mask.alpha_bbox() {
        Some((x0, y0, x1, y1)) => crate::raster::crop(&mask, (x0 as i64, y0 as i64, x1 as i64, y1 as i64)),
        None => return Err(CspError::format("ブラシ先端の画像が空です")),
    };
    let scale = (TIP_SIZE as f64 / mask.width.max(mask.height) as f64).min(1.0);
    let width = ((mask.width as f64 * scale).round() as u32).max(1);
    let height = ((mask.height as f64 * scale).round() as u32).max(1);
    let mask = if scale < 1.0 {
        resize(&mask, width, height, Filter::Box)
    } else {
        mask
    };
    Ok(TipImage {
        width: mask.width,
        height: mask.height,
        png_base64: base64(&mask.to_png()?),
    })
}

/// Bytes of standard base64 (padding optional); None for anything else.
fn unbase64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits = 0u32;
    let mut count = 0;
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        bits = bits << 6 | value as u32;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        0 => {}
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => return None,
    }
    Some(out)
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let value = (bytes[0] as u32) << 16 | (bytes[1] as u32) << 8 | bytes[2] as u32;
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(TABLE[(value >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effector(header: usize, inputs: u32, min: u32, curve: &[[f64; 2]]) -> Vec<u8> {
        let mut words = vec![0u32; header / 4];
        words[0] = header as u32;
        words[1] = 0x1f0;
        words[2] = inputs;
        words[3] = min;
        words[8] = if curve.is_empty() {
            0
        } else {
            12 + 16 * curve.len() as u32
        };
        if header >= 44 {
            words[10] = 100;
        }
        let mut blob: Vec<u8> = words.iter().flat_map(|w| w.to_be_bytes()).collect();
        if !curve.is_empty() {
            for w in [12u32, curve.len() as u32, 16] {
                blob.extend(w.to_be_bytes());
            }
            for [x, y] in curve {
                blob.extend(x.to_be_bytes());
                blob.extend(y.to_be_bytes());
            }
        }
        blob
    }

    #[test]
    fn reads_pressure_settings_from_both_header_sizes() {
        let curve = [[0.0, 0.0], [0.664, 0.082], [1.0, 1.0]];
        for header in [44, 48] {
            let dynamics = Dynamics::parse(&effector(header, 0x10, 0, &curve)).unwrap();
            assert!(dynamics.pressure);
            assert_eq!(dynamics.pressure_min, 0.0);
            assert_eq!(dynamics.pressure_curve, curve.to_vec());
        }
        let off = Dynamics::parse(&effector(44, 0, 100, &[])).unwrap();
        assert!(!off.pressure);
        let straight = Dynamics::parse(&effector(44, 0x10, 20, &[[0.0, 0.0], [1.0, 1.0]])).unwrap();
        assert!(straight.pressure_curve.is_empty());
        assert_eq!(straight.pressure_min, 0.2);
        assert!(Dynamics::parse(&[0, 0, 0, 8]).is_none());
    }

    #[test]
    fn reads_tilt_speed_and_random() {
        // Laid out like CSP's own: pressure, tilt and speed graphs in a row.
        let graphs: [&[[f64; 2]]; 3] = [
            &[[0.0, 0.0], [0.5, 0.75], [1.0, 1.0]],
            &[[0.0, 1.0], [0.5, 1.0], [0.8, 0.0], [1.0, 0.0]],
            &[[0.0, 1.0], [0.005, 0.0], [1.0, 0.0]],
        ];
        let lengths: Vec<u32> = graphs.iter().map(|g| 12 + 16 * g.len() as u32).collect();
        let words = [
            48, 240, 0xf0, 30, 100, 10, 5, 0, lengths[0], lengths[1], 100, lengths[2],
        ];
        let mut blob: Vec<u8> = words.iter().flat_map(|w: &u32| w.to_be_bytes()).collect();
        for graph in graphs {
            for w in [12u32, graph.len() as u32, 16] {
                blob.extend(w.to_be_bytes());
            }
            for [x, y] in graph {
                blob.extend(x.to_be_bytes());
                blob.extend(y.to_be_bytes());
            }
        }
        let dynamics = Dynamics::parse(&blob).unwrap();
        assert!(dynamics.pressure && dynamics.tilt && dynamics.velocity && dynamics.random);
        assert_eq!(
            (
                dynamics.pressure_min,
                dynamics.tilt_min,
                dynamics.velocity_min,
                dynamics.random_min
            ),
            (0.3, 1.0, 0.1, 0.05)
        );
        assert_eq!(dynamics.pressure_curve, graphs[0].to_vec());
        assert_eq!(dynamics.tilt_curve, graphs[1].to_vec());
        assert_eq!(dynamics.velocity_curve, graphs[2].to_vec());
        // A 40-byte header has no speed graph.
        let short = Dynamics::parse(&effector(40, 0x10, 40, &[[0.0, 0.0], [0.3, 0.6], [1.0, 1.0]])).unwrap();
        assert_eq!(short.pressure_min, 0.4);
        assert_eq!(short.velocity_curve, [[0.0, 1.0], [1.0, 0.0]]);
    }

    /// A `BrushPatternImageArray` with one material, as CSP writes it.
    fn material_list(path: &str, install_path: Option<&str>) -> Vec<u8> {
        let material = csp_assets::subtool::blob::MaterialRef {
            path: path.to_owned(),
            kind: Some(2),
            name: Some(String::new()),
            flag: Some(1),
            install_path: install_path.map(str::to_owned),
            rest: Vec::new(),
        };
        MaterialList {
            materials: vec![material],
        }
        .to_bytes()
    }

    #[test]
    fn finds_tip_material_paths() {
        let path = ".:91:20:e6ae21f672-c949-8fb8-0f2b-4fd949ca57:data:material_0.layer";
        let blob = material_list(
            &format!("{path}\0"),
            Some(".:91:20:e6ae21f672-c949-8fb8-0f2b-4fd949ca57"),
        );
        assert_eq!(pattern_paths(&blob), vec![path.to_owned()]);
        assert_eq!(
            material_folders(path),
            vec![
                ["91", "20", "e6ae21f672-c949-8fb8-0f2b-4fd949ca57"]
                    .iter()
                    .collect::<PathBuf>()
            ]
        );
        assert_eq!(
            material_folders(".:Paint106:eca6:data:material_0.layer"),
            vec![
                PathBuf::from("Install/Paint106/eca6"),
                PathBuf::from("Install2/Paint106/eca6")
            ]
        );
        assert!(material_folders(".:..:x:data:a.layer").is_empty());
    }

    pub(crate) fn tar(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in files {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            let size = format!("{:011o}\0", data.len());
            header[124..136].copy_from_slice(size.as_bytes());
            header[257..263].copy_from_slice(b"ustar\0");
            out.extend(header);
            out.extend(*data);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.extend([0u8; 1024]);
        out
    }

    fn tip_png() -> Vec<u8> {
        // A black dot on white, 8 x 8 with a 4 x 2 mark.
        let mut image = RgbaImage::new(8, 8);
        for (index, pixel) in image.pixels.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let (x, y) = (index % 8, index / 8);
            let ink = (2..6).contains(&x) && (3..5).contains(&y);
            pixel.copy_from_slice(if ink { &[0, 0, 0, 255] } else { &[255, 255, 255, 255] });
        }
        image.to_png().unwrap()
    }

    #[test]
    fn tip_mask_keeps_the_mark_only() {
        let mask = tip_mask(&tip_png()).unwrap();
        assert_eq!((mask.width, mask.height), (4, 2));
        assert!(mask.png_base64.starts_with("iVBORw0KGgo"));
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    /// A .sut like the ones CSP writes: one node, its variant, one material.
    fn sut(name: &str, input: i64, composite: i64, vector_eraser: Option<i64>) -> Vec<u8> {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE Manager(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, ToolType INTEGER, Version INTEGER, RootUuid BLOB);
                 CREATE TABLE Node(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, NodeUuid BLOB, NodeName TEXT, NodeInputOp INTEGER, NodeOutputOp INTEGER, NodeFirstChildUuid BLOB, NodeNextUuid BLOB, NodeVariantID INTEGER);
                 CREATE TABLE Variant(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, VariantID INTEGER, Opacity INTEGER, CompositeMode INTEGER, FlickerReduction INTEGER, BrushSize REAL, BrushSizeUnit INTEGER, BrushSizeEffector BLOB, BrushHardness INTEGER, BrushUsePatternImage INTEGER, BrushPatternImageArray BLOB, BrushUseIn INTEGER, BrushInLength REAL, BrushInLengthUnit INTEGER, BrushUseOut INTEGER, BrushOutLength REAL, BrushOutLengthUnit INTEGER, BrushUseVectorEraser INTEGER, BrushVectorEraserType INTEGER, FlickerReductionBySpeed INTEGER, BrushUseRevision INTEGER, BrushRevision INTEGER);
                 CREATE TABLE MaterialFile(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, InstallFolder INTEGER, OriginalPath TEXT, OldMaterial INTEGER, FileData BLOB, CatalogPath TEXT, MaterialUuid TEXT);",
            )
            .unwrap();
        let uuid = [7u8; 16];
        connection
            .execute(
                "INSERT INTO Manager(ToolType, Version, RootUuid) VALUES (0, 145, ?1)",
                [&uuid[..]],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO Node(NodeUuid, NodeName, NodeInputOp, NodeOutputOp, NodeFirstChildUuid, NodeNextUuid, NodeVariantID) VALUES (?1, ?2, ?3, ?3, X'00', X'00', 87)",
                rusqlite::params![&uuid[..], name, input],
            )
            .unwrap();
        let path = ".:91:20:abc:data:material_0.layer";
        let pattern = material_list(path, None);
        connection
            .execute(
                "INSERT INTO Variant VALUES (NULL, 87, 80, ?1, 6, 5.0, 0, ?2, 100, 1, ?3, 1, 20.0, 0, 1, 1.5, 2, ?4, ?5, 1, 1, 30)",
                rusqlite::params![
                    composite,
                    effector(48, 0x10, 10, &[[0.0, 0.0], [0.6, 0.1], [1.0, 1.0]]),
                    pattern,
                    vector_eraser.is_some() as i64,
                    vector_eraser.unwrap_or(0)
                ],
            )
            .unwrap();
        connection
            .execute("INSERT INTO Variant(VariantID) VALUES (88)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO MaterialFile(InstallFolder, OriginalPath, FileData) VALUES (0, ?1, ?2)",
                rusqlite::params![path, tar(&[("thumbnail/thumbnail.png", &tip_png())])],
            )
            .unwrap();
        connection.serialize(rusqlite::MAIN_DB).unwrap().to_vec()
    }

    #[test]
    fn reads_a_pen_from_a_sut() {
        let tools = read_sub_tools_from_bytes(&sut("丸ペン", 11, 0, None), None).unwrap();
        assert_eq!(tools.len(), 1);
        let pen = &tools[0];
        assert_eq!(pen.name, "丸ペン");
        assert_eq!(pen.kind, SubToolKind::Pen);
        assert_eq!(
            pen.size,
            Some(Length {
                value: 5.0,
                unit: LengthUnit::Px
            })
        );
        assert!((pen.size.unwrap().to_mm(600.0) - 5.0 * 25.4 / 600.0).abs() < 1e-9);
        let size = pen.size_dynamics.as_ref().unwrap();
        assert!(size.pressure);
        assert_eq!(size.pressure_min, 0.1);
        assert_eq!(size.pressure_curve.len(), 3);
        assert_eq!(pen.opacity, 0.8);
        assert_eq!(pen.stabilization, 6.0);
        assert!(pen.stabilization_by_speed);
        assert_eq!(pen.post_correction, 30.0);
        assert_eq!(
            pen.taper_in,
            Some(Length {
                value: 20.0,
                unit: LengthUnit::Px
            })
        );
        assert_eq!(
            pen.taper_out,
            Some(Length {
                value: 1.5,
                unit: LengthUnit::Mm
            })
        );
        assert_eq!(pen.tip_material.as_deref(), Some(".:91:20:abc:data:material_0.layer"));
        assert_eq!(pen.tip.as_ref().map(|tip| (tip.width, tip.height)), Some((4, 2)));
        assert_eq!(pen.vector_erase, None);
    }

    #[test]
    fn reads_erasers() {
        let eraser = &read_sub_tools_from_bytes(&sut("硬め", 12, COMPOSITE_ERASE, Some(1)), None).unwrap()[0];
        assert_eq!(eraser.kind, SubToolKind::Eraser);
        assert_eq!(eraser.vector_erase, Some(VectorErase::Intersection));
        let soft = &read_sub_tools_from_bytes(&sut("軟らかめ", 10, COMPOSITE_ERASE, None), None).unwrap()[0];
        assert_eq!(soft.kind, SubToolKind::Eraser);
        assert_eq!(soft.vector_erase, Some(VectorErase::Touched));
    }

    #[test]
    fn skips_tools_that_do_not_draw() {
        assert!(
            read_sub_tools_from_bytes(&sut("塗りつぶし", 50, 0, None), None)
                .unwrap()
                .is_empty()
        );
        assert!(read_sub_tools_from_bytes(b"not sqlite", None).is_err());
    }

    #[test]
    fn base64_decodes_what_it_encodes() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foobar", &[0, 255, 128, 7, 9]] {
            assert_eq!(unbase64(&base64(data)).as_deref(), Some(data));
        }
        assert_eq!(unbase64("Zg").as_deref(), Some(&b"f"[..]));
        assert!(unbase64("Z").is_none());
        assert!(unbase64("Zm9v!").is_none());
    }

    #[test]
    fn keeps_every_setting_and_writes_it_back() {
        let tool = read_sub_tools_from_bytes(&sut("丸ペン", 11, 0, None), None)
            .unwrap()
            .remove(0);
        let csp = &tool.csp;
        assert_eq!(csp.settings.get("Opacity"), Some(&CspValue::Number(80.0)));
        assert_eq!(csp.settings.get("BrushSize"), Some(&CspValue::Number(5.0)));
        assert!(matches!(
            csp.settings.get("BrushSizeEffector"),
            Some(CspValue::Blob { .. })
        ));
        assert!(!csp.settings.contains_key("VariantID"));
        assert_eq!(csp.node.get("NodeInputOp"), Some(&CspValue::Number(11.0)));
        assert!(!csp.node.contains_key("NodeUuid"));
        assert_eq!(csp.manager.get("Version"), Some(&CspValue::Number(145.0)));
        assert_eq!(csp.materials.len(), 1);

        // Edited (a whole number where CSP keeps a real), then written back.
        let mut edited = csp.clone();
        edited.settings.insert("BrushSize".into(), CspValue::Number(12.0));
        edited.settings.insert("Opacity".into(), CspValue::Number(55.0));
        let file = sub_tool_file(&edited, "太い丸ペン", None).unwrap();
        assert!(file.missing_materials.is_empty());
        let db = SubToolDb::from_bytes(&file.bytes).unwrap();
        let entry = &db.sub_tools()[0];
        let node = &db.nodes[entry.node];
        assert_eq!(node.name, "太い丸ペン");
        assert_eq!((node.input_op, node.output_op), (11, 11));
        let settings = db.variant(node.variant_id).unwrap();
        assert_eq!(settings.get("BrushSize"), Some(&Value::Real(12.0)));
        assert_eq!(settings.int("Opacity"), 55);
        assert_eq!(db.variant(node.init_variant_id).unwrap().int("Opacity"), 55);
        assert!(settings.blob("VariantShowParam").is_some());
        assert_eq!(db.materials.len(), 1);
        // Read again, it is the same tool.
        let again = read_sub_tools_from_bytes(&file.bytes, None).unwrap().remove(0);
        assert_eq!(again.name, "太い丸ペン");
        assert_eq!(again.opacity, 0.55);
        assert_eq!(again.tip, tool.tip);
        let mut settings = again.csp.settings.clone();
        settings.remove("VariantShowParam");
        settings.remove("VariantShowSeparator");
        assert_eq!(settings, edited.settings);
    }

    #[test]
    fn names_materials_it_cannot_pack() {
        let mut csp = read_sub_tools_from_bytes(&sut("丸ペン", 11, 0, None), None)
            .unwrap()
            .remove(0)
            .csp;
        csp.materials.clear();
        let file = sub_tool_file(&csp, "素材なし", None).unwrap();
        assert_eq!(file.missing_materials, [".:91:20:abc:data:material_0.layer"]);
        csp.node.remove("NodeInputOp");
        assert!(sub_tool_file(&csp, "種類なし", None).is_err());
    }

    /// Real files from CSP, when CSP_SUBTOOL_SAMPLES names a folder of them
    /// (.sut and EditImageTool.todb). Artwork-free, but not in the repository.
    #[test]
    fn reads_real_sub_tools_when_available() {
        let Some(folder) = std::env::var_os("CSP_SUBTOOL_SAMPLES") else {
            return;
        };
        for entry in std::fs::read_dir(folder).unwrap().flatten() {
            let path = entry.path();
            let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !matches!(extension, "sut" | "todb") {
                continue;
            }
            let tools = read_sub_tools(&path, None).unwrap();
            assert!(!tools.is_empty(), "{}", path.display());
            // A few (ドットペン) leave the size to the tool above them.
            let sized = tools.iter().filter(|tool| tool.size.is_some()).count();
            assert!(sized * 10 >= tools.len() * 9, "{}", path.display());
            // Each written back as a .sut reads as the same settings.
            for tool in &tools {
                let file = sub_tool_file(&tool.csp, &tool.name, None).unwrap();
                let again = read_sub_tools_from_bytes(&file.bytes, None).unwrap();
                assert_eq!(again.len(), 1, "{}", tool.name);
                let again = &again[0];
                let mut settings = again.csp.settings.clone();
                for column in ["VariantShowParam", "VariantShowSeparator"] {
                    if !tool.csp.settings.contains_key(column) {
                        settings.remove(column);
                    }
                }
                assert_eq!(settings, tool.csp.settings, "{}", tool.name);
                assert_eq!(again.size, tool.size, "{}", tool.name);
            }
        }
    }
}
