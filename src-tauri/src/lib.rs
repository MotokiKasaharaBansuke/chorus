mod cli;
mod commands;
mod config_path;
mod error;
mod fs;
mod headless;
mod ipc;
mod pty;
mod settings;
mod worktree;

use tauri::Manager;

use commands::{fs_commands, image_commands, pty_commands, session_commands, settings_commands, worktree_commands};
use fs::watcher::WatcherState;
use pty::manager::PtyManager;

/// Parse --directory flag from command line args, fall back to CWD
fn parse_initial_directory() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--directory" {
            return iter.next().cloned();
        }
        if let Some(dir) = arg.strip_prefix("--directory=") {
            return Some(dir.to_string());
        }
    }
    std::env::current_dir().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_initial_directory() -> Option<String> {
    parse_initial_directory()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .finish();
    tracing::subscriber::set_global_default(subscriber).ok();

    if let Some(dir) = parse_initial_directory() {
        tracing::info!(directory = dir, "Launched with directory");
    }

    let pty_manager = PtyManager::new();
    let watcher_state = WatcherState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty_manager)
        .manage(watcher_state)
        .setup(|app| {
            ipc::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_directory,
            pty_commands::spawn_pty,
            pty_commands::send_message,
            pty_commands::write_pty,
            pty_commands::resize_pty,
            pty_commands::kill_pty,
            pty_commands::interrupt_pty,
            pty_commands::list_session_ids,
            pty_commands::get_stream_session_id,
            pty_commands::kill_zombie_sessions,
            pty_commands::list_zombie_sessions,
            pty_commands::kill_session_by_id,
            fs_commands::list_directory,
            fs_commands::read_file,
            fs_commands::watch_directory,
            fs_commands::unwatch_directory,
            fs_commands::session_file_exists,
            fs_commands::cache_session_file,
            fs_commands::restore_session_file,
            fs_commands::list_sessions,
            fs_commands::read_session,
            fs_commands::list_codex_sessions,
            fs_commands::read_codex_session,
            fs_commands::git_changed_files,
            fs_commands::git_has_tracked_changes,
            image_commands::save_temp_image,
            image_commands::import_image_file,
            image_commands::delete_temp_image,
            image_commands::cleanup_temp_images,
            session_commands::save_session,
            session_commands::load_session,
            settings_commands::load_settings,
            settings_commands::save_settings,
            worktree_commands::find_git_repo_root,
            worktree_commands::list_branches,
            worktree_commands::get_current_branch,
            worktree_commands::list_worktrees,
            worktree_commands::create_worktree,
            worktree_commands::remove_worktree,
            worktree_commands::get_disk_usage,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<PtyManager>();
                state.kill_all();
                let _ = image_commands::cleanup_temp_images();
                ipc::cleanup();
                tracing::info!("All PTY sessions killed on window close");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
