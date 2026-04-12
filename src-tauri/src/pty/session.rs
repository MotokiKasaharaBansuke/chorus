use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::io::{BufRead, BufReader, Read, Write};
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
        for (key, value) in std::env::vars() { cmd.env(key, value); }
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
        let home = std::env::var("HOME").unwrap_or_default();
        let extra_paths = format!(
            "{}/.local/bin:{}/.volta/bin:{}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin",
            home, home, home
        );
        let current_path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{extra_paths}:{current_path}"));

        for (key, value) in std::env::vars() {
            if key != "PATH" {
                cmd.env(&key, &value);
            }
        }

        let cli_label = match self.cli_type {
            CliType::ClaudeCode => "Claude Code",
            CliType::Codex => "Codex",
            CliType::Shell => "Shell",
        };
        tracing::info!(
            command = %self.command,
            args = ?args,
            cwd = %self.working_dir,
            "Spawning {cli_label} process",
        );

        // Use temp files to capture output (avoids pipe buffering issues with macOS sandbox)
        let stdout_path = std::env::temp_dir().join(format!("mlm-stdout-{}.jsonl", pane_id));
        let stderr_path = std::env::temp_dir().join(format!("mlm-stderr-{}.log", pane_id));

        let stdout_file = std::fs::File::create(&stdout_path)
            .map_err(|e| AppError::PtySpawnFailed(format!("Cannot create stdout file: {e}")))?;
        let stderr_file = std::fs::File::create(&stderr_path)
            .map_err(|e| AppError::PtySpawnFailed(format!("Cannot create stderr file: {e}")))?;

        cmd.stdout(stdout_file);
        cmd.stderr(stderr_file);

        let child = cmd.spawn()
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to spawn process");
                AppError::PtySpawnFailed(e.to_string())
            })?;

        // Store PID for kill()
        *self.child_pid.lock() = Some(child.id());

        let stream_id = pane_id.to_string();
        let app_clone = app.clone();
        let is_running = self.is_running.clone();
        let stdout_path_clone = stdout_path.clone();
        let stderr_path_clone = stderr_path.clone();
        let cli_type = self.cli_type;

        std::thread::spawn(move || {
            match cli_type {
                CliType::ClaudeCode => {
                    Self::poll_stream_json(child, &stream_id, &app_clone, &stdout_path_clone, &stderr_path_clone, &is_running);
                }
                CliType::Codex => {
                    Self::poll_codex_jsonl(child, &stream_id, &app_clone, &stdout_path_clone, &stderr_path_clone, &is_running);
                }
                CliType::Shell => unreachable!(),
            }
        });

        Ok(())
    }

    /// Poll output for Claude Code (NDJSON stream-json format — emit lines as-is)
    fn poll_stream_json(
        child: std::process::Child,
        stream_id: &str,
        app: &AppHandle,
        stdout_path: &std::path::Path,
        stderr_path: &std::path::Path,
        is_running: &std::sync::Arc<parking_lot::Mutex<bool>>,
    ) {
        use std::io::{Seek, SeekFrom};

        let mut child = child;
        std::thread::sleep(std::time::Duration::from_millis(500));

        let mut stdout_reader = match std::fs::File::open(stdout_path) {
            Ok(f) => BufReader::new(f),
            Err(e) => {
                tracing::error!(error = %e, "Cannot open stdout file");
                *is_running.lock() = false;
                return;
            }
        };

        let mut last_pos: u64 = 0;

        loop {
            if let Ok(metadata) = std::fs::metadata(stdout_path) {
                let current_size = metadata.len();
                if current_size > last_pos {
                    let _ = stdout_reader.seek(SeekFrom::Start(last_pos));
                    for line in stdout_reader.by_ref().lines() {
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
                    if let Ok(pos) = stdout_reader.seek(SeekFrom::Current(0)) {
                        last_pos = pos;
                    }
                }
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    Self::flush_remaining(&mut stdout_reader, &mut last_pos, stdout_path, stream_id, app);

                    let _ = app.emit("stream-event", StreamEventPayload {
                        id: stream_id.to_string(),
                        data: serde_json::json!({
                            "type": "turn_complete",
                            "exit_code": status.code(),
                        }).to_string(),
                    });

                    Self::log_and_cleanup_stderr(stderr_path);
                    let _ = std::fs::remove_file(stdout_path);
                    *is_running.lock() = false;
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => { *is_running.lock() = false; return; }
            }
        }
    }

    /// Poll JSONL output from `codex exec --json` and translate events to ChatPanel format.
    ///
    /// Codex JSONL events (ThreadEvent):
    ///   thread.started → system.init
    ///   turn.started   → (ignored, init already sent)
    ///   item.started / item.completed → assistant message / tool_use / tool_result
    ///   turn.completed → result + turn_complete
    ///
    /// Each JSONL line is parsed; known events are translated to Claude Code-compatible
    /// stream-events. Unknown lines are forwarded as-is so the frontend can handle them.
    fn poll_codex_jsonl(
        child: std::process::Child,
        stream_id: &str,
        app: &AppHandle,
        stdout_path: &std::path::Path,
        stderr_path: &std::path::Path,
        is_running: &std::sync::Arc<parking_lot::Mutex<bool>>,
    ) {
        use std::io::{Seek, SeekFrom};

        let mut child = child;

        // Emit init so ChatPanel shows the spinner immediately
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "system", "subtype": "init" }).to_string(),
        });

        std::thread::sleep(std::time::Duration::from_millis(300));

        let mut stdout_reader = match std::fs::File::open(stdout_path) {
            Ok(f) => BufReader::new(f),
            Err(e) => {
                tracing::error!(error = %e, "Cannot open stdout file");
                *is_running.lock() = false;
                return;
            }
        };

        let mut last_pos: u64 = 0;

        loop {
            if let Ok(metadata) = std::fs::metadata(stdout_path) {
                let current_size = metadata.len();
                if current_size > last_pos {
                    let _ = stdout_reader.seek(SeekFrom::Start(last_pos));
                    for line in stdout_reader.by_ref().lines() {
                        match line {
                            Ok(l) if !l.is_empty() => {
                                Self::translate_codex_line(&l, stream_id, app);
                            }
                            Err(_) => break,
                            _ => {}
                        }
                    }
                    if let Ok(pos) = stdout_reader.seek(SeekFrom::Current(0)) {
                        last_pos = pos;
                    }
                }
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    // Flush remaining lines with Codex translation
                    Self::flush_remaining_translated(&mut stdout_reader, &mut last_pos, stdout_path, stream_id, app);

                    // Ensure turn_complete is emitted even if Codex didn't send one
                    let _ = app.emit("stream-event", StreamEventPayload {
                        id: stream_id.to_string(),
                        data: serde_json::json!({ "type": "result" }).to_string(),
                    });
                    let _ = app.emit("stream-event", StreamEventPayload {
                        id: stream_id.to_string(),
                        data: serde_json::json!({
                            "type": "turn_complete",
                            "exit_code": status.code(),
                        }).to_string(),
                    });

                    Self::log_and_cleanup_stderr(stderr_path);
                    let _ = std::fs::remove_file(stdout_path);
                    *is_running.lock() = false;
                    return;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_) => { *is_running.lock() = false; return; }
            }
        }
    }

    /// Translate a single Codex JSONL line into a Claude Code-compatible stream-event.
    ///
    /// Actual Codex exec --json output format (verified):
    ///   {"type":"thread.started","thread_id":"..."}
    ///   {"type":"turn.started"}
    ///   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
    ///   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
    ///   {"type":"item.completed","item":{"id":"...","type":"function_call","name":"shell",...}}
    ///   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,...}}
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

    /// Flush remaining lines from stdout file (for stream-json poller)
    fn flush_remaining(
        reader: &mut BufReader<std::fs::File>,
        last_pos: &mut u64,
        stdout_path: &std::path::Path,
        stream_id: &str,
        app: &AppHandle,
    ) {
        use std::io::{Seek, SeekFrom};
        if let Ok(metadata) = std::fs::metadata(stdout_path) {
            if metadata.len() > *last_pos {
                let _ = reader.seek(SeekFrom::Start(*last_pos));
                for line in reader.by_ref().lines() {
                    if let Ok(l) = line {
                        if !l.is_empty() {
                            let _ = app.emit("stream-event", StreamEventPayload {
                                id: stream_id.to_string(),
                                data: l,
                            });
                        }
                    }
                }
            }
        }
    }

    /// Flush remaining lines from stdout file (for Codex JSONL poller — translates each line)
    fn flush_remaining_translated(
        reader: &mut BufReader<std::fs::File>,
        last_pos: &mut u64,
        stdout_path: &std::path::Path,
        stream_id: &str,
        app: &AppHandle,
    ) {
        use std::io::{Seek, SeekFrom};
        if let Ok(metadata) = std::fs::metadata(stdout_path) {
            if metadata.len() > *last_pos {
                let _ = reader.seek(SeekFrom::Start(*last_pos));
                for line in reader.by_ref().lines() {
                    if let Ok(l) = line {
                        if !l.is_empty() {
                            Self::translate_codex_line(&l, stream_id, app);
                        }
                    }
                }
            }
        }
    }

    /// Log stderr content and remove the file
    fn log_and_cleanup_stderr(stderr_path: &std::path::Path) {
        if let Ok(err_content) = std::fs::read_to_string(stderr_path) {
            for line in err_content.lines() {
                if !line.is_empty() {
                    tracing::warn!(stderr = %line, "Process stderr");
                }
            }
        }
        let _ = std::fs::remove_file(stderr_path);
    }

    pub fn kill(&self) {
        if let Some(pid) = self.child_pid.lock().take() {
            // Send SIGTERM to the process group
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            *self.is_running.lock() = false;
            tracing::info!(pid, "Killed child process");
        }
    }
}

// Re-export for use by is_running
impl StreamSession {
    pub fn is_busy(&self) -> bool {
        *self.is_running.lock()
    }
}
