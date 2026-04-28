use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
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
use super::stream_buffer::StreamBuffer;

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

/// Image attachment sent from the frontend as a temp file path + media type.
/// The actual image data is read from the file at send time, avoiding large
/// base64 payloads in the IPC (Tauri command) layer.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub path: String,       // absolute path to temp image file
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
            let mut buf = [0u8; 16384];
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

/// Session flags controlling fork, resume-at, and mirror behavior.
/// All fields default to off/None for backward compatibility.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFlags {
    /// When true, the first message includes `--fork-session` alongside `--resume`.
    #[serde(default)]
    pub fork_session: bool,
    /// When set, the first message uses `--resume <this_id>` instead of
    /// `--session-id <new_uuid>`. Combined with `fork_session` to fork from a
    /// specific parent session.
    pub resume_session_at: Option<String>,
    /// When true, `--session-mirror` is appended to every CLI invocation.
    #[serde(default)]
    pub session_mirror: bool,
}

/// Validate that a session ID is UUID-like: alphanumeric + dashes, max 64 chars.
/// Rejects crafted values that could be interpreted as CLI flags (e.g. "--flag").
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-') // reject values that look like CLI flags
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Extract a `session_id` field from a single Claude Code stream-json line.
///
/// Returns `Some(id)` only when the line parses as JSON, contains a
/// string `session_id`, and that value passes [`is_valid_session_id`] (so
/// untrusted output can never inject CLI flags via this path).
fn extract_session_id(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = value.get("session_id")?.as_str()?;
    is_valid_session_id(id).then(|| id.to_string())
}

/// Try to capture the session_id from a single stream-json line and latch
/// the session-state flags. Returns `true` once the latch fires so the
/// caller can stop scanning subsequent lines for the same field.
///
/// Latching `has_session` and `initial_resume_done` is gated on actually
/// observing a `session_id` from Claude. If the CLI crashes before
/// `system.init`, both flags are untouched here — `read_stream_json`
/// detects the failed exit and marks `initial_resume_done = true` /
/// `has_session = false` to break the death spiral (see the
/// "Break the death spiral" comment in `read_stream_json`).
fn try_latch_session_observation(
    line: &str,
    session_id_slot: &Mutex<String>,
    has_session: &AtomicBool,
    initial_resume_done: &AtomicBool,
) -> bool {
    let Some(observed) = extract_session_id(line) else {
        return false;
    };
    let mut slot = session_id_slot.lock();
    if *slot != observed {
        *slot = observed;
    }
    has_session.store(true, Ordering::Release);
    initial_resume_done.store(true, Ordering::Release);
    true
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
    /// CLI session UUID used with `--session-id` / `--resume`.
    ///
    /// Pre-seeded with a Chorus-generated UUID so the first default-path message
    /// can pass `--session-id <uuid>`. After Claude Code emits its `system.init`
    /// event, the reader thread overwrites this with the *actual* session ID
    /// Claude wrote to disk — required for the resume/fork paths, where Claude
    /// either appends to the parent session or assigns a fresh UUID we never
    /// supplied.
    pub session_id: Arc<Mutex<String>>,
    /// Extra environment variables to set when spawning the CLI (e.g. CLAUDE_CONFIG_DIR).
    pub extra_env: HashMap<String, String>,
    /// Tracks when the current message started processing. None = idle.
    /// Used to detect stale locks (e.g. process crash without cleanup).
    pub running_since: Arc<Mutex<Option<Instant>>>,
    /// PID of the last spawned child process (for kill)
    child_pid: Arc<Mutex<Option<u32>>>,
    /// Whether the first message has been sent (for Claude Code --resume flag)
    has_session: Arc<AtomicBool>,
    /// Session flags for fork, resume-at, and mirror behavior.
    session_flags: SessionFlags,
    /// Whether the initial resume/fork has been consumed. After the first
    /// message, subsequent messages use plain `--resume <session_id>`.
    initial_resume_done: Arc<AtomicBool>,
}

