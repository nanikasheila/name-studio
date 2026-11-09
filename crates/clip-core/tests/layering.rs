//! The Rust crates in layers, slowest first (docs/DEVELOPMENT.md 「構成」):
//! name-model (the name data itself) ← clip-core (CSP files, through
//! csp-format) ← name-cli and the app. A crate leans only on slower ones, so
//! the name data never changes because CSP's format or the window did.

use std::path::Path;

fn manifest(crate_dir: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(crate_dir)
            .join("Cargo.toml"),
    )
    .unwrap()
}

/// The names in a manifest's [dependencies] (not dev-dependencies: tests may build CSP files).
fn dependencies(manifest: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut inside = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            inside = line == "[dependencies]";
        } else if inside && let Some((name, _)) = line.split_once('=') {
            names.push(name.trim().trim_end_matches(".workspace").to_owned());
        }
    }
    names
}

fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push((path.display().to_string(), std::fs::read_to_string(&path).unwrap()));
        }
    }
}

#[test]
fn the_name_data_knows_nothing_of_csp_or_the_app() {
    let deps = dependencies(&manifest("name-model"));
    for slower in [
        "clip-core",
        "csp-format",
        "csp-assets",
        "name-cli",
        "name-studio-app",
        "tauri",
        "rusqlite",
    ] {
        assert!(
            !deps.iter().any(|dep| dep == slower),
            "name-model depends on {slower}: {deps:?}"
        );
    }
    let mut files = Vec::new();
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../name-model/src"),
        &mut files,
    );
    for (path, text) in files {
        for word in ["clip_core", "csp_format", "csp_assets", "tauri"] {
            assert!(!text.contains(word), "{path} uses {word}");
        }
    }
}

#[test]
fn csp_files_know_nothing_of_the_app() {
    let deps = dependencies(&manifest("clip-core"));
    assert!(deps.iter().any(|dep| dep == "name-model"), "{deps:?}");
    for faster in ["name-cli", "name-studio-app", "tauri"] {
        assert!(
            !deps.iter().any(|dep| dep.starts_with(faster)),
            "clip-core depends on {faster}: {deps:?}"
        );
    }
}

/// CSP's files are SQLite inside, and what their tables and columns mean is
/// csp-format's to know: this crate reads and changes them through its
/// functions, not with SQL of its own. (The builders of synthetic test files
/// in fixtures.rs and the tests' own modules write the tables they need.)
#[test]
fn csp_files_are_changed_only_through_csp_format() {
    for manifest in [
        manifest("clip-core"),
        manifest("name-cli"),
        manifest("../app/src-tauri"),
    ] {
        assert!(
            !dependencies(&manifest).iter().any(|dep| dep == "rusqlite"),
            "SQLite comes through csp_format::rusqlite, so there is one copy of it"
        );
    }
    let mut files = Vec::new();
    for dir in ["../clip-core/src", "../name-cli/src", "../../app/src-tauri/src"] {
        sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join(dir), &mut files);
    }
    for (path, text) in files {
        if path.ends_with("fixtures.rs") {
            continue;
        }
        let code = text.split("#[cfg(test)]").next().unwrap_or_default();
        for call in [
            ".execute(",
            ".execute_batch(",
            ".query_row(",
            ".prepare(",
            ".query_map(",
        ] {
            assert!(!code.contains(call), "{path} has SQL of its own ({call})");
        }
    }
}
