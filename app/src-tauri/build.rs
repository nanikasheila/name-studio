fn main() {
    // Set by the release workflow: only released builds update themselves.
    println!("cargo:rerun-if-env-changed=NAME_STUDIO_RELEASE");
    tauri_build::build()
}
