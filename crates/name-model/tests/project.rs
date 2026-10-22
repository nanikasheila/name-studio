use clip_core::ClipDocument;
use clip_core::fixtures::{FixtureCanvas, FixtureLayer, OPEN, build_clip, rectangle};
use name_model::import::import_sheet;
use name_model::{
    BalloonShape, Character, EmotionPoint, LineKind, PageFormat, PanelBorder, PanelEffect, PanelFill, Project,
    ProjectError, Scene, TailStyle, validate,
};

/// 100 x 60 mm at 254 dpi = 1000 x 600 px; two pages, right one first.
fn sheet(folder: &std::path::Path) -> std::path::PathBuf {
    let canvas = FixtureCanvas {
        width_mm: 100.0,
        height_mm: 60.0,
        resolution: 254.0,
        double_page: false,
    };
    let template = vec![
        rectangle(520.0, 20.0, 980.0, 580.0),
        rectangle(570.0, 70.0, 930.0, 530.0),
        rectangle(20.0, 20.0, 480.0, 580.0),
        rectangle(70.0, 70.0, 430.0, 530.0),
    ];
    let layers = vec![
        FixtureLayer::paper(2),
        FixtureLayer::vector(3, "枠", template),
        FixtureLayer::vector(
            4,
            "コマ割り",
            vec![
                rectangle(600.0, 100.0, 900.0, 300.0),
                rectangle(100.0, 100.0, 400.0, 250.0),
            ],
        ),
        FixtureLayer::vector(5, "ラフ線", vec![(OPEN, vec![(100.0, 300.0), (200.0, 400.0)])]),
        FixtureLayer::text(6, "こんにちは", [650, 150, 700, 280], 4.0),
        FixtureLayer::raster(7, "下描き", vec![(0, (100, 100, 110, 110)), (3, (0, 0, 10, 10))]),
        FixtureLayer {
            visible: false,
            ..FixtureLayer::vector(8, "非表示", vec![(OPEN, vec![(700.0, 400.0), (800.0, 450.0)])])
        },
    ];
    build_clip(&folder.join("name.clip"), canvas, layers)
}

