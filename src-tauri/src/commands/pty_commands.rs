use std::collections::HashMap;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::cli::registry::{CliMode, CliType, resolve_command};
use crate::error::AppError;
use crate::pty::manager::PtyManager;
use crate::pty::session::ImageAttachment;

const MAX_WRITE_SIZE: usize = 1_048_576;
const MAX_IMAGE_ATTACHMENTS: usize = 10;
const MAX_CONFIG_DIR_LEN: usize = 512;

/// Validate a user-supplied config-dir path: no NUL bytes, no path traversal, length-bounded.
fn validate_config_dir(path: &str) -> Result<(), AppError> {
    if path.len() > MAX_CONFIG_DIR_LEN {
        return Err(AppError::PtySpawnFailed(format!(
            "claude_config_dir too long (max {MAX_CONFIG_DIR_LEN} chars)"
        )));
    }
    if path.contains('\0') {
        return Err(AppError::PtySpawnFailed("claude_config_dir contains NUL byte".into()));
    }
    // Reject path-traversal components (bare ".." or "/../" style segments)
    for component in path.split('/') {
        if component == ".." {
            return Err(AppError::PtySpawnFailed("claude_config_dir must not contain '..'".into()));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnConfig {
    pub cli_type: CliType,
    pub mode: CliMode,
    pub model: Option<String>,
    pub working_dir: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Optional CLAUDE_CONFIG_DIR override for account switching.
    pub claude_config_dir: Option<String>,
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
        let mut extra_env: HashMap<String, String> = HashMap::new();
        if let Some(dir) = config.claude_config_dir {
            if !dir.is_empty() {
                validate_config_dir(&dir)?;
                extra_env.insert("CLAUDE_CONFIG_DIR".to_string(), dir);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::validate_config_dir;

    #[test]
    fn allows_tilde_home_path() {
        assert!(validate_config_dir("~/.claude-work").is_ok());
    }

    #[test]
    fn allows_absolute_path() {
        assert!(validate_config_dir("/Users/foo/.claude-work").is_ok());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_config_dir("../../etc/passwd").is_err());
        assert!(validate_config_dir("/valid/path/../etc/passwd").is_err());
    }

    #[test]
    fn rejects_nul_byte() {
        assert!(validate_config_dir("/path/with\0nul").is_err());
    }

    #[test]
    fn rejects_path_exceeding_max_length() {
        let long = "a".repeat(513);
        assert!(validate_config_dir(&long).is_err());
    }

    #[test]
    fn accepts_path_at_max_length() {
        let at_limit = "a".repeat(512);
        assert!(validate_config_dir(&at_limit).is_ok());
    }
}
