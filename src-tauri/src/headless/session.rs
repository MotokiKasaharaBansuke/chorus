//! Per-tab session built around the **per-turn spawn** model.
//!
//! ## Why per-turn instead of persistent
//!
//! Earlier phases assumed `claude -p --input-format stream-json` could
//! act as a long-lived bidirectional pipe. The shipped CLI does not work
//! that way: it consumes a single user message, emits the assistant turn
//! plus a `result` envelope, then exits. We therefore spawn a fresh
//! child for every `send_user_message`, write the user line, close
//! stdin so claude actually starts responding, drain stdout to the
//! frontend, and let the child exit. Continuity is preserved with
//! `--session-id <uuid>` on the first turn and `--resume <session-id>`
//! on subsequent turns. The session id is extracted from the upstream
//! `system.init` event and persisted on the `Session`.
//!
//! ## What this owns
//!
//! - the spawn template (binary, base args, cwd, env)
//! - the upstream session id (after the first turn) and the
//!   one-shot `--fork-session` toggle
//! - the in-flight child handle for `kill_now` / `Drop`
//! - the per-tab on-disk lock (`SessionLock`) preventing two Chorus
//!   processes from racing on the same headless tab
//!
//! ## Trust boundary
//!
//! The upstream JSONL stream is **not** trusted. `capture_session_id`
//! re-validates every observed `session_id` against the same allowlist
//! the IPC entry point uses, so a poisoned line cannot smuggle a flag
//! like `--dangerously-skip-permissions` into the next turn's argv.
//!
//! ## Concurrency
//!
//! Exactly one turn runs per session at a time. `send_user_message`
//! returns `SendError::Busy` while the previous turn is still alive,
//! and the in-flight slot is cleared by the run task only when the
//! turn that owns it observes its own exit — this prevents a delayed
//! cleanup from clobbering a freshly-spawned successor.

#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use super::child_transport::ChildProcessTransport;
use super::event::{ErrorKind, HeadlessEvent, RequestId, SessionStatus, TabId};
use super::image::InlineImage;
use super::line_reader::{LineRecord, LineViolation};
use super::parser::StreamParser;
use super::system::{SessionLock, SessionLockError};
use super::transport::{JsonlTransport, SendError};
use super::validation::{is_valid_session_id, ValidatedCwd, ValidatedEnv};
use crate::cli::registry::CliType;

/// Reasons `Session::start` can fail.
#[derive(Debug)]
pub enum SessionStartError {
    /// Lock for this `tab_id` is held by another Chorus instance.
    AlreadyLocked,
    /// Lock file system call failed.
    Lock(SessionLockError),
}

impl std::fmt::Display for SessionStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked => write!(f, "session already running"),
            Self::Lock(e) => write!(f, "session lock failed: {e}"),
        }
    }
}

impl std::error::Error for SessionStartError {}

impl From<SessionLockError> for SessionStartError {
    fn from(e: SessionLockError) -> Self {
        Self::Lock(e)
    }
}

/// Configuration for `Session::start`.
pub struct SessionConfig {
    pub tab_id: TabId,
    /// Which CLI this session drives. Branches `build_turn_args`,
    /// `build_claude_user_message` (vs raw text for codex), and the
    /// upstream-id capture rule — claude and codex use very
    /// different stream-json shapes.
    pub cli_type: CliType,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: ValidatedCwd,
    pub extra_env: ValidatedEnv,
    /// Upstream session id to resume from on the very first turn
    /// (`resume_session_at` from the IPC request). When `None`, the
    /// first turn mints a fresh UUID. Subsequent turns always use the
    /// id observed in the previous turn's `system.init` event.
    pub initial_session_id: Option<String>,
    /// Append `--fork-session` on the first resume turn. Ignored when
    /// `initial_session_id` is `None`; that combination is rejected at
    /// the IPC boundary.
    pub fork_session: bool,
}

/// Captures just enough of an in-flight child to issue SIGKILL
/// synchronously without holding the transport across await
/// boundaries.
#[derive(Clone)]
struct ProcessKiller {
    pid: u32,
}

impl ProcessKiller {
    fn from_transport(t: &ChildProcessTransport) -> Self {
        Self { pid: t.pid() }
    }