fn imported() -> (Project, Vec<String>) {
    let folder = tempfile::tempdir().unwrap();
    let document = ClipDocument::read(sheet(folder.path())).unwrap();
    import_sheet(&document, PageFormat::default()).unwrap()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn imports_pages_in_reading_order_onto_the_basic_frame() {
    let (project, warnings) = imported();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(project.title, "name");
    assert_eq!(project.pages.len(), 2);
    let source = project.source.as_ref().unwrap();
    assert_eq!(
        source.cells,
        vec![[520.0, 20.0, 980.0, 580.0], [20.0, 20.0, 480.0, 580.0]]
    );
    // Frame 360 x 460 px onto 180 x 270 mm: 0.5 mm per px, centred.
    let basic = PageFormat::default().basic_box();
    let panel = &project.pages[0].panels[0];
    let (cx, cy) = ((basic[0] + basic[2]) / 2.0, (basic[1] + basic[3]) / 2.0);
    assert!(close(panel.shape[0][0], cx + (600.0 - 750.0) * 0.5));
    assert!(close(panel.shape[0][1], cy + (100.0 - 300.0) * 0.5));
    assert!(close(panel.shape[2][0], cx + (900.0 - 750.0) * 0.5));
    assert_eq!(panel.order, 1);
    assert!(validate(&project).is_empty(), "{:?}", validate(&project));
}

#[test]
fn sorts_contents_into_pages() {
    let (project, _) = imported();
    let (right, left) = (&project.pages[0], &project.pages[1]);
    assert_eq!((right.panels.len(), left.panels.len()), (1, 1));
    // Template frames are neither panels nor strokes; hidden layers are skipped.
    assert!(right.strokes.is_empty());
    assert_eq!(left.strokes.len(), 1);
    assert!(close(left.strokes[0].points[1][0] - left.strokes[0].points[0][0], 50.0));
    let line = &right.lines[0];
    assert_eq!(line.text, "こんにちは");
    assert!(line.vertical);
    assert_eq!(line.panel.as_deref(), Some(right.panels[0].id.as_str()));
    // 4 pt on the sheet at 0.5 mm/px and 254 dpi is 20 pt on the page.
    assert!(close(line.font_size_pt, 20.0));
    assert_eq!(right.roughs.len(), 1);
    assert_eq!(left.roughs.len(), 1);
    assert_eq!(left.roughs[0].layer_name, "下描き");
}

#[test]
fn saves_and_loads_through_json() {
    let (mut project, _) = imported();
    project.characters.push(Character {
        id: "chara1".into(),
        name: "主人公".into(),
        color: Some("#d04040".into()),
    });
    project.pages[0].lines[0].speaker = Some("chara1".into());
    let first = project.pages[0].id.clone();
    project.emotions.push(EmotionPoint {
        character: "chara1".into(),
        page: first.clone(),
        value: 0.5,
        note: String::new(),
    });
    project.scenes.push(Scene {
        id: "scene1".into(),
        title: "出会い".into(),
        summary: String::new(),
        first_page: first.clone(),
        last_page: first,
        story_time: None,
        story_order: None,
    });
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("作品.namestudio");
    project.save(&path).unwrap();
    assert_eq!(Project::load(&path).unwrap(), project);
}

#[test]
fn refuses_broken_projects() {
    let (mut project, _) = imported();
    project.pages[0].lines[0].speaker = Some("nobody".into());
    project.emotions.push(EmotionPoint {
        character: "nobody".into(),
        page: "page999".into(),
        value: 2.0,
        note: String::new(),
    });
    let problems = validate(&project);
    assert!(problems.len() >= 3, "{problems:?}");
    assert!(matches!(project.to_json(), Err(ProjectError::Invalid(_))));
    assert!(matches!(Project::from_json("{}"), Err(ProjectError::Json(_))));
}

/// A project saved by the editor (app/src/project.ts) reads back and saves unchanged.
#[test]
fn reads_what_the_editor_writes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/editor-project.namestudio");
    let project = Project::load(&path).expect("editor project");
    assert_eq!(project.pages.len(), 3);
    let page = &project.pages[1];
    assert_eq!(page.panels.len(), 6);
    assert!(
        page.lines
            .iter()
            .all(|line| line.panel.is_some() && line.balloon.is_some())
    );
    assert_eq!(project.characters.len(), 1);
    assert_eq!(project.pages[2].strokes.len(), 1);
    let again = Project::from_json(&project.to_json().unwrap()).unwrap();
    assert_eq!(again, project);
}

/// Pens taken from CSP and the strokes drawn with them survive a save.
#[test]
fn keeps_brushes_and_the_brush_of_each_stroke() {
    let json = r#"{
      "formatVersion": 1, "title": "t", "binding": "right",
      "pageFormat": {"canvasMm": [297, 420], "trimMm": [257, 364], "basicMm": [180, 270], "basicOffsetMm": [0, 0]},
      "pages": [{"id": "page1", "strokes": [
        {"id": "stroke2", "points": [[1, 2, 0.5], [3, 4, 1]], "widthMm": 0.5, "closed": false, "brush": "brush3", "cut": [false, true]}
      ]}],
      "brushes": [
        {"id": "brush3", "name": "丸ペン", "kind": "pen", "sizeMm": 0.5,
         "sizePressure": {"min": 0, "curve": [[0, 0], [0.66, 0.08], [1, 1]]},
         "opacity": 1, "hardness": 1, "stabilization": 6, "taperInMm": 0.8, "taperOutMm": 0.8,
         "thickness": 100, "rotation": 0,
         "tip": {"pngBase64": "iVBORw0KGgo=", "width": 4, "height": 2, "interval": 10, "enabled": false},
         "source": "CSP: ペン / 丸ペン"},
        {"id": "brush4", "name": "硬め", "kind": "eraser", "sizeMm": 2.5, "erase": "intersection"}
      ],
      "nextId": 5
    }"#;
    let project = Project::from_json(json).unwrap();
    assert_eq!(project.brushes.len(), 2);
    assert_eq!(project.pages[0].strokes[0].brush.as_deref(), Some("brush3"));
    assert_eq!(project.pages[0].strokes[0].cut, Some([false, true]));
    assert_eq!(project.brushes[1].erase, Some(name_model::EraseMode::Intersection));
    assert_eq!(project.brushes[1].opacity, 1.0);
    let again = Project::from_json(&project.to_json().unwrap()).unwrap();
    assert_eq!(again, project);
    let mut broken = project.clone();
    broken.brushes[1].id = "brush3".into();
    broken.brushes[0].size_mm = 0.0;
    assert_eq!(validate(&broken).len(), 2);
}

