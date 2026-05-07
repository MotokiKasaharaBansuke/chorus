//! Real child-process transport that talks JSONL to claude/codex.
//!
//! `wait_for_exit` is held in reserve for Phase 1c's health-check, where
//! we need to distinguish "child crashed" from "child shut down cleanly".

#![allow(dead_code)]
//!
//! Runs `command args` under its own POSIX session (so SIGTERM hits the
//! whole tree), wires `stdin`/`stdout`/`stderr`, and exposes a
//! `JsonlTransport` impl backed by `LineReader`. `stderr` is mirrored to
//! `tracing::warn` after passing through `redaction::redact`, so a panic
//! traceback that includes a stray API key never lands in plaintext logs.
//!
//! Lifecycle ownership lives in the caller (`Session`):
//! 1. `close_send` to flush stdin and let the CLI exit naturally.
//! 2. `terminate(SIGTERM)` if it does not exit within a grace window.
//! 3. `kill_on_drop = true` is the last-resort SIGKILL when the struct dies.

use std::io;
use std::process::Stdio;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tracing::{debug, warn};

use super::line_reader::{LineReader, LineRecord};
use super::redaction::redact;
use super::transport::{JsonlTransport, SendError};
use super::validation::{ValidatedCwd, ValidatedEnv};

/// Reasons for `spawn` to fail before the child has produced any output.
#[derive(Debug)]
pub enum SpawnError {
    /// `Command::spawn` itself failed — binary missing, ENOEXEC, etc.
    SpawnFailed(io::Error),
    /// Spawn succeeded but `stdin` or `stdout` pipes were not available.
    /// In practice this only happens if the caller forgets `Stdio::piped()`,
    /// kept here for defense-in-depth.
    PipeMissing,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SpawnFailed(e) => write!(f, "failed to spawn child process: {e}"),
            Self::PipeMissing => write!(f, "child process did not expose required pipes"),
        }
    }
}

impl std::error::Error for SpawnError {}

/// JSONL transport backed by a real `tokio::process::Child`.
pub struct ChildProcessTransport {
    /// Held so the child is reaped on drop. `kill_on_drop = true` doubles as
    /// the SIGKILL backstop when the caller never reaches the graceful path.
    child: Option<Child>,
    /// Child PID for diagnostics and `kill -<sig> -<pgid>`.
    pid: u32,
    /// Write half. `None` once `close_send` has been called.
    stdin: Option<ChildStdin>,
    /// Bounded line reader on top of the child's stdout.
    reader: LineReader<ChildStdout>,
}

impl ChildProcessTransport {
    /// Spawn `command args` in `cwd` with the given env additions.
    ///
    /// The child is placed in its own POSIX session (`setsid`) so a single
    /// `kill(-pgid, SIGTERM)` hits any subprocesses the CLI itself spawns.
    /// `extra_env` is a `ValidatedEnv`, so the only path to construct one
    /// runs through `validation::sanitize_extra_env` — `Command::env` is
    /// never called with attacker-controlled keys.
    pub fn spawn(
        command: &str,
        args: &[String],
        cwd: &ValidatedCwd,
        extra_env: &ValidatedEnv,
    ) -> Result<Self, SpawnError> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(cwd.as_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in extra_env.iter() {
            cmd.env(k, v);
        }

        // SAFETY: `setsid` is async-signal-safe and free of
        // allocator/lock interactions — exactly the operations Rust permits
        // in `pre_exec`. Failure is non-fatal: we fall through to the spawn
        // even if the new session cannot be created.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    // Continue rather than aborting the spawn; group-kill
                    // semantics degrade to single-process kill.
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn().map_err(SpawnError::SpawnFailed)?;
        let pid = child.id().ok_or(SpawnError::PipeMissing)?;
        let stdin = child.stdin.take().ok_or(SpawnError::PipeMissing)?;
        let stdout = child.stdout.take().ok_or(SpawnError::PipeMissing)?;

        if let Some(stderr) = child.stderr.take() {
            spawn_stderr_logger(stderr, pid);
        }

        debug!(pid, "headless child spawned");
        Ok(Self { child: Some(child), pid, stdin: Some(stdin), reader: LineReader::new(stdout) })
    }

