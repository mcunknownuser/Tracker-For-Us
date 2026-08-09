// Save the standalone report document to Downloads and open it in the
// default browser. The webview (WKWebView on macOS) cannot print — no
// window.print, no print dialog — so "Save as PDF" in the desktop app hands
// the document to the browser, where File → Print → Save as PDF works.
#[tauri::command]
fn save_report_html(title: String, html: String) -> Result<String, String> {
  let home = std::env::var_os("HOME")
    .map(std::path::PathBuf::from)
    .ok_or_else(|| "Could not find your home folder.".to_string())?;
  let downloads = home.join("Downloads");
  let dir = if downloads.is_dir() { downloads } else { home };

  // Keep letters, digits, spaces, dashes and underscores; everything else
  // becomes a dash so the title can't smuggle in a path separator.
  let safe: String = title
    .chars()
    .map(|c| {
      if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
        c
      } else {
        '-'
      }
    })
    .collect();
  let safe = safe.trim();
  let base = if safe.is_empty() { "Report" } else { safe };

  // Never overwrite an earlier export — "Report (2).html" instead.
  let mut path = dir.join(format!("{base}.html"));
  let mut n = 2;
  while path.exists() {
    path = dir.join(format!("{base} ({n}).html"));
    n += 1;
  }

  std::fs::write(&path, html)
    .map_err(|e| format!("Could not save the report to {}: {e}", path.display()))?;

  #[cfg(target_os = "macos")]
  let opened = std::process::Command::new("open").arg(&path).spawn();
  #[cfg(target_os = "windows")]
  let opened = std::process::Command::new("cmd")
    .args(["/C", "start", ""])
    .arg(&path)
    .spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let opened = std::process::Command::new("xdg-open").arg(&path).spawn();

  opened.map_err(|e| {
    format!(
      "The report was saved to {}, but it could not be opened automatically: {e}",
      path.display()
    )
  })?;

  Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    // Process plugin gives us .relaunch() from JS, used by the updater
    // flow after a successful download+install.
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![save_report_html]);

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
