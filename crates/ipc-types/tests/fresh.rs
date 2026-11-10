//! The app's TypeScript has the commands as the Rust side has them now.

use std::path::Path;

#[test]
fn the_app_has_the_commands_as_rust_has_them() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = ipc_types::generate(&root).unwrap();
    let kept = std::fs::read_to_string(root.join(ipc_types::OUTPUT))
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert!(
        kept == text,
        "{} is not what the Rust side's commands say: run `cargo run -p ipc-types`",
        ipc_types::OUTPUT
    );
}