/// The panel and balloon vocabulary (format 2) as the editor writes it.
#[test]
fn keeps_panel_and_balloon_styles() {
    let text = r##"{
      "formatVersion": 2, "title": "t", "author": "", "binding": "right",
      "pageFormat": {"canvasMm": [297, 420], "trimMm": [257, 364], "basicMm": [180, 270], "basicOffsetMm": [0, 0]},
      "pages": [{
        "id": "page1", "memo": "",
        "panels": [
          {"id": "panel2", "shape": [[58, 0], [238, 0], [238, 120], [58, 120]], "order": 1,
           "border": "wavy", "openEdges": [0], "fill": "black", "effect": "focus", "note": "回想", "spread": "spread9"},
          {"id": "panel3", "shape": [[50, 100], [90, 100], [90, 140], [50, 140]], "order": 2, "fill": "white", "z": 1}
        ],
        "lines": [
          {"id": "line4", "text": "待って", "kind": "speech", "box": [100, 150, 110, 180], "fontSizePt": 13, "vertical": true,
           "balloonShape": "spike", "tails": [{"tip": [90, 200]}, {"tip": [130, 200], "style": "line"}], "inverted": true, "emphasis": true},
          {"id": "line5", "text": "ねえ", "kind": "aside", "box": [80, 150, 90, 170], "fontSizePt": 9, "vertical": true, "linkTo": "line4"}
        ],
        "strokes": [{"id": "stroke6", "points": [[1, 2, 1], [3, 4, 1]], "widthMm": 0.4, "closed": false, "over": true}],
        "roughs": [],
        "breakouts": [{"id": "breakout7", "shape": [[60, 90], [80, 90], [70, 130]], "note": "全身"}]
      }],
      "characters": [], "scenes": [], "emotions": [], "nextId": 10
    }"##;
    let project = Project::from_json(text).expect("format 2 project");
    let page = &project.pages[0];
    assert_eq!(page.panels[0].border, PanelBorder::Wavy);
    assert_eq!(page.panels[0].open_edges, vec![0]);
    assert_eq!(page.panels[0].fill, PanelFill::Black);
    assert_eq!(page.panels[0].effect, PanelEffect::Focus);
    assert_eq!(page.panels[1].z, 1);
    assert_eq!(page.panels[0].spread, "spread9");
    assert_eq!(page.lines[0].balloon_shape, BalloonShape::Spike);
    assert_eq!(page.lines[0].tails[1].style, TailStyle::Line);
    assert_eq!(page.lines[1].kind, LineKind::Aside);
    assert_eq!(page.lines[1].link_to.as_deref(), Some("line4"));
    assert!(page.strokes[0].over);
    assert_eq!(page.breakouts[0].note, "全身");
    let json = project.to_json().unwrap();
    assert!(
        json.contains("\"openEdges\"") && json.contains("\"balloonShape\": \"spike\""),
        "{json}"
    );
    // Defaults are left out, so panels and lines without styles look as before.
    assert!(!json.contains("\"border\": \"solid\""));
    assert_eq!(Project::from_json(&json).unwrap(), project);

    let mut broken = project.clone();
    broken.pages[0].panels[0].open_edges = vec![9];
    broken.pages[0].lines[1].link_to = Some("line404".into());
    // Both halves of a 見開き on one page.
    broken.pages[0].panels[1].spread = "spread9".into();
    let problems = validate(&broken);
    assert_eq!(problems.len(), 3, "{problems:?}");
}