    /// Child PID.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Send SIGTERM to the child's process group. Returns `Ok(())` if the
    /// signal was dispatched, regardless of whether the child has exited.
    pub fn terminate_group(&self) -> io::Result<()> {
        // Negative PID targets the process group whose pgid equals the
        // child's PID (since we called `setsid` above). Falls back to a
        // direct SIGTERM if that fails.
        unsafe {
            if libc::kill(-(self.pid as i32), libc::SIGTERM) == 0 {
                return Ok(());
            }
            if libc::kill(self.pid as i32, libc::SIGTERM) == 0 {
                return Ok(());
            }
        }
        Err(io::Error::last_os_error())
    }

    /// Best-effort SIGKILL of the process group; equivalent to `terminate_group`
    /// but with SIGKILL. Used as the escalation when SIGTERM is ignored.
    pub fn kill_group(&self) -> io::Result<()> {
        unsafe {
            if libc::kill(-(self.pid as i32), libc::SIGKILL) == 0 {
                return Ok(());
            }
            if libc::kill(self.pid as i32, libc::SIGKILL) == 0 {
                return Ok(());
            }
        }
        Err(io::Error::last_os_error())
    }

    /// Non-blocking exit-status check. Returns `Some(status)` if the child
    /// has already exited, `None` otherwise. Used by `Session::start`'s
    /// health check to catch CLIs that die immediately after spawn (missing
    /// binary, bad argv, auth failure) before the reader_loop is set up.
    ///
    /// On `try_wait` errors we return `None` (assumed still alive); the
    /// reader_loop's stdout EOF path will still surface the failure, just
    /// with the lifetime of one read poll instead of the post-spawn poll.
    pub fn try_check_exit(&mut self) -> Option<std::process::ExitStatus> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status),
            Ok(None) => None,
            Err(e) => {
                // ECHILD or kernel-side staleness. Return None so the
                // health-check side does not false-positive an "exited"
                // verdict, but log so operators can investigate flaky
                // SIGCHLD delivery in CI sandboxes etc.
                tracing::warn!(pid = self.pid, "try_wait failed: {e}");
                None
            }
        }
    }

    /// Wait for the child to exit. Returns the exit status if the child has
    /// not been reaped yet. Idempotent — subsequent calls return `None` once
    /// the child handle has been consumed.
    pub async fn wait_for_exit(&mut self) -> Option<std::process::ExitStatus> {
        let mut child = self.child.take()?;
        match child.wait().await {
            Ok(status) => Some(status),
            Err(e) => {
                warn!(pid = self.pid, "wait failed: {e}");
                None
            }
        }
    }
}

/// Spawn a tokio task that mirrors the child's stderr to `tracing::warn`,
/// passing every line through `redact` first so any leaked credentials are
/// scrubbed at the log boundary.
fn spawn_stderr_logger(stderr: tokio::process::ChildStderr, pid: u32) {
    use tokio::io::AsyncBufReadExt;
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => warn!(target: "headless::child", pid, "{}", redact(&line)),
                Ok(None) => break,
                Err(e) => {
                    warn!(target: "headless::child", pid, "stderr read failed: {e}");
                    break;
                }
            }
        }
    });
}

#[async_trait]
impl JsonlTransport for ChildProcessTransport {
    async fn send_line(&mut self, line: &str) -> Result<(), SendError> {
        let stdin = self.stdin.as_mut().ok_or(SendError::PeerClosed)?;
        // Frame the line ourselves so callers stay in control of payload
        // shape. Single trailing newline only — multi-newline payloads are
        // a programming error caught at the caller, not silently smoothed.
        if line.ends_with('\n') {
            stdin.write_all(line.as_bytes()).await?;
        } else {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
        }
        stdin.flush().await?;
        Ok(())
    }

    async fn next_record(&mut self) -> Option<LineRecord> {
        self.reader.next_record().await
    }

