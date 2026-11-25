//! A work this tool wrote, its pages changed the way CSP's ページ管理 changes
//! them, for the test of 「CSP から読み戻す」 (app/e2e/realapp.mjs):
//!
//! - a page added after the first (as CSP does: the next file number, the
//!   next node), holding a 60 × 60 px square on a new raster layer 「下描き」
//!   (or, given one, a copy of a page CSP made, as it is);
//! - the third page deleted (out of the work; its file is left);
//! - the fourth page moved in front of the second.
//!
//! ```text
//! cargo run -p clip-core --example csp_pages -- <work.cmc> [<page made in CSP.clip>]
//! ```

use std::path::PathBuf;

use clip_core::RgbaImage;
use csp_format::database::select;
use csp_format::vector::VectorData;
use csp_format::{ClipFile, CmcFile};

fn main() {
    let cmc = PathBuf::from(std::env::args().nth(1).expect("usage: csp_pages <work.cmc>"));
    let dir = cmc.parent().expect("a folder").to_path_buf();
    let mut work = CmcFile::open(&cmc).expect("work");
    let pages: Vec<(i64, PathBuf)> = work
        .pages()
        .expect("pages")
        .iter()
        .map(|node| (node.main_id, dir.join(node.relative_path().expect("a page file"))))
        .collect();
    assert!(pages.len() >= 4, "the work has {} pages", pages.len());

    // A new page after the first: a page of the same size, nothing on it but the square.
    let (added, name) = work.add_page(Some(pages[0].0), false).expect("a page added");
    let path = dir.join(&name);
    if let Some(made) = std::env::args().nth(2) {
        std::fs::copy(&made, &path).expect("the page made in CSP");
    } else {
        blank_with_square(&pages[0].1, &path);
    }
    work.remove_page(pages[2].0).expect("the third page out");
    work.reorder(&[pages[0].0, added, pages[3].0, pages[1].0])
        .expect("reordered");
    work.save(&cmc).expect("save the work");
    println!("pages changed in {}: added {name}", cmc.display());
}

/// A copy of `page` with its vector layers emptied and a square drawn on a new layer.
fn blank_with_square(page: &std::path::Path, path: &std::path::Path) {
    std::fs::copy(page, path).expect("the new page");
    let mut page = ClipFile::open(path).expect("the new page");
    let rows = select(page.database(), "SELECT VectorData FROM VectorObjectList", []).expect("vector rows");
    for row in rows {
        let id = String::from_utf8_lossy(row.blob("VectorData").expect("vector data")).into_owned();
        let mut data = VectorData::parse(page.external(&id).expect("payload")).expect("vector data");
        data.objects.clear();
        page.set_external(&id, data.to_bytes());
    }
    let mut square = RgbaImage::new(60, 60);
    square.fill([20, 20, 20, 255]);
    page.add_raster_layer("下描き", &square, (300, 300))
        .expect("a raster layer");
    page.save(path).expect("save the new page");
}
