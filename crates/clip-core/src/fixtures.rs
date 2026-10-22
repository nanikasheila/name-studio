//! Tiny synthetic .clip files for tests (feature `fixtures`).
//!
//! Real CSP files contain artwork and stay out of the repository. These
//! builders reproduce the structure observed in real files with only the
//! tables and columns the readers use, like `tests/csp_fixtures.py` in the
//! Python reference.

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::ZlibEncoder;
use rusqlite::{Connection, params};

use crate::text::build_tlv;

pub const CLOSED: u32 = 0x1111;
pub const OPEN: u32 = 0x11;
pub const LAYER_RASTER: i64 = 1;
pub const LAYER_PAPER: i64 = 1584;

/// `(flags, points)` of one vector object.
pub type FixtureVector = (u32, Vec<(f64, f64)>);

/// `(block index, filled box inside the block)` of one raster block, painted red.
pub type FixtureBlock = (u32, (usize, usize, usize, usize));

pub fn rectangle(x0: f64, y0: f64, x1: f64, y1: f64) -> FixtureVector {
    (CLOSED, vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
}

#[derive(Debug, Clone)]
pub struct FixtureLayer {
    pub main_id: i64,
    pub name: String,
    pub layer_type: i64,
    pub folder: bool,
    pub frame_folder: bool,
    pub visible: bool,
    pub opacity: i64,
    pub offset: (i64, i64),
    pub text: Option<String>,
    pub vectors: Vec<FixtureVector>,
    pub text_attributes: Option<Vec<u8>>,
    pub text_attribute_array: Vec<Vec<u8>>,
    /// Raster blocks: (block index, filled box inside the block) painted red.
    pub raster_blocks: Vec<FixtureBlock>,
    pub children: Vec<FixtureLayer>,
}

impl FixtureLayer {
    pub fn new(main_id: i64, name: &str) -> Self {
        FixtureLayer {
            main_id,
            name: name.to_owned(),
            layer_type: 0,
            folder: false,
            frame_folder: false,
            visible: true,
            opacity: 256,
            offset: (0, 0),
            text: None,
            vectors: Vec::new(),
            text_attributes: None,
            text_attribute_array: Vec::new(),
            raster_blocks: Vec::new(),
            children: Vec::new(),
        }
    }

    pub fn paper(main_id: i64) -> Self {
        FixtureLayer {
            layer_type: LAYER_PAPER,
            ..Self::new(main_id, "用紙")
        }
    }

    pub fn vector(main_id: i64, name: &str, vectors: Vec<FixtureVector>) -> Self {
        FixtureLayer {
            vectors,
            ..Self::new(main_id, name)
        }
    }

    pub fn text(main_id: i64, text: &str, bbox: [i32; 4], font_size_pt: f64) -> Self {
        FixtureLayer {
            text: Some(text.to_owned()),
            text_attributes: Some(text_attributes(bbox, font_size_pt, "Font")),
            ..Self::new(main_id, text)
        }
    }

    pub fn raster(main_id: i64, name: &str, blocks: Vec<FixtureBlock>) -> Self {
        FixtureLayer {
            layer_type: LAYER_RASTER,
            raster_blocks: blocks,
            ..Self::new(main_id, name)
        }
    }

    pub fn folder(main_id: i64, name: &str, children: Vec<FixtureLayer>) -> Self {
        FixtureLayer {
            folder: true,
            children,
            ..Self::new(main_id, name)
        }
    }
}

/// Canvas of a fixture; sizes in mm at `resolution` dpi.
#[derive(Debug, Clone, Copy)]
pub struct FixtureCanvas {
    pub width_mm: f64,
    pub height_mm: f64,
    pub resolution: f64,
    pub double_page: bool,
}

impl FixtureCanvas {
    pub fn width_px(&self) -> u32 {
        (self.width_mm * self.resolution / 25.4).round() as u32
    }

    pub fn height_px(&self) -> u32 {
        (self.height_mm * self.resolution / 25.4).round() as u32
    }
}

pub fn vector_payload(objects: &[FixtureVector]) -> Vec<u8> {
    let mut body = Vec::new();
    for (flags, points) in objects {
        let xs = points.iter().map(|p| p.0 as i32);
        let ys = points.iter().map(|p| p.1 as i32);
        let bbox = [
            xs.clone().min().unwrap_or(0) - 2,
            ys.clone().min().unwrap_or(0) - 2,
            xs.max().unwrap_or(0) + 2,
            ys.max().unwrap_or(0) + 2,
        ];
        let mut header = Vec::new();
        for value in [92, 76, 88, 88, points.len() as u32, *flags] {
            header.extend(value.to_be_bytes());
        }
        for value in bbox {
            header.extend(value.to_be_bytes());
        }
        header.resize(92 - 12, 0);
        header.extend(4.0f64.to_be_bytes());
        header.extend(0u32.to_be_bytes());
        body.extend(header);
        for (x, y) in points {
            let mut point = Vec::new();
            point.extend(x.to_be_bytes());
            point.extend(y.to_be_bytes());
            for value in [*x as i32 - 2, *y as i32 - 2, *x as i32 + 2, *y as i32 + 2] {
                point.extend(value.to_be_bytes());
            }
            point.resize(88, 0);
            body.extend(point);
        }
    }
    let mut payload = Vec::new();
    payload.extend(0u32.to_be_bytes());
    payload.extend((body.len() as u32).to_be_bytes());
    payload.extend(body);
    payload
}

pub fn text_attributes(bbox: [i32; 4], font_size_pt: f64, font: &str) -> Vec<u8> {
    let mut name = Vec::new();
    name.extend(1u16.to_le_bytes());
    name.extend((font.len() as u16).to_le_bytes());
    name.extend(font.as_bytes());
    name.extend(0u16.to_le_bytes());
    build_tlv(&[
        (0x0b, vec![1, 2]),
        (0x20, ((font_size_pt * 100.0).round() as i32).to_le_bytes().to_vec()),
        (0x2a, bbox.iter().flat_map(|v| v.to_le_bytes()).collect()),
        (0x39, name),
        (
            0x3f,
            [bbox[2] - bbox[0], bbox[3] - bbox[1]]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
        ),
    ])
}

pub fn attribute_array(blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut array = Vec::new();
    for block in blocks {
        array.extend((block.len() as u32).to_le_bytes());
        array.extend(block);
    }
    array
}

fn utf16(name: &str) -> Vec<u8> {
    let mut data = (name.encode_utf16().count() as u32).to_be_bytes().to_vec();
    for unit in name.encode_utf16() {
        data.extend(unit.to_be_bytes());
    }
    data
}

pub fn offscreen_attribute(width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0; 16];
    data.extend(utf16("Parameter"));
    for value in [width, height, width.div_ceil(256), height.div_ceil(256), 1, 1, 4, 5] {
        data.extend(value.to_be_bytes());
    }
    data
}

