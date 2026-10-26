//! Write what the app would show for a .clip, for checking the front end in a
//! browser without Tauri: `<out>/view.json` and `<out>/overview-<layer id>.png`.
//!
//! cargo run -p name-studio-app --example dump_view -- sheet.clip out/

use clip_core::ClipDocument;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        return Err("usage: dump_view <sheet.clip> <output folder>".into());
    };
    std::fs::create_dir_all(output)?;
    let document = ClipDocument::read(input)?;
    let view = name_studio_app::sheet::build_view(&document)?;
    std::fs::write(format!("{output}/view.json"), serde_json::to_string(&view)?)?;
    let factor = (document.canvas.width_px as u32)
        .div_ceil(4096)
        .max(1)
        .next_power_of_two();
    for layer in document.layers() {
        if let Some(image) = document.render_layer_scaled(layer, factor)? {
            std::fs::write(format!("{output}/overview-{}.png", layer.main_id), image.to_png()?)?;
        }
    }
    println!("factor {factor}");
    Ok(())
}
