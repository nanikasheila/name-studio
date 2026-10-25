//! Edit a CSP-made .clip template: add layers, write pixels, save.
//!
//! An empty page saved by CSP (with the work's settings) is the template,
//! and layers are added by copying rows the way CSP links them. Rows are
//! copied with [`RowCopier`], which follows the id links listed in
//! `ParamScheme` (for example Layer → Mipmap → MipmapInfo → Offscreen), gives
//! every copied row a new `MainId` from `ElemScheme` and copies external
//! chunks under new ids. New layers get copies of the render offscreens of
//! the template's own raster layer, so their size always matches the page.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::container::{FILE_ID_LENGTH, assemble_container, head_file_id};
use super::offscreen::{empty_offscreen, encode_offscreen_image};
use super::schema::{
    ColumnInfo, OWNER_CANVAS, OWNER_LAYER, allocate_id, column_infos, column_names, external_columns, table_names,
    text_of,
};
use super::{Values, int_value, set_value, value_of};
use crate::container::CsfContainer;
use crate::error::{CspError, Result};
use crate::offscreen::{OffscreenParameters, RgbaImage};
use crate::raster::{Filter, resize};

const LAYER_TYPE_RASTER: i64 = 1;
/// Columns that would tie a copied layer to data that is not copied (yet).
const DROPPED_LAYER_LINKS: [&str; 13] = [
    "LayerLayerMaskMipmap",
    "LayerLayerMaskThumbnail",
    "ResizableOriginalMipmap",
    "ComicFrameLineMipmap",
    "FirstLayerObject",
    "Manager3D",
    "Manager3DOd",
    "SpecialRulerManager",
    "StreamLineIndex",
    "VoiceSpeakParam",
    "RulerVectorIndex",
    "TimeLineOriginalMipmap",
    "TimeLineOriginalMaskMipmap",
];

/// Rewrites an external payload while it is copied: (table, column, payload).
pub type PayloadHook<'a> = dyn Fn(&str, &str, Vec<u8>) -> Result<Vec<u8>> + 'a;
/// Rewrites a copied Layer row before it is inserted.
pub type RowHook<'a> = dyn FnMut(&mut Values) -> Result<()> + 'a;
/// Reads an external payload of the source file by id.
pub type PayloadSource<'a> = dyn Fn(&str) -> Option<Vec<u8>> + 'a;

pub fn new_external_id() -> String {
    format!("extrnlid{}", uuid::Uuid::new_v4().simple().to_string().to_uppercase())
}

/// A layer uuid in CSP's 10-4-4-4-10 hex form.
pub fn new_layer_uuid() -> String {
    let text = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}-{}-{}-{}-{}",
        &text[..10],
        &text[10..14],
        &text[14..18],
        &text[18..22],
        &text[22..32]
    )
}

/// A whole row as (column, value) pairs in column order, or None.
pub fn select_values(database: &Connection, sql: &str, parameters: &[Value]) -> Result<Option<Values>> {
    let mut statement = database.prepare(sql)?;
    let names: Vec<String> = statement.column_names().into_iter().map(str::to_owned).collect();
    let row = statement
        .query_row(params_from_iter(parameters.iter()), |row| {
            names
                .iter()
                .enumerate()
                .map(|(index, name)| Ok((name.clone(), row.get::<_, Value>(index)?)))
                .collect()
        })
        .optional()?;
    Ok(row)
}

/// Insert `values` into `table`, keeping only the columns the table has.
pub fn insert_row(database: &Connection, table: &str, values: &Values) -> Result<()> {
    let known: HashSet<String> = column_names(database, table)?.into_iter().collect();
    let kept: Vec<&(String, Value)> = values.iter().filter(|(column, _)| known.contains(column)).collect();
    let names: Vec<String> = kept.iter().map(|(column, _)| format!("\"{column}\"")).collect();
    let marks = vec!["?"; kept.len()].join(", ");
    database.execute(
        &format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")),
        params_from_iter(kept.iter().map(|(_, value)| value)),
    )?;
    Ok(())
}

/// External chunks in file order.
#[derive(Debug, Clone, Default)]
pub struct Externals {
    entries: Vec<(String, Vec<u8>)>,
    index: HashMap<String, usize>,
}

impl Externals {
    pub fn get(&self, id: &str) -> Option<&[u8]> {
        self.index.get(id).map(|position| self.entries[*position].1.as_slice())
    }

