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
    let story = build_tlv(&[(0x0B, runs.collect()), (0x20, 900i32.to_le_bytes().to_vec())]);
    let layers = vec![
        FixtureLayer::paper(2),
        FixtureLayer::raster(3, "レイヤー 1", vec![(0, (0, 0, 0, 0))]),
        FixtureLayer {
            layer_type: 800,
            text: Some("作品 3話".into()),
            text_attributes: Some(story),
            ..FixtureLayer::new(4, "(作品情報)")
        },
    ];
    build_editable_clip(&folder.join("template").join("page.clip"), PAGE, layers)
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
