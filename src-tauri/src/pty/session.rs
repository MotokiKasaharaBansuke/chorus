use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};
use serde::Serialize;

use crate::cli::registry::CliType;
use crate::error::AppError;
use super::output_buffer::OutputBuffer;

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub id: String,
    pub code: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct StreamEventPayload {
    pub id: String,
    pub data: String,
}

/// Raw PTY session for shell/legacy CLI
pub struct PtySession {
    writer: Box<dyn Write + Send>,
    pair: PtyPair,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtySession {
    pub fn spawn(
        id: &str,
        command: &str,
        args: &[String],
        working_dir: &str,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<Self, AppError> {
        let pty_system = NativePtySystem::default();

        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::PtySpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(command);
        for arg in args { cmd.arg(arg); }
        cmd.cwd(working_dir);
        for (key, value) in std::env::vars() {
            if !is_sensitive_env_key(&key) { cmd.env(key, value); }
        }
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd)
            .map_err(|e| AppError::PtySpawnFailed(e.to_string()))?;

        let writer = pair.master.take_writer()
            .map_err(|e| AppError::PtySpawnFailed(e.to_string()))?;

        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| AppError::PtySpawnFailed(e.to_string()))?;

        let buffer = OutputBuffer::new(id.to_string(), app.clone());
        let pty_id = id.to_string();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app.emit("pty-exit", PtyExitPayload { id: pty_id, code: None });
                        break;
                    }
                    Ok(n) => buffer.push(&buf[..n]),
                }
            }
        });

        Ok(Self { writer, pair, child })
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), AppError> {
        self.writer.write_all(data).map_err(|e| AppError::PtyWriteFailed(e.to_string()))?;
        self.writer.flush().map_err(|e| AppError::PtyWriteFailed(e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        self.pair.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::PtyWriteFailed(e.to_string()))
    }

    pub fn kill(&mut self) { let _ = self.child.kill(); }
}

/// Stream session for chat-based CLIs (Claude Code, Codex).
/// Each user message spawns the CLI in non-interactive mode and streams output back.
/// - Claude Code: `claude -p "msg" --session-id <id> --output-format stream-json`
/// - Codex: `codex exec "msg" --json` (JSONL output, translated to compatible events)
pub struct StreamSession {
    pub cli_type: CliType,
    pub command: String,
    pub base_args: Vec<String>,
    pub working_dir: String,
    pub session_id: String,
    pub is_running: std::sync::Arc<parking_lot::Mutex<bool>>,
    /// PID of the last spawned child process (for kill)
    child_pid: std::sync::Arc<parking_lot::Mutex<Option<u32>>>,
}

impl StreamSession {
    pub fn new(
        cli_type: CliType,
        command: String,
        base_args: Vec<String>,
        working_dir: String,
    ) -> Self {
        Self {
            cli_type,
            command,
            child_pid: std::sync::Arc::new(parking_lot::Mutex::new(None)),
            base_args,
            working_dir,
            session_id: uuid::Uuid::new_v4().to_string(),
            is_running: std::sync::Arc::new(parking_lot::Mutex::new(false)),
        }
    }

    /// Build CLI arguments for the current message
    fn build_args(&self, message: &str) -> Vec<String> {
        let mut args = self.base_args.clone();
        match self.cli_type {
            CliType::ClaudeCode => {
                args.push("-p".into());
                args.push(message.into());
                args.push("--output-format".into());
                args.push("stream-json".into());
                args.push("--verbose".into());
                args.push("--session-id".into());
                args.push(self.session_id.clone());
            }
            CliType::Codex => {
                // base_args already starts with ["exec", ...flags]
                args.push("--json".into());
                args.push("--skip-git-repo-check".into());
                // "--" prevents message content from being parsed as CLI flags
                args.push("--".into());
                args.push(message.into());
            }
            CliType::Shell => unreachable!("Shell does not use stream sessions"),
        }
        args
    }

