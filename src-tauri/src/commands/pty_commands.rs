use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::cli::registry::{CliMode, CliType, resolve_command};
use crate::error::AppError;
use crate::pty::manager::PtyManager;
use crate::pty::session::ImageAttachment;

const MAX_WRITE_SIZE: usize = 1_048_576;
const MAX_IMAGE_ATTACHMENTS: usize = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnConfig {
    pub cli_type: CliType,
    pub mode: CliMode,
    pub model: Option<String>,
    pub working_dir: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[tauri::command]
pub fn spawn_pty(
    config: PtySpawnConfig,
    state: State<'_, PtyManager>,
    app: AppHandle,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let (command, args) = resolve_command(&config.cli_type, &config.mode, &config.model)?;

    if config.cli_type.uses_stream_session() {
        // Claude Code / Codex: create stream session (no process yet, spawned per message)
        state.create_stream(&id, config.cli_type, command, args, config.working_dir)?;
    } else {
        // Shell: spawn traditional PTY
        let cols = config.cols.unwrap_or(120);
        let rows = config.rows.unwrap_or(30);
        state.spawn_pty(&id, &command, &args, &config.working_dir, cols, rows, app)?;
    }

    Ok(id)
}

/// Send a message to a Claude Code stream session
#[tauri::command]
pub fn send_message(
    pane_id: String,
    message: String,
    images: Option<Vec<ImageAttachment>>,
    state: State<'_, PtyManager>,
    app: AppHandle,
) -> Result<(), AppError> {
    if message.len() > MAX_WRITE_SIZE {
        return Err(AppError::PtyWriteFailed("Message too large".into()));
    }
    if let Some(ref imgs) = images {
        if imgs.len() > MAX_IMAGE_ATTACHMENTS {
            return Err(AppError::PtyWriteFailed(format!(
                "Too many images: {} (max {MAX_IMAGE_ATTACHMENTS})",
                imgs.len()
            )));
        }
    }
    state.send_stream_message(&pane_id, &message, images.as_deref(), app)
}

#[tauri::command]
pub fn write_pty(
    pty_id: String,
    data: String,
    state: State<'_, PtyManager>,
) -> Result<(), AppError> {
    if data.len() > MAX_WRITE_SIZE {
        return Err(AppError::PtyWriteFailed("Data exceeds maximum size".into()));
    }
    state.write(&pty_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_pty(
    pty_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyManager>,
) -> Result<(), AppError> {
    state.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn kill_pty(
    pty_id: String,
    state: State<'_, PtyManager>,
) -> Result<(), AppError> {
    state.kill(&pty_id)
}

#[tauri::command]
pub fn list_session_ids(
    state: State<'_, PtyManager>,
) -> Vec<String> {
    state.list_session_ids()
}

#[tauri::command]
pub fn kill_zombie_sessions(
    keep_ids: Vec<String>,
    state: State<'_, PtyManager>,
) -> u32 {
    state.kill_except(&keep_ids)
}
