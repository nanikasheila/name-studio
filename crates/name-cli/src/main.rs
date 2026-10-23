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
  name-studio-cli cells <sheet.clip> [--ltr]
  name-studio-cli import <sheet.clip> [--output FILE.namestudio]
  name-studio-cli split <sheet.clip> --template PAGE.clip --out-dir DIR [--pages 1,2] [--fit basic|trim|cell]
                  [--order rtl_ttb|ltr_ttb] [--first-page N] [--name PATTERN] [--cmc NAME]
                  [--story-index N] [--cmc-template WORK.cmc]
  name-studio-cli decode-time <file.clip>
  name-studio-cli subtools <tool.sut|EditImageTool.todb> [--materials DIR] [--tips]
  name-studio-cli check <file.clip|file.cmc|DIR>...   (self-check written pages; exit 1 on problems)
  name-studio-cli spread <page.clip> <spread.clip>   (a 見開き page template from a single page)";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("inspect") => inspect(&args[1..]),
        Some("cells") => cells(&args[1..]),
        Some("decode-time") => decode_time(&args[1..]),
        Some("import") => import(&args[1..]),
        Some("split") => split(&args[1..]),
        Some("subtools") => subtools(&args[1..]),
        Some("check") => check(&args[1..]),
        Some("spread") => spread(&args[1..]),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// Make a spread template from a CSP-made single page; prints its layout.
