//! Command line front end of the name tool's Rust core.
//!
//! `inspect` prints the same JSON as the Python `csp-name-splitter inspect`,
//! so the two implementations can be compared file by file.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

const USAGE: &str = "\
usage:
  name-studio-cli inspect <file.clip|file.cmc> [--pixels] [--output FILE]
  name-studio-cli decode-time <file.clip>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("inspect") => inspect(&args[1..]),
        Some("decode-time") => decode_time(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn inspect(args: &[String]) -> ExitCode {
    let mut input = None;
    let mut output = None;
    let mut include_pixels = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--pixels" => include_pixels = true,
            "--output" => output = iter.next().map(PathBuf::from),
            _ if input.is_none() => input = Some(PathBuf::from(arg)),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(input) = input else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    if !input.exists() {
        eprintln!("Input file not found: {}", input.display());
        return ExitCode::from(2);
    }
    let summary = match clip_core::inspect::inspect_file(&input, include_pixels) {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("Format error: {error}");
            return ExitCode::from(1);
        }
    };
    let text = serde_json::to_string_pretty(&summary).expect("JSON values always serialize");
    match output {
        Some(path) => {
            if let Err(error) = std::fs::write(&path, text + "\n") {
                eprintln!("Cannot write {}: {error}", path.display());
                return ExitCode::from(1);
            }
            println!("Wrote {}", path.display());
        }
        None => println!("{text}"),
    }
    ExitCode::SUCCESS
}

/// Time decoding every raster layer (to compare with the Python reader).
fn decode_time(args: &[String]) -> ExitCode {
    let Some(input) = args.first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let started = Instant::now();
    let document = match clip_core::ClipDocument::read(input) {
        Ok(document) => document,
        Err(error) => {
            eprintln!("Format error: {error}");
            return ExitCode::from(1);
        }
    };
    println!("read: {:.3}s", started.elapsed().as_secs_f64());
    for layer in document.layers() {
        let started = Instant::now();
        match document.render_layer_pixels(layer) {
            Ok(Some(image)) => println!(
                "{} {}x{}: {:.3}s",
                layer.name,
                image.width,
                image.height,
                started.elapsed().as_secs_f64()
            ),
            Ok(None) => {}
            Err(error) => {
                eprintln!("{}: {error}", layer.name);
                return ExitCode::from(1);
            }
        }
    }
    ExitCode::SUCCESS
}