    /// Send a user message and stream the response back via events
    pub fn send_message(
        &self,
        pane_id: &str,
        message: &str,
        app: AppHandle,
    ) -> Result<(), AppError> {
        {
            let mut running = self.is_running.lock();
            if *running {
                return Err(AppError::PtyWriteFailed("Already processing a message".into()));
            }
            *running = true;
        }

        let args = self.build_args(message);

        let mut cmd = Command::new(&self.command);
        cmd.args(&args);
        cmd.current_dir(&self.working_dir);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Ensure PATH includes common binary locations
        let current_path = std::env::var("PATH").unwrap_or_default();
        let extra_paths = if let Ok(home) = std::env::var("HOME") {
            format!(
                "{home}/.local/bin:{home}/.volta/bin:{home}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin"
            )
        } else {
            tracing::warn!("HOME env var not set; skipping user-local path entries");
            "/usr/local/bin:/opt/homebrew/bin".to_string()
        };
        cmd.env("PATH", format!("{extra_paths}:{current_path}"));

        for (key, value) in std::env::vars() {
            if key != "PATH" && !is_sensitive_env_key(&key) {
                cmd.env(&key, &value);
            }
        }

        let cli_label = match self.cli_type {
            CliType::ClaudeCode => "Claude Code",
            CliType::Codex => "Codex",
            CliType::Shell => "Shell",
        };
        // Log without message content to avoid storing user prompts in logs
        tracing::info!(
            command = %self.command,
            cwd = %self.working_dir,
            "Spawning {cli_label} process",
        );

        // Isolate the child in its own process group so kill(-pid) targets only its group
        cmd.process_group(0);

        let mut child = cmd.spawn()
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to spawn process");
                // Release the lock so future send_message calls are not permanently blocked
                *self.is_running.lock() = false;
                AppError::PtySpawnFailed(e.to_string())
            })?;

        // Store PID for kill()
        *self.child_pid.lock() = Some(child.id());

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                *self.is_running.lock() = false;
                return Err(AppError::PtySpawnFailed("stdout handle unavailable".into()));
            }
        };
        let stderr = match child.stderr.take() {
            Some(s) => s,
            None => {
                let _ = child.kill();
                *self.is_running.lock() = false;
                return Err(AppError::PtySpawnFailed("stderr handle unavailable".into()));
            }
        };

        let stream_id = pane_id.to_string();
        let app_clone = app.clone();
        let is_running = self.is_running.clone();
        let cli_type = self.cli_type;

        std::thread::spawn(move || {
            match cli_type {
                CliType::ClaudeCode => {
                    Self::read_stream_json(child, stdout, stderr, &stream_id, &app_clone, &is_running);
                }
                CliType::Codex => {
                    Self::read_codex_jsonl(child, stdout, stderr, &stream_id, &app_clone, &is_running);
                }
                CliType::Shell => unreachable!(),
            }
        });

        Ok(())
    }

    /// Stream Claude Code NDJSON output line by line from piped stdout.
    /// Blocks until each line arrives — no polling, no temp files, no sleep.
    fn read_stream_json(
        mut child: std::process::Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        stream_id: &str,
        app: &AppHandle,
        is_running: &std::sync::Arc<parking_lot::Mutex<bool>>,
    ) {
        spawn_stderr_logger(stderr, "Claude Code");

        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    let _ = app.emit("stream-event", StreamEventPayload {
                        id: stream_id.to_string(),
                        data: l,
                    });
                }
                Err(_) => break,
                _ => {}
            }
        }

        let exit_code = child.wait().ok().and_then(|s| s.code());
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({
                "type": "turn_complete",
                "exit_code": exit_code,
            }).to_string(),
        });
        *is_running.lock() = false;
    }

    /// Stream Codex JSONL output line by line from piped stdout, translating events.
    /// Blocks until each line arrives — no polling, no temp files, no sleep.
    ///
    /// Codex exec --json output format (verified):
    ///   {"type":"thread.started","thread_id":"..."}
    ///   {"type":"turn.started"}
    ///   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
    ///   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
    ///   {"type":"item.completed","item":{"id":"...","type":"function_call","name":"shell",...}}
    ///   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,...}}
    fn read_codex_jsonl(
        mut child: std::process::Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        stream_id: &str,
        app: &AppHandle,
        is_running: &std::sync::Arc<parking_lot::Mutex<bool>>,
    ) {
        // Emit init so ChatPanel shows the spinner immediately (before any output arrives)
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "system", "subtype": "init" }).to_string(),
        });

        spawn_stderr_logger(stderr, "Codex");

        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.is_empty() => Self::translate_codex_line(&l, stream_id, app),
                Err(_) => break,
                _ => {}
            }
        }

        let _ = child.wait();
        // Ensure result + turn_complete is emitted even if Codex didn't send turn.completed
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "result" }).to_string(),
        });
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "turn_complete" }).to_string(),
        });
        *is_running.lock() = false;
    }

    /// Translate a single Codex JSONL line into a Claude Code-compatible stream-event.
    fn translate_codex_line(line: &str, stream_id: &str, app: &AppHandle) {
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };

        let event_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "item.completed" | "item.started" => {
                if let Some(item) = obj.get("item") {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");

                    match item_type {
                        // Reasoning → thinking block
                        "reasoning" if !text.is_empty() => {
                            Self::emit_translated(stream_id, app, serde_json::json!({
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [{ "type": "thinking", "thinking": text }]
                                }
                            }));
                        }
                        // Agent message → text block
                        "agent_message" if !text.is_empty() => {
                            Self::emit_translated(stream_id, app, serde_json::json!({
                                "type": "assistant",
                                "message": {
                                    "role": "assistant",
                                    "content": [{ "type": "text", "text": text }]
                                }
                            }));
                        }
                        // Function calls (shell, apply_patch, etc.)
                        "function_call" | "local_shell_call" | "mcp_tool_call" => {
                            let tool_name = item.get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool");
                            let tool_id = item.get("id")
                                .or_else(|| item.get("call_id"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let input = item.get("arguments")
                                .map(|v| v.as_str().unwrap_or("").to_string())
                                .or_else(|| item.get("command").map(|c|
                                    c.as_str().map(|s| s.to_string())
                                        .unwrap_or_else(|| serde_json::to_string_pretty(c).unwrap_or_default())
                                ))
                                .unwrap_or_default();

                            let mut blocks = vec![serde_json::json!({
                                "type": "tool_use",
                                "name": tool_name,
                                "id": tool_id,
                                "input": input,
                            })];

                            // On completion, add tool_result
                            if event_type == "item.completed" {
                                let output = item.get("output")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let is_error = item.get("exit_code")
                                    .and_then(|v| v.as_i64())
                                    .map(|c| c != 0)
                                    .or_else(|| item.get("status")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s != "completed"))
                                    .unwrap_or(false);
                                blocks.push(serde_json::json!({
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": output,
                                    "is_error": is_error,
                                }));
                            }

                            Self::emit_translated(stream_id, app, serde_json::json!({
                                "type": "assistant",
                                "message": { "role": "assistant", "content": blocks }
                            }));
                        }
                        _ => {
                            tracing::debug!(item_type = item_type, "Unknown Codex item type");
                        }
                    }
                }
            }
            // turn.completed carries usage info
            "turn.completed" => {
                if let Some(usage) = obj.get("usage") {
                    Self::emit_translated(stream_id, app, serde_json::json!({
                        "type": "result",
                        "usage": {
                            "input_tokens": usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                            "output_tokens": usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        }
                    }));
                }
            }
            // thread.started, turn.started → already covered by synthetic init
            _ => {}
        }
    }

    fn emit_translated(stream_id: &str, app: &AppHandle, data: serde_json::Value) {
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: data.to_string(),
        });
    }

    pub fn kill(&self) {
        if let Some(pid) = self.child_pid.lock().take() {
            match i32::try_from(pid) {
                Ok(pid_i32) if pid_i32 > 0 => {
                    // Send SIGTERM to the process group (negative PID)
                    unsafe { libc::kill(-pid_i32, libc::SIGTERM); }
                    tracing::info!(pid, "Sent SIGTERM to child process group");
                    // Escalate to SIGKILL if the process does not exit within 3 seconds.
                    // Signal 0 checks whether the process group still exists before sending SIGKILL,
                    // preventing a kill of an unrelated process that recycled the same PID.
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        if unsafe { libc::kill(-pid_i32, 0) } == 0 {
                            unsafe { libc::kill(-pid_i32, libc::SIGKILL); }
                        }
                    });
                }
                _ => tracing::warn!(pid, "Cannot kill process: PID out of i32 range"),
            }
            *self.is_running.lock() = false;
        }
    }

    pub fn is_busy(&self) -> bool {
        *self.is_running.lock()
    }
}