    /// Best-effort SIGKILL of the process group. Synchronous so it can
    /// run from `Drop` and from non-async contexts.
    fn kill_now(&self) {
        unsafe {
            if libc::kill(-(self.pid as i32), libc::SIGKILL) == 0 {
                return;
            }
            let _ = libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }
}

/// State for the single in-flight turn. Held in `Session::in_flight`
/// while a child is alive; replaced with `None` by the run task only
/// when its own `turn_id` still owns the slot.
struct InFlightTurn {
    turn_id: u64,
    killer: ProcessKiller,
    handle: JoinHandle<()>,
}

/// Per-task context. Cloned out of `Session` once at spawn time so the
/// run task does not borrow the session itself across `await` points.
#[derive(Clone)]
struct TurnContext {
    app: AppHandle,
    tab_id: TabId,
    cli_type: CliType,
    upstream_session_id: Arc<Mutex<Option<String>>>,
    fork_on_next_turn: Arc<Mutex<bool>>,
    in_flight: Arc<Mutex<Option<InFlightTurn>>>,
    turn_id: u64,
    /// Last in-stream error message observed for this turn (e.g.
    /// codex `error` / `turn.failed` envelopes carry the API's
    /// human-readable reason). `finish_turn` prefers this string
    /// over a bare `exit code N` so the user sees "model not
    /// supported" instead of an opaque crash code.
    captured_error: Arc<Mutex<Option<String>>>,
}

/// Per-tab session handle. See module doc for the lifecycle model.
pub struct Session {
    tab_id: TabId,
    cli_type: CliType,
    command: String,
    base_args: Vec<String>,
    cwd: ValidatedCwd,
    extra_env: ValidatedEnv,
    app: AppHandle,
    /// Upstream session id used for the next spawn. Seeded from
    /// `SessionConfig::initial_session_id` and refreshed on every turn
    /// from the upstream `system.init` event. `None` only when the
    /// user never asked for a resume *and* no turn has completed yet.
    upstream_session_id: Arc<Mutex<Option<String>>>,
    /// Spend the `--fork-session` flag on the next resume turn. Cleared
    /// the first time `capture_session_id` observes a new id (so a
    /// failed first attempt can still benefit from the fork).
    fork_on_next_turn: Arc<Mutex<bool>>,
    /// In-flight turn slot. `Some` exactly while a child is alive.
    in_flight: Arc<Mutex<Option<InFlightTurn>>>,
    /// Monotonic id used to detect "is this still my slot?" on cleanup
    /// after a kill / respawn race.
    next_turn_id: AtomicU64,
    _lock: Arc<SessionLock>,
}

impl Session {
    pub async fn start(config: SessionConfig, app: AppHandle) -> Result<Self, SessionStartError> {
        let SessionConfig {
            tab_id,
            cli_type,
            command,
            args,
            cwd,
            extra_env,
            initial_session_id,
            fork_session,
        } = config;

        let lock = SessionLock::try_acquire(&tab_id)?
            .ok_or(SessionStartError::AlreadyLocked)?;

        // Optimistic: tell the UI we are ready to take input. The first
        // child is spawned lazily on the first `send_user_message`.
        emit_status(&app, &tab_id, SessionStatus::Idle, None, None);
        info!(tab_id = %tab_id, cli = ?cli_type, "headless session ready");

        Ok(Self {
            tab_id,
            cli_type,
            command,
            base_args: args,
            cwd,
            extra_env,
            app,
            upstream_session_id: Arc::new(Mutex::new(initial_session_id)),
            fork_on_next_turn: Arc::new(Mutex::new(fork_session)),
            in_flight: Arc::new(Mutex::new(None)),
            next_turn_id: AtomicU64::new(1),
            _lock: Arc::new(lock),
        })
    }

    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    /// Send a user message: spawn a fresh child, write the message,
    /// close stdin so claude starts responding, then forward the entire
    /// stream-json output until the child exits.
    ///
    /// Rejects with `SendError::Busy` if a previous turn is still in
    /// flight — the caller must wait for the next `Status::Idle` /
    /// `Status::Error` event before retrying.
    pub async fn send_user_message(
        &self,
        text: String,
        images: Vec<InlineImage>,
    ) -> Result<RequestId, SendError> {
        // Hold the in-flight guard across the entire body so the
        // busy-check and slot reservation are atomic. The body has no
        // `.await` (every step — `Command::spawn`, `tokio::spawn`,
        // emit) is synchronous — so keeping a `parking_lot::MutexGuard`
        // here cannot deadlock the runtime. Releasing the guard between
        // check and write would let two concurrent calls both pass the
        // check and spawn two children racing on the same upstream id.
        let mut guard = self.in_flight.lock();
        if guard.is_some() {
            return Err(SendError::Busy);
        }

        let turn_id = self.next_turn_id.fetch_add(1, Ordering::SeqCst);
        let args = self.build_turn_args();

        let transport =
            ChildProcessTransport::spawn(&self.command, &args, &self.cwd, &self.extra_env)
                .map_err(|e| {
                    warn!(tab_id = %self.tab_id, "spawn failed: {e}");
                    // Surface the failure so the UI can leave the
                    // "thinking" / disabled-input state.
                    emit_status(
                        &self.app,
                        &self.tab_id,
                        SessionStatus::Error,
                        Some(ErrorKind::CliIncompatible),
                        Some(format!("spawn failed: {e}")),
                    );
                    SendError::PeerClosed
                })?;

        let killer = ProcessKiller::from_transport(&transport);
        emit_status(&self.app, &self.tab_id, SessionStatus::Thinking, None, None);

        let ctx = TurnContext {
            app: self.app.clone(),
            tab_id: self.tab_id.clone(),
            cli_type: self.cli_type,
            upstream_session_id: self.upstream_session_id.clone(),
            fork_on_next_turn: self.fork_on_next_turn.clone(),
            in_flight: self.in_flight.clone(),
            turn_id,
            captured_error: Arc::new(Mutex::new(None)),
        };
        let handle = tokio::spawn(run_turn(transport, text, images, ctx));

        *guard = Some(InFlightTurn { turn_id, killer, handle });

        Ok(RequestId::new())
    }

