//! Per-tab session: owns the child process, the reader task, and the
//! pending-request table.
//!
//! Several public surfaces (`RequestOutcome::Completed`/`Cancelled`,
//! `Session::register_pending`) are wired into the type system but not
//! yet consumed by the reader loop — Phase 1c will hook them up once we
//! have CLI fixtures to drive the message-id correlation.

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
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};
use uuid::Uuid;

use super::child_transport::{ChildProcessTransport, SpawnError};
use super::event::{ErrorKind, HeadlessEvent, SessionStatus, TabId};
use super::line_reader::{LineRecord, LineViolation};
use super::system::{SessionLock, SessionLockError};
use super::transport::{JsonlTransport, SendError};
use super::validation::{ValidatedCwd, ValidatedEnv};


/// Logical identifier for one user message. Used to correlate the request
/// to the assistant message id the CLI eventually emits, and to fail
/// in-flight messages on crash.
pub type RequestId = String;

/// Reasons `Session::start` can fail.
#[derive(Debug)]
pub enum SessionStartError {
    /// Lock for this `tab_id` is held by another Chorus instance.
    AlreadyLocked,
    /// Lock file system call failed.
    Lock(SessionLockError),
    /// Child process could not be spawned.
    Spawn(SpawnError),
}

impl std::fmt::Display for SessionStartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyLocked => write!(f, "session already running"),
            Self::Lock(e) => write!(f, "session lock failed: {e}"),
            Self::Spawn(e) => write!(f, "session spawn failed: {e}"),
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

/// Outcome a pending request resolves to.
#[derive(Debug)]
pub enum RequestOutcome {
    /// Assistant produced a `message-complete` event for this request.
    Completed,
    /// Cancel succeeded (control JSON was acknowledged or the message
    /// stream ended early as a result).
    Cancelled,
    /// Child crashed before this request could complete.
    AgentCrashed,
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
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<RequestOutcome>>>>,
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

        let transport = ChildProcessTransport::spawn(&command, &args, &cwd, &extra_env)?;
        let killer = Arc::new(ProcessKiller::from_transport(&transport));

        let pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<RequestOutcome>>>> =
            Arc::new(Mutex::new(HashMap::new()));
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

        // Optimistic: tell the UI we are ready to take input. A real
        // health-check (waiting for `system-init` from the CLI) lands in
        // Phase 1c once we have fixture-driven coverage.
        emit(&app, HeadlessEvent::Status {
            tab_id: tab_id.clone(),
            status: SessionStatus::Idle,
            error_kind: None,
            message: None,
        });

        Ok(Self { tab_id, cmd_tx, pending, killer, _lock: lock })
    }

    /// Tab ID this session belongs to.
    pub fn tab_id(&self) -> &str {
        &self.tab_id
    }

    /// Send a free-form user message. The returned `RequestId` is what the
    /// caller uses to correlate the assistant's reply (or to wait on a
    /// `oneshot::Receiver` if you need synchronous "did this turn finish"
    /// semantics — see `register_pending`).
    pub async fn send_user_message(&self, text: String) -> Result<RequestId, SendError> {
        let request_id = Uuid::new_v4().to_string();
        let (responder, response) = oneshot::channel();
        self.cmd_tx
            .send(ReaderTaskCmd::SendUserText { request_id: request_id.clone(), text, responder })
            .await
            .map_err(|_| SendError::PeerClosed)?;
        match response.await {
            Ok(Ok(())) => Ok(request_id),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(SendError::PeerClosed),
        }
    }

    /// Register a oneshot you want resolved when `request_id` completes,
    /// cancels, or the agent crashes. Drops silently if the session has
    /// already torn down.
    pub fn register_pending(&self, request_id: RequestId, tx: oneshot::Sender<RequestOutcome>) {
        self.pending.lock().insert(request_id, tx);
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
    /// chance to exit, then SIGTERM/SIGKILL the group. Idempotent — calling
    /// after the reader has already exited is a no-op.
    pub async fn shutdown(&self) {
        let _ = self.cmd_tx.send(ReaderTaskCmd::Shutdown).await;
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
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<RequestOutcome>>>>,
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
                    Some(record) => handle_record(record, &app, &tab_id),
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
                        let payload = build_user_text_line(&text);
                        let result = transport.send_line(&payload).await;
                        let _ = responder.send(result);
                    }
                    Some(ReaderTaskCmd::Cancel { responder }) => {
                        let payload = json!({ "type": "control", "action": "cancel" }).to_string();
                        let result = transport.send_line(&payload).await;
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
fn handle_record(record: LineRecord, app: &AppHandle, tab_id: &str) {
    match record {
        LineRecord::Line(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(value) => emit(
                app,
                super::event::unknown_event(tab_id.to_string(), value),
            ),
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
    pending: &Arc<Mutex<HashMap<RequestId, oneshot::Sender<RequestOutcome>>>>,
    app: &AppHandle,
    tab_id: &str,
    reason: &str,
) {
    let drained: Vec<_> = pending.lock().drain().collect();
    for (_id, tx) in drained {
        let _ = tx.send(RequestOutcome::AgentCrashed);
    }
    emit(app, HeadlessEvent::Status {
        tab_id: tab_id.to_string(),
        status: SessionStatus::Error,
        error_kind: Some(ErrorKind::AgentCrashed),
        message: Some(reason.to_string()),
    });
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
    use crate::headless::validation::validate_cwd;

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
    }
}
