//! `cargo run -p ipc-types`: write app/src/generated/ipc.ts from the Rust
//! side's commands. `--check` only says whether the file is behind.

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = match ipc_types::generate(&root) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let path = root.join(ipc_types::OUTPUT);
    if std::env::args().any(|arg| arg == "--check") {
        let kept = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
        if kept != text {
            eprintln!(
                "{} is behind the Rust side: run `cargo run -p ipc-types`",
                ipc_types::OUTPUT
            );
            return ExitCode::FAILURE;
        }
        return ExitCode::SUCCESS;
    }
    if let Err(error) = std::fs::write(&path, text) {
        eprintln!("{}: {error}", path.display());
        return ExitCode::FAILURE;
    }
    println!("{}", ipc_types::OUTPUT);
    ExitCode::SUCCESS
}
