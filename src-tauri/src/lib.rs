//! NETRUNNER backend.
//!
//! Layering: `commands` (Tauri IPC adapters) → `services` / `system`
//! (domain logic) → `storage` (SQLite). `security` holds execution safeguards
//! used by services. `desktop`, `overlay` and `automation` integrate with the
//! Tauri runtime (tray, windows, background events). See docs/ARCHITECTURE.md.

mod automation;
mod browser;
mod commands;
mod dev;
mod desktop;
mod error;
mod files;
mod neural;
mod alarm;
mod overlay;
mod overlay_snap;
mod security;
mod services;
mod state;
mod storage;
mod system;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use services::activity::{self, Level};
use state::AppState;
use storage::Database;

/// Defence in depth on top of Tauri's ACL (which already refuses remote
/// origins): nothing running in a browser tab or web overlay (`web-*`
/// webviews) may call a NETRUNNER command, whatever page it shows.
fn guarded<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if invoke.message.webview_ref().label().starts_with(browser::LABEL_PREFIX) {
            invoke.resolver.reject("NETRUNNER commands are not available to web pages");
            return true;
        }
        handler(invoke)
    }
}

/// Data folders. Development builds use a `dev` subfolder (or
/// `NETRUNNER_DATA_DIR`), so running one never migrates or changes the
/// installed app's database, wallpapers or browser profile.
fn data_dirs(app: &tauri::AppHandle) -> tauri::Result<(std::path::PathBuf, std::path::PathBuf)> {
    let (data, local) = (app.path().app_data_dir()?, app.path().app_local_data_dir()?);
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("NETRUNNER_DATA_DIR") {
            let dir = std::path::PathBuf::from(dir);
            return Ok((dir.join("roaming"), dir.join("local")));
        }
        return Ok((data.join("dev"), local.join("dev")));
    }
    Ok((data, local))
}