/// External payload holding colour blocks painted red inside their boxes.
pub fn block_payload(blocks: &[FixtureBlock]) -> Vec<u8> {
    let mut payload = vec![0; 8];
    for (index, filled) in blocks {
        let mut raw = vec![0u8; 256 * 256 * 5];
        for y in filled.1..filled.3 {
            for x in filled.0..filled.2 {
                raw[y * 256 + x] = 255;
                raw[65536 + (y * 256 + x) * 4 + 2] = 200;
            }
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw).expect("in-memory write");
        let compressed = encoder.finish().expect("in-memory write");
        let mut record = utf16("BlockDataBeginChunk");
        for value in [*index, raw.len() as u32, 256, 256, 1, compressed.len() as u32 + 4] {
            record.extend(value.to_be_bytes());
        }
        record.extend((compressed.len() as u32).to_le_bytes());
        record.extend(&compressed);
        payload.extend((record.len() as u32 + 4).to_be_bytes());
        payload.extend(record);
    }
    payload
}

/// Wrap a database and external chunks in a CSF container.
pub fn container(database: &Connection, externals: &[(String, Vec<u8>)]) -> Vec<u8> {
    let image = database.serialize("main").expect("serialize").to_vec();
    let mut chunks = Vec::new();
    let mut chunk = |tag: &[u8; 8], body: &[u8]| {
        chunks.extend(tag);
        chunks.extend((body.len() as u64).to_be_bytes());
        chunks.extend(body);
    };
    chunk(b"CHNKHead", &[0; 40]);
    for (id, payload) in externals {
        let mut body = 40u64.to_be_bytes().to_vec();
        body.extend(id.as_bytes());
        body.extend(payload);
        chunk(b"CHNKExta", &body);
    }
    chunk(b"CHNKSQLi", &image);
    chunk(b"CHNKFoot", &[]);
    let mut file = b"CSFCHUNK".to_vec();
    file.extend(((24 + chunks.len()) as u64).to_be_bytes());
    file.extend(24u64.to_be_bytes());
    file.extend(chunks);
    file
}

