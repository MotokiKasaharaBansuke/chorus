//! Per-tab session: owns the child process, the reader task, and the
//! pending-request table.
//!
//! `RequestOutcome::Completed` is wired into the type system but not yet
//! consumed by the reader loop — Phase 1e will hook it up once we have
//! CLI fixtures to drive message-id correlation deterministically. The
//! other variants (`Cancelled`, `AgentCrashed`) are already resolved
//! today by `cancel_pending` and `crash_pending` respectively.

#![allow(dead_code)]
//!
//! Architecture is actor-style:
//!
//! * `Session::start` spawns the CLI, takes the `SessionLock`, and forks a
//!   tokio task that owns the `ChildProcessTransport` end-to-end. That
//!   reader task is the **only** thing that calls `transport.next_record`,
//!   so framing state is never shared across `await` points by accident.
//! * The public surface (`send_user_message`, `cancel_current`, `shutdown`,
//!   `kill`) talks to the reader task through a bounded `mpsc` channel. No
//!   public method holds a `tokio` lock across `await`.
//! * `pending` maps `requestId` → `oneshot::Sender` so that if the child
//!   crashes mid-turn the reader task can fail every in-flight request
//!   instead of leaving the UI stuck on "thinking".

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};

use super::child_transport::{ChildProcessTransport, SpawnError};
use super::event::{ErrorKind, HeadlessEvent, RequestId, SessionStatus, TabId};
use super::line_reader::{LineRecord, LineViolation};
use super::system::{SessionLock, SessionLockError};
use super::transport::{JsonlTransport, SendError};
use super::validation::{ValidatedCwd, ValidatedEnv};


/// Reasons `Session::start` can fail.
#[derive(Debug)]
pub enum SessionStartError {
    /// Lock for this `tab_id` is held by another Chorus instance.
    AlreadyLocked,
    /// Lock file system call failed.
    Lock(SessionLockError),
    /// Child process could not be spawned.
    Spawn(SpawnError),
    /// Child exited before completing the post-spawn health check.
    HealthCheckFailed(String),
}

/// Reasons `Session::shutdown` can fail.
///
/// Distinct from `SendError` because the public surface should be able to
/// tell "we successfully asked the reader task to wind down" from "the
/// session was already torn down" without parsing strings.
#[derive(Debug, PartialEq, Eq)]
pub enum ShutdownError {
    /// Reader task already exited; the channel is closed. Idempotent
    /// callers can treat this as success, but explicit handlers can
    /// surface "double shutdown" diagnostics.
    AlreadyClosed,
}

impl std::fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyClosed => write!(f, "session already closed"),
        }
    }
}

impl std::error::Error for ShutdownError {}

impl std::fmt::Display for SessionStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked => write!(f, "session already running"),
            Self::Lock(e) => write!(f, "session lock failed: {e}"),
            Self::Spawn(e) => write!(f, "session spawn failed: {e}"),
            Self::HealthCheckFailed(msg) => write!(f, "health check failed: {msg}"),
        }
    }
}

impl std::error::Error for SessionStartError {}

impl From<SessionLockError> for SessionStartError {
    fn from(e: SessionLockError) -> Self {
        Self::Lock(e)
    }
}

impl From<SpawnError> for SessionStartError {
    fn from(e: SpawnError) -> Self {
        Self::Spawn(e)
    }
}

/// Handle returned by `Session::send_user_message`.
///
/// `id` is the Chorus-side request id (suitable for logging or for
/// matching against CLI events); `outcome` resolves once the turn
/// completes, cancels, or the agent crashes. Drop the struct entirely if
/// the caller does not need completion semantics — the session GC will
/// reclaim the pending entry without further action.
#[derive(Debug)]
pub struct PendingRequest {
    pub id: RequestId,
    pub outcome: oneshot::Receiver<RequestOutcome>,
}

/// Outcome a pending request resolves to.
#[derive(Debug, PartialEq, Eq)]
pub enum RequestOutcome {
    /// Assistant produced a `message-complete` event for this request.
    /// Resolution by `crash_pending`/`cancel_pending` is wired today;
    /// full message-id correlation against assistant `message-complete`
    /// events lands in Phase 1e once we have CLI fixtures.
    Completed,
    /// Cancel succeeded (control JSON was acknowledged or the message
    /// stream ended early as a result).
    Cancelled,
    /// Child crashed before this request could complete.
    AgentCrashed,
}