    pub fn insert(&mut self, id: String, payload: Vec<u8>) {
        match self.index.get(&id) {
            Some(position) => self.entries[*position].1 = payload,
            None => {
                self.index.insert(id.clone(), self.entries.len());
                self.entries.push((id, payload));
            }
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &[u8])> {
        self.entries
            .iter()
            .map(|(id, payload)| (id.as_str(), payload.as_slice()))
    }
}

/// Copies rows (and everything they link to) from one database to another.
pub struct RowCopier<'a> {
    source: &'a Connection,
    source_payload: &'a PayloadSource<'a>,
    payload_hook: Option<&'a PayloadHook<'a>>,
    canvas_id: i64,
    pub owner_layer: i64,
    pub skip: HashSet<(String, String)>,
    done: HashMap<(String, i64), i64>,
    externals: HashSet<(String, String)>,
    infos: HashMap<String, HashMap<String, ColumnInfo>>,
    /// External chunks copied so far, to be added to the target file.
    pub new_externals: Vec<(String, Vec<u8>)>,
}

impl<'a> RowCopier<'a> {
    pub fn new(
        source: &'a Connection,
        source_payload: &'a PayloadSource<'a>,
        payload_hook: Option<&'a PayloadHook<'a>>,
        canvas_id: i64,
    ) -> Result<Self> {
        Ok(RowCopier {
            source,
            source_payload,
            payload_hook,
            canvas_id,
            owner_layer: 0,
            skip: HashSet::new(),
            done: HashMap::new(),
            externals: external_columns(source)?,
            infos: HashMap::new(),
            new_externals: Vec::new(),
        })
    }

    /// Copy row `main_id` of `table` into `target`; return its new id there.
    pub fn copy(&mut self, target: &Connection, table: &str, main_id: i64) -> Result<i64> {
        let key = (table.to_owned(), main_id);
        if let Some(id) = self.done.get(&key) {
            return Ok(*id);
        }
        let row = select_values(
            self.source,
            &format!("SELECT * FROM \"{table}\" WHERE MainId = ?1"),
            &[Value::Integer(main_id)],
        )?
        .ok_or_else(|| CspError::format(format!("{table} {main_id} not found")))?;
        let new_id = allocate_id(target, table)?;
        self.done.insert(key, new_id);
        let values = self.translate(target, table, row, new_id)?;
        insert_row(target, table, &values)?;
        Ok(new_id)
    }

    /// Rewrite ids, owner columns and external ids of one row.
    pub fn translate(&mut self, target: &Connection, table: &str, values: Values, new_id: i64) -> Result<Values> {
        if !self.infos.contains_key(table) {
            self.infos.insert(table.to_owned(), column_infos(self.source, table)?);
        }
        let mut result = Vec::with_capacity(values.len());
        for (column, value) in values {
            if column == "_PW_ID" {
                continue;
            }
            let info = self.infos[table].get(&column).cloned();
            let key = (table.to_owned(), column.clone());
            let value = if column == "MainId" {
                Value::Integer(new_id)
            } else if self.skip.contains(&key) {
                value
            } else if info.as_ref().is_some_and(|info| info.owner_type == OWNER_CANVAS) {
                Value::Integer(self.canvas_id)
            } else if info.as_ref().is_some_and(|info| info.owner_type == OWNER_LAYER) {
                Value::Integer(self.owner_layer)
            } else if let (Some(link), Value::Integer(id)) =
                (info.as_ref().and_then(|info| info.link_table.clone()), &value)
                && *id != 0
            {
                Value::Integer(self.copy(target, &link, *id)?)
            } else if let Value::Blob(id) = &value
                && !id.is_empty()
                && self.externals.contains(&key)
            {
                Value::Blob(
                    self.copy_external(table, &column, &String::from_utf8_lossy(id))?
                        .into_bytes(),
                )
            } else {
                value
            };
            result.push((column, value));
        }
        Ok(result)
    }

    fn copy_external(&mut self, table: &str, column: &str, external_id: &str) -> Result<String> {
        let new_id = new_external_id();
        if let Some(mut payload) = (self.source_payload)(external_id) {
            if let Some(hook) = self.payload_hook {
                payload = hook(table, column, payload)?;
            }
            self.new_externals.push((new_id.clone(), payload));
        }
        Ok(new_id)
    }
}