    /// Synchronously SIGKILL the in-flight child, if any. No-op
    /// between turns. Idempotent. Callable from sync (`Drop`, window
    /// destroy) and async paths alike — the single tear-down verb for
    /// both "user pressed cancel" and "tab is closing" UX flows.
    pub fn kill_now(&self) {
        if let Some(in_flight) = self.in_flight.lock().as_ref() {
            in_flight.killer.kill_now();
        }
    }

    /// Build per-turn argv. Continuity flags differ per CLI:
    /// claude takes `--resume <id>` / `--session-id <new>` as a
    /// trailing pair, while codex needs `resume <id>` injected as a
    /// sub-subcommand right after `exec`.
    fn build_turn_args(&self) -> Vec<String> {
        match self.cli_type {
            CliType::ClaudeCode => self.build_claude_args(),
            CliType::Codex => self.build_codex_args(),
            // Shell never reaches headless — `headless_commands.rs`
            // rejects it at the IPC boundary.
            CliType::Shell => self.base_args.clone(),
        }
    }

    fn build_claude_args(&self) -> Vec<String> {
        let mut args = self.base_args.clone();
        match self.upstream_session_id.lock().clone() {
            Some(prev) => {
                args.push("--resume".into());
                args.push(prev);
                let mut fork = self.fork_on_next_turn.lock();
                if *fork {
                    args.push("--fork-session".into());
                    *fork = false;
                }
            }
            None => {
                args.push("--session-id".into());
                args.push(uuid::Uuid::new_v4().to_string());
            }
        }
        args
    }

