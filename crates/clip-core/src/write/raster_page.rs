//! Write page .clip files made of whole-page raster layers, and the work
//! (.cmc) around them.
//!
//! The name tool draws each page of its own name data (panels, balloons,
//! text, rough lines) into images; this puts them into copies of a CSP-made
//! empty page as separate raster layers, so the page opens in CSP with the
//! name on layers to draw over.

use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use serde::Serialize;

use super::Values;
use super::cmc::{work_canvas_values, write_cmc};
use super::editor::ClipEditor;
use super::page::{apply_page_settings, replace_preview};
use super::split::page_file_name;
use crate::RgbaImage;
use crate::clip::ClipDocument;
use crate::error::{CspError, Result};
use crate::raster::{Filter, resize};

/// One raster layer of a page; the image covers the whole page canvas.
pub struct RasterLayer {
    pub name: String,
    pub image: RgbaImage,
}

/// Size and frames of the template page, in its pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCanvas {
    pub width_px: u32,
    pub height_px: u32,
    pub resolution: f64,
    /// 仕上がり枠 and 基本枠 as `[x0, y0, x1, y1]`, when the template has them.
    pub trim_px: Option<[f64; 4]>,
    pub basic_px: Option<[f64; 4]>,
}

pub fn template_canvas(template: &ClipDocument) -> TemplateCanvas {
    let canvas = &template.canvas;
    let (width, height) = (canvas.width_px, canvas.height_px);
    let centred = |size: (f64, f64), offset: (f64, f64)| {
        let x0 = (width as f64 - size.0) / 2.0 + offset.0;
        let y0 = (height as f64 - size.1) / 2.0 + offset.1;
        [x0, y0, x0 + size.0, y0 + size.1]
    };
    TemplateCanvas {
        width_px: width as u32,
        height_px: height as u32,
        resolution: canvas.resolution,
        trim_px: canvas
            .crop_size_px
            .map(|(w, h)| centred((w as f64, h as f64), (0.0, 0.0))),
        basic_px: canvas.basic_size_px.map(|(w, h)| {
            centred(
                (w as f64, h as f64),
                (canvas.basic_offset_px.0 as f64, canvas.basic_offset_px.1 as f64),
            )
        }),
    }
}

/// Write one page: a copy of `template` with `layers` added on top, bottom
/// layer first. Images of another size are scaled to the page canvas.
pub fn write_raster_page(
    template: &Path,
    layers: &[RasterLayer],
    output: &Path,
    page_index: i64,
    canvas_values: &Values,
) -> Result<Vec<i64>> {
    let source = ClipDocument::read(template)?;
    let (width, height) = (source.canvas.width_px as u32, source.canvas.height_px as u32);
    let mut editor = ClipEditor::open(template)?;
    editor.renew_ids()?;
    apply_page_settings(&editor.db, page_index, canvas_values)?;
    let raster = editor.first_raster_layer()?;
    let payload = |id: &str| source.container.external_payload(id).map(<[u8]>::to_vec);
    let mut composite = RgbaImage {
        width,
        height,
        pixels: [255, 255, 255, 255].repeat(width as usize * height as usize),
    };
    let mut ids = Vec::new();
    for layer in layers {
        let image = if (layer.image.width, layer.image.height) == (width, height) {
            None
        } else {
            Some(resize(&layer.image, width, height, Filter::Lanczos3))
        };
        let image = image.as_ref().unwrap_or(&layer.image);
        let mut rename = |values: &mut Values| -> Result<()> {
            super::set_value(values, "LayerName", Value::Text(layer.name.clone()));
            Ok(())
        };
        let id = editor.add_layer(source.database(), &payload, raster, Some(&mut rename), None)?;
        editor.append_to_folder(editor.root_id, id, None)?;
        if !image.is_transparent() {
            editor.set_layer_image(id, image, (0, 0))?;
            composite.blend_over(image, 0, 0);
        }
        ids.push(id);
    }
    replace_preview(&editor.db, &composite)?;
    editor.save(output)?;
    Ok(ids)
}

/// Where and how a set of pages (and their work) is written.
pub struct WorkOptions {
    pub template: PathBuf,
    pub out_dir: PathBuf,
    pub name_pattern: String,
    /// Writes `<name>.cmc` from this .cmc template.
    pub work: Option<(String, PathBuf)>,
    pub story_index: Option<i64>,
    /// Files the output must not overwrite (their folders are refused as the output folder).
    pub inputs: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReport {
    pub pages: Vec<PathBuf>,
    pub work: Option<PathBuf>,
}

/// Writes pages one at a time (each page's images can be large), then the work.
pub struct RasterWorkWriter {
    options: WorkOptions,
    out_dir: PathBuf,
    canvas_values: Values,
    overrides: Values,
    pages: Vec<PathBuf>,
    pub canvas: TemplateCanvas,
}

impl RasterWorkWriter {
    pub fn new(options: WorkOptions) -> Result<Self> {
        let mut inputs = vec![options.template.clone()];
        if let Some((_, cmc)) = &options.work {
            inputs.push(cmc.clone());
        }
        for input in &inputs {
            if !input.exists() {
                return Err(CspError::format(format!("Input file not found: {}", input.display())));
            }
        }
        inputs.extend(options.inputs.iter().filter(|path| path.exists()).cloned());
        std::fs::create_dir_all(&options.out_dir)?;
        let out_dir = options.out_dir.canonicalize()?;
        for input in &inputs {
            let folder = input
                .canonicalize()?
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_default();
            if folder == out_dir {
                return Err(CspError::format(
                    "The output folder must differ from the input folders so originals are never overwritten",
                ));
            }
        }
        let canvas = template_canvas(&ClipDocument::read(&options.template)?);
        let mut canvas_values = match &options.work {
            Some((_, cmc)) => work_canvas_values(cmc)?,
            None => Vec::new(),
        };
        let overrides: Values = match options.story_index {
            Some(index) => vec![
                ("ComicStoryUseStoryIndex".to_owned(), Value::Integer(1)),
                ("ComicStoryStoryIndex".to_owned(), Value::Integer(index)),
            ],
            None => Vec::new(),
        };
        for (column, value) in &overrides {
            super::set_value(&mut canvas_values, column, value.clone());
        }
        Ok(RasterWorkWriter {
            options,
            out_dir,
            canvas_values,
            overrides,
            pages: Vec::new(),
            canvas,
        })
    }

    /// Write the next page (numbered from 1 in the order they are written).
    pub fn write_page(&mut self, layers: &[RasterLayer]) -> Result<PathBuf> {
        let number = self.pages.len() as i64 + 1;
        let output = self.out_dir.join(page_file_name(&self.options.name_pattern, number));
        write_raster_page(&self.options.template, layers, &output, number - 1, &self.canvas_values)?;
        self.pages.push(output.clone());
        Ok(output)
    }

    pub fn finish(self) -> Result<WorkReport> {
        let work = match &self.options.work {
            Some((name, cmc)) => {
                if self.pages.is_empty() {
                    return Err(CspError::format("No pages to put in the work"));
                }
                Some(write_cmc(
                    cmc,
                    &self.pages,
                    &self.out_dir.join(format!("{name}.cmc")),
                    &self.overrides,
                )?)
            }
            None => None,
        };
        Ok(WorkReport {
            pages: self.pages,
            work,
        })
    }
}
