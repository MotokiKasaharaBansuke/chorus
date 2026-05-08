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
    if matches!(request.cli_type, CliType::Codex) {
        // Codex headless is Phase 1f territory: `codex exec` reads a
        // single positional prompt and emits `--json` events, but it
        // does not accept stream-json on stdin. We need a small adapter
        // that re-spawns per turn before this path can be lit.
        return Err(AppError::CliNotFound(
            "Codex headless support lands in Phase 1f".into(),
        ));
    }
    let (command, mut args) = resolve_command(&request.cli_type, &request.mode, &request.model)?;

    // Headless flags for Claude Code: stream-json bidirectional pipe,
    // partial messages so the UI can render deltas, and either a fresh
    // `--session-id` or `--resume <existing>` for continuity.
    //
    // `--verbose` is required by `--print` + `--output-format stream-json`
    // on Claude Code 1.x — without it the CLI silently emits nothing.
    if matches!(request.cli_type, CliType::ClaudeCode) {
        args.push("-p".into());
        args.push("--output-format".into());
        args.push("stream-json".into());
        args.push("--input-format".into());
        args.push("stream-json".into());
        args.push("--include-partial-messages".into());
        args.push("--verbose".into());
    }

    // Continuity (`--session-id` first turn / `--resume <id>` after) is
    // owned by `Session` itself, since the per-turn spawn model has to
    // re-emit those flags on every turn and only the session knows
    // whether the upstream id has been observed yet. Validate the
    // resume id here so a bad payload fails fast.
    let initial_session_id = match request.resume_session_at.as_deref() {
        Some(id) => {
            validate_session_id(id).map_err(validation_to_app)?;
            Some(id.to_string())
        }
        None => None,
    };
    if request.fork_session && initial_session_id.is_none() {
        // Silently dropping `fork_session` would mask a client bug; surface it.
        return Err(AppError::PtySpawnFailed(
            "fork_session requires resume_session_at".into(),
        ));
    }

    let config = SessionConfig {
        tab_id: request.tab_id.clone(),
        command,
        args,
        cwd,
        extra_env,
        initial_session_id,
        fork_session: request.fork_session,
    };

    let session = Session::start(config, app).await.map_err(start_to_app)?;
    let tab_id = session.tab_id().to_string();
    state
        .insert(Arc::new(session))
        .map_err(|_| AppError::StreamSessionBusy("session already registered".into()))?;
    Ok(tab_id)
}

/// 256 KiB. Generous for any plausible user turn (Markdown + pasted code)
/// while still preventing a runaway input from monopolising stdin or
/// inflating the IPC payload past Tauri's serialization budget.
///
/// Must stay in sync with `MAX_INPUT_BYTES` in
/// `src/components/headless/headless-input.tsx`. The frontend rejects
/// over-budget input first; this constant is the defence-in-depth line
/// when the renderer is bypassed or compromised.
const MAX_USER_TEXT_BYTES: usize = 256 * 1024;

/// Returns Ok(()) when `text` is within the per-message budget.
/// Extracted so the budget can be exercised by unit tests without
/// spinning up a Tauri runtime.
fn check_user_text_bytes(text: &str) -> Result<(), AppError> {
    if text.len() > MAX_USER_TEXT_BYTES {
        return Err(AppError::PtyWriteFailed(format!(
            "user text {} bytes exceeds {} bytes",
            text.len(),
            MAX_USER_TEXT_BYTES,
        )));
    }
    Ok(())
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
    check_user_text_bytes(&request.text)?;
    let session = state
        .get(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    let request_id = session
        .send_user_message(request.text)
        .await
        .map_err(|e| AppError::PtyWriteFailed(format!("{e}")))?;
    // Per-turn model: the spawn + drain runs on a background tokio task,
    // so the frontend correlates completion via the per-tab event
    // channel rather than awaiting here.
    Ok(request_id.as_str().to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelHeadlessRequest {
    pub tab_id: String,
}

/// Cancel the in-flight turn by SIGKILLing the child group. The
/// underlying `Session::kill_now` is idempotent and a no-op when no
/// turn is in flight, so the UI cancel button can be wired here
/// without extra guards.
#[tauri::command]
pub async fn cancel_headless_message(
    state: State<'_, HeadlessManager>,
    request: CancelHeadlessRequest,
) -> Result<(), AppError> {
    let session = state
        .get(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    session.kill_now();
    Ok(())
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

/// Tear the session down. `Session::kill_now` SIGKILLs the in-flight
/// child, then `Drop` releases the per-tab `SessionLock` and aborts
/// the run task — both are idempotent, so a double-call from the UI
/// is safe.
#[tauri::command]
pub async fn kill_headless(
    state: State<'_, HeadlessManager>,
    request: KillHeadlessRequest,
) -> Result<(), AppError> {
    let session = state
        .remove(&request.tab_id)
        .ok_or_else(|| AppError::PtyNotFound(request.tab_id.clone()))?;
    session.kill_now();
    drop(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_text_within_budget_is_accepted() {
        check_user_text_bytes("hello").expect("ascii hello must pass");
        check_user_text_bytes("").expect("empty text must pass");
    }

    #[test]
    fn user_text_at_exact_budget_is_accepted() {
        let text = "a".repeat(MAX_USER_TEXT_BYTES);
        check_user_text_bytes(&text).expect("exact-cap input must pass");
    }

    #[test]
    fn user_text_one_byte_over_budget_is_rejected() {
        let text = "a".repeat(MAX_USER_TEXT_BYTES + 1);
        let err = check_user_text_bytes(&text).expect_err("over-cap input must reject");
        match err {
            AppError::PtyWriteFailed(msg) => {
                assert!(msg.contains("exceeds"), "{msg}");
                assert!(msg.contains(&MAX_USER_TEXT_BYTES.to_string()), "{msg}");
            }
            other => panic!("expected PtyWriteFailed, got {other:?}"),
        }
    }

    /// Multi-byte UTF-8 characters consume more `len()` bytes than chars,
    /// so the byte-based budget is the right call. This pins the
    /// behaviour: the cap means "256 KiB on the wire", not "256 K chars".
    #[test]
    fn user_text_budget_is_byte_based_not_char_based() {
        // Each '日' is 3 UTF-8 bytes. 90_000 chars ≈ 270 KiB > MAX.
        let text = "日".repeat(90_000);
        assert!(check_user_text_bytes(&text).is_err());
    }
}
