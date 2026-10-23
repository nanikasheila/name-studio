//! Writing page .clip files and the .cmc work from a name sheet.
//!
//! Only CSP can confirm a file opens; these tests check that what is written
//! reads back with the planned layers, positions, sizes and page order, and
//! that input files are never changed. `tools/compare_with_python.py`
//! additionally checks the output against the Python reference.

#![cfg(feature = "fixtures")]

use std::path::{Path, PathBuf};

use clip_core::fixtures::{FixtureCanvas, FixtureLayer, OPEN, build_cmc, build_editable_clip, rectangle};
use clip_core::layout::ReadingOrder;
use clip_core::plan::{Fit, PlanOptions, plan_sheet};
use clip_core::text::{build_tlv, parse_text_attributes, parse_tlv};
use clip_core::write::editor::ClipEditor;
use clip_core::write::split::{DEFAULT_NAME_PATTERN, SplitOptions, split_sheet};
use clip_core::{ClipDocument, CmcProject, RgbaImage};

/// 160 x 60 mm and 40 x 56 mm at 254 dpi: 1600 x 600 and 400 x 560 px.
const SHEET: FixtureCanvas = FixtureCanvas {
    width_mm: 160.0,
    height_mm: 60.0,
    resolution: 254.0,
    double_page: true,
};
const PAGE: FixtureCanvas = FixtureCanvas {
    width_mm: 40.0,
    height_mm: 56.0,
    resolution: 254.0,
    double_page: false,
};

fn right_spread() -> Vec<clip_core::fixtures::FixtureVector> {
    vec![
        rectangle(840.0, 40.0, 1560.0, 560.0),
        rectangle(860.0, 60.0, 1190.0, 540.0),
        rectangle(1210.0, 60.0, 1540.0, 540.0),
    ]
}

fn sheet(folder: &Path) -> PathBuf {
    std::fs::create_dir_all(folder.join("sheet")).unwrap();
    let layers = vec![
        FixtureLayer::paper(2),
        FixtureLayer::folder(
            10,
            "テンプレート",
            vec![
                FixtureLayer::vector(11, "右", right_spread()),
                FixtureLayer {
                    offset: (-800, 0),
                    ..FixtureLayer::vector(12, "左", right_spread())
                },
            ],
        ),
        // A 20 px dot around (1300, 300): block 12 of the 7-block-wide grid.
        FixtureLayer::raster(20, "下描き", vec![(12, (10, 34, 30, 54))]),
        FixtureLayer::folder(
            30,
            "ネーム",
            vec![FixtureLayer::vector(
                21,
                "線",
                vec![(OPEN, vec![(1250.0, 100.0), (1500.0, 500.0)])],
            )],
        ),
        FixtureLayer::text(23, "あ", [900, 100, 960, 300], 4.0),
    ];
    build_editable_clip(&folder.join("sheet").join("sheet.clip"), SHEET, layers)
}

fn template(folder: &Path) -> PathBuf {
    std::fs::create_dir_all(folder.join("template")).unwrap();
    let runs = 1u32
        .to_le_bytes()
        .into_iter()
        .chain(0u32.to_le_bytes())
        .chain(6u32.to_le_bytes())
        .chain(26u32.to_le_bytes());
    let story = build_tlv(&[
        (0x0B, runs.collect()),
        (0x20, 900i32.to_le_bytes().to_vec()),
        (0x32, 77i32.to_le_bytes().to_vec()),
    ]);
    let layers = vec![
        FixtureLayer::paper(2),
        FixtureLayer::raster(3, "レイヤー 1", vec![(0, (0, 0, 0, 0))]),
        FixtureLayer {
            layer_type: 800,
            text: Some("作品 3話".into()),
            text_attributes: Some(story),
            ..FixtureLayer::new(4, "(作品情報)")
        },
        FixtureLayer {
            layer_type: 800,
            text: Some("1".into()),
            text_attributes: Some(nombre_attributes()),
            ..FixtureLayer::new(5, "(ノンブル)")
        },
    ];
    build_editable_clip(&folder.join("template").join("page.clip"), PAGE, layers)
}

fn le(numbers: &[i32]) -> Vec<u8> {
    numbers.iter().flat_map(|n| n.to_le_bytes()).collect()
}

/// The hidden ノンブル of a left page: one 10 px wide digit near the right
/// (binding) edge, with CSP's cached rendering in Offscreen 78.
fn nombre_attributes() -> Vec<u8> {
    build_tlv(&[
        (0x0B, le(&[1, 0, 1])),
        (0x2A, le(&[380, 540, 390, 550])),
        (0x3F, le(&[10, 10])),
        (0x40, le(&[0, 0, 1000, 0, 1000, 1000, 0, 1000])),
        (0x32, le(&[78])),
    ])
}