impl StreamSession {
    pub fn new(
        cli_type: CliType,
        command: String,
        base_args: Vec<String>,
        working_dir: String,
        extra_env: HashMap<String, String>,
        flags: SessionFlags,
    ) -> Self {
        // Sanitize: strip resume_session_at if it fails UUID-like validation.
        // This prevents argument injection via crafted session IDs.
        let flags = SessionFlags {
            resume_session_at: flags.resume_session_at.filter(|id| is_valid_session_id(id)),
            ..flags
        };
        // When resume_session_at is set, the first message should use --resume
        // (not --session-id), so start with has_session = true.
        let has_session = flags.resume_session_at.is_some();
        Self {
            cli_type,
            command,
            child_pid: Arc::new(Mutex::new(None)),
            base_args,
            working_dir,
            session_id: Arc::new(Mutex::new(uuid::Uuid::new_v4().to_string())),
            extra_env,
            running_since: Arc::new(Mutex::new(None)),
            has_session: Arc::new(AtomicBool::new(has_session)),
            session_flags: flags,
            initial_resume_done: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns the current effective session ID for `--session-id` / `--resume`.
    /// May change after the first stream-json `session_id` is observed (resume/fork).
    pub fn current_session_id(&self) -> String {
        self.session_id.lock().clone()
    }

    /// Expand `~` at the start of a path to the user's home directory.
    /// Handles both `~` alone and `~/rest` forms.
    fn expand_tilde(path: &str) -> String {
        if path == "~" {
            if let Ok(home) = std::env::var("HOME") {
                return home;
            }
        } else if let Some(rest) = path.strip_prefix("~/") {
            if let Ok(home) = std::env::var("HOME") {
                return PathBuf::from(home).join(rest).to_string_lossy().into_owned();
            }
        }
        path.to_string()
    }

    /// Build CLI arguments for the current message.
    /// When `use_stream_input` is true (Claude Code with image attachments),
    /// the message is sent via stdin (stream-json) instead of as a positional argument.
    /// For Codex, images are passed via `--image <path>` flags.
    fn build_args(&self, message: &str, use_stream_input: bool, image_paths: &[String]) -> Vec<String> {
        let mut args = self.base_args.clone();
        match self.cli_type {
            CliType::ClaudeCode => {
                // `-p` without a following value is valid when `--input-format
                // stream-json` is present — the CLI reads the prompt from stdin.
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
                // Session ID / resume logic:
                // - Default (no flags): first msg → --session-id <own_id>, then --resume <own_id>
                // - resume_session_at: first msg → --resume <parent_id>, then --resume <observed_id>
                // - fork_session + resume_session_at: first msg → --resume <parent_id> --fork-session
                //
                // For the resume/fork paths we never pass `--session-id`, so Claude
                // Code either appends to the parent or assigns a brand-new UUID.
                // The reader thread captures that UUID from the stream-json output
                // and updates `self.session_id`, so subsequent `--resume` here
                // targets the conversation Claude actually wrote to disk.
                let pending_parent = self.session_flags.resume_session_at.as_deref()
                    .filter(|_| !self.initial_resume_done.load(Ordering::Acquire));

                if let Some(parent_id) = pending_parent {
                    args.push("--resume".into());
                    args.push(parent_id.to_owned());
                    if self.session_flags.fork_session {
                        args.push("--fork-session".into());
                    }
                } else if self.has_session.load(Ordering::Acquire) {
                    args.push("--resume".into());
                    args.push(self.current_session_id());
                } else {
                    args.push("--session-id".into());
                    args.push(self.current_session_id());
                }
                if self.session_flags.session_mirror {
                    args.push("--session-mirror".into());
                }
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
        let started = {
            let mut running = self.running_since.lock();
            if let Some(prev) = *running {
                let elapsed = prev.elapsed();
                if elapsed < Self::STALE_LOCK_TIMEOUT {
                    tracing::warn!(pane_id = %pane_id, elapsed_ms = elapsed.as_millis(), "send_message rejected: running_since still held");
                    return Err(AppError::StreamSessionBusy("Already processing a message".into()));
                }
                // Stale lock: previous process likely crashed. Force reset.
                tracing::warn!(elapsed_secs = elapsed.as_secs(), "Resetting stale is_running lock");
                // Kill the stale process if PID is still set
                self.kill();
            }
            let now = Instant::now();
            *running = Some(now);
            now
        };

        // Guard owns `started` so it only clears its own run on drop. If an
        // interrupt + fresh send_message race in before the reader thread
        // exits, the stale guard sees a different Instant and leaves the new
        // run's busy flag intact.
        let guard = super::running_guard::MessageRunGuard::new(self.running_since.clone(), started);

        let has_images = images.is_some_and(|imgs| !imgs.is_empty());
        let imgs = images.unwrap_or(&[]);
        // Claude Code: validate paths now, read+encode during stdin write (one at a time).
        // Codex: validate paths only — the CLI reads files itself via --image flags.
        let use_stream_input = has_images && self.cli_type == CliType::ClaudeCode;

        // Validate all image paths/types upfront (cheap). Actual file reads are
        // deferred to write_stream_json_input so only one image is in memory at a time.
        let image_paths = if has_images {
            Self::validate_image_paths(imgs)?
        } else {
            Vec::new()
        };

        let (mut child, stdin, stdout, stderr) = self.spawn_cli_process(message, use_stream_input, &image_paths)?;

        // Write stream-json input to stdin for Claude Code image attachments.
        // Images are read and base64-encoded one at a time to limit peak memory.
        if use_stream_input {
            match stdin {
                Some(stdin_handle) => {
                    if let Err(e) = Self::write_stream_json_input(stdin_handle, message, imgs) {
                        let _ = child.kill();
                        return Err(e);
                    }
                }
                None => {
                    let _ = child.kill();
                    return Err(AppError::PtyWriteFailed("stdin unavailable for stream-json input".into()));
                }
            }
        }

        // Temp files are cleaned up by the reader thread after the CLI exits
        // (covers both Claude Code and Codex paths).

        // For Codex (no stream-json session_id to observe) latch the session
        // flags right away. For Claude Code we latch them inside the reader
        // thread *after* observing a session_id from stream-json — otherwise
        // a crash before `system.init` would leave `initial_resume_done = true`
        // with `session_id` still pointing at the never-acknowledged Chorus
        // UUID, causing the next message to fail with "No conversation found".
        if self.cli_type == CliType::Codex {
            self.has_session.store(true, Ordering::Release);
            self.initial_resume_done.store(true, Ordering::Release);
        }
        self.start_reader_thread(pane_id, child, stdout, stderr, app, guard, image_paths)?;
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
        for (key, value) in &self.extra_env {
            cmd.env(key, Self::expand_tilde(value));
        }

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

    const ALLOWED_MEDIA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

    /// 20 MiB — must match MAX_IMAGE_BYTES in image_commands.rs.
    const MAX_IMAGE_READ_BYTES: u64 = 20 * 1024 * 1024;

    /// Shared path-level validation: rejects traversal and paths outside temp dir.
    fn assert_temp_image_path(path: &str) -> Result<(), AppError> {
        let p = std::path::Path::new(path);
        if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(AppError::ImageSaveFailed("Path traversal not allowed".into()));
        }
        if !path.starts_with("/tmp/chorus-images/") {
            return Err(AppError::ImageSaveFailed("Image path outside temp directory".into()));
        }
        Ok(())
    }

    /// Shared media type validation.
    fn assert_media_type(media_type: &str) -> Result<(), AppError> {
        if !Self::ALLOWED_MEDIA_TYPES.contains(&media_type) {
            return Err(AppError::ImageSaveFailed(format!(
                "Unsupported media type: {media_type}",
            )));
        }
        Ok(())
    }

    /// Validate a temp image path and read its contents atomically.
    /// Opens with `O_NOFOLLOW` to reject symlinks without a TOCTOU window,
    /// then checks size from the open fd before reading.
    fn validate_and_read_image(path: &str) -> Result<Vec<u8>, AppError> {
        use std::os::unix::fs::OpenOptionsExt;

        Self::assert_temp_image_path(path)?;

        // O_NOFOLLOW atomically rejects symlinks at open time (no TOCTOU window).
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|e| {
                if e.raw_os_error() == Some(libc::ELOOP) {
                    AppError::ImageSaveFailed("Symlinks not allowed".into())
                } else {
                    AppError::ImageSaveFailed(format!("Cannot open image {path}: {e}"))
                }
            })?;

        let meta = file.metadata()
            .map_err(|e| AppError::ImageSaveFailed(format!("Cannot stat image {path}: {e}")))?;
        if !meta.is_file() {
            return Err(AppError::ImageSaveFailed("Not a regular file".into()));
        }
        if meta.len() > Self::MAX_IMAGE_READ_BYTES {
            return Err(AppError::ImageSaveFailed(format!(
                "Image too large: {} bytes (max {})",
                meta.len(), Self::MAX_IMAGE_READ_BYTES
            )));
        }

        let mut bytes = Vec::with_capacity(meta.len() as usize);
        std::io::Read::read_to_end(&mut file, &mut bytes)
            .map_err(|e| AppError::ImageSaveFailed(format!("Failed to read image {path}: {e}")))?;
        Ok(bytes)
    }

    /// Validate all image attachments (media type + path) without reading file contents.
    fn validate_image_paths(images: &[ImageAttachment]) -> Result<Vec<String>, AppError> {
        let mut paths = Vec::with_capacity(images.len());
        for img in images {
            Self::assert_media_type(&img.media_type)?;
            Self::assert_temp_image_path(&img.path)?;
            paths.push(img.path.clone());
        }
        Ok(paths)
    }

    /// Write a stream-json user message to stdin, then drop stdin so the CLI
    /// processes the input.  Images are read and base64-encoded **one at a time**
    /// so peak memory is proportional to the largest single image, not the sum.
    fn write_stream_json_input(
        stdin: std::process::ChildStdin,
        message: &str,
        images: &[ImageAttachment],
    ) -> Result<(), AppError> {
        use base64::Engine;
        use std::io::Write as _;

        let write_err = |e: std::io::Error| AppError::PtyWriteFailed(format!("stdin write failed: {e}"));

        let mut w = std::io::BufWriter::new(stdin);

        // Build JSON manually so each image's bytes can be freed before the next
        // is loaded. The outer structure is:
        //   {"type":"user","message":{"role":"user","content":[...images...,{text}]}}
        w.write_all(br#"{"type":"user","message":{"role":"user","content":["#).map_err(write_err)?;

        for (i, img) in images.iter().enumerate() {
            if i > 0 {
                w.write_all(b",").map_err(write_err)?;
            }
            // Read one image, encode, write, then drop — only one in memory at a time.
            let bytes = Self::validate_and_read_image(&img.path)?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            drop(bytes); // free raw bytes before writing the (potentially large) b64 string

            // NOTE: serde_json::to_string wraps the value in quotes (e.g. "image/png"),
            // which is intentional — the surrounding JSON template omits them.
            let media_type_json = serde_json::to_string(&img.media_type)
                .map_err(|e| AppError::PtyWriteFailed(format!("JSON escape failed: {e}")))?;
            w.write_all(br#"{"type":"image","source":{"type":"base64","media_type":"#).map_err(write_err)?;
            w.write_all(media_type_json.as_bytes()).map_err(write_err)?;
            w.write_all(br#","data":""#).map_err(write_err)?;
            w.write_all(b64.as_bytes()).map_err(write_err)?;
            w.write_all(br#""}}"#).map_err(write_err)?;
            // b64 is dropped here
        }

        // Append the text content part.
        // NOTE: serde_json::to_string wraps the value in quotes and escapes
        // special characters, which is intentional for the manual JSON template.
        let text_json = serde_json::to_string(message)
            .map_err(|e| AppError::PtyWriteFailed(format!("JSON escape failed: {e}")))?;
        if !images.is_empty() {
            w.write_all(b",").map_err(write_err)?;
        }
        w.write_all(br#"{"type":"text","text":"#).map_err(write_err)?;
        w.write_all(text_json.as_bytes()).map_err(write_err)?;
        w.write_all(br#"}"#).map_err(write_err)?;

        // Close content array and outer objects
        w.write_all(b"]}}\n").map_err(write_err)?;
        w.flush().map_err(write_err)?;
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
    ) -> Result<(), AppError> {
        let stream_id = pane_id.to_string();
        let cli_type = self.cli_type;
        let session_id_slot = Arc::clone(&self.session_id);
        let has_session = Arc::clone(&self.has_session);
        let initial_resume_done = Arc::clone(&self.initial_resume_done);

        std::thread::Builder::new()
            .name(format!("reader[{stream_id}]"))
            .stack_size(128 * 1024) // 128 KB — JSON parsing + string ops only
            .spawn(move || {
            // guard is moved into the read function, which drops it explicitly
            // before emitting turn_complete. On panic, catch_unwind's unwind
            // drops it via normal RAII since it's on the call stack.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match cli_type {
                    CliType::ClaudeCode => {
                        Self::read_stream_json(
                            child,
                            stdout,
                            stderr,
                            &stream_id,
                            session_id_slot,
                            has_session,
                            initial_resume_done,
                            &app,
                            guard,
                        );
                    }
                    CliType::Codex => {
                        Self::read_codex_jsonl(
                            child, stdout, stderr, &stream_id, &app, guard,
                        );
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
            // Clean up temp image files after the CLI process exits (both CLI types)
            for path in &temp_image_paths {
                if let Err(e) = std::fs::remove_file(path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(path = %path, error = %e, "Failed to clean up temp image");
                    }
                }
            }
        }).map_err(|e| AppError::PtySpawnFailed(format!("reader thread: {e}")))?;
        Ok(())
    }

    /// Stream Claude Code NDJSON output line by line from piped stdout.
    /// Blocks until each line arrives — no polling, no temp files, no sleep.
    fn read_stream_json(
        mut child: std::process::Child,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
        stream_id: &str,
        session_id_slot: Arc<Mutex<String>>,
        has_session: Arc<AtomicBool>,
        initial_resume_done: Arc<AtomicBool>,
        app: &AppHandle,
        guard: super::running_guard::MessageRunGuard,
    ) {
        // Capture stderr in a background thread so we can forward it on failure.
        // If thread spawn fails, fall back to draining stderr on the current thread
        // to avoid blocking stdout reading — the thread is best-effort.
        let stderr_handle = std::thread::Builder::new()
            .stack_size(64 * 1024) // 64 KB — string accumulation only
            .spawn(move || {
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

        let buffer = StreamBuffer::new(stream_id.to_string(), app.clone());
        let mut got_output = false;
        // Capture session_id once per turn — typically present on the first
        // event (`system.init`). Skip subsequent updates to avoid re-locking
        // and to ignore any later events that lack the field.
        let mut session_id_captured = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    got_output = true;
                    if !session_id_captured && try_latch_session_observation(
                        &l,
                        &session_id_slot,
                        &has_session,
                        &initial_resume_done,
                    ) {
                        session_id_captured = true;
                    }
                    buffer.push(l);
                }
                Err(_) => break,
                _ => {}
            }
        }
        tracing::debug!(stream_id, "Claude Code stdout EOF reached");
        // Flush remaining buffered lines before turn_complete via unbatched channel
        drop(buffer);

        let wait_start = Instant::now();
        let exit_code = child.wait().ok().and_then(|s| s.code());
        tracing::debug!(stream_id, exit_code, wait_ms = wait_start.elapsed().as_millis(), "Claude Code child.wait() returned");
        let stderr_text: String = stderr_handle
            .ok()
            .and_then(|h| h.join().ok())
            .unwrap_or_default();
        tracing::debug!(stream_id, "Claude Code stderr thread joined");

        // Break the death spiral: if the CLI exited without emitting a
        // session_id (e.g. "No conversation found with session ID: ..."),
        // consume the resume/fork flags AND clear has_session so the next
        // send_message falls through to `--session-id <chorus-uuid>` (fresh
        // session) instead of retrying the same invalid `--resume <parent_id>`.
        // Without clearing has_session, the next message would use
        // `--resume <chorus-uuid>` which also fails (Chorus-generated UUIDs
        // are never written to Claude's session store).
        if !session_id_captured && exit_code.is_none_or(|c| c != 0) {
            initial_resume_done.store(true, Ordering::Release);
            has_session.store(false, Ordering::Release);
            tracing::warn!(
                stream_id,
                "CLI exited without session_id — resetting session flags to prevent death spiral"
            );
        }

        // Clear running_since BEFORE emitting events so the frontend can
        // immediately send a new message upon receiving turn_complete without
        // hitting StreamSessionBusy. This eliminates the race condition that
        // previously required the 6×500ms busy-retry polling loop.
        drop(guard);

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
        tracing::debug!(stream_id, "Claude Code read_stream_json done");
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
        guard: super::running_guard::MessageRunGuard,
    ) {
        // Emit init so ChatPanel shows the spinner immediately (before any output arrives)
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "system", "subtype": "init" }).to_string(),
        });

        spawn_stderr_logger(stderr, "Codex");

        let buffer = StreamBuffer::new(stream_id.to_string(), app.clone());
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    if let Some(translated) = Self::translate_codex_line_to_string(&l) {
                        buffer.push(translated);
                    }
                }
                Err(_) => break,
                _ => {}
            }
        }
        tracing::debug!(stream_id, "Codex stdout EOF reached");
        // Flush remaining buffered lines before turn_complete via unbatched channel
        drop(buffer);

        let wait_start = Instant::now();
        let _ = child.wait();
        tracing::debug!(stream_id, wait_ms = wait_start.elapsed().as_millis(), "Codex child.wait() returned");
        // Clear running_since before emitting events (same rationale as read_stream_json)
        drop(guard);

        // Ensure result + turn_complete is emitted even if Codex didn't send turn.completed
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "result" }).to_string(),
        });
        let _ = app.emit("stream-event", StreamEventPayload {
            id: stream_id.to_string(),
            data: serde_json::json!({ "type": "turn_complete" }).to_string(),
        });
        tracing::debug!(stream_id, "Codex read_codex_jsonl done");
    }

    fn translate_codex_line_to_string(line: &str) -> Option<String> {
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return None,
        };

        let event_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "item.completed" | "item.started" => {
                let item = obj.get("item")?;
                let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");

                match item_type {
                    "reasoning" if !text.is_empty() => {
                        Some(serde_json::json!({
                            "type": "assistant",
                            "message": {
                                "role": "assistant",
                                "content": [{ "type": "thinking", "thinking": text }]
                            }
                        }).to_string())
                    }
                    "agent_message" if !text.is_empty() => {
                        Some(serde_json::json!({
                            "type": "assistant",
                            "message": {
                                "role": "assistant",
                                "content": [{ "type": "text", "text": text }]
                            }
                        }).to_string())
                    }
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

                        Some(serde_json::json!({
                            "type": "assistant",
                            "message": { "role": "assistant", "content": blocks }
                        }).to_string())
                    }
                    _ => {
                        tracing::debug!(item_type = item_type, "Unknown Codex item type");
                        None
                    }
                }
            }
            "turn.completed" => {
                obj.get("usage").map(|usage| {
                    serde_json::json!({
                        "type": "result",
                        "usage": {
                            "input_tokens": usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                            "output_tokens": usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        }
                    }).to_string()
                })
            }
            _ => None,
        }
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

    /// Test-only: simulates the state after a successful first message so
    /// tests can verify that `interrupt` preserves the `--resume` flag.
    #[cfg(test)]
    pub(super) fn mark_session_started_for_test(&self) {
        self.has_session.store(true, Ordering::Release);
    }

    /// Test-only: simulates the reader thread latching after observing a
    /// `session_id` event from Claude Code's stream-json output.
    #[cfg(test)]
    pub(super) fn mark_initial_resume_done_for_test(&self) {
        self.initial_resume_done.store(true, Ordering::Release);
    }

    /// Test-only: reads the `has_session` flag without exposing the
    /// underlying `AtomicBool` to non-test code.
    #[cfg(test)]
    pub(super) fn has_session_for_test(&self) -> bool {
        self.has_session.load(Ordering::Acquire)
    }

    /// Test-only: reads the `initial_resume_done` flag without exposing
    /// the underlying `AtomicBool` to non-test code.
    #[cfg(test)]
    pub(super) fn initial_resume_done_for_test(&self) -> bool {
        self.initial_resume_done.load(Ordering::Acquire)
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
    use super::{extract_session_id, is_sensitive_env_key, try_latch_session_observation, SessionFlags, StreamSession};
    use crate::cli::registry::CliType;
    use parking_lot::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    // ---- build_args ----

    fn make_session(cli_type: CliType) -> StreamSession {
        StreamSession::new(cli_type, "claude".into(), vec![], "/tmp".into(), Default::default(), Default::default())
    }

    fn make_session_with_flags(cli_type: CliType, flags: SessionFlags) -> StreamSession {
        StreamSession::new(cli_type, "claude".into(), vec![], "/tmp".into(), Default::default(), flags)
    }

    #[test]
    fn build_args_normal_message_uses_p_arg() {
        let session = make_session(CliType::ClaudeCode);
        let args = session.build_args("hello world", false, &[]);
        // -p should be followed by the message
        let p_idx = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[p_idx + 1], "hello world");
        assert!(!args.contains(&"--input-format".to_string()));
    }

    #[test]
    fn build_args_slash_command_uses_p_arg() {
        let session = make_session(CliType::ClaudeCode);
        let args = session.build_args("/compact", false, &[]);
        let p_idx = args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(args[p_idx + 1], "/compact");
        assert!(!args.contains(&"--input-format".to_string()));
    }

    #[test]
    fn build_args_stream_input_omits_message_after_p() {
        let session = make_session(CliType::ClaudeCode);
        let args = session.build_args("msg with image", true, &[]);
        let p_idx = args.iter().position(|a| a == "-p").unwrap();
        // Next arg after -p should be a flag, not the message
        assert!(args[p_idx + 1].starts_with("--"));
        assert!(args.contains(&"--input-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn build_args_first_message_uses_session_id() {
        let session = make_session(CliType::ClaudeCode);
        let args = session.build_args("hello", false, &[]);
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_args_subsequent_message_uses_resume() {
        let session = make_session(CliType::ClaudeCode);
        session.has_session.store(true, Ordering::Release);
        let args = session.build_args("hello", false, &[]);
        assert!(args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    // ---- session flags ----

    #[test]
    fn build_args_fork_session_includes_fork_and_resume_parent() {
        let flags = SessionFlags {
            fork_session: true,
            resume_session_at: Some("parent-session-id".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        let args = session.build_args("hello", false, &[]);
        // First message should use --resume <parent_id> --fork-session
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"parent-session-id".to_string()));
        assert!(args.contains(&"--fork-session".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn build_args_fork_session_subsequent_uses_observed_session_id() {
        let flags = SessionFlags {
            fork_session: true,
            resume_session_at: Some("parent-session-id".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        // Simulate first message completed and Claude reporting the new
        // forked session ID via stream-json.
        session.has_session.store(true, Ordering::Release);
        session.initial_resume_done.store(true, Ordering::Release);
        *session.session_id.lock() = "claude-fork-uuid".to_string();
        let args = session.build_args("hello", false, &[]);
        // Subsequent message must --resume the observed fork ID,
        // not the parent and not a stale Chorus-generated UUID.
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"claude-fork-uuid".to_string()));
        assert!(!args.contains(&"parent-session-id".to_string()));
        assert!(!args.contains(&"--fork-session".to_string()));
    }

    #[test]
    fn build_args_resume_session_at_subsequent_uses_observed_session_id() {
        // Regression: non-fork resume previously emitted --resume <chorus-uuid>
        // for the second message, which Claude Code rejected with
        // "No conversation found with session ID: ...". The reader thread
        // now overwrites session_id with the value Claude reports, so
        // build_args must pick that up.
        let flags = SessionFlags {
            resume_session_at: Some("parent-session-id".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        session.has_session.store(true, Ordering::Release);
        session.initial_resume_done.store(true, Ordering::Release);
        // Non-fork resume: Claude appends to the parent and reports parent_id.
        *session.session_id.lock() = "parent-session-id".to_string();
        let args = session.build_args("hello", false, &[]);
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"parent-session-id".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn build_args_resume_session_at_uses_resume_from_start() {
        let flags = SessionFlags {
            resume_session_at: Some("existing-session-id".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        let args = session.build_args("hello", false, &[]);
        // First message should use --resume <existing_id> (not --session-id)
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"existing-session-id".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--fork-session".to_string()));
    }

    #[test]
    fn build_args_session_mirror_flag() {
        let flags = SessionFlags {
            session_mirror: true,
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        let args = session.build_args("hello", false, &[]);
        assert!(args.contains(&"--session-mirror".to_string()));
    }

    #[test]
    fn invalid_resume_session_at_is_stripped() {
        // Crafted values (e.g. "--flag-injection") should be rejected
        let flags = SessionFlags {
            resume_session_at: Some("--malicious-flag".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        let args = session.build_args("hello", false, &[]);
        // Should fall back to --session-id (fresh session) since resume_session_at was invalid
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--malicious-flag".to_string()));
    }

    #[test]
    fn empty_resume_session_at_is_stripped() {
        let flags = SessionFlags {
            resume_session_at: Some("".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        let args = session.build_args("hello", false, &[]);
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_args_resume_flags_unchanged_until_session_observed() {
        // If Claude Code crashes before emitting `system.init`, the reader
        // thread never latches the session-state flags. The next send_message
        // must therefore re-issue --resume <parent_id>, not --resume <stale chorus uuid>.
        let flags = SessionFlags {
            resume_session_at: Some("parent-session-id".into()),
            ..Default::default()
        };
        let session = make_session_with_flags(CliType::ClaudeCode, flags);
        // Simulate failed first turn: send_message returned, but reader saw
        // no session_id event, so neither flag was latched.
        assert!(session.has_session.load(Ordering::Acquire), "resume sets has_session at construction");
        assert!(!session.initial_resume_done.load(Ordering::Acquire));
        let args = session.build_args("retry", false, &[]);
        // pending_parent should still resolve to the parent_id, so the retry
        // attempts a fresh resume from the original session.
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"parent-session-id".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn build_args_default_flags_match_existing_behavior() {
        let session = make_session(CliType::ClaudeCode);
        let args = session.build_args("hello", false, &[]);
        // Default: --session-id on first message, no fork/mirror flags
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--fork-session".to_string()));
        assert!(!args.contains(&"--session-mirror".to_string()));
    }

    // ---- extract_session_id ----

    #[test]
    fn extract_session_id_parses_system_init_event() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc-123","cwd":"/tmp"}"#;
        assert_eq!(extract_session_id(line).as_deref(), Some("abc-123"));
    }

    #[test]
    fn extract_session_id_returns_none_when_field_missing() {
        let line = r#"{"type":"assistant","message":{"role":"assistant"}}"#;
        assert_eq!(extract_session_id(line), None);
    }

    #[test]
    fn extract_session_id_returns_none_for_invalid_json() {
        assert_eq!(extract_session_id("not json"), None);
        assert_eq!(extract_session_id(""), None);
    }

    #[test]
    fn extract_session_id_rejects_flag_like_value() {
        // Defense-in-depth: even if Claude somehow emits a CLI-flag-shaped
        // session_id, we must not propagate it into argv.
        let line = r#"{"session_id":"--malicious"}"#;
        assert_eq!(extract_session_id(line), None);
    }

    #[test]
    fn extract_session_id_rejects_non_string_value() {
        let line = r#"{"session_id":12345}"#;
        assert_eq!(extract_session_id(line), None);
    }

    // ---- try_latch_session_observation ----

    fn make_latch_state(initial_id: &str) -> (Mutex<String>, AtomicBool, AtomicBool) {
        (Mutex::new(initial_id.into()), AtomicBool::new(false), AtomicBool::new(false))
    }

    #[test]
    fn try_latch_returns_false_when_no_session_id_field() {
        let (slot, has, done) = make_latch_state("chorus-uuid");
        let line = r#"{"type":"assistant","message":{}}"#;
        assert!(!try_latch_session_observation(line, &slot, &has, &done));
        // Slot and flags untouched
        assert_eq!(*slot.lock(), "chorus-uuid");
        assert!(!has.load(Ordering::Acquire));
        assert!(!done.load(Ordering::Acquire));
    }

    #[test]
    fn try_latch_updates_slot_and_flags_on_observation() {
        let (slot, has, done) = make_latch_state("chorus-uuid");
        let line = r#"{"type":"system","subtype":"init","session_id":"observed-id"}"#;
        assert!(try_latch_session_observation(line, &slot, &has, &done));
        assert_eq!(*slot.lock(), "observed-id");
        assert!(has.load(Ordering::Acquire));
        assert!(done.load(Ordering::Acquire));
    }

    #[test]
    fn try_latch_keeps_slot_when_observed_matches() {
        let (slot, has, done) = make_latch_state("same-id");
        let line = r#"{"session_id":"same-id"}"#;
        assert!(try_latch_session_observation(line, &slot, &has, &done));
        // No-op write path still latches the flags
        assert_eq!(*slot.lock(), "same-id");
        assert!(has.load(Ordering::Acquire));
        assert!(done.load(Ordering::Acquire));
    }

    #[test]
    fn try_latch_rejects_invalid_session_id() {
        let (slot, has, done) = make_latch_state("chorus-uuid");
        let line = r#"{"session_id":"--malicious"}"#;
        assert!(!try_latch_session_observation(line, &slot, &has, &done));
        assert_eq!(*slot.lock(), "chorus-uuid");
        assert!(!has.load(Ordering::Acquire));
        assert!(!done.load(Ordering::Acquire));
    }

    // ---- expand_tilde ----

    #[test]
    fn expand_tilde_replaces_tilde_alone() {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() { return; } // skip if HOME not set
        assert_eq!(StreamSession::expand_tilde("~"), home);
    }

    #[test]
    fn expand_tilde_replaces_tilde_slash_prefix() {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() { return; }
        let result = StreamSession::expand_tilde("~/.claude-work");
        assert!(result.starts_with(&home));
        assert!(result.ends_with(".claude-work"));
        assert!(!result.contains('~'));
    }

    #[test]
    fn expand_tilde_passthrough_absolute() {
        assert_eq!(StreamSession::expand_tilde("/absolute/path"), "/absolute/path");
    }

    #[test]
    fn expand_tilde_passthrough_relative() {
        assert_eq!(StreamSession::expand_tilde("relative/path"), "relative/path");
    }

    // ---- is_sensitive_env_key ----

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

    // ---- validate_and_read_image ----

    #[test]
    fn validate_read_rejects_path_traversal() {
        let result = StreamSession::validate_and_read_image("/tmp/chorus-images/../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn validate_read_rejects_outside_temp_dir() {
        let result = StreamSession::validate_and_read_image("/etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn validate_read_rejects_home_dir_path() {
        let result = StreamSession::validate_and_read_image("/Users/someone/photo.png");
        assert!(result.is_err());
    }

    #[test]
    fn validate_read_accepts_valid_temp_file() {
        let dir = std::path::Path::new("/tmp/chorus-images");
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("test-validate-read.png");
        std::fs::write(&path, b"fake-image-data").unwrap();
        let result = StreamSession::validate_and_read_image(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        let bytes = result.unwrap();
        assert_eq!(bytes, b"fake-image-data");
    }

    #[test]
    fn validate_read_rejects_nonexistent_file() {
        let result = StreamSession::validate_and_read_image(
            "/tmp/chorus-images/nonexistent-abc123.png"
        );
        assert!(result.is_err());
    }

    #[test]
    fn validate_read_rejects_oversized_file() {
        let dir = std::path::Path::new("/tmp/chorus-images");
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("test-oversize.png");
        // Create a sparse file whose metadata reports > MAX_IMAGE_READ_BYTES
        // without actually writing 20+ MiB of data.
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(StreamSession::MAX_IMAGE_READ_BYTES + 1).unwrap();
        drop(file);
        let result = StreamSession::validate_and_read_image(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err());
        let err_msg = format!("{:?}", result.unwrap_err());
        assert!(err_msg.contains("too large"), "Expected 'too large' error, got: {err_msg}");
    }

    // ---- validate_image_paths ----

    #[test]
    fn validate_paths_rejects_unsupported_media_type() {
        let images = vec![super::ImageAttachment {
            path: "/tmp/chorus-images/test.png".into(),
            media_type: "application/pdf".into(),
        }];
        let result = StreamSession::validate_image_paths(&images);
        assert!(result.is_err());
    }

    #[test]
    fn validate_paths_rejects_traversal() {
        let images = vec![super::ImageAttachment {
            path: "/tmp/chorus-images/../etc/passwd".into(),
            media_type: "image/png".into(),
        }];
        let result = StreamSession::validate_image_paths(&images);
        assert!(result.is_err());
    }

    #[test]
    fn validate_paths_rejects_outside_temp_dir() {
        let images = vec![super::ImageAttachment {
            path: "/etc/passwd".into(),
            media_type: "image/png".into(),
        }];
        let result = StreamSession::validate_image_paths(&images);
        assert!(result.is_err());
    }

    #[test]
    fn validate_paths_returns_empty_for_empty_input() {
        let result = StreamSession::validate_image_paths(&[]);
        assert!(result.unwrap().is_empty());
    }
}

/// Spawn a thread that drains `stderr` and logs each non-empty line.
fn spawn_stderr_logger(stderr: std::process::ChildStderr, label: &'static str) {
    if let Err(e) = std::thread::Builder::new()
        .stack_size(64 * 1024) // 64 KB — log forwarding only
        .spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if !line.is_empty() {
                    tracing::warn!(stderr = %line, "{label} stderr");
                }
            }
        })
    {
        tracing::error!(error = %e, "Failed to spawn stderr logger thread");
        // stderr pipe will be dropped, which is safe — CLI won't block on it
    }
}