/// Maximum time a pending entry stays in the table before being garbage
/// collected. 5 minutes is well past the longest realistic Claude turn,
/// so a still-live entry past this point almost certainly indicates a
/// caller that dropped the receiver and forgot about the request.
const PENDING_REQUEST_TTL: Duration = Duration::from_secs(5 * 60);

/// Internal book-keeping for `pending`. Bundles the resolver with the
/// timestamp used by the TTL sweep.
/// `pub(crate)` for regression test access only. Production callers
/// must go through the `Session` API — touching the table directly
/// risks bypassing the lifecycle guarantees `Session` holds.
pub(crate) struct PendingEntry {
    responder: oneshot::Sender<RequestOutcome>,
    pub(crate) created_at: Instant,
}

impl PendingEntry {
    pub(crate) fn new(responder: oneshot::Sender<RequestOutcome>) -> Self {
        Self { responder, created_at: Instant::now() }
    }

    /// Should this entry be evicted on the next sweep?
    fn is_stale(&self) -> bool {
        // Caller dropped its `Receiver` — nobody is going to await this
        // outcome, so resolving would be a no-op. Drop the entry now to
        // free the table.
        if self.responder.is_closed() {
            return true;
        }
        // TTL backstop in case a caller held a `Receiver` past any
        // reasonable turn duration.
        self.created_at.elapsed() > PENDING_REQUEST_TTL
    }
}

/// `pub(crate)` for regression test access only — see `PendingEntry`.
pub(crate) type PendingTable = HashMap<RequestId, PendingEntry>;

/// Drop entries whose receiver was dropped or whose TTL elapsed. Cheap
/// enough to run on every `send_user_message` because the table never
/// grows past the count of in-flight turns (~1 per tab in practice).
fn sweep_pending(table: &mut PendingTable) {
    table.retain(|_, entry| !entry.is_stale());
}

/// Configuration for `Session::start`.
pub struct SessionConfig {
    pub tab_id: TabId,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: ValidatedCwd,
    pub extra_env: ValidatedEnv,
}

/// Commands the public surface enqueues for the reader task.
///
/// `Reader` qualifier disambiguates from `tauri::command` and command-line
/// arguments — every variant is something the reader task consumes.
#[derive(Debug)]
enum ReaderTaskCmd {
    SendUserText {
        request_id: RequestId,
        text: String,
        responder: oneshot::Sender<Result<(), SendError>>,
    },
    Cancel {
        responder: oneshot::Sender<Result<(), SendError>>,
    },
    Shutdown,
}

/// Per-tab session handle.
///
/// Tear-down has three distinct entry points so each context can pick the
/// right one:
/// * `shutdown()` — async, the graceful path. Closes stdin, lets the CLI
///   exit cleanly, escalates to SIGTERM/SIGKILL after a 3 s grace.
/// * `kill_now()` — sync, the emergency path. Sends SIGKILL to the process
///   group immediately. Used from non-async contexts like Tauri's
///   `WindowEvent::Destroyed` where a 3 s sleep would orphan children.
/// * `Drop` — the safety net. Tries `try_send(Shutdown)` first, then
///   falls back to `kill_now` so a forgotten handle never leaks the child.
pub struct Session {
    tab_id: TabId,
    cmd_tx: mpsc::Sender<ReaderTaskCmd>,
    pending: Arc<Mutex<PendingTable>>,
    /// PID + group-kill helpers. `Arc` so the reader task can keep its own
    /// handle for in-task SIGKILL while the public surface uses this copy
    /// for the synchronous emergency path.
    killer: Arc<ProcessKiller>,
    _lock: Arc<SessionLock>,
}

/// Captures just enough of a `ChildProcessTransport` to issue SIGTERM/
/// SIGKILL synchronously without holding the transport itself across the
/// reader task boundary.
struct ProcessKiller {
    pid: u32,
}

impl ProcessKiller {
    fn from_transport(t: &ChildProcessTransport) -> Self {
        Self { pid: t.pid() }
    }

    /// Best-effort SIGKILL of the process group, then a fallback direct
    /// SIGKILL. Synchronous so it can run from `Drop` and from Tauri's
    /// non-async window-destroy handler.
    fn kill_now(&self) {
        unsafe {
            if libc::kill(-(self.pid as i32), libc::SIGKILL) == 0 {
                return;
            }
            let _ = libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }
}

impl Session {
    /// Start a session: acquire the lock, spawn the CLI, fork the reader
    /// task. Emits `Status::Idle` when the pipe is healthy enough to
    /// accept a `send_user_message`.
    pub async fn start(
        config: SessionConfig,
        app: AppHandle,
    ) -> Result<Self, SessionStartError> {
        let SessionConfig { tab_id, command, args, cwd, extra_env } = config;

        let lock = SessionLock::try_acquire(&tab_id)?.ok_or(SessionStartError::AlreadyLocked)?;
        let lock = Arc::new(lock);

        let mut transport = ChildProcessTransport::spawn(&command, &args, &cwd, &extra_env)?;
        post_spawn_health_check(&mut transport, SPAWN_HEALTH_CHECK_GRACE).await?;

        let killer = Arc::new(ProcessKiller::from_transport(&transport));

        let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));
        let (cmd_tx, cmd_rx) = mpsc::channel::<ReaderTaskCmd>(64);

