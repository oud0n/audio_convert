fn main() {
  let mut attributes = tauri_build::Attributes::new();
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
  {
    // tauri-build embeds its manifest (Common Controls v6) only in the app binary, so
    // test binaries fail to start (STATUS_ENTRYPOINT_NOT_FOUND). Embed it for every
    // binary through the linker instead.
    attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
  }
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