pub fn run() {
    let overlay_hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyO);

    tauri::Builder::default()
        // Must be first: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main(app)))
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: Some("netrunner".into()),
                }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop::AUTOSTART_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &overlay_hotkey && event.state() == ShortcutState::Pressed {
                        overlay::toggle_all(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let (data_dir, local_dir) = data_dirs(app.handle())?;
            let db = Database::open(&data_dir.join("netrunner.db"), &data_dir.join("backups"))?;
            {
                let conn = db.conn()?;
                services::profiles::ensure_seeded(&conn)?;
                activity::record(&conn, Level::Info, "core", &format!("NETRUNNER {} started", app.package_info().version));
            }
            let prefs = browser::Prefs::load(&*db.conn()?);
            app.manage(browser::Browser::new(&data_dir, &local_dir, prefs));
            let alarm_dir = data_dir.clone();
            app.manage(AppState::new(db, data_dir));
            app.manage(dev::terminal::Terminals::default());

            let handle = app.handle().clone();
            desktop::build_tray(&handle)?;
            desktop::apply_launch_mode(&handle);
            #[cfg(windows)]
            desktop::repair_autostart(&handle);
            if let Err(err) = app.global_shortcut().register(overlay_hotkey) {
                // Another app may own the combination; everything else still works.
                log::warn!("overlay hotkey Ctrl+Alt+O unavailable: {err}");
            }
            overlay::restore_on_startup(&handle);
            alarm::start(&handle, alarm_dir);
            browser::start_blocker(handle.clone(), false);
            automation::start_process_watcher(handle.clone());
            std::thread::spawn(move || automation::fire(&handle, "netrunner_start", ""));
            Ok(())
        })
        .on_window_event(desktop::handle_window_event)
        .invoke_handler(guarded(tauri::generate_handler![
            commands::app::app_info,
            commands::app::app_autostart_get,
            commands::app::app_autostart_set,
            commands::app::app_quit,
            commands::app::app_open_url,
            commands::app::app_check_update,
            commands::app::app_install_update,
            commands::settings::settings_get_all,
            commands::settings::settings_set,
            commands::settings::appearance_wallpapers,
            commands::settings::appearance_import_wallpaper,
            commands::settings::appearance_delete_wallpaper,
            commands::settings::appearance_wallpaper_data,
            commands::profiles::profiles_state,
            commands::profiles::profile_create,
            commands::profiles::profile_rename,
            commands::profiles::profile_delete,
            commands::profiles::profile_save_layout,
            commands::profiles::profile_set_widget_config,
            commands::profiles::profile_activate,
            commands::quick_access::qa_list,
            commands::quick_access::qa_create,
            commands::quick_access::qa_update,
            commands::quick_access::qa_set_favorite,
            commands::quick_access::qa_reorder,
            commands::quick_access::qa_delete,
            commands::quick_access::qa_launch,
            commands::quick_access::qa_reveal,
            commands::quick_access::qa_assess_command,
            commands::activity::activity_list,
            commands::activity::activity_clear,
            commands::system::system_info,
            commands::system::system_snapshot,
            commands::system::system_top_processes,
            commands::system::system_terminate_process,
            commands::system::system_startup_list,
            commands::system::system_startup_set,
            commands::system::system_services,
            commands::system::system_power,
            commands::system::system_power_set_plan,
            commands::system::network_status,
            commands::library::games_scan,
            commands::library::games_launch,
            commands::library::games_reveal,
            commands::library::integrations_list,
            commands::library::integration_launch,
            commands::library::automation_list,
            commands::library::automation_create,
            commands::library::automation_update,
            commands::library::automation_delete,
            commands::library::automation_run,
            commands::overlay::overlay_list,
            commands::overlay::overlay_get,
            commands::overlay::overlay_create,
            commands::overlay::overlay_patch,
            commands::overlay::overlay_set_geometry,
            commands::overlay::overlay_set_visible,
            commands::overlay::overlay_delete,
            commands::overlay::overlay_toggle_all,
            commands::studio::studio_list,
            commands::studio::studio_create,
            commands::studio::studio_update,
            commands::studio::studio_set_profile,
            commands::studio::studio_counter,
            commands::studio::studio_delete,
            commands::studio::studio_feed,
            commands::studio::browser_open_request,
            commands::alarms::alarms_state,
            commands::alarms::alarm_save,
            commands::alarms::alarm_set_enabled,
            commands::alarms::alarm_delete,
            commands::alarms::timer_create,
            commands::alarms::timer_control,
            commands::alarms::timer_delete,
            commands::alarms::alarm_stop,
            commands::alarms::alarm_snooze,
            commands::alarms::sounds_list,
            commands::alarms::sound_import,
            commands::alarms::sound_delete,
            commands::alarms::sound_preview,
            commands::alarms::sound_preview_stop,
            commands::notes::notes_board,
            commands::notes::notes_set_text,
            commands::notes::notes_add,
            commands::notes::notes_update,
            commands::notes::notes_delete,
            commands::notes::notes_reorder,
            commands::notes::notes_clear_done,
            commands::dev::dev_projects,
            commands::dev::dev_open_project,
            commands::dev::dev_close_project,
            commands::dev::dev_list_dir,
            commands::dev::dev_read_file,
            commands::dev::dev_write_file,
            commands::dev::dev_create,
            commands::dev::dev_rename,
            commands::dev::dev_delete,
            commands::dev::dev_reveal,
            commands::dev::dev_toolchains,
            commands::dev::term_shells,
            commands::dev::term_spawn,
            commands::dev::term_write,
            commands::dev::term_resize,
            commands::dev::term_kill,
            commands::dev::git_status,
            commands::dev::git_diff,
            commands::dev::git_stage,
            commands::dev::git_unstage,
            commands::dev::git_discard,
            commands::dev::git_commit,
            commands::dev::git_log,
            commands::dev::git_branches,
            commands::dev::git_checkout,
            commands::dev::git_create_branch,
            commands::dev::git_pull,
            commands::dev::git_push,
            commands::dev::git_init,
            commands::dev::git_clone,
            commands::dev::github_status,
            commands::dev::github_connect,
            commands::dev::github_disconnect,
            commands::dev::github_repos,
            commands::dev::github_issues,
            commands::neural::neural_status,
            commands::neural::neural_connect,
            commands::neural::neural_disconnect,
            commands::neural::neural_models,
            commands::neural::neural_preview,
            commands::neural::neural_chat,
            commands::neural::neural_cancel,
            commands::neural::neural_chat_open,
            commands::neural::neural_chat_new,
            commands::neural::neural_chat_delete,
            commands::neural::neural_chat_rename,
            commands::neural::neural_chat_append,
            commands::files::files_places,
            commands::files::files_list,
            commands::files::files_preview,
            commands::files::files_create_dir,
            commands::files::files_rename,
            commands::files::files_transfer,
            commands::files::files_delete,
            commands::files::files_open,
            commands::files::files_reveal,
            commands::files::files_search,
            commands::overlay::overlay_create_web,
            commands::overlay::overlay_set_profile,
            commands::browser::browser_status,
            commands::browser::browser_prefs_changed,
            commands::browser::browser_update_lists,
            commands::browser::browser_tabs,
            commands::browser::browser_open,
            commands::browser::browser_navigate,
            commands::browser::browser_action,
            commands::browser::browser_close,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_zoom,
            commands::browser::browser_allow_http,
            commands::browser::browser_clear_data,
            commands::browser::browser_downloads,
            commands::browser::browser_bookmarks,
            commands::browser::browser_bookmark_add,
            commands::browser::browser_bookmark_rename,
            commands::browser::browser_bookmark_remove,
            commands::browser::browser_history,
            commands::browser::browser_history_clear,
            commands::browser::browser_permissions,
            commands::browser::browser_permission_set,
            commands::browser::browser_pop_out,
            commands::browser::browser_overlay_tab,
            commands::browser::browser_return_tab,
            commands::browser::browser_media,
            commands::browser::browser_media_control,
            commands::browser::browser_media_artwork,
            commands::system::media_status,
            commands::system::media_control,
        ]))
        .run(tauri::generate_context!())
        .expect("error while running NETRUNNER");
}