        let reader_pending = pending.clone();
        let reader_app = app.clone();
        let reader_tab = tab_id.clone();
        let reader_lock = lock.clone();
        tokio::spawn(reader_loop(
            transport,
            cmd_rx,
            reader_app,
            reader_tab,
            reader_pending,
            reader_lock,
        ));

        // Optimistic: tell the UI we are ready to take input. A stronger
        // health-check (peeking stderr / waiting for `system-init`) lands
        // in Phase 1e once we have fixture-driven coverage.
        emit(&app, HeadlessEvent::Status {
            tab_id: tab_id.clone(),
            status: SessionStatus::Idle,
            error_kind: None,
            message: None,
        });

        info!(tab_id = %tab_id, pid = killer.pid, "headless session started");
        Ok(Self { tab_id, cmd_tx, pending, killer, _lock: lock })
    }

    /// Tab ID this session belongs to.
    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    /// Send a free-form user message.
    ///
    /// Returns a `PendingRequest` with the freshly-minted `RequestId` and
    /// a `oneshot::Receiver<RequestOutcome>` that will fire when the turn
    /// completes, is cancelled, or the agent crashes. The receiver may be
    /// dropped if the caller does not need completion semantics — the
    /// session sweeps caller-dropped entries on every subsequent send,
    /// and a 5-minute TTL backstops any held-but-forgotten receivers.
    ///
    /// Pending registration happens **before** the channel send so that a
    /// crash mid-send is still observable. On send failure we explicitly
    /// remove the entry to keep the table from drifting.
    ///
    /// Note: pending entries currently resolve via `crash_pending`,
    /// `cancel_pending`, and the GC sweep. Per-message `Completed`
    /// resolution lands in Phase 1e once we have CLI fixtures to drive
    /// message-id correlation deterministically.
    pub async fn send_user_message(
        &self,
        text: String,
    ) -> Result<PendingRequest, SendError> {
        let request_id = RequestId::new();
        let (outcome_tx, outcome_rx) = oneshot::channel();

        {
            let mut table = self.pending.lock();
            sweep_pending(&mut table);
            table.insert(request_id.clone(), PendingEntry::new(outcome_tx));
        }

        let (responder, response) = oneshot::channel();
        if self
            .cmd_tx
            .send(ReaderTaskCmd::SendUserText { request_id: request_id.clone(), text, responder })
            .await
            .is_err()
        {
            self.pending.lock().remove(&request_id);
            return Err(SendError::PeerClosed);
        }

        match response.await {
            Ok(Ok(())) => Ok(PendingRequest { id: request_id, outcome: outcome_rx }),
            Ok(Err(e)) => {
                self.pending.lock().remove(&request_id);
                Err(e)
            }
            Err(_) => {
                self.pending.lock().remove(&request_id);
                Err(SendError::PeerClosed)
            }
        }
    }

    /// Send the protocol-level cancel envelope. Note: the actual semantics
    /// of mid-stream cancel depend on the CLI; if it does not respond, the
    /// caller should escalate to `kill` after a grace window.
    pub async fn cancel_current(&self) -> Result<(), SendError> {
        let (responder, response) = oneshot::channel();
        self.cmd_tx
            .send(ReaderTaskCmd::Cancel { responder })
            .await
            .map_err(|_| SendError::PeerClosed)?;
        response.await.map_err(|_| SendError::PeerClosed)?
    }

    /// Tell the reader task to wind down: close stdin, give the CLI a
    /// chance to exit, then SIGTERM/SIGKILL the group.
    ///
    /// Returns `Err(ShutdownError::AlreadyClosed)` when the reader task has
    /// already exited. Callers that want idempotent semantics can simply
    /// ignore this error, but having it surfaced lets diagnostics
    /// distinguish "graceful shutdown sent" from "double shutdown".
    pub async fn shutdown(&self) -> Result<(), ShutdownError> {
        self.cmd_tx
            .send(ReaderTaskCmd::Shutdown)
            .await
            .map_err(|_| ShutdownError::AlreadyClosed)
    }

    /// Synchronous emergency tear-down: send SIGKILL to the process group
    /// immediately, then nudge the reader task. Use when the caller cannot
    /// `await` (e.g. Tauri `WindowEvent::Destroyed`) and would otherwise
    /// risk leaving children alive past app exit.
    pub fn kill_now(&self) {
        self.killer.kill_now();
        // Best-effort wakeup so the reader task observes EOF promptly. If
        // the channel is full or closed, the SIGKILL above is enough.
        let _ = self.cmd_tx.try_send(ReaderTaskCmd::Shutdown);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Two-step safety net: nudge the reader task to wind down via the
        // graceful path, and if the channel is full or closed (unusual,
        // but observable when the runtime is mid-shutdown) escalate to a
        // synchronous SIGKILL so the child is never left running.
        if self.cmd_tx.try_send(ReaderTaskCmd::Shutdown).is_err() {
            self.killer.kill_now();
        }
    }
}