fn external_id(number: usize) -> String {
    format!("extrnlid{number:032}")
}

fn flatten<'a>(layers: &'a [FixtureLayer], result: &mut Vec<&'a FixtureLayer>) {
    for layer in layers {
        result.push(layer);
        flatten(&layer.children, result);
    }
}

/// Write a .clip whose root folder (MainId 1) contains `layers`.
pub fn build_clip(path: &Path, canvas: FixtureCanvas, layers: Vec<FixtureLayer>) -> PathBuf {
    build(path, canvas, layers, false)
}

/// Like [`build_clip`], plus what the writers need from a CSP file: the
/// schema tables (ParamScheme, ElemScheme, ExternalTableAndColumnName),
/// layer thumbnails, mipmap chains, page position and story columns, and a
/// real (white) preview at a quarter of the canvas size.
pub fn build_editable_clip(path: &Path, canvas: FixtureCanvas, layers: Vec<FixtureLayer>) -> PathBuf {
    build(path, canvas, layers, true)
}

/// (table, column, link table, owner type) as CSP lists them in ParamScheme.
const EDITING_SCHEME: [(&str, &str, &str, i64); 10] = [
    ("Layer", "LayerRenderMipmap", "Mipmap", 0),
    ("Layer", "LayerRenderThumbnail", "LayerThumbnail", 0),
    ("Layer", "VectorNormalStrokeIndex", "VectorObjectList", 0),
    ("Mipmap", "BaseMipmapInfo", "MipmapInfo", 0),
    ("Mipmap", "LayerId", "", 4),
    ("MipmapInfo", "Offscreen", "Offscreen", 0),
    ("MipmapInfo", "LayerId", "", 4),
    ("Offscreen", "LayerId", "", 4),
    ("LayerThumbnail", "LayerId", "", 4),
    ("VectorObjectList", "LayerId", "", 4),
];

fn add_editing_schema(database: &Connection, canvas: FixtureCanvas) {
    database
        .execute_batch(
            "ALTER TABLE Canvas ADD COLUMN ComicPageIndex;
             ALTER TABLE Canvas ADD COLUMN ComicIsLeftPage;
             ALTER TABLE Canvas ADD COLUMN ComicStoryStoryName;
             ALTER TABLE Canvas ADD COLUMN ComicStoryStoryIndex;
             UPDATE Canvas SET ComicPageIndex = 0, ComicIsLeftPage = 1, ComicStoryStoryName = 'Template',
                 ComicStoryStoryIndex = 3;
             ALTER TABLE Layer ADD COLUMN LayerRenderThumbnail;
             ALTER TABLE Layer ADD COLUMN LayerUuid;
             UPDATE Layer SET LayerUuid = 'fixture-layer-' || MainId;
             ALTER TABLE Layer ADD COLUMN VectorNormalStrokeIndex;
             ALTER TABLE Layer ADD COLUMN ComicStoryInfoType;
             UPDATE Layer SET ComicStoryInfoType = 1 WHERE LayerType = 800;
             UPDATE Layer SET VectorNormalStrokeIndex =
                 (SELECT MainId FROM VectorObjectList v WHERE v.LayerId = Layer.MainId);
             ALTER TABLE Mipmap ADD COLUMN LayerId;
             ALTER TABLE MipmapInfo ADD COLUMN LayerId;
             ALTER TABLE MipmapInfo ADD COLUMN NextIndex;
             ALTER TABLE Offscreen ADD COLUMN LayerId;
             CREATE TABLE LayerThumbnail(MainId, LayerId);
             CREATE TABLE ParamScheme(TableName, LabelName, LinkTable, OwnerType);
             CREATE TABLE ElemScheme(TableName, ElemType, MaxIndex);
             CREATE TABLE ExternalTableAndColumnName(TableName, ColumnName);
             INSERT INTO ExternalTableAndColumnName VALUES('Offscreen', 'BlockData'), ('VectorObjectList', 'VectorData');
             UPDATE MipmapInfo SET NextIndex = 0;",
        )
        .expect("editing schema");
    for (table, label, link, owner) in EDITING_SCHEME {
        database
            .execute(
                "INSERT INTO ParamScheme VALUES(?1, ?2, ?3, ?4)",
                params![table, label, link, owner],
            )
            .expect("scheme");
    }
    let layers: Vec<(i64, i64)> = {
        let mut statement = database
            .prepare("SELECT MainId, LayerRenderMipmap FROM Layer")
            .expect("layers");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("layers")
            .map(Result::unwrap)
            .collect()
    };
    for (layer_id, mipmap) in layers.into_iter().filter(|(_, mipmap)| *mipmap != 0) {
        database
            .execute("INSERT INTO LayerThumbnail VALUES(?1, ?2)", [mipmap, layer_id])
            .expect("thumbnail");
        database
            .execute(
                "UPDATE Layer SET LayerRenderThumbnail = ?1 WHERE MainId = ?2",
                [mipmap, layer_id],
            )
            .expect("thumbnail");
        for table in ["Mipmap", "MipmapInfo", "Offscreen"] {
            database
                .execute(
                    &format!("UPDATE {table} SET LayerId = ?1 WHERE MainId = ?2"),
                    [layer_id, mipmap],
                )
                .expect("owner");
        }
    }
    for table in [
        "Layer",
        "Mipmap",
        "MipmapInfo",
        "Offscreen",
        "LayerThumbnail",
        "VectorObjectList",
    ] {
        database
            .execute(
                &format!("INSERT INTO ElemScheme VALUES(?1, 0, (SELECT COALESCE(MAX(MainId), 0) FROM {table}))"),
                [table],
            )
            .expect("elem scheme");
    }
    let preview = crate::RgbaImage {
        width: canvas.width_px().div_ceil(4),
        height: canvas.height_px().div_ceil(4),
        pixels: vec![255; canvas.width_px().div_ceil(4) as usize * canvas.height_px().div_ceil(4) as usize * 4],
    };
    database
        .execute(
            "UPDATE CanvasPreview SET ImageData = ?1",
            [preview.to_png().expect("preview")],
        )
        .expect("preview");
}