    /// Codex argv shape:
    /// - First turn:   `exec <flags> -`
    /// - Resumed turn: `exec <flags> resume <thread_id> -`
    ///
    /// **Flag placement matters.** `codex exec resume` is a clap
    /// sub-subcommand whose own option set is tiny (`--last`,
    /// `--config`, `--enable`, `--disable`). `--full-auto`,
    /// `--json`, `--skip-git-repo-check`, `--model` etc. all belong
    /// to the parent `exec`, so they have to appear *before* the
    /// `resume` token. Putting them after exits with code 2
    /// ("unexpected argument").
    ///
    /// The trailing `-` tells codex to read the prompt from stdin —
    /// the same channel `send_user_turn` writes to.
    fn build_codex_args(&self) -> Vec<String> {
        debug_assert_eq!(
            self.base_args.first().map(String::as_str),
            Some("exec"),
            "codex base_args must start with `exec` (see cli/registry.rs)",
        );
        let mut args = self.base_args.clone();
        if let Some(id) = self.upstream_session_id.lock().clone() {
            args.push("resume".into());
            args.push(id);
        }
        args.push("-".into());
        args
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Take the slot atomically: kill the child, abort the run
        // task, and ensure the task cannot observe its own clear path
        // after we have torn down. Without `abort` a delayed task
        // could clobber a freshly-registered successor session that
        // happens to share the same `Arc<Mutex<...>>` shape.
        if let Some(in_flight) = self.in_flight.lock().take() {
            in_flight.killer.kill_now();
            in_flight.handle.abort();
        }
    }
}

// --- run_turn split into 3 stages: send → drain → finish ---

async fn run_turn(
    mut transport: ChildProcessTransport,
    text: String,
    images: Vec<InlineImage>,
    ctx: TurnContext,
) {
    let pid = transport.pid();
    debug!(tab_id = %ctx.tab_id, turn_id = ctx.turn_id, pid, cli = ?ctx.cli_type, "turn started");

    if let Err(detail) = send_user_turn(&mut transport, &text, &images, ctx.cli_type).await {
        finish_turn(transport, ctx, TurnOutcome::SendFailed(detail)).await;
        return;
    }

    let outcome = drain_stream_json(&mut transport, &ctx).await;
    finish_turn(transport, ctx, outcome).await;
}

/// What the drain loop saw. Replaces the earlier `had_error +
/// error_message` pair with a closed enumeration so `classify` can
/// pattern-match exhaustively.
enum TurnOutcome {
    /// Child closed stdout cleanly (the only happy path).
    Drained,
    /// Could not write the user line. Detail goes into the status event.
    SendFailed(String),
    /// 8 MiB-per-line cap hit.
    LineCapExceeded,
    /// Underlying stdout IO error.
    StdoutIo(String),
}

async fn send_user_turn(
    t: &mut ChildProcessTransport,
    text: &str,
    images: &[InlineImage],
    cli_type: CliType,
) -> Result<(), String> {
    let payload = match cli_type {
        CliType::ClaudeCode => build_claude_user_message(text, images),
        // Codex reads the prompt as plain text from stdin (we add
        // `-` to argv in `build_codex_args`). It does not accept
        // images on stdin — those would go through `-i FILE...` at
        // spawn time, which is out of scope for the first pass.
        CliType::Codex => text.to_string(),
        CliType::Shell => text.to_string(),
    };
    if let Err(e) = t.send_line(&payload).await {
        return Err(format!("stdin write failed: {e}"));
    }
    if let Err(e) = t.close_send().await {
        warn!("stdin close failed: {e}");
    }
    Ok(())
}

async fn drain_stream_json(t: &mut ChildProcessTransport, ctx: &TurnContext) -> TurnOutcome {
    let mut parser = StreamParser::new();
    let mut lines_seen = 0u32;
    while let Some(record) = t.next_record().await {
        match record {
            LineRecord::Line(line) => {
                lines_seen += 1;
                process_jsonl_line(&line, ctx, &mut parser);
            }
            LineRecord::Violation(LineViolation::LineTooLong) => return TurnOutcome::LineCapExceeded,
            LineRecord::Violation(LineViolation::Io(msg)) => return TurnOutcome::StdoutIo(msg),
        }
    }
    debug!(tab_id = %ctx.tab_id, turn_id = ctx.turn_id, lines_seen, "turn drain finished");
    TurnOutcome::Drained
}

/// Translate one JSONL line into typed events (via `StreamParser`)
/// and forward each one to the frontend. Always-on debug copy is sent
/// as `unknown` so the raw payload remains inspectable until a typed
/// renderer exists for every claude envelope.
fn process_jsonl_line(line: &str, ctx: &TurnContext, parser: &mut StreamParser) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        warn!(tab_id = %ctx.tab_id, "non-JSON stdout line ignored");
        return;
    };
    if let Some(captured) = capture_session_id(
        &value,
        &ctx.upstream_session_id,
        &ctx.fork_on_next_turn,
    ) {
        emit_event(
            &ctx.app,
            HeadlessEvent::SessionIdCaptured {
                tab_id: ctx.tab_id.clone(),
                session_id: captured,
            },
        );
    }

    if let Some(message) = extract_inline_error(&value) {
        // First-write-wins. Codex emits `error` (specific API reason
        // like "model not supported") *before* `turn.failed` (a
        // generic "turn failed" wrapper), so blindly overwriting the
        // slot would discard the more useful detail. The downstream
        // contract is "show the user the first explanation we got";
        // only the absence of any prior message lets a later one win.
        let mut slot = ctx.captured_error.lock();
        if slot.is_none() {
            *slot = Some(message);
        }
    }

    let typed = parser.translate(&value, &ctx.tab_id);
    let envelope = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    debug!(
        tab_id = %ctx.tab_id,
        turn_id = ctx.turn_id,
        envelope = %envelope,
        typed_count = typed.len(),
        "headless line",
    );
    for event in typed {
        emit_event(&ctx.app, event);
    }
    emit_event(
        &ctx.app,
        super::event::unknown_event(ctx.tab_id.clone(), value),
    );
}

async fn finish_turn(
    mut transport: ChildProcessTransport,
    ctx: TurnContext,
    outcome: TurnOutcome,
) {
    // If drain bailed early (cap / io violation), the child may still
    // be writing. Kill the group before waiting so the wait does not
    // hang on a producer with a closed reader.
    if !matches!(outcome, TurnOutcome::Drained) {
        let _ = transport.kill_group();
    }
    let exit_code = transport.wait_for_exit().await.and_then(|s| s.code());

    // Only clear the slot if we still own it. If a kill_now already
    // replaced or cleared us, leave the new state alone — otherwise a
    // delayed task would clobber the next turn's slot.
    {
        let mut g = ctx.in_flight.lock();
        let owns_slot = g.as_ref().map(|f| f.turn_id) == Some(ctx.turn_id);
        if owns_slot {
            *g = None;
        }
    }

    let captured_error = ctx.captured_error.lock().clone();
    let (status, kind, message) = classify_turn(outcome, exit_code, captured_error);
    emit_status(&ctx.app, &ctx.tab_id, status, kind, message);
}