/// Returns true for env keys that should not be forwarded to child CLI processes.
///
/// Uses a suffix-based blocklist. AI coding assistants need `ANTHROPIC_API_KEY`,
/// `OPENAI_API_KEY`, `GITHUB_TOKEN`, and similar vars to function, so those are
/// intentionally allowed through. Only block credentials unrelated to their
/// operation (DB passwords, private keys, connection strings, etc.).
///
/// Note: `_SECRET_KEY` is blocked to catch compound credentials like
/// `STRIPE_SECRET_KEY` that would slip through a plain `_SECRET` suffix check.
fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.ends_with("_PASSWORD")
        || upper.ends_with("_PASSWD")
        || upper.ends_with("_SECRET")
        || upper.ends_with("_SECRET_KEY")
        || upper.ends_with("_PRIVATE_KEY")
        || upper.ends_with("_DSN")
        || upper.ends_with("_CONNECTION_STRING")
        || upper == "AWS_SECRET_ACCESS_KEY"
        || upper == "AWS_SESSION_TOKEN"
        || upper == "DATABASE_URL"
        || upper == "POSTGRES_URL"
        || upper == "MYSQL_URL"
        || upper == "REDIS_URL"
        || upper == "MONGODB_URI"
}

#[cfg(test)]
mod tests {
    use super::is_sensitive_env_key;