/// The single owner of the child transport. Pumps records to the frontend
/// and routes outbound commands back to stdin.
///
/// Holds an `Arc<SessionLock>` for its full lifetime so the lock cannot be
/// dropped while the reader is still draining stdout — otherwise a fresh
/// `Session::start` for the same `tab_id` could win the lock mid-shutdown
/// and end up writing to a half-dead pipe.
async fn reader_loop(
    mut transport: ChildProcessTransport,
    mut cmd_rx: mpsc::Receiver<ReaderTaskCmd>,
    app: AppHandle,
    tab_id: TabId,
    pending: Arc<Mutex<PendingTable>>,
    _lock: Arc<SessionLock>,
) {
    let pid = transport.pid();
    debug!(tab_id = %tab_id, pid, "reader loop started");
    loop {
        tokio::select! {
            // Bias toward draining stdout so streamed text is not delayed
            // by a flood of outbound commands.
            biased;
            record = transport.next_record() => {
                match record {
                    Some(record) => handle_record(record, &app, &tab_id, &pending),
                    None => {
                        // EOF on stdout: child exited or closed its pipes.
                        // Fail every pending request so the UI does not
                        // dangle on "thinking".
                        crash_pending(&pending, &app, &tab_id, "child exited unexpectedly");
                        break;
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(ReaderTaskCmd::SendUserText { request_id: _, text, responder }) => {
                        // Phase 1e will resolve `request_id` against the
                        // matching `message-complete` event so the pending
                        // entry fires `Completed`. Today registration is
                        // already done by `Session::send_user_message`; this
                        // task just needs to forward the user line.
                        let payload = build_user_text_line(&text);
                        let result = transport.send_line(&payload).await;
                        let _ = responder.send(result);
                    }
                    Some(ReaderTaskCmd::Cancel { responder }) => {
                        let payload = json!({ "type": "control", "action": "cancel" }).to_string();
                        let result = transport.send_line(&payload).await;
                        if result.is_ok() {
                            // The control envelope has been delivered;
                            // resolve every pending entry as `Cancelled`
                            // so awaiting callers learn the turn is done
                            // even if the CLI never emits a confirmation.
                            let count = cancel_pending(&pending);
                            if count > 0 {
                                debug!(tab_id = %tab_id, count, "pending requests cancelled");
                            }
                        }
                        let _ = responder.send(result);
                    }
                    Some(ReaderTaskCmd::Shutdown) | None => {
                        // Public surface dropped or asked us to wind down.
                        let _ = transport.close_send().await;
                        graceful_kill(&transport).await;
                        crash_pending(&pending, &app, &tab_id, "session shutdown");
                        break;
                    }
                }
            }
        }
    }
    debug!(tab_id = %tab_id, pid, "reader loop ended");
}

/// Translate one record into a Tauri event. Unknown shapes go through
/// `unknown_event` so a malformed line never tears down the session.
///
/// Phase 1e adds a heuristic resolution path: when the CLI emits a
/// `message-complete` shape (`type` plus a `finish_reason` field), we
/// drain the **oldest** pending entry and resolve it with `Completed`
/// (`Cancelled` if `finish_reason == "cancel"`). FIFO is a safe
/// approximation today because Chorus serialises user turns through the
/// reader task — a real `request_id` ↔ `message_id` correlation lands
/// once we have CLI fixtures (Phase 1f).
fn handle_record(
    record: LineRecord,
    app: &AppHandle,
    tab_id: &str,
    pending: &Arc<Mutex<PendingTable>>,
) {
    match record {
        LineRecord::Line(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(value) => {
                if let Some(reason) = detect_message_complete(&value) {
                    resolve_oldest_pending(pending, reason);
                }
                emit(
                    app,
                    super::event::unknown_event(tab_id.to_string(), value),
                );
            }
            Err(_) => emit(app, HeadlessEvent::Status {
                tab_id: tab_id.to_string(),
                status: SessionStatus::Error,
                error_kind: Some(ErrorKind::ProtocolViolation),
                message: Some("non-JSON line on stdout".into()),
            }),
        },
        LineRecord::Violation(LineViolation::LineTooLong) => {
            emit(app, HeadlessEvent::Status {
                tab_id: tab_id.to_string(),
                status: SessionStatus::Error,
                error_kind: Some(ErrorKind::ProtocolViolation),
                message: Some("stdout line exceeded 8 MiB cap".into()),
            });
        }
        LineRecord::Violation(LineViolation::Io(msg)) => {
            warn!(tab_id, "stdout io violation: {msg}");
            emit(app, HeadlessEvent::Status {
                tab_id: tab_id.to_string(),
                status: SessionStatus::Error,
                error_kind: Some(ErrorKind::ProtocolViolation),
                message: Some(msg),
            });
        }
    }
}

/// Turn-end shapes the heuristic recognises:
///
/// * Anthropic stream-json: `type: "message-complete"` (Phase 1+ canonical)
/// * Claude Code's CLI: `type: "message_stop"`
/// * `--print --output-format=json` summary: `type: "result"`
///
/// `finish_reason` keys nested inside other shapes (e.g. a `tool-use` whose
/// `input` object happens to contain `finish_reason`) are **deliberately
/// ignored**: matching only the discriminator field keeps the heuristic
/// from firing on incidental key names.
const TURN_END_TYPES: &[&str] = &["message-complete", "message_stop", "result"];

/// Inspect a parsed JSONL line for a turn-end shape.
///
/// Returns the canonical `RequestOutcome` for the matched line so the
/// caller can resolve a pending entry; `None` for any other line.
///
/// `finish_reason` is read **only** at the top level of a line whose
/// `type` is in `TURN_END_TYPES`. A `finish_reason` of `"cancel"` maps to
/// `Cancelled`; anything else (including missing / non-string) maps to
/// `Completed`, since the assistant turn has clearly ended.
fn detect_message_complete(value: &serde_json::Value) -> Option<RequestOutcome> {
    let obj = value.as_object()?;
    let type_str = obj.get("type").and_then(|t| t.as_str())?;
    if !TURN_END_TYPES.contains(&type_str) {
        return None;
    }
    let finish_reason = obj
        .get("finish_reason")
        .or_else(|| obj.get("finishReason"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Some(if finish_reason == "cancel" {
        RequestOutcome::Cancelled
    } else {
        RequestOutcome::Completed
    })
}

/// Resolve the oldest pending entry with the supplied outcome.
///
/// The "oldest" rule is a heuristic until Phase 1f wires real
/// `request_id` ↔ `message_id` correlation. It works because Chorus
/// serialises user turns through the reader task — there is at most one
/// in-flight request per session at a given moment in normal operation.
/// `pub(crate)` for regression test access only — production code goes
/// through `handle_record`, which owns the timing of when this fires.
pub(crate) fn resolve_oldest_pending(
    pending: &Arc<Mutex<PendingTable>>,
    outcome: RequestOutcome,
) {
    let mut table = pending.lock();
    let Some(oldest_id) = table
        .iter()
        .min_by_key(|(_, entry)| entry.created_at)
        .map(|(id, _)| id.clone())
    else {
        return;
    };
    if let Some(entry) = table.remove(&oldest_id) {
        let _ = entry.responder.send(outcome);
    }
}

/// SIGTERM the process group, give it 3 seconds to exit, then SIGKILL.
/// Best-effort — kill_on_drop is the ultimate backstop.
async fn graceful_kill(transport: &ChildProcessTransport) {
    let _ = transport.terminate_group();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let _ = transport.kill_group();
}

/// Resolve every pending request with `AgentCrashed` and emit an Error
/// status so the UI can prompt the user to retry.
fn crash_pending(
    pending: &Arc<Mutex<PendingTable>>,
    app: &AppHandle,
    tab_id: &str,
    reason: &str,
) {
    let drained: Vec<_> = pending.lock().drain().collect();
    for (_id, entry) in drained {
        let _ = entry.responder.send(RequestOutcome::AgentCrashed);
    }
    emit(app, HeadlessEvent::Status {
        tab_id: tab_id.to_string(),
        status: SessionStatus::Error,
        error_kind: Some(ErrorKind::AgentCrashed),
        message: Some(reason.to_string()),
    });
}

/// Drain pending and resolve every entry with `Cancelled`. Triggered by
/// the protocol-level cancel flow — the assumption is that any in-flight
/// turn has been told to stop, so callers waiting on a `RequestOutcome`
/// should observe `Cancelled` rather than `Completed`.
fn cancel_pending(pending: &Arc<Mutex<PendingTable>>) -> usize {
    let drained: Vec<_> = pending.lock().drain().collect();
    let count = drained.len();
    for (_id, entry) in drained {
        let _ = entry.responder.send(RequestOutcome::Cancelled);
    }
    count
}

/// Grace period for the post-spawn health check. A CLI that dies on argv
/// (missing binary, bad flag, ENOEXEC, auth refusal) typically exits within
/// tens of milliseconds. 200 ms is far below human-perceptible spawn
/// latency yet long enough to catch the common failure modes.
const SPAWN_HEALTH_CHECK_GRACE: Duration = Duration::from_millis(200);

/// Catch CLIs that die immediately after spawn before the reader_loop is
/// attached. Two probes — one before the sleep and one after — let us detect
/// both "already gone before we got the handle" and "died during the grace
/// window" without busy-waiting.
///
/// Failures are fatal: callers should not auto-restart, since a CLI that
/// can't survive its own health check would just respawn-loop.
async fn post_spawn_health_check(
    transport: &mut ChildProcessTransport,
    grace: Duration,
) -> Result<(), SessionStartError> {
    if let Some(status) = transport.try_check_exit() {
        return Err(SessionStartError::HealthCheckFailed(format!(
            "child exited before health check: {status:?}"
        )));
    }
    tokio::time::sleep(grace).await;
    if let Some(status) = transport.try_check_exit() {
        return Err(SessionStartError::HealthCheckFailed(format!(
            "child exited during health check: {status:?}"
        )));
    }
    Ok(())
}

/// Stream-json envelope claude expects on stdin for a fresh user turn.
fn build_user_text_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": text }],
        },
    })
    .to_string()
}