/// Values after the size and block grid in an offscreen's `Parameter`
/// section, for a layer mask (one 8-bit plane), as CSP writes them.
const MASK_PARAMETERS: [u32; 12] = [1, 1, 0, 1, 0, 0, 0, 1, 256, 0, 256, 256];

/// A colour offscreen's `Attribute` made a mask's: same size, one plane.
fn mask_attribute(attribute: &[u8]) -> Result<Vec<u8>> {
    OffscreenParameters::parse(attribute)?;
    let name: Vec<u8> = "Parameter".encode_utf16().flat_map(u16::to_be_bytes).collect();
    let start = attribute
        .windows(name.len())
        .position(|window| window == name.as_slice())
        .ok_or_else(|| CspError::format("Offscreen attribute has no Parameter section"))?
        + name.len()
        // width, height, blocks across and down
        + 16;
    let end = start + 4 * MASK_PARAMETERS.len();
    if end > attribute.len() {
        return Err(CspError::format("Offscreen Parameter section is too short"));
    }
    let mut result = attribute.to_vec();
    for (index, value) in MASK_PARAMETERS.iter().enumerate() {
        result[start + 4 * index..start + 4 * index + 4].copy_from_slice(&value.to_be_bytes());
    }
    Ok(result)
}

/// A .clip template opened for editing (the template file is not changed).
pub struct ClipEditor {
    pub db: Connection,
    pub file_id: [u8; FILE_ID_LENGTH],
    pub externals: Externals,
    pub canvas_id: i64,
    pub root_id: i64,
}

impl ClipEditor {
    pub fn open(template: impl AsRef<Path>) -> Result<Self> {
        Self::from_container(CsfContainer::read(template)?)
    }

    /// Open a .clip held in memory (such as a page built into the program).
    pub fn from_bytes(data: Vec<u8>) -> Result<Self> {
        Self::from_container(CsfContainer::parse(data)?)
    }

