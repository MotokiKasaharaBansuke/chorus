use std::collections::HashMap;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::cli::registry::{CliMode, CliType, find_binary, resolve_command};
use crate::error::AppError;
use crate::pty::manager::PtyManager;
use crate::pty::session::ImageAttachment;

const MAX_WRITE_SIZE: usize = 1_048_576;
const MAX_IMAGE_ATTACHMENTS: usize = 10;

/// Allowed (command, args) pairs for ephemeral PTY sessions.
/// Only these exact combinations are permitted via `command_override`.
const EPHEMERAL_ALLOWED: &[(&str, &[&str])] = &[
    ("claude", &["auth", "login"]),
    ("claude", &["auth", "logout"]),
    ("claude", &["auth", "status"]),
    ("claude", &["doctor"]),
];
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnConfig {
    pub cli_type: CliType,
    pub mode: CliMode,
    pub model: Option<String>,
    pub working_dir: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Override the command binary (e.g. "claude") for ephemeral PTY sessions.
    /// When set, spawns a raw PTY with the given command instead of the normal
    /// CLI resolution, ignoring `cli_type` / `mode` / `model`.
    pub command_override: Option<String>,
    /// Arguments for the overridden command.
    pub args_override: Option<Vec<String>>,
}

#[tauri::command]
pub fn spawn_pty(
    config: PtySpawnConfig,
    state: State<'_, PtyManager>,
    app: AppHandle,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();

    // Ephemeral PTY: command_override bypasses normal CLI resolution.
    // Only allow explicitly listed (command, args) pairs to prevent arbitrary execution.
    if let Some(ref cmd_name) = config.command_override {
        let args = config.args_override.unwrap_or_default();
        let args_strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let is_allowed = EPHEMERAL_ALLOWED.iter().any(|(cmd, allowed_args)| {
            *cmd == cmd_name.as_str() && *allowed_args == args_strs.as_slice()
        });
        if !is_allowed {
            return Err(AppError::PtySpawnFailed(
                "Ephemeral command not in allowlist".into(),
            ));
        }
        let command = find_binary(cmd_name)
            .ok_or_else(|| AppError::CliNotFound(format!("{cmd_name} not found")))?
            .to_string_lossy()
            .to_string();
        let cols = config.cols.unwrap_or(120);
        let rows = config.rows.unwrap_or(30);
        state.spawn_pty(&id, &command, &args, &config.working_dir, cols, rows, app)?;
        return Ok(id);
    }

    let (command, args) = resolve_command(&config.cli_type, &config.mode, &config.model)?;

    if config.cli_type.uses_stream_session() {
        let extra_env: HashMap<String, String> = HashMap::new();
        // Claude Code / Codex: create stream session (no process yet, spawned per message)
        state.create_stream(&id, config.cli_type, command, args, config.working_dir, extra_env)?;
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

/// Interrupt a stream session's running child without discarding the
/// session. The next `send_message` on this pty id resumes the same CLI
/// conversation via `--resume`, so the model keeps its context.
#[tauri::command]
pub fn interrupt_pty(
    pty_id: String,
    state: State<'_, PtyManager>,
) -> Result<(), AppError> {
    state.interrupt_stream(&pty_id)
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZombieInfo {
    pub id: String,
    pub cli_type: String,
}

#[tauri::command]
pub fn list_zombie_sessions(
    keep_ids: Vec<String>,
    state: State<'_, PtyManager>,
) -> Vec<ZombieInfo> {
    state
        .list_zombie_infos(&keep_ids)
        .into_iter()
        .map(|(id, cli_type)| ZombieInfo { id, cli_type })
        .collect()
}

#[tauri::command]
pub fn kill_session_by_id(
    id: String,
    state: State<'_, PtyManager>,
) -> bool {
    state.kill_one(&id)
}