/// Emit on the per-tab Tauri channel `headless:<tabId>:event`. Routing
/// uses `HeadlessEvent::tab_id`, so adding a variant only requires
/// updating that single method — not every emit site.
fn emit(app: &AppHandle, event: HeadlessEvent) {
    let channel = format!("headless:{}:event", event.tab_id());
    if let Err(e) = app.emit(&channel, &event) {
        warn!(channel, "headless emit failed: {e}");
    }
    // Also emit on a sticky compatibility channel so subscribers that wire
    // up *after* the per-tab listener can still see the most recent event
    // type when they call `app.listen("headless:event")` blanket-wise.
    let _ = app.emit("headless:event", &event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless::validation::{sanitize_extra_env, validate_cwd};
    use std::collections::HashMap;

    #[allow(dead_code)]
    fn config(tab_id: &str, command: &str, args: &[&str]) -> SessionConfig {
        SessionConfig {
            tab_id: tab_id.into(),
            command: command.into(),
            args: args.iter().map(|s| (*s).into()).collect(),
            cwd: validate_cwd("/tmp").unwrap(),
            extra_env: ValidatedEnv::empty(),
        }
    }

    fn cwd() -> ValidatedCwd {
        validate_cwd("/tmp").unwrap()
    }

    fn empty_env() -> ValidatedEnv {
        let (env, _) = sanitize_extra_env(HashMap::new());
        env
    }

    /// `build_user_text_line` produces exactly one JSON object per call,
    /// terminated by a newline at the framing layer (not here).
    #[test]
    fn build_user_text_line_shapes_envelope() {
        let line = build_user_text_line("hello");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn session_start_error_displays_each_variant() {
        // Smoke-test that the error wrapper compiles and Display fires;
        // detailed coverage of the underlying causes lives in their own
        // modules.
        let e = SessionStartError::AlreadyLocked;
        assert!(format!("{e}").contains("already running"));
        let e = SessionStartError::HealthCheckFailed("boom".into());
        assert!(format!("{e}").contains("health check"));
    }

    #[test]
    fn shutdown_error_displays_already_closed() {
        assert_eq!(
            ShutdownError::AlreadyClosed.to_string(),
            "session already closed",
        );
    }

    /// `post_spawn_health_check` must fail when the child has already exited
    /// before the reader loop is attached. We simulate this with `sh -c
    /// "exit 9"` — the kernel reaps it within the grace window.
    #[tokio::test]
    async fn health_check_fails_for_quick_exit() {
        let mut transport = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "exit 9".into()],
            &cwd(),
            &empty_env(),
        )
        .expect("spawn /bin/sh exit 9");
        let result = post_spawn_health_check(&mut transport, Duration::from_millis(150)).await;
        match result {
            Err(SessionStartError::HealthCheckFailed(msg)) => {
                assert!(msg.contains("exited"), "{msg}");
            }
            other => panic!("expected HealthCheckFailed, got {other:?}"),
        }
    }

    /// `sweep_pending` must drop entries whose `oneshot::Sender::is_closed`
    /// returns true (the receiver was dropped) and entries past TTL. Active
    /// entries with live receivers must survive the sweep.
    #[test]
    fn sweep_drops_caller_dropped_and_ttl_expired_entries() {
        let mut table: PendingTable = PendingTable::new();

        // Live receiver: should survive.
        let (tx_live, _rx_live) = oneshot::channel::<RequestOutcome>();
        table.insert(RequestId::from("live"), PendingEntry::new(tx_live));

        // Receiver dropped: should be swept.
        let (tx_dropped, rx_dropped) = oneshot::channel::<RequestOutcome>();
        drop(rx_dropped);
        table.insert(RequestId::from("dropped"), PendingEntry::new(tx_dropped));

        // TTL-expired entry: backdate created_at.
        let (tx_expired, _rx_expired) = oneshot::channel::<RequestOutcome>();
        let mut expired = PendingEntry::new(tx_expired);
        expired.created_at = Instant::now() - PENDING_REQUEST_TTL - Duration::from_secs(1);
        table.insert(RequestId::from("expired"), expired);

        sweep_pending(&mut table);

        assert!(table.contains_key(&RequestId::from("live")));
        assert!(!table.contains_key(&RequestId::from("dropped")));
        assert!(!table.contains_key(&RequestId::from("expired")));
    }

    /// `detect_message_complete` matches every turn-end discriminator
    /// Chorus expects to see in the wild, with optional `finish_reason`
    /// driving Completed vs Cancelled.
    #[test]
    fn detect_message_complete_handles_known_shapes() {
        use serde_json::json;
        assert_eq!(
            detect_message_complete(&json!({"type": "message-complete"})),
            Some(RequestOutcome::Completed),
        );
        assert_eq!(
            detect_message_complete(&json!({"type": "message_stop"})),
            Some(RequestOutcome::Completed),
        );
        assert_eq!(
            detect_message_complete(&json!({"type": "result"})),
            Some(RequestOutcome::Completed),
        );
        assert_eq!(
            detect_message_complete(&json!({
                "type": "message-complete",
                "finish_reason": "stop",
            })),
            Some(RequestOutcome::Completed),
        );
        assert_eq!(
            detect_message_complete(&json!({
                "type": "result",
                "finishReason": "cancel",
            })),
            Some(RequestOutcome::Cancelled),
        );
    }

    /// Critical: do not fire on a nested `finish_reason` that happens to
    /// appear inside an unrelated shape (e.g. a tool-use whose `input`
    /// payload mentions `finish_reason`). The discriminator must always
    /// be the top-level `type`.
    #[test]
    fn detect_message_complete_ignores_nested_finish_reason() {
        use serde_json::json;
        assert!(
            detect_message_complete(&json!({
                "type": "tool-use",
                "input": { "finish_reason": "stop" },
            }))
            .is_none(),
        );
        // Top-level `finish_reason` without a recognised `type` is also
        // ignored — turn-end events always carry a `type` discriminator.
        assert!(
            detect_message_complete(&json!({"finish_reason": "stop"})).is_none(),
        );
    }

    #[test]
    fn detect_message_complete_returns_none_for_other_shapes() {
        use serde_json::json;
        assert!(detect_message_complete(&json!({"type": "message-delta"})).is_none());
        assert!(detect_message_complete(&json!({"type": "tool-use"})).is_none());
        assert!(detect_message_complete(&json!({"unrelated": 42})).is_none());
        assert!(detect_message_complete(&json!(null)).is_none());
        assert!(detect_message_complete(&json!("just a string")).is_none());
        // Non-object JSON values must be rejected before the `type` lookup.
        assert!(detect_message_complete(&json!([1, 2, 3])).is_none());
        assert!(detect_message_complete(&json!(42)).is_none());
        assert!(detect_message_complete(&json!(true)).is_none());
    }

    /// FIFO heuristic: the oldest entry resolves first. Phase 1f will
    /// replace this with a real id-keyed lookup once we have a fixture
    /// recording of Claude's stream-json envelope shape.
    #[tokio::test]
    async fn resolve_oldest_pending_drains_eldest_first() {
        let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));

        let (tx_a, rx_a) = oneshot::channel::<RequestOutcome>();
        let mut entry_a = PendingEntry::new(tx_a);
        entry_a.created_at = Instant::now() - Duration::from_secs(2);
        pending.lock().insert(RequestId::from("a"), entry_a);

        let (tx_b, rx_b) = oneshot::channel::<RequestOutcome>();
        pending.lock().insert(RequestId::from("b"), PendingEntry::new(tx_b));

        // First resolve picks `a` (older), second picks `b`.
        resolve_oldest_pending(&pending, RequestOutcome::Completed);
        assert_eq!(rx_a.await.unwrap(), RequestOutcome::Completed);

        resolve_oldest_pending(&pending, RequestOutcome::Cancelled);
        assert_eq!(rx_b.await.unwrap(), RequestOutcome::Cancelled);

        assert!(pending.lock().is_empty());
    }

    #[tokio::test]
    async fn resolve_oldest_pending_is_safe_when_empty() {
        let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));
        // Just verify the call does not panic and leaves the table empty.
        resolve_oldest_pending(&pending, RequestOutcome::Completed);
        assert!(pending.lock().is_empty());
    }

    /// FIFO ordering must hold across more than two entries. Resolves in
    /// strict eldest-first order regardless of insertion order.
    #[tokio::test]
    async fn resolve_oldest_pending_preserves_fifo_across_many_entries() {
        let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));

        let now = Instant::now();
        let make_entry = |sender: oneshot::Sender<RequestOutcome>, age_secs: u64| {
            let mut e = PendingEntry::new(sender);
            e.created_at = now - Duration::from_secs(age_secs);
            e
        };

        let (tx_a, rx_a) = oneshot::channel::<RequestOutcome>();
        let (tx_b, rx_b) = oneshot::channel::<RequestOutcome>();
        let (tx_c, rx_c) = oneshot::channel::<RequestOutcome>();

        // Insert in non-FIFO order: middle, oldest, youngest. The resolver
        // must still pick by age.
        pending.lock().insert(RequestId::from("b"), make_entry(tx_b, 5));
        pending.lock().insert(RequestId::from("a"), make_entry(tx_a, 10));
        pending.lock().insert(RequestId::from("c"), make_entry(tx_c, 1));

        resolve_oldest_pending(&pending, RequestOutcome::Completed);
        assert_eq!(rx_a.await.unwrap(), RequestOutcome::Completed);

        resolve_oldest_pending(&pending, RequestOutcome::Completed);
        assert_eq!(rx_b.await.unwrap(), RequestOutcome::Completed);

        resolve_oldest_pending(&pending, RequestOutcome::Cancelled);
        assert_eq!(rx_c.await.unwrap(), RequestOutcome::Cancelled);

        assert!(pending.lock().is_empty());
    }

    /// `cancel_pending` resolves every entry with `Cancelled` and reports
    /// the count drained, regardless of whether the receiver still cared.
    #[tokio::test]
    async fn cancel_pending_resolves_each_outcome_with_cancelled() {
        let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));

        let (tx_a, rx_a) = oneshot::channel::<RequestOutcome>();
        let (tx_b, rx_b) = oneshot::channel::<RequestOutcome>();
        pending.lock().insert(RequestId::from("a"), PendingEntry::new(tx_a));
        pending.lock().insert(RequestId::from("b"), PendingEntry::new(tx_b));

        let count = cancel_pending(&pending);
        assert_eq!(count, 2);
        assert!(pending.lock().is_empty());
        assert_eq!(rx_a.await.unwrap(), RequestOutcome::Cancelled);
        assert_eq!(rx_b.await.unwrap(), RequestOutcome::Cancelled);
    }

    /// A long-running child must clear the health check.
    #[tokio::test]
    async fn health_check_passes_for_long_running_child() {
        let mut transport = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "sleep 60".into()],
            &cwd(),
            &empty_env(),
        )
        .expect("spawn /bin/sh sleep");
        // Use a tiny grace window so the test runs quickly. Real callers
        // pass `SPAWN_HEALTH_CHECK_GRACE`.
        post_spawn_health_check(&mut transport, Duration::from_millis(50))
            .await
            .expect("long-running child should pass health check");
        transport.kill_group().expect("kill_group");
    }
}
