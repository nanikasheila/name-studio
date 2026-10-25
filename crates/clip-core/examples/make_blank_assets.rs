//! Makes the built-in template files (assets/) from files CSP EX saved: an
//! empty single page (a left page), a work (.cmc) and a page with a vector
//! line and a plain text layer. The story info is replaced by placeholders
//! and the font by one that comes with Windows; see docs/builtin-template.md.
//!
//! ```text
//! cargo run -p clip-core --example make_blank_assets -- <page.clip> <work.cmc> <sheet.clip> <assets folder>
//! ```

use std::path::{Path, PathBuf};

use clip_core::text::NewText;
use clip_core::vector::NewVectorLine;
use clip_core::write::blank::{PageSetup, StoryFont, apply_setup};
use clip_core::write::editor::ClipEditor;
use clip_core::write::raster_page::{Donors, PageLayer, write_name_page};
use rusqlite::Connection;

fn setup() -> PageSetup {
    PageSetup {
        canvas_mm: [297.0, 420.0],
        resolution: 600.0,
        trim_mm: [257.0, 364.0],
        bleed_mm: 5.0,
        basic_mm: [212.0, 300.0],
        basic_offset_mm: [0.0, 0.0],
        right_binding: true,
        first_page_left: true,
        title: "作品名".to_owned(),
        story_index: Some(1),
        author: "作者名".to_owned(),
        nombre_start: 1,
        font: Some(StoryFont {
            name: "ＭＳ ゴシック".to_owned(),
            postscript: "MS-Gothic".to_owned(),
        }),
    }
}

fn main() {
    let args: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).collect();
    let [page, work, sheet, out] = &args[..] else {
        panic!("usage: make_blank_assets <page.clip> <work.cmc> <sheet.clip> <assets folder>");
    };
    std::fs::create_dir_all(out).unwrap();
    let blank = out.join("blank-page.clip");
    let mut editor = ClipEditor::open(page).unwrap();
    editor.renew_ids().unwrap();
    apply_setup(&mut editor, &setup()).unwrap();
    // Leave nothing of the old texts in freed space.
    editor.db.execute("VACUUM", []).unwrap();
    editor.save(&blank).unwrap();

    let parts = out.join("blank-parts.clip");
    let donors = Donors::find(&blank, std::slice::from_ref(sheet), false).unwrap();
    assert!(
        donors.vector.is_some() && donors.text.is_some(),
        "the sheet needs a vector line and a text"
    );
    let layers = [
        PageLayer::Vector {
            name: "線".to_owned(),
            lines: vec![NewVectorLine {
                points: vec![(1000.0, 1000.0, 1.0), (2000.0, 1000.0, 1.0)],
                closed: false,
                width_px: 10.0,
            }],
        },
        PageLayer::Text(NewText {
            text: "あ".to_owned(),
            frame: [3000, 1000, 3100, 1100],
            font_size_pt: 12.0,
            vertical: true,
            color: None,
            font: None,
            line_spacing: None,
        }),
    ];
    let ids = write_name_page(&blank, &layers, &donors, None, &parts, 0, &Vec::new(), true, &[], &[]).unwrap();
    // The lines and the text are in page px: their layers sit at the origin.
    let mut editor = ClipEditor::open(&parts).unwrap();
    for id in ids {
        editor
            .db
            .execute(
                "UPDATE Layer SET LayerOffsetX = 0, LayerOffsetY = 0, LayerRenderOffscrOffsetX = 0, LayerRenderOffscrOffsetY = 0 WHERE MainId = ?1",
                [id],
            )
            .unwrap();
    }
    editor.renew_ids().unwrap();
    editor.db.execute("VACUUM", []).unwrap();
    editor.save(&parts).unwrap();

    write_work(work, &out.join("blank-work.cmc"));
}

/// The work with placeholder story info and only its first page node.
fn write_work(template: &Path, output: &Path) {
    let data = std::fs::read(template).unwrap();
    let mut db = Connection::open_in_memory().unwrap();
    db.deserialize_read_exact("main", data.as_slice(), data.len(), false)
        .unwrap();
    let setup = setup();
    let font = setup.font.unwrap();
    db.execute(
        "UPDATE Project SET ComicStoryStoryName = ?1, ComicStoryStoryIndex = 1, ComicStoryAuthorName = ?2, \
         ComicStoryNombreFont = ?3, ComicStoryNombreFontPostScriptName = ?4, MaxCanvasFileIndex = 1",
        (&setup.title, &setup.author, &font.name, &font.postscript),
    )
    .unwrap();
    let root: i64 = db
        .query_row("SELECT ProjectRootCanvasNode FROM Project", [], |row| row.get(0))
        .unwrap();
    let first: i64 = db
        .query_row(
            "SELECT FirstChildIndex FROM CanvasNode WHERE MainId = ?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    db.execute("DELETE FROM CanvasNode WHERE MainId NOT IN (?1, ?2)", [root, first])
        .unwrap();
    db.execute(
        "UPDATE CanvasNode SET NextIndex = 0, PageFlag = 0, LinkPath = '.:page0001.clip' WHERE MainId = ?1",
        [first],
    )
    .unwrap();
    db.execute(
        "UPDATE CanvasNode SET SelectedIndex = ?1 WHERE MainId = ?2",
        [first, root],
    )
    .unwrap();
    db.execute(
        "UPDATE ElemScheme SET MaxIndex = ?1 WHERE TableName = 'CanvasNode'",
        [root.max(first)],
    )
    .unwrap();
    db.execute("VACUUM", []).unwrap();
    std::fs::write(output, &*db.serialize("main").unwrap()).unwrap();
}
