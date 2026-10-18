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
            audio::convert::convert_audio,
            audio::convert::move_output_into_place,
            audio::convert::start_conversion_job,
            audio::convert::cancel_conversion_job,
            audio::convert::finish_conversion_job,
            audio::convert::decode_audio_to_wav,
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