fn build(path: &Path, canvas: FixtureCanvas, layers: Vec<FixtureLayer>, editable: bool) -> PathBuf {
    let database = Connection::open_in_memory().expect("in-memory database");
    database
        .execute_batch(
            "CREATE TABLE Canvas(MainId, CanvasUnit, CanvasWidth, CanvasHeight, CanvasResolution, CanvasRootFolder,
                 CanvasDoublePage);
             CREATE TABLE Layer(MainId, LayerName, LayerType, LayerFolder, LayerVisibility, LayerOpacity,
                 LayerComposite, LayerOffsetX, LayerOffsetY, LayerClip, LayerLock, LayerNextIndex,
                 LayerFirstChildIndex, LayerRenderMipmap, LayerLayerMaskMipmap, TextLayerString,
                 ComicFrameLineMipmap, TextLayerAttributes, TextLayerAttributesArray,
                 LayerRenderOffscrOffsetX, LayerRenderOffscrOffsetY);
             CREATE TABLE Mipmap(MainId, BaseMipmapInfo);
             CREATE TABLE MipmapInfo(MainId, Offscreen);
             CREATE TABLE Offscreen(MainId, Attribute, BlockData);
             CREATE TABLE VectorObjectList(MainId, LayerId, VectorData);
             CREATE TABLE CanvasPreview(MainId, ImageData);
             CREATE TABLE ExternalChunk(ExternalID, Offset);",
        )
        .expect("schema");
    database
        .execute(
            "INSERT INTO Canvas VALUES(1, 2, ?1, ?2, ?3, 1, ?4)",
            params![
                canvas.width_mm,
                canvas.height_mm,
                canvas.resolution,
                canvas.double_page as i64
            ],
        )
        .expect("canvas");
    let root = FixtureLayer {
        layer_type: 256,
        ..FixtureLayer::folder(1, "", layers)
    };
    let mut all = Vec::new();
    flatten(std::slice::from_ref(&root), &mut all);
    let mut externals = Vec::new();
    for layer in &all {
        let next = sibling_after(&root, layer.main_id).unwrap_or(0);
        let first_child = layer.children.first().map_or(0, |child| child.main_id);
        let mut mipmap = 0;
        if !layer.raster_blocks.is_empty() {
            mipmap = layer.main_id;
            let id = external_id(externals.len() + 1);
            database
                .execute("INSERT INTO Mipmap VALUES(?1, ?1)", [mipmap])
                .and_then(|_| database.execute("INSERT INTO MipmapInfo VALUES(?1, ?1)", [mipmap]))
                .and_then(|_| {
                    database.execute(
                        "INSERT INTO Offscreen VALUES(?1, ?2, ?3)",
                        params![
                            mipmap,
                            offscreen_attribute(canvas.width_px(), canvas.height_px()),
                            id.as_bytes()
                        ],
                    )
                })
                .expect("offscreen");
            externals.push((id, block_payload(&layer.raster_blocks)));
        }
        if !layer.vectors.is_empty() {
            let id = external_id(externals.len() + 1);
            database
                .execute(
                    "INSERT INTO VectorObjectList VALUES(?1, ?1, ?2)",
                    params![layer.main_id, id.as_bytes()],
                )
                .expect("vectors");
            externals.push((id, vector_payload(&layer.vectors)));
        }
        let array = (!layer.text_attribute_array.is_empty()).then(|| attribute_array(&layer.text_attribute_array));
        database
            .execute(
                "INSERT INTO Layer VALUES(?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, 0, 0, ?9, ?10, ?11, 0, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    layer.main_id,
                    layer.name,
                    layer.layer_type,
                    layer.folder as i64,
                    layer.visible as i64,
                    layer.opacity,
                    layer.offset.0,
                    layer.offset.1,
                    next,
                    first_child,
                    mipmap,
                    // CSP stores the text as a UTF-8 blob.
                    layer.text.as_ref().map(|text| text.as_bytes().to_vec()),
                    layer.frame_folder.then_some(1),
                    layer.text_attributes,
                    array,
                    -layer.offset.0,
                    -layer.offset.1,
                ],
            )
            .expect("layer");
    }
    database
        .execute("INSERT INTO CanvasPreview VALUES(1, x'89504e47')", [])
        .expect("preview");
    if editable {
        add_editing_schema(&database, canvas);
    }
    std::fs::write(path, container(&database, &externals)).expect("write fixture");
    path.to_path_buf()
}

