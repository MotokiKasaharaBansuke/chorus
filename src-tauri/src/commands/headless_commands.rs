//! Tauri commands for the headless agent pipeline.
//!
//! Naming mirrors the existing PTY commands (`spawn_pty`, `write_pty`,
//! `kill_pty`) so the verb set stays uniform: `spawn_headless`,
//! `write_headless_input`, `cancel_headless_message`, `kill_headless`.
//! Phase 1c will add `resume_headless` / `fork_headless` once stale-lock
//! detection lands.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};
use tracing::warn;

use crate::error::AppError;
use crate::headless::manager::HeadlessManager;
use crate::headless::session::{Session, SessionConfig, SessionStartError};
use crate::headless::validation::{
    sanitize_extra_env, validate_cwd, validate_model, validate_session_id, ValidationError,
};

/// Payload from the frontend for `spawn_headless`. Mirrors `pty_commands`
/// where possible: `tabId`, `cwd`, `extraEnv`. `command` and `args` are
/// pre-resolved by the frontend's CLI registry; we accept them as-is and
/// re-validate the `cwd` here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnHeadlessRequest {
    pub tab_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Optional model override. Forwarded only after validation; an invalid
    /// shape produces an error rather than being silently dropped, since
    /// model selection materially changes user-visible behaviour.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub extra_env: HashMap<String, String>,
}

/// Convert validation errors into `AppError` so the frontend sees a single
/// error shape regardless of which check fired.
fn validation_to_app(e: ValidationError) -> AppError {
    AppError::PtySpawnFailed(format!("validation rejected request: {e:?}"))
}

fn start_to_app(e: SessionStartError) -> AppError {
    match e {
        SessionStartError::AlreadyLocked => {
            AppError::StreamSessionBusy("session already running for this tab".into())
        }
        SessionStartError::Lock(inner) => {
            AppError::PtySpawnFailed(format!("session lock: {inner}"))
        }
        SessionStartError::Spawn(inner) => {
            AppError::PtySpawnFailed(format!("spawn: {inner}"))
        }
    }
}

/// Spawn a headless session and register it in `HeadlessManager`.
///
/// On success the frontend should subscribe to `headless:<tabId>:event`
/// before sending its first `write_headless_input`. The session emits an
/// initial `Status::Idle` so the UI can flip to "ready" without a poll.
#[tauri::command]
pub async fn spawn_headless(
    app: AppHandle,
    state: State<'_, HeadlessManager>,
    request: SpawnHeadlessRequest,
) -> Result<String, AppError> {
    validate_session_id(&request.tab_id).map_err(validation_to_app)?;
    let cwd = validate_cwd(&request.cwd).map_err(validation_to_app)?;
    if let Some(model) = request.model.as_deref() {
        validate_model(model).map_err(validation_to_app)?;
    }
    let (extra_env, rejected) = sanitize_extra_env(request.extra_env);
    if !rejected.is_empty() {
        warn!(
            tab_id = %request.tab_id,
            rejected = ?rejected,
            "headless: dropped sensitive env keys"
        );
    }

    let config = SessionConfig {
        tab_id: request.tab_id.clone(),
        command: request.command,
        args: request.args,
        cwd,
        extra_env,
    };

    let session = Session::start(config, app).await.map_err(start_to_app)?;
    let tab_id = session.tab_id().to_string();
    state
        .insert(Arc::new(session))
        .map_err(|_| AppError::StreamSessionBusy("session already registered".into()))?;
    Ok(tab_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteHeadlessInputRequest {
    pub tab_id: String,
    pub text: String,
}

/// Send a user message to the running session. Returns the request id so
/// the frontend can correlate the assistant reply.
#[tauri::command]
pub async fn write_headless_input(
    state: State<'_, HeadlessManager>,
    request: WriteHeadlessInputRequest,
) -> Result<String, AppError> {
    let session = state
        .get(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    session
        .send_user_message(request.text)
        .await
        .map_err(|e| AppError::PtyWriteFailed(format!("{e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelHeadlessRequest {
    pub tab_id: String,
}

/// Send the protocol-level cancel envelope. Does not kill the process.
#[tauri::command]
pub async fn cancel_headless_message(
    state: State<'_, HeadlessManager>,
    request: CancelHeadlessRequest,
) -> Result<(), AppError> {
    let session = state
        .get(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    session
        .cancel_current()
        .await
        .map_err(|e| AppError::PtyWriteFailed(format!("{e}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillHeadlessRequest {
    pub tab_id: String,
}

/// Tear the session down: graceful close, then SIGTERM/SIGKILL escalation
/// (handled inside the reader task).
#[tauri::command]
pub async fn kill_headless(
    state: State<'_, HeadlessManager>,
    request: KillHeadlessRequest,
) -> Result<(), AppError> {
    let session = state
        .remove(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    session.shutdown().await;
    // Drop releases the SessionLock and lets `kill_on_drop` do final cleanup.
    drop(session);
    Ok(())
}
