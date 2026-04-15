use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};

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

/// Image attachment for stream-json input to Claude Code CLI.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub data: String,       // base64-encoded image data
    pub media_type: String, // e.g. "image/png"
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
    /// Tracks when the current message started processing. None = idle.
    /// Used to detect stale locks (e.g. process crash without cleanup).
    pub running_since: Arc<Mutex<Option<Instant>>>,
    /// PID of the last spawned child process (for kill)
    child_pid: Arc<Mutex<Option<u32>>>,
    /// Whether the first message has been sent (for Claude Code --resume flag)
    has_session: Arc<AtomicBool>,
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
            child_pid: Arc::new(Mutex::new(None)),
            base_args,
            working_dir,
            session_id: uuid::Uuid::new_v4().to_string(),
            running_since: Arc::new(Mutex::new(None)),
            has_session: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Build CLI arguments for the current message.
    /// When `use_stream_input` is true (Claude Code with images), the message is sent
    /// via stdin (stream-json) instead of as a positional argument.
    /// For Codex, images are passed via `--image <path>` flags.
    fn build_args(&self, message: &str, use_stream_input: bool, image_paths: &[String]) -> Vec<String> {
        let mut args = self.base_args.clone();
        match self.cli_type {
            CliType::ClaudeCode => {
                args.push("-p".into());
                if !use_stream_input {
                    args.push(message.into());
                }
                args.push("--output-format".into());
                args.push("stream-json".into());
                args.push("--verbose".into());
                if use_stream_input {
                    args.push("--input-format".into());
                    args.push("stream-json".into());
                }
                // First message: --session-id UUID creates a new session
                // Subsequent messages: --resume UUID resumes that specific session
                if self.has_session.load(Ordering::Acquire) {
                    args.push("--resume".into());
                } else {
                    args.push("--session-id".into());
                }
                args.push(self.session_id.clone());
            }
            CliType::Codex => {
                // base_args already starts with ["exec", ...flags]
                args.push("--json".into());
                args.push("--skip-git-repo-check".into());
                for path in image_paths {
                    args.push("--image".into());
                    args.push(path.clone());
                }
                // "--" prevents message content from being parsed as CLI flags
                args.push("--".into());
                args.push(message.into());
            }
            CliType::Shell => unreachable!("Shell does not use stream sessions"),
        }
        args
    }

    /// Send a user message and stream the response back via events
    /// Maximum time a single message can run before the lock is considered stale
    const STALE_LOCK_TIMEOUT: Duration = Duration::from_secs(600); // 10 minutes

    pub fn send_message(
        &self,
        pane_id: &str,
        message: &str,
        images: Option<&[ImageAttachment]>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        {
            let mut running = self.running_since.lock();
            if let Some(started) = *running {
                let elapsed = started.elapsed();
                if elapsed < Self::STALE_LOCK_TIMEOUT {
                    tracing::warn!(pane_id = %pane_id, elapsed_ms = elapsed.as_millis(), "send_message rejected: running_since still held");
                    return Err(AppError::StreamSessionBusy("Already processing a message".into()));
                }
                // Stale lock: previous process likely crashed. Force reset.
                tracing::warn!(elapsed_secs = elapsed.as_secs(), "Resetting stale is_running lock");
                // Kill the stale process if PID is still set
                self.kill();
            }
            *running = Some(Instant::now());
        }

        // Guard created immediately after setting running_since.
        // If anything below panics or returns Err, Drop clears running_since automatically.
        let guard = super::running_guard::MessageRunGuard::new(self.running_since.clone());

        let has_images = images.is_some_and(|imgs| !imgs.is_empty());
        // Claude Code: images sent via stdin (stream-json)
        // Codex: images saved to temp files and passed via --image flags
        let use_stream_input = has_images && self.cli_type == CliType::ClaudeCode;
        let image_paths = if has_images && self.cli_type == CliType::Codex {
            Self::save_images_to_temp(images.unwrap_or(&[]))?
        } else {
            Vec::new()
        };

        let (mut child, stdin, stdout, stderr) = self.spawn_cli_process(message, use_stream_input, &image_paths)?;

        // When images are present for Claude Code, write stream-json input to stdin
        if use_stream_input {
            match (stdin, images) {
                (Some(stdin_handle), Some(imgs)) => {
                    if let Err(e) = Self::write_stream_json_input(stdin_handle, message, imgs) {
                        let _ = child.kill();
                        return Err(e);
                    }
                }
                _ => {
                    let _ = child.kill();
                    return Err(AppError::PtyWriteFailed("stdin unavailable for stream-json input".into()));
                }
            }
        }

        // Mark session as created so subsequent messages use --resume
        // (set AFTER successful stdin write to avoid --resume on a never-started session)
        self.has_session.store(true, Ordering::Release);
        self.start_reader_thread(pane_id, child, stdout, stderr, app, guard, image_paths);
        Ok(())
    }

    /// Build and spawn the CLI process, returning the child and its stdio handles.
    fn spawn_cli_process(
        &self,
        message: &str,
        use_stream_input: bool,
        image_paths: &[String],
    ) -> Result<(std::process::Child, Option<std::process::ChildStdin>, std::process::ChildStdout, std::process::ChildStderr), AppError> {
        let args = self.build_args(message, use_stream_input, image_paths);
        let mut cmd = Command::new(&self.command);
        cmd.args(&args)
            .current_dir(&self.working_dir)
            .stdin(if use_stream_input { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        Self::configure_env(&mut cmd);

        let cli_label = match self.cli_type {
            CliType::ClaudeCode => "Claude Code",
            CliType::Codex => "Codex",
            CliType::Shell => "Shell",
        };
        tracing::info!(command = %self.command, cwd = %self.working_dir, "Spawning {cli_label} process");

        // Isolate the child in its own process group so kill(-pid) targets only its group
        cmd.process_group(0);

        let mut child = cmd.spawn()
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to spawn process");
                AppError::PtySpawnFailed(e.to_string())
            })?;

        *self.child_pid.lock() = Some(child.id());

        let stdin = child.stdin.take();
        let stdout = child.stdout.take()
            .ok_or_else(|| {
                let _ = child.kill();
                AppError::PtySpawnFailed("stdout handle unavailable".into())
            })?;
        let stderr = child.stderr.take()
            .ok_or_else(|| {
                let _ = child.kill();
                AppError::PtySpawnFailed("stderr handle unavailable".into())
            })?;

        Ok((child, stdin, stdout, stderr))
    }

    /// Save base64 image attachments to temp files for Codex `--image` flag.
    /// Delegates to the existing `save_temp_image` command which has full security
    /// hardening (O_EXCL, mode 0o600, size limits, extension allowlist).
    const ALLOWED_MEDIA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

    fn save_images_to_temp(images: &[ImageAttachment]) -> Result<Vec<String>, AppError> {
        let mut paths = Vec::with_capacity(images.len());
        for img in images {
            if !Self::ALLOWED_MEDIA_TYPES.contains(&img.media_type.as_str()) {
                return Err(AppError::ImageSaveFailed(format!(
                    "Unsupported media type: {}",
                    img.media_type
                )));
            }
            let ext = img.media_type.strip_prefix("image/").unwrap_or("png");
            // save_temp_image also validates extension via ALLOWED_EXTENSIONS
            let path = crate::commands::image_commands::save_temp_image(
                img.data.clone(),
                Some(ext.to_string()),
            )?;
            paths.push(path);
        }
        Ok(paths)
    }

    /// Write a stream-json user message (with image content blocks) to stdin,
    /// then drop stdin so the CLI processes the input.
    fn write_stream_json_input(
        stdin: std::process::ChildStdin,
        message: &str,
        images: &[ImageAttachment],
    ) -> Result<(), AppError> {
        let mut content = Vec::new();
        for img in images {
            content.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.media_type,
                    "data": img.data,
                }
            }));
        }
        content.push(serde_json::json!({
            "type": "text",
            "text": message,
        }));

        let input_line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": content,
            }
        });

        let mut writer = std::io::BufWriter::new(stdin);
        serde_json::to_writer(&mut writer, &input_line)
            .map_err(|e| AppError::PtyWriteFailed(format!("Failed to write stream-json input: {e}")))?;
        writer.write_all(b"\n")
            .map_err(|e| AppError::PtyWriteFailed(format!("Failed to write newline: {e}")))?;
        writer.flush()
            .map_err(|e| AppError::PtyWriteFailed(format!("Failed to flush stdin: {e}")))?;
        // stdin is dropped here, closing the pipe
        Ok(())
    }

    /// Configure PATH and environment variables for the CLI process.
    fn configure_env(cmd: &mut Command) {
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
    }

    /// Spawn the reader thread that consumes the child process output.
    fn start_reader_thread(
        &self,
        pane_id: &str,
        child: std::process::Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        app: AppHandle,
        guard: super::running_guard::MessageRunGuard,
        temp_image_paths: Vec<String>,
    ) {
        let stream_id = pane_id.to_string();
        let cli_type = self.cli_type;

        std::thread::spawn(move || {
            let _guard = guard; // Dropped on normal exit or panic — clears running_since
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match cli_type {
                    CliType::ClaudeCode => {
                        Self::read_stream_json(child, stdout, stderr, &stream_id, &app);
                    }
                    CliType::Codex => {
                        Self::read_codex_jsonl(child, stdout, stderr, &stream_id, &app);
                    }
                    CliType::Shell => unreachable!(),
                }
            }));
            if let Err(e) = result {
                let msg = e.downcast_ref::<String>()
                    .map(|s| s.as_str())
                    .or_else(|| e.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown");
                tracing::error!(panic = msg, "Reader thread panicked");
            }
            // Clean up Codex temp image files after the CLI process exits
            for path in &temp_image_paths {
                let _ = std::fs::remove_file(path);
            }
        });
    }

    /// Stream Claude Code NDJSON output line by line from piped stdout.
    /// Blocks until each line arrives — no polling, no temp files, no sleep.
    fn read_stream_json(
        mut child: std::process::Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        stream_id: &str,
        app: &AppHandle,
    ) {
        // Capture stderr in a background thread so we can forward it on failure
        let stderr_handle = std::thread::spawn(move || {
            let mut collected = String::new();
            for line in BufReader::new(stderr).lines().flatten() {
                if !line.is_empty() {
                    tracing::warn!(stderr = %line, "Claude Code stderr");
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            collected
        });

        let mut got_output = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    got_output = true;
                    let _ = app.emit("stream-event", StreamEventPayload {
                        id: stream_id.to_string(),
                        data: l,
                    });
                }
                Err(_) => break,
                _ => {}
            }
        }
        tracing::debug!(stream_id, "Claude Code stdout EOF reached");

        let wait_start = Instant::now();
        let exit_code = child.wait().ok().and_then(|s| s.code());
        tracing::debug!(stream_id, exit_code, wait_ms = wait_start.elapsed().as_millis(), "Claude Code child.wait() returned");
        let stderr_text = stderr_handle.join().unwrap_or_default();
        tracing::debug!(stream_id, "Claude Code stderr thread joined");

        // Forward stderr to frontend when process failed or produced no output
        if (!got_output || exit_code.is_none_or(|c| c != 0)) && !stderr_text.is_empty() {
            let _ = app.emit("stream-event", StreamEventPayload {
                id: stream_id.to_string(),
                data: serde_json::json!({
                    "type": "stderr",
                    "text": stderr_text.trim(),
                }).to_string(),
            });
        }

        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({
                "type": "turn_complete",
                "exit_code": exit_code,
            }).to_string(),
        });
        tracing::debug!(stream_id, "Claude Code read_stream_json returning — guard will drop");
        // running_since is cleared by MessageRunGuard (RAII)
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
        tracing::debug!(stream_id, "Codex stdout EOF reached");

        let wait_start = Instant::now();
        let _ = child.wait();
        tracing::debug!(stream_id, wait_ms = wait_start.elapsed().as_millis(), "Codex child.wait() returned");
        // Ensure result + turn_complete is emitted even if Codex didn't send turn.completed
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "result" }).to_string(),
        });
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "turn_complete" }).to_string(),
        });
        tracing::debug!(stream_id, "Codex read_codex_jsonl returning — guard will drop");
        // running_since is cleared by MessageRunGuard (RAII)
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
                        std::thread::sleep(Duration::from_secs(3));
                        if unsafe { libc::kill(-pid_i32, 0) } == 0 {
                            unsafe { libc::kill(-pid_i32, libc::SIGKILL); }
                        }
                    });
                }
                _ => tracing::warn!(pid, "Cannot kill process: PID out of i32 range"),
            }
            // Fallback clear: the reader thread's MessageRunGuard may already have
            // been dropped, or the thread may still be blocked on I/O. Explicitly
            // clearing here ensures kill() always leaves the session idle.
            *self.running_since.lock() = None;
        }
    }

    pub fn is_busy(&self) -> bool {
        self.running_since.lock().is_some()
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
