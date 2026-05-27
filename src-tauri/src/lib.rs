#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    // Process plugin gives us .relaunch() from JS, used by the updater
    // flow after a successful download+install.
    .plugin(tauri_plugin_process::init());

  // Updater plugin is desktop-only — the crate isn't available on
  // mobile (see Cargo.toml target-specific dependency).
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
