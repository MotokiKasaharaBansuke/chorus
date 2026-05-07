//! Tauri commands for the headless agent pipeline.
//!
//! Naming mirrors the existing PTY commands (`spawn_pty`, `write_pty`,
//! `kill_pty`) so the verb set stays uniform: `spawn_headless`,
//! `write_headless_input`, `cancel_headless_message`, `kill_headless`.
//! Resume / fork are folded into `spawn_headless` (the `resumeSessionAt`
//! and `forkSession` fields). Codex resume support follows in Phase 1e.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, State};
use tracing::warn;

use serde::Serialize;

use crate::cli::registry::{resolve_command, CliMode, CliType};
use crate::error::AppError;
use crate::headless::manager::HeadlessManager;
use crate::headless::session::{Session, SessionConfig, SessionStartError};
use crate::headless::system::{force_release_lock, lock_age};
use crate::headless::validation::{
    sanitize_extra_env, validate_cwd, validate_model, validate_session_id, ValidationError,
};

/// Payload from the frontend for `spawn_headless`.
///
/// `cliType` and `mode` are the only knobs the frontend exposes for
/// process selection; the actual binary path and base argv are resolved
/// inside the backend via `cli::registry::resolve_command`. This closes
/// the lateral-movement risk of accepting an arbitrary `command` string —
/// a compromised renderer cannot point Chorus at `/usr/bin/curl` or any
/// other binary outside the registered allowlist.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnHeadlessRequest {
    pub tab_id: String,
    pub cli_type: CliType,
    #[serde(default)]
    pub mode: CliMode,
    pub cwd: String,
    /// Optional model override. Forwarded only after validation; an invalid
    /// shape produces an error rather than being silently dropped, since
    /// model selection materially changes user-visible behaviour.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub extra_env: HashMap<String, String>,
    /// When set, append `--resume <id>` to the Claude argv so the new
    /// process continues an existing session rather than starting fresh.
    /// The id is validated as session-id-shaped before being passed
    /// through, so a crafted value cannot inject arbitrary CLI flags.
    /// Currently only honoured for `CliType::ClaudeCode`; Codex resume
    /// uses the `codex exec resume <id>` subcommand and lands in Phase 1e.
    #[serde(default)]
    pub resume_session_at: Option<String>,
    /// When true and `resume_session_at` is set, also append
    /// `--fork-session` so Claude assigns a fresh session id rather than
    /// appending to the parent. Without `resume_session_at` this flag is
    /// a no-op (consistent with Claude's CLI semantics).
    #[serde(default)]
    pub fork_session: bool,
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
        SessionStartError::HealthCheckFailed(msg) => {
            AppError::PtySpawnFailed(format!("health check: {msg}"))
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

    // Resolve binary + base argv inside the backend so the renderer can
    // never point us at an unregistered binary. `Shell` is excluded from
    // the headless pipeline — it has no JSONL contract.
    if matches!(request.cli_type, CliType::Shell) {
        return Err(AppError::CliNotFound(
            "Shell CliType is not supported by headless pipeline".into(),
        ));
    }
    let (command, mut args) = resolve_command(&request.cli_type, &request.mode, &request.model)?;

    // Append resume / fork flags for Claude. Codex resume uses a different
    // subcommand path and lands in Phase 1e.
    if matches!(request.cli_type, CliType::ClaudeCode) {
        if let Some(session_id) = request.resume_session_at.as_deref() {
            validate_session_id(session_id).map_err(validation_to_app)?;
            args.push("--resume".into());
            args.push(session_id.into());
            if request.fork_session {
                args.push("--fork-session".into());
            }
        } else if request.fork_session {
            // Fail fast — silently dropping `fork_session` would mask a
            // client bug where the user intended to fork. Surface it so
            // the frontend can correct the argument shape.
            return Err(AppError::PtySpawnFailed(
                "fork_session requires resume_session_at".into(),
            ));
        }
    }

    let config = SessionConfig {
        tab_id: request.tab_id.clone(),
        command,
        args,
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
/// the frontend can correlate the assistant reply via the per-tab event
/// channel.
#[tauri::command]
pub async fn write_headless_input(
    state: State<'_, HeadlessManager>,
    request: WriteHeadlessInputRequest,
) -> Result<String, AppError> {
    let session = state
        .get(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    let pending = session
        .send_user_message(request.text)
        .await
        .map_err(|e| AppError::PtyWriteFailed(format!("{e}")))?;
    // The frontend correlates completion via the per-tab event channel;
    // the outcome receiver is dropped here so the session GC can reclaim
    // the pending entry once it is no longer needed.
    Ok(pending.id.as_str().to_string())
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectHeadlessLockRequest {
    pub tab_id: String,
}

/// Per-tab lock diagnostic surface for the frontend's "session already
/// running" UI. `None` means no lock file exists; a present age lets the
/// UI decide whether to offer a force-release prompt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectHeadlessLockResponse {
    pub age_seconds: Option<u64>,
}

/// Inspect the lock file for `tabId` without trying to acquire it.
#[tauri::command]
pub async fn inspect_headless_lock(
    request: InspectHeadlessLockRequest,
) -> Result<InspectHeadlessLockResponse, AppError> {
    validate_session_id(&request.tab_id).map_err(validation_to_app)?;
    let age = lock_age(&request.tab_id)
        .map_err(|e| AppError::PtySpawnFailed(format!("lock_age: {e}")))?;
    Ok(InspectHeadlessLockResponse {
        age_seconds: age.map(|d| d.as_secs()),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceReleaseHeadlessLockRequest {
    pub tab_id: String,
}

/// Forcibly remove the lock file for `tabId`. Frontend must have first
/// shown the user the lock age via `inspect_headless_lock` and obtained
/// explicit consent — this function performs no consent or staleness
/// checks of its own.
#[tauri::command]
pub async fn force_release_headless_lock(
    request: ForceReleaseHeadlessLockRequest,
) -> Result<(), AppError> {
    validate_session_id(&request.tab_id).map_err(validation_to_app)?;
    force_release_lock(&request.tab_id)
        .map_err(|e| AppError::PtySpawnFailed(format!("force_release: {e}")))
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
    // Already-closed is not a hard error here — `kill_headless` is meant to
    // be idempotent. Log at debug so the double-shutdown case is still
    // observable in trace builds. Drop still releases the SessionLock and
    // triggers `kill_on_drop` for the underlying child.
    if let Err(e) = session.shutdown().await {
        tracing::debug!(tab_id = %request.tab_id, "shutdown returned: {e}");
    }
    drop(session);
    Ok(())
}
