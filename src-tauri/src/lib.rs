pub mod audio;
pub mod system;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let active_jobs: audio::convert::ActiveJobs = Arc::new(Mutex::new(HashMap::new()));

    tauri::Builder::default()
        .manage(active_jobs)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // macOS: "Support the developer" in the Help menu, like ds_universal (it opens
            // the same dialog as the header button). Windows and Linux keep no menu bar.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
                use tauri::Emitter;
                let menu = Menu::default(app.handle())?;
                let support = MenuItem::with_id(app, "support", "開発者を支援 (Buy Me a Coffee)...", true, None::<&str>)?;
                let help = menu.items()?.into_iter().find_map(|item| match item {
                    MenuItemKind::Submenu(sub) if sub.text().is_ok_and(|t| t == "Help") => Some(sub),
                    _ => None,
                });
                match help {
                    Some(help) => {
                        help.prepend(&PredefinedMenuItem::separator(app)?)?;
                        help.prepend(&support)?;
                    }
                    None => {
                        let sub = tauri::menu::Submenu::with_items(app, "Help", true, &[&support])?;
                        menu.append(&sub)?;
                    }
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id() == "support" {
                        let _ = app.emit("open-donate-modal", ());
                    }
                });
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio::metadata::read_audio_metadata,
            audio::cue::read_image_tracks_command,
            audio::cue::split_points,
            audio::convert::convert_audio,
            audio::convert::channel_names,
            audio::convert::merge::merge_audio,
            audio::convert::loudness::write_loudness_tags,
            audio::convert::move_output_into_place,
            audio::convert::start_conversion_job,
            audio::convert::cancel_conversion_job,
            audio::convert::finish_conversion_job,
            audio::convert::decode_audio_to_wav,
            audio::convert::cancel_preview,
            audio::convert::set_queued_sources,
            audio::audit::verify_audio_quality,
            system::settings::load_settings,
            system::settings::save_settings,
            system::commands::trash_file,
            system::commands::expand_dropped_paths,
            system::commands::get_default_save_path,
            system::commands::log_debug,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