fn sibling_after(parent: &FixtureLayer, main_id: i64) -> Option<i64> {
    for (index, child) in parent.children.iter().enumerate() {
        if child.main_id == main_id {
            return parent.children.get(index + 1).map(|next| next.main_id);
        }
        if let Some(found) = sibling_after(child, main_id) {
            return Some(found);
        }
    }
    None
}

/// Write a minimal .cmc whose pages link to `page_files` in order.
pub fn build_cmc(path: &Path, page_files: &[&str]) -> PathBuf {
    let database = Connection::open(path).expect("cmc");
    database
        .execute_batch(
            "CREATE TABLE Project(ProjectInternalVersion, ProjectRootCanvasNode, ComicStoryStoryName,
                 ComicStoryAuthorName, ComicBindPosition, ComicStartPage, ComicCoverExist, MaxCanvasFileIndex,
                 DefaultPageUnit, DefaultPageWidth, DefaultPageHeight, DefaultPageResolution,
                 DefaultPageDoublePage, DefaultPageTemplateName, ComicStoryStoryIndex DEFAULT 3);
             CREATE TABLE CanvasNode(MainId, Type, NextIndex, FirstChildIndex, PageFlag, Memo, LinkPath);",
        )
        .expect("cmc schema");
    database
        .execute(
            "INSERT INTO Project VALUES('1.1.0', 1, 'Story', 'Author', 1, 1, 0, ?1, 2, 182.0, 257.0, 600.0, 0, '', 3)",
            [page_files.len() as i64],
        )
        .expect("project");
    database
        .execute("INSERT INTO CanvasNode VALUES(1, 0, 0, 2, 0, '', NULL)", [])
        .expect("root");
    for (index, file) in page_files.iter().enumerate() {
        let id = index as i64 + 2;
        let next = if index + 1 < page_files.len() { id + 1 } else { 0 };
        database
            .execute(
                "INSERT INTO CanvasNode VALUES(?1, 2, ?2, 0, 0, '', ?3)",
                params![id, next, format!(".:{file}")],
            )
            .expect("page node");
    }
    path.to_path_buf()
}
