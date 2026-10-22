use clip_core::ClipDocument;
use clip_core::fixtures::{FixtureCanvas, FixtureLayer, OPEN, build_clip, rectangle};
use name_model::import::import_sheet;
use name_model::{Character, EmotionPoint, PageFormat, Project, ProjectError, Scene, validate};

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