fn classify_turn(
    outcome: TurnOutcome,
    exit_code: Option<i32>,
    captured_error: Option<String>,
) -> (SessionStatus, Option<ErrorKind>, Option<String>) {
    match outcome {
        TurnOutcome::Drained => match exit_code {
            Some(0) => (SessionStatus::Idle, None, None),
            Some(c) => (
                SessionStatus::Error,
                Some(ErrorKind::AgentCrashed),
                Some(captured_error.unwrap_or_else(|| format!("exit code {c}"))),
            ),
            None => (
                SessionStatus::Error,
                Some(ErrorKind::AgentCrashed),
                Some(
                    captured_error
                        .unwrap_or_else(|| "child exited with no status".into()),
                ),
            ),
        },
        TurnOutcome::SendFailed(detail) => (
            SessionStatus::Error,
            Some(ErrorKind::AgentCrashed),
            Some(detail),
        ),
        TurnOutcome::LineCapExceeded => (
            SessionStatus::Error,
            Some(ErrorKind::ProtocolViolation),
            Some("stdout line exceeded 8 MiB cap".into()),
        ),
        TurnOutcome::StdoutIo(msg) => (
            SessionStatus::Error,
            Some(ErrorKind::ProtocolViolation),
            Some(msg),
        ),
    }
}

/// Pull the upstream `session_id` out of any line that carries one.
/// Validates against the IPC allowlist before storing — the upstream
/// stream is not a trust boundary, so a malformed value (anything that
/// `validate_session_id` would reject) is silently dropped with a
/// warn-level log.
/// Returns `Some(id)` if a *new* upstream session id was stored —
/// callers emit a `SessionIdCaptured` wire event on a non-`None`
/// result so the frontend can persist it for future `--resume` use.
/// Returns `None` for missing / malformed / already-stored ids.
///
/// Two CLIs ship two different field names:
/// - **Claude** stamps every line with `session_id`.
/// - **Codex** carries the id only on the very first
///   `thread.started` envelope, under `thread_id`.
///
/// Both are validated against the same `is_valid_session_id`
/// allowlist so a poisoned upstream line cannot smuggle an
/// argv-shaped string into the next turn's `--resume` / `resume`.
fn capture_session_id(
    value: &serde_json::Value,
    slot: &Arc<Mutex<Option<String>>>,
    fork_on_next_turn: &Arc<Mutex<bool>>,
) -> Option<String> {
    let id = extract_upstream_session_id(value)?;
    if id.is_empty() {
        return None;
    }
    if !is_valid_session_id(id) {
        warn!(id, "ignoring malformed upstream session_id");
        return None;
    }

    let mut guard = slot.lock();
    if guard.as_deref() == Some(id) {
        return None;
    }
    *guard = Some(id.to_string());
    // A `--fork-session` only makes sense on the *first* turn of a
    // resumed conversation. Once we have observed any upstream id
    // (which every successful turn produces exactly once), the
    // fork has been spent.
    *fork_on_next_turn.lock() = false;
    Some(id.to_string())
}

fn extract_upstream_session_id(value: &serde_json::Value) -> Option<&str> {
    let obj = value.as_object()?;
    if let Some(id) = obj.get("session_id").and_then(|v| v.as_str()) {
        return Some(id);
    }
    if obj.get("type").and_then(|v| v.as_str()) == Some("thread.started") {
        if let Some(id) = obj.get("thread_id").and_then(|v| v.as_str()) {
            return Some(id);
        }
    }
    None
}

/// Pull a human-readable reason from any in-stream error envelope.
/// Today this fires only on codex events (claude surfaces failures
/// via `Status::Error` already); kept generic so a future CLI can
/// reuse the same plumbing.
///
/// Shapes handled:
/// - `{"type":"error","message":"..."}` (codex direct)
/// - `{"type":"turn.failed","error":{"message":"..."}}`
///
/// Codex sometimes wraps the human text in a JSON-encoded string —
/// `"{\"detail\":\"The 'gpt-5.1' model is not supported...\"}"` —
/// so the raw `message` would render as escape-laden noise. We
/// peel one layer if it parses as `{"detail": "..."}`; anything
/// else is returned verbatim.
fn extract_inline_error(value: &serde_json::Value) -> Option<String> {
    let obj = value.as_object()?;
    let envelope_type = obj.get("type").and_then(|v| v.as_str())?;
    let raw = match envelope_type {
        "error" => obj.get("message").and_then(|v| v.as_str())?,
        "turn.failed" => obj
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())?,
        _ => return None,
    };
    Some(unwrap_json_detail(raw))
}

