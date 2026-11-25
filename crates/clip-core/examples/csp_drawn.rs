//! A page this tool wrote, changed the way drawing in CSP changes it, for
//! the test of 「CSP から読み戻す」 (app/e2e/realapp.mjs):
//!
//! - ラフ線: its first line deleted, its second moved 40 px right, a copy of
//!   its third 200 px lower added (a line drawn in CSP);
//! - コマ枠: its first line (the first panel) moved 30 px right, and a line
//!   straight across the second panel added (cut there);
//! - a new raster layer 「下描き」 with a 60 × 60 px square at (300, 300).
//!
//! ```text
//! cargo run -p clip-core --example csp_drawn -- <page.clip>
//! ```

use std::path::PathBuf;

use clip_core::{ClipDocument, RgbaImage};
use csp_format::ClipFile;
use csp_format::database::select;
use csp_format::vector::{FLAG_CLOSED, VectorData};

fn payload_id(file: &ClipFile, layer: i64) -> String {
    let rows = select(
        file.database(),
        "SELECT VectorData FROM VectorObjectList WHERE LayerId = ?1",
        [layer],
    )
    .expect("vector rows");
    let row = rows.first().expect("a vector layer");
    String::from_utf8_lossy(row.blob("VectorData").expect("vector data")).into_owned()
}

fn main() {
    let path = PathBuf::from(std::env::args().nth(1).expect("usage: csp_drawn <page.clip>"));
    let document = ClipDocument::read(&path).expect("page");
    let id_of = |name: &str| {
        document
            .layers()
            .into_iter()
            .find(|layer| layer.name == name)
            .unwrap_or_else(|| panic!("no layer {name}"))
            .main_id
    };
    let (rough, panels) = (id_of("ラフ線"), id_of("コマ枠"));
    drop(document);
    let mut file = ClipFile::open(&path).expect("page");

    let id = payload_id(&file, rough);
    let mut data = VectorData::parse(file.external(&id).expect("payload")).expect("vector data");
    assert!(data.objects.len() >= 3, "ラフ線 has {} lines", data.objects.len());
    let mut drawn = data.objects[2].clone();
    drawn.transform(1.0, 0.0, 200.0);
    data.objects[1].transform(1.0, 40.0, 0.0);
    data.objects.remove(0);
    data.objects.push(drawn);
    file.set_external(&id, data.to_bytes());

    let id = payload_id(&file, panels);
    let mut data = VectorData::parse(file.external(&id).expect("payload")).expect("vector data");
    assert!(data.objects.len() >= 2, "コマ枠 has {} lines", data.objects.len());
    data.objects[0].transform(1.0, 30.0, 0.0);
    // Straight across the second panel, top to bottom through its middle.
    let target = data.objects[1].clone();
    let points = target.coordinates();
    let (x0, x1) = points
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.0), b.max(p.0)));
    let (y0, y1) = points
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), p| (a.min(p.1), b.max(p.1)));
    let mid = (x0 + x1) / 2.0;
    let mut cut = target.clone();
    cut.points.truncate(2);
    let flags = cut.flags() & !FLAG_CLOSED;
    cut.header[16..20].copy_from_slice(&2u32.to_be_bytes());
    cut.header[20..24].copy_from_slice(&flags.to_be_bytes());
    for (raw, y) in cut.points.iter_mut().zip([y0 - 20.0, y1 + 20.0]) {
        raw[0..8].copy_from_slice(&mid.to_be_bytes());
        raw[8..16].copy_from_slice(&y.to_be_bytes());
    }
    data.objects.push(cut);
    file.set_external(&id, data.to_bytes());

    let mut square = RgbaImage::new(60, 60);
    square.fill([20, 20, 20, 255]);
    file.add_raster_layer("下描き", &square, (300, 300))
        .expect("a raster layer");
    file.save(&path).expect("save");
    println!("drawn on {}", path.display());
}