fn spread(args: &[String]) -> ExitCode {
    let [single, output] = args else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match clip_core::write::spread::make_spread_template(single.as_ref(), output.as_ref()) {
        Ok(layout) => {
            println!("{}", serde_json::to_string(&layout).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

/// Read written pages and works back (folders: every .clip and .cmc in them)
/// and print what the self-check finds, as JSON lines.
fn check(args: &[String]) -> ExitCode {
    use clip_core::write::verify::{check_clip, verify_work};
    if args.is_empty() {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }
    let mut files = Vec::new();
    for arg in args {
        let path = PathBuf::from(arg);
        if path.is_dir() {
            let mut found: Vec<PathBuf> = match std::fs::read_dir(&path) {
                Ok(entries) => entries.flatten().map(|entry| entry.path()).collect(),
                Err(error) => {
                    eprintln!("{}: {error}", path.display());
                    return ExitCode::from(2);
                }
            };
            found.retain(|file| {
                file.extension().is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("clip") || extension.eq_ignore_ascii_case("cmc")
                })
            });
            found.sort();
            files.extend(found);
        } else {
            files.push(path);
        }
    }
    let mut problems = 0;
    for file in &files {
        let is_work = file
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmc"));
        let result = if is_work {
            verify_work(file, None)
        } else {
            check_clip(file)
        };
        problems += result.problems.len();
        println!("{}", serde_json::to_string(&result).expect("check result"));
    }
    eprintln!("{} files, {problems} problems", files.len());
    if problems == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
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

/// Print the page cells found on a name sheet as JSON.
fn cells(args: &[String]) -> ExitCode {
    let Some(input) = args.first() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let order = if args.iter().any(|arg| arg == "--ltr") {
        clip_core::layout::ReadingOrder::LeftToRight
    } else {
        clip_core::layout::ReadingOrder::RightToLeft
    };
    let result = clip_core::ClipDocument::read(input)
        .and_then(|document| clip_core::layout::detect_document_cells(&document, order));
    match result {
        Ok(cells) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&cells).expect("cells always serialize")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Format error: {error}");
            ExitCode::from(1)
        }
    }
}

/// Turn a name sheet into a project file (ネームデータ).
fn import(args: &[String]) -> ExitCode {
    let Some(input) = args.first().map(PathBuf::from) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let output = match args.get(1).map(String::as_str) {
        Some("--output") => match args.get(2) {
            Some(path) => PathBuf::from(path),
            None => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        },
        None => input.with_extension(name_model::EXTENSION),
        Some(_) => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let imported = clip_core::ClipDocument::read(&input)
        .and_then(|document| name_model::import::import_sheet(&document, name_model::PageFormat::default()));
    let (project, warnings) = match imported {
        Ok(result) => result,
        Err(error) => {
            eprintln!("Format error: {error}");
            return ExitCode::from(1);
        }
    };
    for warning in &warnings {
        eprintln!("warning: {warning}");
    }
    if let Err(error) = project.save(&output) {
        eprintln!("Cannot write {}: {error}", output.display());
        return ExitCode::from(1);
    }
    let count = |f: fn(&name_model::Page) -> usize| project.pages.iter().map(f).sum::<usize>();
    println!(
        "Wrote {}: {} pages, {} panels, {} lines, {} strokes",
        output.display(),
        project.pages.len(),
        count(|page| page.panels.len()),
        count(|page| page.lines.len()),
        count(|page| page.strokes.len())
    );
    ExitCode::SUCCESS
}

/// Write one .clip per page of a name sheet (and a .cmc with `--cmc`).
fn split(args: &[String]) -> ExitCode {
    use clip_core::layout::ReadingOrder;
    use clip_core::plan::Fit;
    use clip_core::write::split::{DEFAULT_NAME_PATTERN, SplitOptions, split_sheet};

    let usage = |message: &str| {
        eprintln!("{message}\n{USAGE}");
        ExitCode::from(2)
    };
    let mut sheet = None;
    let (mut template, mut out_dir, mut pages, mut cmc, mut cmc_template, mut story_index) =
        (None, None, None, None, None, None);
    let (mut fit, mut order, mut first_page, mut name) = (
        Fit::Basic,
        ReadingOrder::RightToLeft,
        1,
        DEFAULT_NAME_PATTERN.to_owned(),
    );
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = || iter.next().cloned();
        match arg.as_str() {
            "--template" => template = value().map(PathBuf::from),
            "--out-dir" => out_dir = value().map(PathBuf::from),
            "--pages" => pages = value(),
            "--fit" => {
                fit = match value().as_deref() {
                    Some("basic") => Fit::Basic,
                    Some("trim") => Fit::Trim,
                    Some("cell") => Fit::Cell,
                    _ => return usage("--fit must be basic, trim or cell"),
                }
            }
            "--order" => {
                order = match value().as_deref() {
                    Some("rtl_ttb") => ReadingOrder::RightToLeft,
                    Some("ltr_ttb") => ReadingOrder::LeftToRight,
                    _ => return usage("--order must be rtl_ttb or ltr_ttb"),
                }
            }
            "--first-page" => match value().and_then(|text| text.parse().ok()) {
                Some(number) => first_page = number,
                None => return usage("--first-page must be a number"),
            },
            "--name" => match value() {
                Some(pattern) => name = pattern,
                None => return usage("--name needs a pattern"),
            },
            "--cmc" => cmc = value(),
            "--cmc-template" => cmc_template = value().map(PathBuf::from),
            "--story-index" => match value().and_then(|text| text.parse().ok()) {
                Some(number) => story_index = Some(number),
                None => return usage("--story-index must be a number"),
            },
            _ if sheet.is_none() && !arg.starts_with("--") => sheet = Some(PathBuf::from(arg)),
            _ => return usage(&format!("Unknown option: {arg}")),
        }
    }
    let (Some(sheet), Some(template), Some(out_dir)) = (sheet, template, out_dir) else {
        return usage("split needs a sheet, --template and --out-dir");
    };
    let pages = match pages {
        Some(text) => match text
            .split(',')
            .filter(|part| !part.trim().is_empty())
            .map(|part| part.trim().parse())
            .collect()
        {
            Ok(numbers) => Some(numbers),
            Err(_) => return usage(&format!("--pages must be comma-separated numbers, got {text:?}")),
        },
        None => None,
    };
    let work = match cmc {
        Some(name) => {
            let template = cmc_template.or_else(|| {
                let folder = sheet
                    .parent()
                    .filter(|folder| !folder.as_os_str().is_empty())
                    .unwrap_or(".".as_ref());
                let mut found: Vec<PathBuf> = std::fs::read_dir(folder)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.extension()
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmc"))
                    })
                    .collect();
                found.sort();
                (found.len() == 1).then(|| found.remove(0))
            });
            match template {
                Some(template) => Some((name, template)),
                None => return usage("--cmc needs --cmc-template (no single .cmc found next to the sheet)"),
            }
        }
        None => None,
    };
    let options = SplitOptions {
        sheet,
        template,
        out_dir,
        pages,
        fit,
        order,
        first_page,
        name_pattern: name,
        work,
        story_index,
    };
    match split_sheet(&options) {
        Ok(report) => {
            for page in &report.pages {
                println!("Wrote {} ({} layers)", page.path.display(), page.layers);
                for warning in &page.warnings {
                    eprintln!("Warning: page {}: {warning}", page.number);
                }
            }
            if let Some(work) = &report.work {
                println!("Wrote {} ({} pages)", work.display(), report.pages.len());
            }
            for warning in &report.warnings {
                eprintln!("Warning: {warning}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Format error: {error}");
            ExitCode::from(1)
        }
    }
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

/// Print the pens and erasers of a .sut or of CSP's tool database as JSON.
fn subtools(args: &[String]) -> ExitCode {
    let mut input = None;
    let mut materials = None;
    let mut tips = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--materials" => materials = iter.next().map(PathBuf::from),
            "--tips" => tips = true,
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
    let mut tools = match clip_core::subtool::read_sub_tools(&input, materials.as_deref()) {
        Ok(tools) => tools,
        Err(error) => {
            eprintln!("Format error: {error}");
            return ExitCode::from(1);
        }
    };
    if !tips {
        // The pictures are long; say only how big they are.
        for tool in &mut tools {
            if let Some(tip) = &mut tool.tip {
                tip.png_base64 = format!("({} bytes)", tip.png_base64.len());
            }
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&tools).expect("sub tools always serialize")
    );
    ExitCode::SUCCESS
}