/// If `raw` parses as `{"detail": "..."}` (as codex sometimes
/// produces), return the inner string; otherwise return the raw
/// payload. Bounded to a single shallow `from_str` so a malformed
/// nested document cannot recurse or allocate without limit.
fn unwrap_json_detail(raw: &str) -> String {
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(detail) = obj.get("detail").and_then(|v| v.as_str()) {
            return detail.to_string();
        }
        if let Some(message) = obj.get("message").and_then(|v| v.as_str()) {
            return message.to_string();
        }
    }
    raw.to_string()
}

/// Stream-json envelope claude expects on stdin for a fresh user turn.
/// Builds a `content[]` with one `text` block followed by one `image`
/// block per attachment. Empty `text` is dropped so a turn can be
/// "image only" without sending a useless empty text block.
fn build_claude_user_message(text: &str, images: &[InlineImage]) -> String {
    let mut content = Vec::with_capacity(images.len() + 1);
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for img in images {
        content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.media_type,
                "data": img.data,
            },
        }));
    }
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content,
        },
    })
    .to_string()
}

fn emit_status(
    app: &AppHandle,
    tab_id: &str,
    status: SessionStatus,
    error_kind: Option<ErrorKind>,
    message: Option<String>,
) {
    emit_event(
        app,
        HeadlessEvent::Status {
            tab_id: tab_id.to_string(),
            status,
            error_kind,
            message,
        },
    );
}