    #[test]
    fn blocks_password_suffix() {
        assert!(is_sensitive_env_key("DB_PASSWORD"));
        assert!(is_sensitive_env_key("db_password"));
        assert!(is_sensitive_env_key("MY_APP_PASSWD"));
    }

    #[test]
    fn blocks_secret_suffix() {
        assert!(is_sensitive_env_key("APP_SECRET"));
        assert!(is_sensitive_env_key("STRIPE_SECRET"));
    }

    #[test]
    fn blocks_secret_key_compound_suffix() {
        // STRIPE_SECRET_KEY ends with _SECRET_KEY, not _SECRET alone
        assert!(is_sensitive_env_key("STRIPE_SECRET_KEY"));
        assert!(is_sensitive_env_key("JWT_SECRET_KEY"));
    }

    #[test]
    fn blocks_private_key_suffix() {
        assert!(is_sensitive_env_key("SSL_PRIVATE_KEY"));
        assert!(is_sensitive_env_key("RSA_PRIVATE_KEY"));
    }

    #[test]
    fn blocks_dsn_suffix() {
        assert!(is_sensitive_env_key("SENTRY_DSN"));
        assert!(is_sensitive_env_key("APP_DSN"));
    }

    #[test]
    fn blocks_connection_string_suffix() {
        assert!(is_sensitive_env_key("DB_CONNECTION_STRING"));
    }

    #[test]
    fn blocks_exact_aws_credentials() {
        assert!(is_sensitive_env_key("AWS_SECRET_ACCESS_KEY"));
        assert!(is_sensitive_env_key("AWS_SESSION_TOKEN"));
    }

    #[test]
    fn blocks_database_urls() {
        assert!(is_sensitive_env_key("DATABASE_URL"));
        assert!(is_sensitive_env_key("POSTGRES_URL"));
        assert!(is_sensitive_env_key("MYSQL_URL"));
        assert!(is_sensitive_env_key("REDIS_URL"));
        assert!(is_sensitive_env_key("MONGODB_URI"));
    }

    #[test]
    fn allows_api_keys() {
        assert!(!is_sensitive_env_key("ANTHROPIC_API_KEY"));
        assert!(!is_sensitive_env_key("OPENAI_API_KEY"));
        assert!(!is_sensitive_env_key("GITHUB_TOKEN"));
    }

    #[test]
    fn allows_common_env_vars() {
        assert!(!is_sensitive_env_key("PATH"));
        assert!(!is_sensitive_env_key("HOME"));
        assert!(!is_sensitive_env_key("USER"));
        assert!(!is_sensitive_env_key("LANG"));
    }

    #[test]
    fn case_insensitive_matching() {
        assert!(is_sensitive_env_key("db_password"));
        assert!(is_sensitive_env_key("Db_Password"));
        assert!(!is_sensitive_env_key("anthropic_api_key"));
    }
}

/// Spawn a thread that drains `stderr` and logs each non-empty line.
fn spawn_stderr_logger(stderr: std::process::ChildStderr, label: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            if !line.is_empty() {
                tracing::warn!(stderr = %line, "{label} stderr");
            }
        }
    });
}