    async fn close_send(&mut self) -> Result<(), SendError> {
        if let Some(mut stdin) = self.stdin.take() {
            // `shutdown` flushes and closes the write half; the CLI sees EOF.
            stdin.shutdown().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless::line_reader::LineRecord;
    use crate::headless::validation::sanitize_extra_env;
    use std::collections::HashMap;

    fn cwd() -> ValidatedCwd {
        crate::headless::validation::validate_cwd("/tmp")
            .expect("/tmp is a valid cwd")
    }

    fn env() -> ValidatedEnv {
        ValidatedEnv::empty()
    }

    #[tokio::test]
    async fn echo_round_trips_lines() {
        // /bin/cat as a stand-in for an LLM CLI: stdin → stdout, framed by
        // newlines. Verifies spawn, stdin write, stdout read, and natural
        // shutdown all interlock correctly.
        let mut t = ChildProcessTransport::spawn("/bin/cat", &[], &cwd(), &env())
            .expect("spawn /bin/cat");

        t.send_line("{\"hello\":1}").await.unwrap();
        t.send_line("{\"hello\":2}").await.unwrap();

        let first = t.next_record().await.unwrap();
        let second = t.next_record().await.unwrap();
        assert_eq!(first, LineRecord::Line("{\"hello\":1}".into()));
        assert_eq!(second, LineRecord::Line("{\"hello\":2}".into()));

        t.close_send().await.unwrap();
        // After EOF on stdin, cat closes stdout; the reader returns None.
        assert!(t.next_record().await.is_none());
    }

    #[tokio::test]
    async fn missing_binary_yields_spawn_failed() {
        let result = ChildProcessTransport::spawn("/no/such/binary", &[], &cwd(), &env());
        assert!(matches!(result, Err(SpawnError::SpawnFailed(_))));
    }

    #[tokio::test]
    async fn terminate_group_returns_ok_after_spawn() {
        let t = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "sleep 60".into()],
            &cwd(),
            &env(),
        )
        .expect("spawn /bin/sh");
        t.terminate_group().expect("terminate_group");
        // Cleanup happens via kill_on_drop.
    }

    #[tokio::test]
    async fn send_after_close_send_returns_peer_closed() {
        let mut t = ChildProcessTransport::spawn("/bin/cat", &[], &cwd(), &env())
            .expect("spawn /bin/cat");
        t.close_send().await.unwrap();
        let err = t.send_line("late").await.expect_err("send after close");
        assert!(matches!(err, SendError::PeerClosed));
    }

    #[tokio::test]
    async fn try_check_exit_returns_none_for_running_child() {
        let mut t = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "sleep 60".into()],
            &cwd(),
            &env(),
        )
        .expect("spawn /bin/sh sleep");
        assert!(t.try_check_exit().is_none());
        t.kill_group().expect("kill_group");
    }

    #[tokio::test]
    async fn try_check_exit_returns_status_for_quick_exit() {
        let mut t = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "exit 7".into()],
            &cwd(),
            &env(),
        )
        .expect("spawn /bin/sh exit 7");
        // Give the kernel a moment to deliver SIGCHLD; 50 ms is well below
        // the 200 ms post-spawn health-check window in `Session::start`.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let status = t.try_check_exit().expect("child should have exited");
        assert_eq!(status.code(), Some(7));
    }

    #[tokio::test]
    async fn extra_env_is_forwarded_to_child() {
        let mut input = HashMap::new();
        input.insert("HEADLESS_TEST_VAR".into(), "alpaca".into());
        let (validated, _rejected) = sanitize_extra_env(input);
        let mut t = ChildProcessTransport::spawn(
            "/bin/sh",
            &["-c".into(), "printf '%s' \"$HEADLESS_TEST_VAR\"".into()],
            &cwd(),
            &validated,
        )
        .expect("spawn /bin/sh");
        let record = t.next_record().await.unwrap();
        assert_eq!(record, LineRecord::Line("alpaca".into()));
        assert!(t.next_record().await.is_none());
    }
}