    fn from_container(container: CsfContainer) -> Result<Self> {
        let sqlite = container.sqlite_bytes()?;
        let mut db = Connection::open_in_memory()?;
        db.deserialize_read_exact("main", sqlite, sqlite.len(), false)?;
        let file_id = head_file_id(&container)?;
        let mut externals = Externals::default();
        let mut ids: Vec<(usize, String)> = container
            .chunks
            .iter()
            .filter(|chunk| chunk.tag.as_bytes() == crate::container::CHUNK_EXTERNAL)
            .filter_map(|chunk| {
                let start = chunk.body_offset + 8;
                let id = container
                    .data
                    .get(start..start + crate::container::EXTERNAL_ID_LENGTH)?;
                Some((chunk.header_offset, String::from_utf8_lossy(id).into_owned()))
            })
            .collect();
        ids.sort();
        for (_, id) in ids {
            if let Some(payload) = container.external_payload(&id) {
                externals.insert(id, payload.to_vec());
            }
        }
        let (canvas_id, root_id) = db.query_row("SELECT MainId, CanvasRootFolder FROM Canvas", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(ClipEditor {
            db,
            file_id,
            externals,
            canvas_id,
            root_id,
        })
    }

    /// Give the file and the template's layers new unique ids.
    ///
    /// CSP gives every page file its own file id (CHNKHead) and layer uuids;
    /// pages written from one template would otherwise share them.
    pub fn renew_ids(&mut self) -> Result<()> {
        self.file_id = *uuid::Uuid::new_v4().as_bytes();
        if column_names(&self.db, "Layer")?
            .iter()
            .any(|column| column == "LayerUuid")
        {
            let ids: Vec<i64> = {
                let mut statement = self
                    .db
                    .prepare("SELECT MainId FROM Layer WHERE LayerUuid IS NOT NULL")?;
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<std::result::Result<_, _>>()?
            };
            for id in ids {
                self.db.execute(
                    "UPDATE Layer SET LayerUuid = ?1 WHERE MainId = ?2",
                    (new_layer_uuid(), id),
                )?;
            }
        }
        Ok(())
    }

    pub fn layer_row(&self, layer_id: i64) -> Result<Values> {
        select_values(
            &self.db,
            "SELECT * FROM Layer WHERE MainId = ?1",
            &[Value::Integer(layer_id)],
        )?
        .ok_or_else(|| CspError::format(format!("Layer {layer_id} not found in template")))
    }

    pub fn update_layer(&self, layer_id: i64, values: &[(&str, Value)]) -> Result<()> {
        let known: HashSet<String> = column_names(&self.db, "Layer")?.into_iter().collect();
        for (column, value) in values {
            if known.contains(*column) {
                self.db.execute(
                    &format!("UPDATE Layer SET \"{column}\" = ?1 WHERE MainId = ?2"),
                    (value, layer_id),
                )?;
            }
        }
        Ok(())
    }

    pub fn children(&self, folder_id: i64) -> Result<Vec<i64>> {
        let mut result = Vec::new();
        let mut child = int_value(value_of(&self.layer_row(folder_id)?, "LayerFirstChildIndex"));
        while child != 0 && !result.contains(&child) {
            result.push(child);
            child = int_value(value_of(&self.layer_row(child)?, "LayerNextIndex"));
        }
        Ok(result)
    }

    /// Put `layer_id` at the top of `folder_id` (or right below `below`).
    pub fn append_to_folder(&self, folder_id: i64, layer_id: i64, below: Option<i64>) -> Result<()> {
        let mut siblings = self.children(folder_id)?;
        let position = below
            .and_then(|below| siblings.iter().position(|id| *id == below))
            .unwrap_or(siblings.len());
        siblings.insert(position, layer_id);
        self.update_layer(folder_id, &[("LayerFirstChildIndex", Value::Integer(siblings[0]))])?;
        for (index, sibling) in siblings.iter().enumerate() {
            let following = siblings.get(index + 1).copied().unwrap_or(0);
            self.update_layer(*sibling, &[("LayerNextIndex", Value::Integer(following))])?;
        }
        Ok(())
    }

    /// The template's raster layer, whose offscreens new layers reuse.
    pub fn first_raster_layer(&self) -> Result<i64> {
        self.db
            .query_row(
                "SELECT MainId FROM Layer WHERE LayerType = ?1 ORDER BY MainId LIMIT 1",
                [LAYER_TYPE_RASTER],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CspError::format("Template has no raster layer to copy offscreens from"))
    }

    /// Copy one layer row (without children) from `source`; return the new id.
    ///
    /// The copy gets fresh render offscreens cloned from the template, no
    /// mask, offset (0, 0), and is not yet linked into the tree.
    pub fn add_layer(
        &mut self,
        source: &Connection,
        source_payload: &PayloadSource<'_>,
        layer_id: i64,
        row_hook: Option<&mut RowHook<'_>>,
        payload_hook: Option<&PayloadHook<'_>>,
    ) -> Result<i64> {
        let render_from = self.first_raster_layer()?;
        self.add_layer_rendered_like(source, source_payload, layer_id, row_hook, payload_hook, render_from)
    }

    /// [`Self::add_layer`] with render offscreens cloned from this file's
    /// layer `render_from` instead of its raster layer.
    pub fn add_layer_rendered_like(
        &mut self,
        source: &Connection,
        source_payload: &PayloadSource<'_>,
        layer_id: i64,
        row_hook: Option<&mut RowHook<'_>>,
        payload_hook: Option<&PayloadHook<'_>>,
        render_from: i64,
    ) -> Result<i64> {
        let mut values = select_values(
            source,
            "SELECT * FROM Layer WHERE MainId = ?1",
            &[Value::Integer(layer_id)],
        )?
        .ok_or_else(|| CspError::format(format!("Source layer {layer_id} not found")))?;
        let new_id = allocate_id(&self.db, "Layer")?;
        let (translated, copied) = {
            let mut copier = RowCopier::new(source, source_payload, payload_hook, self.canvas_id)?;
            copier.owner_layer = new_id;
            for column in [
                "LayerRenderMipmap",
                "LayerRenderThumbnail",
                "LayerNextIndex",
                "LayerFirstChildIndex",
            ] {
                copier.skip.insert(("Layer".to_owned(), column.to_owned()));
            }
            for (column, value) in values.iter_mut() {
                if DROPPED_LAYER_LINKS.contains(&column.as_str()) {
                    *value = Value::Integer(0);
                }
            }
            let translated = copier.translate(&self.db, "Layer", values, new_id)?;
            (translated, copier.new_externals)
        };
        for (id, payload) in copied {
            self.externals.insert(id, payload);
        }
        let mut values = translated;
        let (mipmap, thumbnail) = self.clone_render_offscreens(new_id, render_from)?;
        let zero = || Value::Integer(0);
        for (column, value) in [
            ("LayerRenderMipmap", Value::Integer(mipmap)),
            ("LayerRenderThumbnail", Value::Integer(thumbnail)),
            ("LayerNextIndex", zero()),
            ("LayerFirstChildIndex", zero()),
            ("LayerOffsetX", zero()),
            ("LayerOffsetY", zero()),
            ("LayerRenderOffscrOffsetX", zero()),
            ("LayerRenderOffscrOffsetY", zero()),
            ("LayerMaskOffsetX", zero()),
            ("LayerMaskOffsetY", zero()),
            ("LayerMaskOffscrOffsetX", zero()),
            ("LayerMaskOffscrOffsetY", zero()),
            ("LayerSelect", zero()),
            ("LayerUuid", Value::Text(new_layer_uuid())),
        ] {
            set_value(&mut values, column, value);
        }
        if let Some(hook) = row_hook {
            hook(&mut values)?;
        }
        insert_row(&self.db, "Layer", &values)?;
        Ok(new_id)
    }

    fn clone_render_offscreens(&mut self, owner: i64, from: i64) -> Result<(i64, i64)> {
        let template = self.layer_row(from)?;
        let externals = &self.externals;
        let payload = |id: &str| externals.get(id).map(<[u8]>::to_vec);
        let mut copier = RowCopier::new(&self.db, &payload, None, self.canvas_id)?;
        copier.owner_layer = owner;
        let mipmap = copier.copy(&self.db, "Mipmap", int_value(value_of(&template, "LayerRenderMipmap")))?;
        let thumbnail_id = int_value(value_of(&template, "LayerRenderThumbnail"));
        let thumbnail = if thumbnail_id != 0 {
            copier.copy(&self.db, "LayerThumbnail", thumbnail_id)?
        } else {
            0
        };
        let copied = copier.new_externals;
        for (id, payload) in copied {
            self.externals.insert(id, payload);
        }
        Ok((mipmap, thumbnail))
    }

    /// Give a copied frame folder its mask and border images: offscreens the
    /// size of the page with no pixels stored, which CSP draws from the
    /// frames (CSP saves a frame folder's that way). The mask has one plane.
    pub fn add_frame_offscreens(&mut self, folder_id: i64) -> Result<()> {
        let raster = self.first_raster_layer()?;
        let (mask, mask_thumbnail) = self.clone_render_offscreens(folder_id, raster)?;
        let (line, _) = self.clone_render_offscreens(folder_id, raster)?;
        for (mipmap, is_mask) in [(mask, true), (line, false)] {
            for (offscreen_id, attribute, _) in self.mipmap_levels(mipmap)? {
                let attribute = if is_mask {
                    mask_attribute(&attribute)?
                } else {
                    attribute
                };
                self.db.execute(
                    "UPDATE Offscreen SET Attribute = ?1, BlockData = ?2 WHERE MainId = ?3",
                    (attribute, new_external_id().as_bytes(), offscreen_id),
                )?;
            }
        }
        self.update_layer(
            folder_id,
            &[
                ("LayerLayerMaskMipmap", Value::Integer(mask)),
                ("LayerLayerMaskThumbnail", Value::Integer(mask_thumbnail)),
                ("ComicFrameLineMipmap", Value::Integer(line)),
            ],
        )
    }

    /// Empty the layer's stored pixels at every zoom level. A new layer's
    /// render offscreens are copies of a raster layer's, which in a page
    /// drawn on in CSP holds a drawing.
    pub fn clear_layer_image(&mut self, layer_id: i64) -> Result<()> {
        let row = self.layer_row(layer_id)?;
        for (offscreen_id, attribute, external) in self.mipmap_levels(int_value(value_of(&row, "LayerRenderMipmap")))? {
            let external = if external.is_empty() {
                let id = new_external_id();
                self.db.execute(
                    "UPDATE Offscreen SET BlockData = ?1 WHERE MainId = ?2",
                    (id.as_bytes(), offscreen_id),
                )?;
                id
            } else {
                external
            };
            let payload = empty_offscreen(&OffscreenParameters::parse(&attribute)?)?;
            self.externals.insert(external, payload);
        }
        Ok(())
    }

    /// Store `image` placed at `position` (canvas px) as the layer's pixels,
    /// at every zoom level of its mipmap.
    pub fn set_layer_image(&mut self, layer_id: i64, image: &RgbaImage, position: (i64, i64)) -> Result<()> {
        let row = self.layer_row(layer_id)?;
        let get = |column: &str| int_value(value_of(&row, column));
        let origin_x = get("LayerOffsetX") + get("LayerRenderOffscrOffsetX");
        let origin_y = get("LayerOffsetY") + get("LayerRenderOffscrOffsetY");
        let levels = self.mipmap_levels(get("LayerRenderMipmap"))?;
        let base = OffscreenParameters::parse(&levels[0].1)?;
        let mut full = RgbaImage::transparent(base.width, base.height);
        full.paste(image, position.0 - origin_x, position.1 - origin_y);
        for (offscreen_id, attribute, external) in levels {
            let parameters = OffscreenParameters::parse(&attribute)?;
            let level = if (parameters.width, parameters.height) == (full.width, full.height) {
                None
            } else {
                Some(resize(&full, parameters.width, parameters.height, Filter::Box))
            };
            let external = if external.is_empty() {
                let id = new_external_id();
                self.db.execute(
                    "UPDATE Offscreen SET BlockData = ?1 WHERE MainId = ?2",
                    (id.as_bytes(), offscreen_id),
                )?;
                id
            } else {
                external
            };
            let payload = encode_offscreen_image(level.as_ref().unwrap_or(&full), &parameters)?;
            self.externals.insert(external, payload);
        }
        Ok(())
    }

    /// (offscreen id, attribute, external id) of every level, 100% first.
    fn mipmap_levels(&self, mipmap_id: i64) -> Result<Vec<(i64, Vec<u8>, String)>> {
        let mut info_id: i64 = self
            .db
            .query_row(
                "SELECT BaseMipmapInfo FROM Mipmap WHERE MainId = ?1",
                [mipmap_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| CspError::format(format!("Mipmap {mipmap_id} not found")))?;
        let has_next = column_names(&self.db, "MipmapInfo")?
            .iter()
            .any(|column| column == "NextIndex");
        let mut levels = Vec::new();
        while info_id != 0 && levels.len() < 32 {
            let sql = if has_next {
                "SELECT Offscreen, NextIndex FROM MipmapInfo WHERE MainId = ?1"
            } else {
                "SELECT Offscreen, 0 FROM MipmapInfo WHERE MainId = ?1"
            };
            let (offscreen_id, next): (i64, Option<i64>) = self
                .db
                .query_row(sql, [info_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let (attribute, block): (Vec<u8>, Value) = self.db.query_row(
                "SELECT Attribute, BlockData FROM Offscreen WHERE MainId = ?1",
                [offscreen_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            levels.push((offscreen_id, attribute, text_of(&block)));
            info_id = next.unwrap_or(0);
        }
        if levels.is_empty() {
            return Err(CspError::format(format!("Mipmap {mipmap_id} has no levels")));
        }
        Ok(levels)
    }

    /// Write the edited file through a temporary file; unreferenced external
    /// chunks are dropped.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        self.save_with(path, false)
    }

    /// [`Self::save`], keeping every external chunk with `keep_all`: for a
    /// file CSP saved, whose chunks may be referenced in ways this tool does
    /// not know.
    pub fn save_with(&self, path: impl AsRef<Path>, keep_all: bool) -> Result<()> {
        let referenced = self.referenced_externals()?;
        let externals: Vec<(&str, &[u8])> = self
            .externals
            .iter()
            .filter(|(id, _)| keep_all || referenced.contains(*id))
            .collect();
        let data = assemble_container(&self.db, &externals, &self.file_id)?;
        let path = path.as_ref();
        let temporary = path.with_extension("clip.tmp");
        std::fs::write(&temporary, data)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    }

    fn referenced_externals(&self) -> Result<HashSet<String>> {
        let tables = table_names(&self.db)?;
        let mut referenced = HashSet::new();
        for (table, column) in external_columns(&self.db)? {
            if !tables.contains(&table) || !column_names(&self.db, &table)?.contains(&column) {
                continue;
            }
            let mut statement = self.db.prepare(&format!("SELECT \"{column}\" FROM \"{table}\""))?;
            let values = statement.query_map([], |row| row.get::<_, Value>(0))?;
            for value in values {
                if let Value::Blob(id) = value?
                    && !id.is_empty()
                {
                    referenced.insert(String::from_utf8_lossy(&id).into_owned());
                }
            }
        }
        Ok(referenced)
    }
}