/// The ノンブル text, its bbox, its cached-rendering id and the page side flag.
fn nombre(path: &Path) -> (String, Vec<u8>, Vec<u8>, i64) {
    let document = ClipDocument::read(path).unwrap();
    let (string, attributes): (Vec<u8>, Vec<u8>) = document
        .database()
        .query_row(
            "SELECT TextLayerString, TextLayerAttributes FROM Layer WHERE ComicStoryInfoType = 2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let flag: i64 = document
        .database()
        .query_row("SELECT CropFrameOptionFlag FROM Canvas", [], |row| row.get(0))
        .unwrap();
    let items = parse_tlv(&attributes).unwrap();
    let value = |id: u32| items.iter().find(|(tag, _)| *tag == id).unwrap().1.to_vec();
    (String::from_utf8(string).unwrap(), value(0x2A), value(0x32), flag)
}

#[test]
fn write_page_sets_nombre_and_side() {
    let folder = tempfile::tempdir().unwrap();
    let sheet = ClipDocument::read(sheet(folder.path())).unwrap();
    let template = template(folder.path());
    let options = PlanOptions {
        fit: Fit::Cell,
        ..PlanOptions::default()
    };
    let plan = plan_sheet(&sheet, 400, 560, options).unwrap();
    let page = &plan.pages[0];
    let write = |name: &str, index: i64| {
        let output = folder.path().join(name);
        clip_core::write::page::write_page(&template, &sheet, page, &output, Some(index), &Vec::new()).unwrap();
        nombre(&output)
    };
    // Same side as the template (left): only the number changes, keeping the binding edge.
    assert_eq!(
        write("p11.clip", 10),
        ("11".into(), le(&[370, 540, 390, 550]), le(&[0]), 2)
    );
    // A right page: CSP keeps the ノンブル at the binding edge, now on the left, and flags the side.
    assert_eq!(write("p2.clip", 1), ("2".into(), le(&[10, 540, 20, 550]), le(&[0]), 4));
}

fn digest(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

fn canvas_page(path: &Path) -> (i64, i64) {
    let document = ClipDocument::read(path).unwrap();
    document
        .database()
        .query_row("SELECT ComicPageIndex, ComicIsLeftPage FROM Canvas", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap()
}

#[test]
fn editor_adds_a_layer_with_pixels() {
    let folder = tempfile::tempdir().unwrap();
    let template = template(folder.path());
    let before = digest(&template);
    let mut editor = ClipEditor::open(&template).unwrap();
    let source = ClipDocument::read(&template).unwrap();
    let payload = |id: &str| source.container.external_payload(id).map(<[u8]>::to_vec);
    let raster = editor.first_raster_layer().unwrap();
    let mut rename = |values: &mut clip_core::write::Values| {
        for (column, value) in values.iter_mut() {
            if column == "LayerName" {
                *value = rusqlite::types::Value::Text("追加".into());
            }
        }
        Ok(())
    };
    let new_id = editor
        .add_layer(source.database(), &payload, raster, Some(&mut rename), None)
        .unwrap();
    editor.append_to_folder(editor.root_id, new_id, None).unwrap();
    let red = RgbaImage {
        width: 20,
        height: 10,
        pixels: [255, 0, 0, 255].repeat(200),
    };
    editor.set_layer_image(new_id, &red, (100, 200)).unwrap();
    let output = folder.path().join("out.clip");
    editor.save(&output).unwrap();
    assert_eq!(digest(&template), before);
    let document = ClipDocument::read(&output).unwrap();
    let layer = document.find_layer(new_id).unwrap();
    assert_eq!(layer.name, "追加");
    assert_eq!(document.root.children.last().unwrap().name, "追加");
    let pixels = document.render_layer_pixels(layer).unwrap().unwrap();
    assert_eq!(pixels.alpha_bbox(), Some((100, 200, 120, 210)));
    // The template's own layer keeps its (empty) pixels.
    let original = document
        .render_layer_pixels(document.find_layer(3).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(original.alpha_bbox(), None);
}

#[test]
fn writes_planned_layers_into_pages() {
    let folder = tempfile::tempdir().unwrap();
    let (sheet_path, template_path) = (sheet(folder.path()), template(folder.path()));
    let sheet = ClipDocument::read(&sheet_path).unwrap();
    let options = PlanOptions {
        fit: Fit::Cell,
        order: ReadingOrder::RightToLeft,
        ..PlanOptions::default()
    };
    let plan = plan_sheet(&sheet, 400, 560, options).unwrap();
    assert_eq!(plan.pages.len(), 4);
    assert_eq!(plan.template_layer_ids, vec![11, 12]);
    let page = &plan.pages[0];
    let output = folder.path().join("page0001.clip");
    let result = clip_core::write::page::write_page(&template_path, &sheet, page, &output, None, &Vec::new()).unwrap();
    assert_eq!(result.layer_ids.len(), 2);
    let document = ClipDocument::read(&output).unwrap();
    let names: Vec<String> = document.layers().iter().map(|layer| layer.name.clone()).collect();
    assert!(names.contains(&"下描き".into()) && names.contains(&"ネーム".into()) && names.contains(&"線".into()));
    assert!(!names.contains(&"テンプレート".into()) && !names.contains(&"あ".into()));
    let (scale, dx, dy) = (page.transform.scale, page.transform.dx, page.transform.dy);
    let sketch = document
        .layers()
        .into_iter()
        .find(|layer| layer.name == "下描き")
        .unwrap();
    let (x0, y0, x1, y1) = document
        .render_layer_pixels(sketch)
        .unwrap()
        .unwrap()
        .alpha_bbox()
        .unwrap();
    assert!(((x0 + x1) as f64 / 2.0 - (1300.0 * scale + dx)).abs() <= 2.0);
    assert!(((y0 + y1) as f64 / 2.0 - (300.0 * scale + dy)).abs() <= 2.0);
    let line_layer = document.layers().into_iter().find(|layer| layer.name == "線").unwrap();
    let line = &document.vector_objects(line_layer).unwrap()[0];
    assert!((line.points[0].0 - (1250.0 * scale + dx)).abs() < 1e-9);
    assert!((line.points[0].1 - (100.0 * scale + dy)).abs() < 1e-9);
    assert_eq!(canvas_page(&output), (0, 1));
    assert_eq!(digest(&sheet_path), std::fs::read(&sheet_path).unwrap());
}

#[test]
fn scales_text_with_the_page() {
    let folder = tempfile::tempdir().unwrap();
    let (sheet_path, template_path) = (sheet(folder.path()), template(folder.path()));
    let sheet = ClipDocument::read(&sheet_path).unwrap();
    let plan = plan_sheet(
        &sheet,
        400,
        560,
        PlanOptions {
            fit: Fit::Cell,
            ..PlanOptions::default()
        },
    )
    .unwrap();
    let page = plan
        .pages
        .iter()
        .find(|page| page.contents.iter().any(|content| content.name == "あ"))
        .unwrap();
    let output = folder.path().join("text.clip");
    let values = vec![(
        "ComicStoryStoryName".to_owned(),
        rusqlite::types::Value::Text("第4話".into()),
    )];
    clip_core::write::page::write_page(&template_path, &sheet, page, &output, Some(5), &values).unwrap();
    let document = ClipDocument::read(&output).unwrap();
    let text = document.layers().into_iter().find(|layer| layer.name == "あ").unwrap();
    let blob: Vec<u8> = document
        .database()
        .query_row(
            "SELECT TextLayerAttributes FROM Layer WHERE MainId = ?1",
            [text.main_id],
            |row| row.get(0),
        )
        .unwrap();
    let size = parse_text_attributes(&blob).unwrap().font_size_pt.unwrap();
    assert!((size - 4.0 * page.transform.scale).abs() < 0.01);
    assert_eq!(canvas_page(&output), (5, 0));
}

#[test]
fn splits_a_sheet_into_a_work() {
    let folder = tempfile::tempdir().unwrap();
    let (sheet_path, template_path) = (sheet(folder.path()), template(folder.path()));
    let cmc_path = build_cmc(&folder.path().join("sheet").join("name.cmc"), &["sheet.clip"]);
    let inputs: Vec<(PathBuf, Vec<u8>)> = [&sheet_path, &template_path, &cmc_path]
        .iter()
        .map(|path| ((*path).clone(), digest(path)))
        .collect();
    let out = folder.path().join("work");
    let options = SplitOptions {
        sheet: sheet_path.clone(),
        template: template_path.clone(),
        out_dir: out.clone(),
        pages: None,
        fit: Fit::Cell,
        order: ReadingOrder::RightToLeft,
        first_page: 1,
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: Some(("第1話".into(), cmc_path.clone())),
        story_index: Some(12),
    };
    let report = split_sheet(&options).unwrap();
    assert_eq!(report.pages.len(), 4);
    let project = CmcProject::read(out.join("第1話.cmc")).unwrap();
    let files: Vec<String> = project.pages.iter().map(|page| page.file_name.clone()).collect();
    assert_eq!(
        files,
        (1..=4)
            .map(|number| format!("page{number:04}.clip"))
            .collect::<Vec<_>>()
    );
    assert_eq!(project.story_name, "Story");
    assert_eq!(project.max_canvas_file_index, 4);
    let indexes: Vec<i64> = files.iter().map(|file| canvas_page(&out.join(file)).0).collect();
    assert_eq!(indexes, vec![0, 1, 2, 3]);
    // Every page is its own file for CSP: distinct file ids and layer uuids.
    let mut file_ids = std::collections::HashSet::new();
    let mut uuids = Vec::new();
    for file in &files {
        let document = ClipDocument::read(out.join(file)).unwrap();
        file_ids.insert(document.container.data[16 + 16 + 24..16 + 16 + 40].to_vec());
        let mut statement = document
            .database()
            .prepare("SELECT LayerUuid FROM Layer WHERE LayerUuid IS NOT NULL")
            .unwrap();
        uuids.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap),
        );
    }
    assert_eq!(file_ids.len(), 4);
    let unique: std::collections::HashSet<&String> = uuids.iter().collect();
    assert!(unique.len() == uuids.len() && uuids.len() > 4);
    // Pages keep the template's Canvas columns: spread-only columns from the
    // sheet would make CSP rebuild the story info of right-hand pages on open.
    for file in &files {
        let document = ClipDocument::read(out.join(file)).unwrap();
        let columns: Vec<String> = document
            .database()
            .prepare("SELECT name FROM pragma_table_info('Canvas')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(!columns.iter().any(|column| column == "ComicStoryRightLayerCreated"));
    }
    // Story info comes from the work's .cmc; --story-index overrides the episode.
    let first = ClipDocument::read(out.join("page0001.clip")).unwrap();
    let (name, index, string, attributes): (String, i64, Vec<u8>, Vec<u8>) = first
        .database()
        .query_row(
            "SELECT c.ComicStoryStoryName, c.ComicStoryStoryIndex, l.TextLayerString, l.TextLayerAttributes \
             FROM Canvas c, Layer l WHERE l.ComicStoryInfoType = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!((name.as_str(), index), ("Story", 12));
    assert_eq!(String::from_utf8(string).unwrap(), "作品 12話");
    let runs = parse_tlv(&attributes)
        .unwrap()
        .into_iter()
        .find(|(tag, _)| *tag == 0x0B)
        .unwrap()
        .1
        .to_vec();
    assert_eq!(u32::from_le_bytes(runs[8..12].try_into().unwrap()), 7);
    // CSP would show its cached image of "作品 3話" (TLV 0x32) instead of the text.
    let cache = parse_tlv(&attributes)
        .unwrap()
        .into_iter()
        .find(|(tag, _)| *tag == 0x32)
        .unwrap()
        .1
        .to_vec();
    assert_eq!(cache, 0u32.to_le_bytes());
    let work = rusqlite::Connection::open(out.join("第1話.cmc")).unwrap();
    let story_index: i64 = work
        .query_row("SELECT ComicStoryStoryIndex FROM Project", [], |row| row.get(0))
        .unwrap();
    assert_eq!(story_index, 12);
    for (path, before) in inputs {
        assert_eq!(digest(&path), before, "{} changed", path.display());
    }
    // The output folder may not be an input folder.
    let same = SplitOptions {
        out_dir: sheet_path.parent().unwrap().to_path_buf(),
        ..options
    };
    assert!(split_sheet(&same).is_err());
}

#[test]
fn writes_whole_page_raster_layers_into_a_work() {
    use clip_core::write::raster_page::{PageLayer, RasterLayer, RasterWorkWriter, WorkOptions};
    let folder = tempfile::tempdir().unwrap();
    let template_path = template(folder.path());
    let cmc_path = build_cmc(&folder.path().join("template").join("name.cmc"), &["page.clip"]);
    let before = digest(&template_path);
    let out = folder.path().join("work");
    let mut writer = RasterWorkWriter::new(WorkOptions {
        template: template_path.clone(),
        out_dir: out.clone(),
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: Some(("第2話".into(), cmc_path.clone())),
        story_index: Some(2),
        inputs: Vec::new(),
        donor_sources: Vec::new(),
        draft_layers: Vec::new(),
    })
    .unwrap();
    assert_eq!((writer.canvas.width_px, writer.canvas.height_px), (400, 560));
    // Panels drawn at half size are scaled up to the page; balloons stay empty.
    let mut frame = RgbaImage::transparent(200, 280);
    frame.paste(
        &RgbaImage {
            width: 50,
            height: 40,
            pixels: [0, 0, 0, 255].repeat(2000),
        },
        20,
        30,
    );
    for _ in 0..2 {
        writer
            .write_page(
                &[
                    PageLayer::Raster(RasterLayer {
                        name: "コマ枠".into(),
                        image: frame.clone(),
                    }),
                    PageLayer::Raster(RasterLayer {
                        name: "フキダシ".into(),
                        image: RgbaImage::transparent(400, 560),
                    }),
                ],
                None,
                false,
            )
            .unwrap();
    }
    let report = writer.finish().unwrap();
    assert_eq!(report.pages.len(), 2);
    assert_eq!(digest(&template_path), before);
    let project = CmcProject::read(report.work.unwrap()).unwrap();
    assert_eq!(project.pages.len(), 2);
    let page = ClipDocument::read(&report.pages[1]).unwrap();
    assert_eq!(canvas_page(&report.pages[1]).0, 1);
    let names: Vec<&str> = page.root.children.iter().map(|layer| layer.name.as_str()).collect();
    assert_eq!(&names[names.len() - 2..], ["コマ枠", "フキダシ"]);
    let frame_layer = page.root.children.iter().find(|layer| layer.name == "コマ枠").unwrap();
    let pixels = page.render_layer_pixels(frame_layer).unwrap().unwrap();
    let (x0, y0, x1, y1) = pixels.alpha_bbox().unwrap();
    // Lanczos leaves a faint fringe a few pixels wide.
    let near = |a: u32, b: u32| a.abs_diff(b) <= 6;
    assert!(
        near(x0, 40) && near(y0, 60) && near(x1, 140) && near(y1, 140),
        "{:?}",
        (x0, y0, x1, y1)
    );
    // Writing into the template's folder would risk the originals.
    let refused = RasterWorkWriter::new(WorkOptions {
        template: template_path.clone(),
        out_dir: folder.path().join("template"),
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: None,
        story_index: None,
        inputs: Vec::new(),
        donor_sources: Vec::new(),
        draft_layers: Vec::new(),
    });
    assert!(refused.is_err());
}

#[test]
fn writes_vector_and_text_layers_copied_from_the_sheet() {
    use clip_core::LayerKind;
    use clip_core::text::NewText;
    use clip_core::vector::NewVectorLine;
    use clip_core::write::raster_page::{PageLayer, RasterWorkWriter, WorkOptions};
    let folder = tempfile::tempdir().unwrap();
    let template_path = template(folder.path());
    let sheet_path = sheet(folder.path());
    let sheet_before = digest(&sheet_path);
    let options = |donor_sources: Vec<PathBuf>| WorkOptions {
        template: template_path.clone(),
        out_dir: folder.path().join("out"),
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: None,
        story_index: None,
        inputs: vec![sheet_path.clone()],
        donor_sources,
        draft_layers: Vec::new(),
    };
    // The template has no vector or text layer to copy: without the sheet
    // there is nothing to make them from.
    let mut bare = RasterWorkWriter::new(options(Vec::new())).unwrap();
    assert!(bare.donors.vector.is_none() && bare.donors.text.is_none());
    // A copy of the sheet next to the template is found without being named.
    let beside = template_path.with_file_name("page0002.clip");
    std::fs::copy(&sheet_path, &beside).unwrap();
    let found = RasterWorkWriter::new(options(Vec::new())).unwrap();
    assert!(found.donors.vector.is_some() && found.donors.text.is_some());
    drop(found);
    std::fs::remove_file(&beside).unwrap();
    let panel = NewVectorLine {
        points: vec![
            (20.0, 30.0, 1.0),
            (380.0, 30.0, 1.0),
            (380.0, 250.0, 1.0),
            (20.0, 250.0, 1.0),
        ],
        closed: true,
        width_px: 6.0,
    };
    let stroke = NewVectorLine {
        points: vec![(50.0, 300.0, 0.2), (120.0, 340.0, 0.9)],
        closed: false,
        width_px: 3.0,
    };
    let text = NewText {
        text: "こんにちは\nせかい".into(),
        frame: [300, 60, 340, 200],
        font_size_pt: 7.5,
        vertical: true,
        color: None,
    };
    let layers = [
        PageLayer::Vector {
            name: "コマ枠".into(),
            lines: vec![panel.clone()],
        },
        PageLayer::Vector {
            name: "ラフ線".into(),
            lines: vec![stroke.clone()],
        },
        PageLayer::Text(text.clone()),
    ];
    assert!(bare.write_page(&layers, None, false).is_err());

    let mut writer = RasterWorkWriter::new(options(vec![sheet_path.clone()])).unwrap();
    assert!(writer.donors.vector.is_some() && writer.donors.text.is_some());
    let page_path = writer.write_page(&layers, None, false).unwrap();
    writer.finish().unwrap();
    assert_eq!(digest(&sheet_path), sheet_before);

    let page = ClipDocument::read(&page_path).unwrap();
    let find = |name: &str| {
        page.layers()
            .into_iter()
            .find(|layer| layer.name == name)
            .unwrap()
            .clone()
    };
    // Vector lines find their brush styles through Canvas; without it CSP
    // opens the layers empty.
    let manager: i64 = page
        .database()
        .query_row("SELECT BrushStyleManager FROM Canvas", [], |row| row.get(0))
        .unwrap();
    let managers: i64 = page
        .database()
        .query_row(
            "SELECT COUNT(*) FROM BrushStyleManager WHERE MainId = ?1",
            [manager],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((manager, managers), (8, 1));
    let frame = find("コマ枠");
    assert_eq!(frame.kind, LayerKind::Vector);
    let objects = page.vector_objects(&frame).unwrap();
    assert_eq!(objects.len(), 1);
    // CSP marks a closed polyline (折れ線 with 線を閉じる) with 0x100.
    assert_eq!(objects[0].flags, 0x111);
    assert_eq!(
        objects[0].points,
        vec![(20.0, 30.0), (380.0, 30.0), (380.0, 250.0), (20.0, 250.0)]
    );
    assert_eq!(objects[0].brush_size, 3.0);
    let rough = page.vector_objects(&find("ラフ線")).unwrap();
    assert_eq!(rough[0].flags, 0x11);
    assert_eq!(rough[0].points.len(), 2);

    let said = find("こんにちは");
    assert_eq!(said.kind, LayerKind::Text);
    assert_eq!(page.text_strings(&said), vec!["こんにちは\r\nせかい".to_owned()]);
    // CSP shows garbage for text stored as TEXT instead of a blob.
    let stored: rusqlite::types::Value = page
        .database()
        .query_row(
            "SELECT TextLayerString FROM Layer WHERE MainId = ?1",
            [said.main_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(matches!(stored, rusqlite::types::Value::Blob(_)));
    let attributes = &page.text_blocks(&said).unwrap()[0];
    assert_eq!(attributes.font_size_pt, Some(7.5));
    assert_eq!(attributes.bbox, Some((300, 60, 340, 200)));
    // The sheet's text, folder and other layers are not copied along.
    assert!(
        page.layers()
            .iter()
            .all(|layer| layer.name != "あ" && layer.name != "テンプレート")
    );
}

#[test]
fn checks_written_pages_and_works() {
    use clip_core::text::NewText;
    use clip_core::vector::NewVectorLine;
    use clip_core::write::raster_page::{PageLayer, RasterLayer, RasterWorkWriter, WorkOptions};
    use clip_core::write::verify::{ExpectedLayer, check_clip, verify_page, verify_work};
    let folder = tempfile::tempdir().unwrap();
    let template_path = template(folder.path());
    let sheet_path = sheet(folder.path());
    let cmc_path = build_cmc(&folder.path().join("template").join("name.cmc"), &["page.clip"]);
    let mut writer = RasterWorkWriter::new(WorkOptions {
        template: template_path.clone(),
        out_dir: folder.path().join("out"),
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: Some(("確認".into(), cmc_path)),
        story_index: None,
        inputs: vec![sheet_path.clone()],
        donor_sources: vec![sheet_path.clone()],
        draft_layers: vec!["ラフ".into()],
    })
    .unwrap();
    let mut rough = RgbaImage::transparent(200, 280);
    rough.paste(
        &RgbaImage {
            width: 30,
            height: 20,
            pixels: [0, 0, 0, 255].repeat(600),
        },
        100,
        150,
    );
    let white = NewText {
        text: "白抜き".into(),
        frame: [300, 60, 340, 200],
        font_size_pt: 8.0,
        vertical: true,
        color: Some([255, 255, 255]),
    };
    let layers = vec![
        PageLayer::Raster(RasterLayer {
            name: "ラフ".into(),
            image: rough,
        }),
        PageLayer::Raster(RasterLayer {
            name: "空".into(),
            image: RgbaImage::transparent(400, 560),
        }),
        PageLayer::Vector {
            name: "コマ枠".into(),
            lines: vec![NewVectorLine {
                points: vec![(20.0, 30.0, 1.0), (380.0, 30.0, 1.0), (380.0, 250.0, 1.0)],
                closed: true,
                width_px: 4.0,
            }],
        },
        PageLayer::Text(white.clone()),
    ];
    let (width, height) = (writer.canvas.width_px, writer.canvas.height_px);
    let expected: Vec<ExpectedLayer> = layers
        .iter()
        .map(|layer| ExpectedLayer::of(layer, width, height))
        .collect();
    assert_eq!(
        expected[0],
        ExpectedLayer::Raster {
            name: "ラフ".into(),
            bbox: Some([200.0, 300.0, 260.0, 340.0])
        }
    );
    let canvas = writer.canvas;
    let page = writer.write_page(&layers, None, false).unwrap();
    let report = writer.finish().unwrap();
    let check = verify_page(&page, &expected, &canvas);
    assert!(check.ok(), "{:?}", check.problems);
    assert_eq!((check.vector_lines, check.texts), (1, 1));
    assert!(check_clip(&page).ok());
    // The rough is a 下描き layer at half opacity, the others as they were.
    let written = ClipDocument::read(&page).unwrap();
    let opacity = |name: &str| {
        written
            .layers()
            .iter()
            .find(|layer| layer.name == name)
            .unwrap()
            .opacity
    };
    assert_eq!((opacity("ラフ"), opacity("空")), (0.5, 1.0));
    let work = report.work.unwrap();
    assert!(verify_work(&work, Some(&report.pages)).ok());

    // What the page was meant to hold, but is not there.
    let mut wrong = expected.clone();
    wrong[0] = ExpectedLayer::Raster {
        name: "ラフ".into(),
        bbox: Some([10.0, 10.0, 60.0, 60.0]),
    };
    wrong[1] = ExpectedLayer::Raster {
        name: "空".into(),
        bbox: Some([0.0, 0.0, 10.0, 10.0]),
    };
    wrong[2] = ExpectedLayer::Vector {
        name: "コマ枠".into(),
        lines: 2,
    };
    wrong[3] = ExpectedLayer::Text {
        text: "白抜き".into(),
        color: Some([0, 0, 0]),
    };
    let problems = verify_page(&page, &wrong, &canvas).problems;
    assert_eq!(problems.len(), 4, "{problems:?}");
    assert!(problems[0].contains("ずれ") && problems[1].contains("空です"));
    assert!(problems[2].contains("1 本") && problems[3].contains("#ffffff"));

    // The faults CSP has shown: vectors without the brush style manager.
    let broken = folder.path().join("broken.clip");
    let editor = ClipEditor::open(&page).unwrap();
    editor
        .db
        .execute("UPDATE Canvas SET BrushStyleManager = NULL", [])
        .unwrap();
    editor.save(&broken).unwrap();
    let problems = check_clip(&broken).problems;
    assert!(
        problems.iter().any(|problem| problem.contains("BrushStyleManager")),
        "{problems:?}"
    );

    // A work whose page went missing.
    std::fs::remove_file(&report.pages[0]).unwrap();
    let problems = verify_work(&work, None).problems;
    assert!(problems[0].contains("ありません"), "{problems:?}");
}

/// The template with a 仕上がり枠 of 30 x 50 mm (300 x 500 px), as spreads need.
fn trimmed_template(folder: &Path) -> PathBuf {
    let path = folder.join("template").join("page-trim.clip");
    let editor = ClipEditor::open(template(folder)).unwrap();
    editor
        .db
        .execute_batch(
            "ALTER TABLE Canvas ADD COLUMN CropFrameUnitKind;
             ALTER TABLE Canvas ADD COLUMN CropFrameWidth;
             ALTER TABLE Canvas ADD COLUMN CropFrameHeight;
             UPDATE Canvas SET CropFrameUnitKind = 2, CropFrameWidth = 30.0, CropFrameHeight = 50.0;",
        )
        .unwrap();
    editor.save(&path).unwrap();
    path
}

/// (text, bbox x0, x1, for the right page) of each story info layer of `kind`.
fn story_texts(path: &Path, kind: i64) -> Vec<(String, i32, i32, bool)> {
    let document = ClipDocument::read(path).unwrap();
    let mut statement = document
        .database()
        .prepare(
            "SELECT TextLayerString, TextLayerAttributes, IFNULL(ComicStoryInfoForRightPage, 0), LayerOffsetX
             FROM Layer WHERE ComicStoryInfoType = ?1 ORDER BY MainId",
        )
        .unwrap();
    statement
        .query_map([kind], |row| {
            let text: Vec<u8> = row.get(0)?;
            let attributes: Vec<u8> = row.get(1)?;
            let right: i64 = row.get(2)?;
            let offset: i64 = row.get(3)?;
            Ok((text, attributes, right != 0, offset))
        })
        .unwrap()
        .map(Result::unwrap)
        .map(|(text, attributes, right, offset)| {
            let items = parse_tlv(&attributes).unwrap();
            let bbox = items.iter().find(|(tag, _)| *tag == 0x2A).map(|(_, bbox)| *bbox);
            let x = |at: usize| {
                bbox.map(|bbox| i32::from_le_bytes(bbox[at..at + 4].try_into().unwrap()) + offset as i32)
                    .unwrap_or(0)
            };
            (String::from_utf8(text).unwrap(), x(0), x(8), right)
        })
        .collect()
}

#[test]
fn writes_spread_pages() {
    use clip_core::offscreen::OffscreenParameters;
    use clip_core::write::raster_page::{PageLayer, RasterLayer, RasterWorkWriter, WorkOptions};
    use clip_core::write::spread::{SpreadLayout, make_spread_template};
    use clip_core::write::verify::{ExpectedLayer, verify_page, verify_work};
    let folder = tempfile::tempdir().unwrap();
    let template_path = trimmed_template(folder.path());
    let before = digest(&template_path);

    // The two pages' trims meet at the middle; single-page frame settings.
    let spread_path = folder.path().join("spread.clip");
    let layout = make_spread_template(&template_path, &spread_path).unwrap();
    assert_eq!(digest(&template_path), before);
    assert_eq!(
        layout,
        SpreadLayout {
            width_px: 800,
            height_px: 560,
            gutter_px: 400.0,
            left_dx: 50.0,
            right_dx: 350.0
        }
    );
    let spread = ClipDocument::read(&spread_path).unwrap();
    assert!(spread.canvas.is_double_page);
    assert_eq!((spread.canvas.width_px, spread.canvas.height_px), (800, 560));
    assert_eq!(spread.canvas.crop_size_px, Some((300, 500)));
    let (left, flag): (i64, i64) = spread
        .database()
        .query_row("SELECT ComicIsLeftPage, CropFrameOptionFlag FROM Canvas", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((left, flag), (0, 17));
    // Every render offscreen is as wide as the spread (padded to blocks).
    let mut statement = spread.database().prepare("SELECT Attribute FROM Offscreen").unwrap();
    let widths: Vec<(u32, u32)> = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .unwrap()
        .map(|attribute| {
            let attribute = attribute.unwrap();
            let parameters = OffscreenParameters::parse(&attribute).unwrap();
            // BlockSize: one entry per block, at the end of the attribute.
            let count = u32::from_be_bytes(
                attribute[attribute.len() - 4 * (parameters.blocks_x * parameters.blocks_y) as usize - 8..][..4]
                    .try_into()
                    .unwrap(),
            );
            assert_eq!(count, parameters.blocks_x * parameters.blocks_y);
            (parameters.width, parameters.blocks_x)
        })
        .collect();
    assert!(!widths.is_empty());
    assert!(
        widths.iter().all(|(width, _)| [800, 1024].contains(width)),
        "{widths:?}"
    );
    // 作品情報 and ノンブル for each page; the ノンブル at each binding edge.
    let nombres = story_texts(&spread_path, 2);
    assert_eq!(
        nombres
            .iter()
            .map(|(_, x0, x1, right)| (*x0, *x1, *right))
            .collect::<Vec<_>>(),
        vec![(430, 440, false), (359, 369, true)]
    );
    let stories: Vec<bool> = story_texts(&spread_path, 1).into_iter().map(|story| story.3).collect();
    assert_eq!(stories, [false, true]);

    // A work: page 1, the spread of pages 2-3, page 4.
    let cmc_path = build_cmc(&folder.path().join("template").join("name.cmc"), &["page.clip"]);
    let mut writer = RasterWorkWriter::new(WorkOptions {
        template: template_path.clone(),
        out_dir: folder.path().join("out"),
        name_pattern: DEFAULT_NAME_PATTERN.into(),
        work: Some(("見開き".into(), cmc_path)),
        story_index: None,
        inputs: Vec::new(),
        donor_sources: Vec::new(),
        draft_layers: Vec::new(),
    })
    .unwrap();
    assert_eq!(writer.first_page_left, Some(true));
    let canvas = writer.spread_canvas().unwrap();
    assert_eq!((canvas.width_px, canvas.height_px), (800, 560));
    let mut wide = RgbaImage::transparent(800, 560);
    wide.paste(
        &RgbaImage {
            width: 40,
            height: 40,
            pixels: [0, 0, 0, 255].repeat(1600),
        },
        600,
        100,
    );
    let page = |image: RgbaImage| {
        vec![PageLayer::Raster(RasterLayer {
            name: "コマ枠".into(),
            image,
        })]
    };
    writer
        .write_page(&page(RgbaImage::transparent(400, 560)), None, false)
        .unwrap();
    let layers = page(wide);
    let expected: Vec<ExpectedLayer> = layers.iter().map(|layer| ExpectedLayer::of(layer, 800, 560)).collect();
    let spread_page = writer.write_page(&layers, None, true).unwrap();
    let check = verify_page(&spread_page, &expected, &canvas);
    assert!(check.problems.is_empty(), "{:?}", check.problems);
    let last = writer
        .write_page(&page(RgbaImage::transparent(400, 560)), None, false)
        .unwrap();
    let report = writer.finish().unwrap();
    let names: Vec<String> = report
        .pages
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["page0001.clip", "page0002.clip", "page0004.clip"]);
    // Pages 2 (right) and 3 (left) on the spread; page 4 is a right page.
    let numbers: Vec<(String, bool)> = story_texts(&spread_page, 2)
        .into_iter()
        .map(|(text, _, _, right)| (text, right))
        .collect();
    assert_eq!(numbers, [("3".to_owned(), false), ("2".to_owned(), true)]);
    assert_eq!(canvas_page(&spread_page), (1, 0));
    assert_eq!(canvas_page(&last), (3, 0));
    let work = report.work.unwrap();
    let check = verify_work(&work, Some(&report.pages));
    assert!(check.problems.is_empty(), "{:?}", check.problems);
    let project = CmcProject::read(&work).unwrap();
    let spreads: Vec<bool> = project.pages.iter().map(|page| page.page_flag == 1).collect();
    assert_eq!(spreads, [false, true, false]);
    assert_eq!(digest(&template_path), before);
}