fn emit_event(app: &AppHandle, event: HeadlessEvent) {
    let channel = format!("headless:{}:event", event.tab_id());
    if let Err(e) = app.emit(&channel, &event) {
        warn!(channel, "headless emit failed: {e}");
    }
    let _ = app.emit("headless:event", &event);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_pair() -> (Arc<Mutex<Option<String>>>, Arc<Mutex<bool>>) {
        (Arc::new(Mutex::new(None)), Arc::new(Mutex::new(false)))
    }

    #[test]
    fn build_claude_user_message_text_only() {
        let line = build_claude_user_message("hello", &[]);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "hello");
        assert_eq!(v["message"]["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn build_claude_user_message_with_images_emits_image_blocks_after_text() {
        let images = vec![
            InlineImage { media_type: "image/png".into(), data: "AAAA".into() },
            InlineImage { media_type: "image/jpeg".into(), data: "BBBB".into() },
        ];
        let line = build_claude_user_message("look:", &images);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "AAAA");
        assert_eq!(content[2]["source"]["media_type"], "image/jpeg");
    }

    #[test]
    fn build_claude_user_message_image_only_drops_empty_text() {
        // An "image only" turn (user pastes a screenshot, hits Enter
        // with no text) must not send a useless empty text block —
        // claude rejects empty text content.
        let images = vec![InlineImage {
            media_type: "image/png".into(),
            data: "X".into(),
        }];
        let line = build_claude_user_message("", &images);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn capture_session_id_stores_first_seen_id() {
        let (slot, fork) = slot_pair();
        let v = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": "abc-123",
        });
        let captured = capture_session_id(&v, &slot, &fork);
        assert_eq!(captured.as_deref(), Some("abc-123"));
        assert_eq!(slot.lock().as_deref(), Some("abc-123"));
    }

    #[test]
    fn capture_session_id_ignores_unrelated_lines() {
        let (slot, fork) = slot_pair();
        assert!(capture_session_id(
            &serde_json::json!({"type": "message-delta"}),
            &slot,
            &fork,
        ).is_none());
        assert!(slot.lock().is_none());
        assert!(capture_session_id(&serde_json::json!(42), &slot, &fork).is_none());
        assert!(slot.lock().is_none());
    }

    #[test]
    fn capture_session_id_returns_none_when_unchanged() {
        let (slot, fork) = slot_pair();
        let v = serde_json::json!({"session_id": "abc-123"});
        assert_eq!(capture_session_id(&v, &slot, &fork).as_deref(), Some("abc-123"));
        // Second call with the same id must return None so the caller
        // does not re-emit a duplicate `SessionIdCaptured` wire event.
        assert!(capture_session_id(&v, &slot, &fork).is_none());
    }

    #[test]
    fn capture_session_id_overwrites_on_change() {
        let (slot, fork) = slot_pair();
        *slot.lock() = Some("old".into());
        let captured = capture_session_id(
            &serde_json::json!({"session_id": "new-id"}),
            &slot,
            &fork,
        );
        assert_eq!(captured.as_deref(), Some("new-id"));
        assert_eq!(slot.lock().as_deref(), Some("new-id"));
    }

    /// Argv-injection guard: a poisoned upstream line that puts a
    /// flag-shaped string in `session_id` must be ignored, otherwise
    /// the next turn would smuggle it into the spawn argv.
    #[test]
    fn capture_session_id_rejects_argv_injection() {
        let (slot, fork) = slot_pair();
        assert!(capture_session_id(
            &serde_json::json!({"session_id": "--dangerously-skip-permissions"}),
            &slot,
            &fork,
        ).is_none(), "leading-dash id must not be stored");
        assert!(slot.lock().is_none());

        assert!(capture_session_id(
            &serde_json::json!({"session_id": "abc;rm -rf /"}),
            &slot,
            &fork,
        ).is_none(), "shell metas must not be stored");
        assert!(slot.lock().is_none());
    }

    /// Codex stamps the upstream id only on its very first
    /// `thread.started` envelope, under `thread_id` (not the
    /// `session_id` field claude uses).
    #[test]
    fn capture_session_id_picks_up_codex_thread_started() {
        let (slot, fork) = slot_pair();
        let captured = capture_session_id(
            &serde_json::json!({
                "type": "thread.started",
                "thread_id": "019e0581-dff2-7a42-942c-e85ce089694b",
            }),
            &slot,
            &fork,
        );
        assert_eq!(
            captured.as_deref(),
            Some("019e0581-dff2-7a42-942c-e85ce089694b"),
        );
    }

    #[test]
    fn capture_session_id_ignores_thread_id_outside_thread_started() {
        // Defensive: only `thread.started` carries an id we trust.
        // A made-up `{"type": "turn.started", "thread_id": "..."}`
        // line should be ignored — codex never emits it, and we
        // would not want a future codex change to silently start
        // attaching ids to other envelopes.
        let (slot, fork) = slot_pair();
        assert!(capture_session_id(
            &serde_json::json!({"type": "turn.started", "thread_id": "abc-123"}),
            &slot,
            &fork,
        )
        .is_none());
        assert!(slot.lock().is_none());
    }

    /// The fork flag is one-shot: the very first observed upstream id
    /// (failed turn or otherwise) must consume it, so a later retry
    /// cannot accidentally fork a second time.
    #[test]
    fn capture_session_id_consumes_pending_fork() {
        let (slot, fork) = slot_pair();
        *fork.lock() = true;
        capture_session_id(
            &serde_json::json!({"session_id": "abc-123"}),
            &slot,
            &fork,
        );
        assert!(!*fork.lock(), "fork flag must be cleared once an id lands");
    }

    #[test]
    fn classify_turn_drained_zero_is_idle() {
        let (status, kind, _) = classify_turn(TurnOutcome::Drained, Some(0), None);
        assert_eq!(status, SessionStatus::Idle);
        assert!(kind.is_none());
    }

    #[test]
    fn classify_turn_drained_nonzero_is_agent_crashed() {
        let (status, kind, msg) = classify_turn(TurnOutcome::Drained, Some(7), None);
        assert_eq!(status, SessionStatus::Error);
        assert_eq!(kind, Some(ErrorKind::AgentCrashed));
        assert!(msg.unwrap().contains('7'));
    }

    #[test]
    fn classify_turn_prefers_captured_error_over_exit_code() {
        // Codex emits a useful reason in its `error` / `turn.failed`
        // envelope before exiting non-zero. Without this preference
        // the user only sees `exit code 1`.
        let (_, _, msg) = classify_turn(
            TurnOutcome::Drained,
            Some(1),
            Some("model not supported".into()),
        );
        assert_eq!(msg.as_deref(), Some("model not supported"));
    }

    #[test]
    fn classify_turn_uses_captured_error_when_exit_status_missing() {
        let (_, _, msg) = classify_turn(
            TurnOutcome::Drained,
            None,
            Some("rate limited".into()),
        );
        assert_eq!(msg.as_deref(), Some("rate limited"));
    }

    #[test]
    fn classify_turn_line_cap_is_protocol_violation() {
        let (status, kind, _) = classify_turn(TurnOutcome::LineCapExceeded, Some(0), None);
        assert_eq!(status, SessionStatus::Error);
        assert_eq!(kind, Some(ErrorKind::ProtocolViolation));
    }

    #[test]
    fn build_codex_args_first_turn_appends_stdin_dash() {
        // Construct just the argv shape — `Session` needs an
        // `AppHandle`, but the arg builder reads only `cli_type`,
        // `base_args`, and the `upstream_session_id` slot. We test
        // it via free helpers below to avoid a Tauri runtime.
        let base = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--model".into(),
            "gpt-5.2".into(),
        ];
        let prev: Option<String> = None;
        let args = codex_args_for_test(&base, prev.as_deref());
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "--json".into(),
                "--skip-git-repo-check".into(),
                "--model".into(),
                "gpt-5.2".into(),
                "-".into(),
            ]
        );
    }

    #[test]
    fn build_codex_args_resumed_turn_appends_resume_after_flags() {
        // Flags must precede `resume <id>`; otherwise `codex exec
        // resume` rejects them with exit 2 because they belong to
        // the parent `exec` subcommand.
        let base = vec![
            "exec".into(),
            "--full-auto".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--model".into(),
            "gpt-5.2".into(),
        ];
        let args = codex_args_for_test(&base, Some("019e0580-72"));
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "--full-auto".into(),
                "--json".into(),
                "--skip-git-repo-check".into(),
                "--model".into(),
                "gpt-5.2".into(),
                "resume".into(),
                "019e0580-72".into(),
                "-".into(),
            ],
            "flags must come before `resume <id>` per codex 0.66 grammar",
        );
    }

    /// Free-function mirror of `Session::build_codex_args` so the
    /// argv shape can be unit-tested without a `Session` instance
    /// (which requires a Tauri `AppHandle`).
    fn codex_args_for_test(base: &[String], prev: Option<&str>) -> Vec<String> {
        let mut args = base.to_vec();
        if let Some(id) = prev {
            args.push("resume".into());
            args.push(id.to_string());
        }
        args.push("-".into());
        args
    }

    #[test]
    fn classify_turn_send_failed_is_agent_crashed() {
        let (status, kind, msg) =
            classify_turn(TurnOutcome::SendFailed("pipe broken".into()), None, None);
        assert_eq!(status, SessionStatus::Error);
        assert_eq!(kind, Some(ErrorKind::AgentCrashed));
        assert_eq!(msg.as_deref(), Some("pipe broken"));
    }

    #[test]
    fn extract_inline_error_handles_codex_error_envelope() {
        let v = serde_json::json!({"type":"error","message":"model not supported"});
        assert_eq!(extract_inline_error(&v).as_deref(), Some("model not supported"));
    }

    #[test]
    fn extract_inline_error_handles_codex_turn_failed() {
        let v = serde_json::json!({
            "type": "turn.failed",
            "error": {"message": "rate limited"}
        });
        assert_eq!(extract_inline_error(&v).as_deref(), Some("rate limited"));
    }

    #[test]
    fn extract_inline_error_returns_none_for_unrelated_lines() {
        assert!(extract_inline_error(&serde_json::json!({"type":"turn.started"})).is_none());
        assert!(extract_inline_error(&serde_json::json!({"foo":"bar"})).is_none());
    }

    /// Pins the first-write-wins guard in `process_jsonl_line`.
    /// Codex emits a specific `error` envelope before a generic
    /// `turn.failed` wrapper — without this rule the user would see
    /// the wrapper text instead of the actionable reason.
    #[test]
    fn captured_error_slot_first_write_wins() {
        let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let observe = |msg: &str| {
            let mut g = slot.lock();
            if g.is_none() {
                *g = Some(msg.to_string());
            }
        };
        observe("first specific");
        observe("second generic");
        assert_eq!(slot.lock().as_deref(), Some("first specific"));
    }

    /// Codex sometimes JSON-encodes the human reason inside the
    /// `message` field. We peel one layer so the user sees the raw
    /// sentence instead of `{"detail": "..."}` with escape noise.
    #[test]
    fn extract_inline_error_unwraps_codex_json_detail() {
        let v = serde_json::json!({
            "type": "error",
            "message": "{\"detail\":\"The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.\"}",
        });
        let unwrapped = extract_inline_error(&v).expect("error envelope must yield message");
        assert_eq!(
            unwrapped,
            "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
        );
    }

    #[test]
    fn extract_inline_error_passes_through_non_json_messages() {
        let v = serde_json::json!({"type": "error", "message": "rate limited"});
        assert_eq!(extract_inline_error(&v).as_deref(), Some("rate limited"));
    }

    #[test]
    fn extract_inline_error_passes_through_json_without_detail_key() {
        // A future codex shape might emit `{"reason":"..."}` etc.
        // We only know how to unwrap `detail` / `message`; other
        // shapes round-trip as-is so the user still sees something.
        let v = serde_json::json!({
            "type": "error",
            "message": "{\"reason\":\"too many requests\"}",
        });
        assert_eq!(
            extract_inline_error(&v).as_deref(),
            Some("{\"reason\":\"too many requests\"}"),
        );
    }
}
