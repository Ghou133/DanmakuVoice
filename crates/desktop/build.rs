fn main() {
    // Tauri stages the native icon in OUT_DIR. Rebuild those resources whenever
    // the artwork changes, including incremental builds with unchanged config.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build();
}
