use std::io::{BufRead, BufReader};
use std::process::Command;
use serde::Serialize;
use tauri::{AppHandle, State};
use crate::error::AppError;
use crate::fs::tree::{self, FileNode};
use crate::fs::watcher::WatcherState;

/// Validate that `path` is within the user's home directory.
/// Blocks access to system directories like /etc, /var, etc.
fn validate_path_scope(path: &str) -> Result<std::path::PathBuf, AppError> {
    let requested = std::path::Path::new(path);
    let canonical = requested.canonicalize()
        .map_err(|e| AppError::FileSystemError(format!("Cannot resolve path: {e}")))?;

    let home = home_dir()?;
    let canonical_home = home.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    if !canonical.starts_with(&canonical_home) {
        return Err(AppError::FileSystemError("Access denied: path outside home directory".into()));
    }

    // Block sensitive directories within home
    let sensitive = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube", ".docker", ".npmrc", ".netrc", ".env"];
    for dir in &sensitive {
        if canonical.starts_with(canonical_home.join(dir)) {
            return Err(AppError::FileSystemError("Access denied: sensitive directory".into()));
        }
    }

    Ok(canonical)
}

#[tauri::command]
pub fn list_directory(path: String, depth: Option<usize>) -> Result<Vec<FileNode>, AppError> {
    validate_path_scope(&path)?;
    tree::list_directory(&path, depth.unwrap_or(1))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, AppError> {
    validate_path_scope(&path)?;
    tree::read_file_content(&path)
}

#[tauri::command]
pub fn watch_directory(
    path: String,
    app: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<(), AppError> {
    validate_path_scope(&path)?;
    state.start(&path, app)
}

#[tauri::command]
pub fn unwatch_directory(state: State<'_, WatcherState>) -> Result<(), AppError> {
    state.stop();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub last_modified: u64,
    pub first_line: String,
}

fn home_dir() -> Result<std::path::PathBuf, AppError> {
    let home = std::env::var("HOME")
        .map_err(|_| AppError::FileSystemError("HOME environment variable not set".into()))?;
    if home.is_empty() {
        return Err(AppError::FileSystemError("HOME environment variable is empty".into()));
    }
    Ok(std::path::PathBuf::from(home))
}

/// Encode a working directory path to match Claude Code's project directory naming.
/// Claude Code converts both slashes and underscores to dashes.
fn encode_project_dir(working_dir: &str) -> String {
    working_dir.replace('/', "-").replace('_', "-")
}

/// Validate that a session ID is UUID-like: alphanumeric + dashes, max 64 chars.
fn is_valid_session_id(id: &str) -> bool {
    id.len() <= 64 && !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Build the path to the Claude Code project directory for a given working dir.
/// Returns `~/.claude/projects/<encoded_dir>`.
/// Rejects empty or `..`-containing paths as defense-in-depth against traversal.
fn claude_project_dir(working_dir: &str) -> Result<std::path::PathBuf, AppError> {
    if working_dir.is_empty() || working_dir.contains("..") {
        return Err(AppError::FileSystemError("Invalid working directory".into()));
    }
    let home = home_dir()?;
    let encoded = encode_project_dir(working_dir);
    Ok(home.join(".claude").join("projects").join(encoded))
}

/// List past Claude Code sessions for a project directory
#[tauri::command]
pub fn list_sessions(working_dir: String) -> Result<Vec<SessionInfo>, AppError> {
    let dir = claude_project_dir(&working_dir)?;

    if !dir.exists() {
        return Ok(vec![]);
    }

    // Guard against path traversal: ensure dir is within ~/.claude/projects/
    let allowed_root = home_dir()?.join(".claude").join("projects");
    let canonical_allowed = allowed_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;
    let canonical_dir = dir.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;
    if !canonical_dir.starts_with(&canonical_allowed) {
        return Err(AppError::FileSystemError("Access denied: path outside allowed directory".into()));
    }

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(canonical_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") { continue; }

            let session_id = name.trim_end_matches(".jsonl").to_string();
            if !is_valid_session_id(&session_id) { continue; }

            let metadata = entry.metadata().map_err(|e| AppError::FileSystemError(e.to_string()))?;
            let modified = metadata.modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);

            // Read first user message for preview — stream first 30 lines only
            let mut first_line = String::new();
            if let Ok(file) = std::fs::File::open(entry.path()) {
                let reader = BufReader::new(file);
                for line in reader.lines().take(30).flatten() {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Look for user messages with text content
                        let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let role = val.get("message")
                            .and_then(|m| m.get("role"))
                            .and_then(|r| r.as_str())
                            .unwrap_or("");

                        if (msg_type == "user" || msg_type == "human") && role == "user" {
                            if let Some(content_arr) = val.get("message")
                                .and_then(|m| m.get("content"))
                                .and_then(|c| c.as_array())
                            {
                                for block in content_arr {
                                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                            // Skip XML-like tags (IDE context)
                                            let clean = text.lines()
                                                .find(|l| !l.trim().is_empty() && !l.starts_with('<'))
                                                .unwrap_or("")
                                                .trim();
                                            if !clean.is_empty() {
                                                first_line = clean.chars().take(80).collect();
                                                break;
                                            }
                                        }
                                    }
                                }
                            } else if let Some(text) = val.get("message")
                                .and_then(|m| m.get("content"))
                                .and_then(|c| c.as_str())
                            {
                                first_line = text.lines()
                                    .find(|l| !l.trim().is_empty() && !l.starts_with('<'))
                                    .unwrap_or("")
                                    .trim()
                                    .chars()
                                    .take(80)
                                    .collect();
                            }
                            if !first_line.is_empty() { break; }
                        }
                    }
                }
            }

            sessions.push(SessionInfo { session_id, last_modified: modified, first_line });
        }
    }

    // Sort by most recent first
    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(sessions.into_iter().take(20).collect())
}

/// Resolve and validate a session JSONL path, guarding against path traversal.
/// Returns `None` if the file doesn't exist or is outside `~/.claude/projects/`.
fn resolve_session_path(working_dir: &str, session_id: &str) -> Result<Option<std::path::PathBuf>, AppError> {
    let dir = claude_project_dir(working_dir)?;
    let path = dir.join(format!("{session_id}.jsonl"));
    // File must exist for canonicalize to succeed
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    // Guard against symlinks / traversal: the resolved path must stay within
    // ~/.claude/projects/
    let allowed_root = home_dir()?.join(".claude").join("projects");
    let canonical_allowed = allowed_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;
    if !canonical_path.starts_with(&canonical_allowed) {
        return Ok(None);
    }
    Ok(Some(canonical_path))
}

/// Check whether a Claude Code session file exists on disk.
/// Returns `true` if `~/.claude/projects/<encoded_dir>/<session_id>.jsonl` exists
/// and is a non-empty file.  Used to validate a `lastSessionId` before attempting
/// `--resume`, avoiding the "No conversation found" error.
///
/// Unlike `read_session`, invalid inputs return `Ok(false)` rather than `Err`
/// because "does this session exist?" has a natural boolean answer.
#[tauri::command]
pub fn session_file_exists(working_dir: String, session_id: String) -> Result<bool, AppError> {
    if !is_valid_session_id(&session_id) {
        return Ok(false);
    }
    let path = match resolve_session_path(&working_dir, &session_id) {
        Ok(Some(p)) => p,
        _ => return Ok(false),
    };
    match std::fs::metadata(&path) {
        Ok(m) => Ok(m.is_file() && m.len() > 0),
        Err(_) => Ok(false),
    }
}

/// Build the path to the Chorus-managed session cache directory for a given working dir.
/// Returns `~/.config/chorus/session-cache/<encoded_dir>`.
fn session_cache_dir(working_dir: &str) -> Result<std::path::PathBuf, AppError> {
    if working_dir.is_empty() || working_dir.contains("..") {
        return Err(AppError::FileSystemError("Invalid working directory".into()));
    }
    let key = encode_project_dir(working_dir);
    Ok(crate::config_path::config_dir().join("session-cache").join(key))
}

/// Synchronous implementation of session file caching.
fn cache_session_file_sync(working_dir: &str, session_id: &str) -> Result<(), AppError> {
    if !is_valid_session_id(session_id) {
        return Ok(());
    }
    let src = match resolve_session_path(working_dir, session_id) {
        Ok(Some(p)) => p,
        _ => return Ok(()),
    };
    let dest_dir = session_cache_dir(working_dir)?;
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| AppError::FileSystemError(format!("Cannot create cache dir: {e}")))?;
    let dest = dest_dir.join(format!("{session_id}.jsonl"));
    // TOCTOU: source may have been deleted since resolve_session_path.
    match std::fs::copy(&src, &dest) {
        Ok(_) => Ok(()),
        Err(_) => Ok(()),
    }
}

/// Copy a Claude Code session file to Chorus's local cache.
/// Called after each successful turn so the session can be restored if Claude Code
/// prunes the original.  Silently succeeds if the source file doesn't exist.
/// Runs on a blocking thread to avoid stalling the main thread on large files.
#[tauri::command]
pub async fn cache_session_file(working_dir: String, session_id: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || cache_session_file_sync(&working_dir, &session_id))
        .await
        .map_err(|e| AppError::FileSystemError(format!("cache task: {e}")))?
}

/// Synchronous implementation of session file restoration.
fn restore_session_file_sync(working_dir: &str, session_id: &str) -> Result<bool, AppError> {
    if !is_valid_session_id(session_id) {
        return Ok(false);
    }
    // If the original file already exists, no restore needed.
    if let Ok(Some(_)) = resolve_session_path(working_dir, session_id) {
        return Ok(false);
    }
    // Look for the cached copy.
    let cache_dir = match session_cache_dir(working_dir) {
        Ok(d) => d,
        Err(_) => return Ok(false),
    };
    let cache_path = cache_dir.join(format!("{session_id}.jsonl"));
    if !cache_path.is_file() {
        return Ok(false);
    }
    // Restore to ~/.claude/projects/<key>/<id>.jsonl with path traversal guard.
    let dest_dir = claude_project_dir(working_dir)?;
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| AppError::FileSystemError(format!("Cannot create project dir: {e}")))?;
    // Canonicalize after create_dir_all so the directory exists for resolution.
    let allowed_root = home_dir()?.join(".claude").join("projects");
    let canonical_allowed = allowed_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;
    let canonical_dest_dir = dest_dir.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;
    if !canonical_dest_dir.starts_with(&canonical_allowed) {
        return Ok(false);
    }
    let dest = canonical_dest_dir.join(format!("{session_id}.jsonl"));
    // TOCTOU: cache file may have been deleted since the is_file check.
    match std::fs::copy(&cache_path, &dest) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Restore a cached session file to its original Claude Code location.
/// Returns `true` if the file was restored, `false` if no restore was needed
/// (original already exists) or no cache was available.
/// Runs on a blocking thread to avoid stalling the main thread on large files.
#[tauri::command]
pub async fn restore_session_file(working_dir: String, session_id: String) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || restore_session_file_sync(&working_dir, &session_id))
        .await
        .map_err(|e| AppError::FileSystemError(format!("restore task: {e}")))?
}

/// Read a session's JSONL file and return lines as JSON strings
#[tauri::command]
pub fn read_session(working_dir: String, session_id: String) -> Result<Vec<String>, AppError> {
    if !is_valid_session_id(&session_id) {
        return Err(AppError::FileSystemError("Invalid session id".into()));
    }
    let canonical_path = resolve_session_path(&working_dir, &session_id)?
        .ok_or_else(|| AppError::FileSystemError("Invalid session path".into()))?;

    // Only return user/assistant lines to reduce IPC transfer size
    // (Claude Code sessions can be 10-50MB with tool output, thinking, etc.)
    let file = std::fs::File::open(&canonical_path)
        .map_err(|e| AppError::FileSystemError(format!("Cannot read session: {e}")))?;
    let reader = BufReader::new(file);

    Ok(reader.lines()
        .flatten()
        .filter(|l| {
            if l.is_empty() { return false; }
            // Quick check: only parse lines that look like user/assistant messages
            l.contains("\"type\":\"user\"") || l.contains("\"type\":\"assistant\"")
              || l.contains("\"type\":\"human\"")
        })
        .map(|l| l.to_string())
        .collect())
}

/// List past Codex sessions (all sessions — Codex uses YYYY/MM/DD date-based dirs)
#[tauri::command]
pub fn list_codex_sessions(working_dir: String) -> Result<Vec<SessionInfo>, AppError> {
    let _ = working_dir; // Codex has no per-project dirs; all sessions shown
    let sessions_root = home_dir()?.join(".codex").join("sessions");

    if !sessions_root.exists() {
        return Ok(vec![]);
    }

    // Canonicalize the allowed root once for symlink-safe traversal checks
    let canonical_root = sessions_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    let mut sessions = Vec::new();

    // Walk YYYY/MM/DD/*.jsonl — 4 levels deep
    for year_entry in std::fs::read_dir(&sessions_root).into_iter().flatten().flatten() {
        if !year_entry.path().is_dir() { continue; }
        for month_entry in std::fs::read_dir(year_entry.path()).into_iter().flatten().flatten() {
            if !month_entry.path().is_dir() { continue; }
            for day_entry in std::fs::read_dir(month_entry.path()).into_iter().flatten().flatten() {
                if !day_entry.path().is_dir() { continue; }
                // day_entry is a DD/ directory — iterate its files
                for file_entry in std::fs::read_dir(day_entry.path()).into_iter().flatten().flatten() {
                    let path = file_entry.path();
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if !name.ends_with(".jsonl") { continue; }

                    // Guard against symlink-based traversal out of sessions root
                    let canonical_path = match path.canonicalize() {
                        Ok(p) => p,
                        Err(_) => continue,
                    };
                    if !canonical_path.starts_with(&canonical_root) { continue; }

                    let modified = file_entry.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    // Find first user_message event for preview — stream first 30 lines only
                    let file = match std::fs::File::open(&canonical_path) {
                        Ok(f) => f,
                        Err(_) => continue,
                    };
                    let mut first_line_preview = String::new();
                    for line in BufReader::new(file).lines().take(30).flatten() {
                        let val: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if val.get("type").and_then(|t| t.as_str()) == Some("event_msg") {
                            if val.pointer("/payload/type").and_then(|t| t.as_str()) == Some("user_message") {
                                if let Some(msg) = val.pointer("/payload/message").and_then(|m| m.as_str()) {
                                    let clean = msg.trim();
                                    if !clean.is_empty() {
                                        first_line_preview = clean.chars().take(80).collect();
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    sessions.push(SessionInfo {
                        session_id: canonical_path.to_string_lossy().to_string(),
                        last_modified: modified,
                        first_line: first_line_preview,
                    });
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    Ok(sessions.into_iter().take(20).collect())
}

/// Read a Codex session JSONL file by absolute path (must be within ~/.codex/sessions/)
#[tauri::command]
pub fn read_codex_session(session_path: String) -> Result<Vec<String>, AppError> {
    let allowed_root = home_dir()?.join(".codex").join("sessions");
    let canonical_allowed = allowed_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    let path = std::path::PathBuf::from(&session_path);
    let canonical_path = path.canonicalize()
        .map_err(|_| AppError::FileSystemError("Invalid session path".into()))?;

    if !canonical_path.starts_with(&canonical_allowed) {
        return Err(AppError::FileSystemError("Access denied: path outside allowed directory".into()));
    }

    // Only return event_msg lines (user_message / agent_message)
    let file = std::fs::File::open(&canonical_path)
        .map_err(|e| AppError::FileSystemError(format!("Cannot read codex session: {e}")))?;
    let reader = BufReader::new(file);

    Ok(reader.lines()
        .flatten()
        .filter(|l| !l.is_empty() && l.contains("\"event_msg\""))
        .map(|l| l.to_string())
        .collect())
}

const MAX_CHANGED_FILES: usize = 200;
const GIT_TIMEOUT_SECS: u64 = 10;

/// Run a git command with a timeout. Kills the child process if it exceeds the limit.
fn run_git_with_timeout(args: &[&str], working_dir: &str) -> Result<Vec<String>, AppError> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(working_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::FileSystemError(format!("Failed to run git: {e}")))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(GIT_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err(AppError::FileSystemError(
                        format!("git {args:?} timed out after {GIT_TIMEOUT_SECS}s"),
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(AppError::FileSystemError(format!("git process error: {e}"))),
        }
    }

    let output = child.wait_with_output()
        .map_err(|e| AppError::FileSystemError(format!("git process error: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let hint = stderr.lines().next().unwrap_or("unknown error");
        return Err(AppError::FileSystemError(format!("git {args:?} failed: {hint}")));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// Get files changed in the git working tree (staged, unstaged, and untracked).
/// Returns a sorted, deduplicated list of relative file paths (max 200).
#[tauri::command]
pub fn git_changed_files(working_dir: String) -> Result<Vec<String>, AppError> {
    validate_path_scope(&working_dir)?;

    let mut files: Vec<String> = Vec::new();

    // Unstaged changes
    files.extend(run_git_with_timeout(&["diff", "--name-only"], &working_dir)?);
    // Staged changes
    files.extend(run_git_with_timeout(&["diff", "--cached", "--name-only"], &working_dir)?);
    // Untracked files
    files.extend(run_git_with_timeout(&["ls-files", "--others", "--exclude-standard"], &working_dir)?);

    files.sort();
    files.dedup();
    files.truncate(MAX_CHANGED_FILES);
    Ok(files)
}

/// Returns true when the working tree has any change relative to HEAD
/// (modified or staged tracked files). Deliberately ignores untracked
/// files so that post-create-hook artifacts (e.g. `.cargo/config.toml`
/// copied into a new worktree) don't look like user edits.
#[tauri::command]
pub fn git_has_tracked_changes(working_dir: String) -> Result<bool, AppError> {
    validate_path_scope(&working_dir)?;
    let files = run_git_with_timeout(&["diff", "HEAD", "--name-only"], &working_dir)?;
    Ok(!files.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_valid_session_id ----

    #[test]
    fn valid_uuid_session_id() {
        assert!(is_valid_session_id("0614d5d0-7916-4502-a1b0-3848a1bed133"));
    }

    #[test]
    fn empty_session_id_is_invalid() {
        assert!(!is_valid_session_id(""));
    }

    #[test]
    fn session_id_with_path_traversal_is_invalid() {
        assert!(!is_valid_session_id("../../../etc/passwd"));
    }

    #[test]
    fn session_id_over_64_chars_is_invalid() {
        let long = "a".repeat(65);
        assert!(!is_valid_session_id(&long));
    }

    #[test]
    fn session_id_with_slash_is_invalid() {
        assert!(!is_valid_session_id("abc/def"));
    }

    #[test]
    fn session_id_at_64_chars_is_valid() {
        let exact = "a".repeat(64);
        assert!(is_valid_session_id(&exact));
    }

    // ---- encode_project_dir ----

    #[test]
    fn encode_replaces_slashes_and_underscores() {
        assert_eq!(
            encode_project_dir("/Users/test/my_project"),
            "-Users-test-my-project"
        );
    }

    #[test]
    fn encode_empty_string() {
        assert_eq!(encode_project_dir(""), "");
    }

    #[test]
    fn encode_consecutive_slashes() {
        assert_eq!(encode_project_dir("//a//b"), "--a--b");
    }

    // ---- session_file_exists ----

    #[test]
    fn session_file_exists_rejects_invalid_id() {
        // Should return Ok(false), not Err
        let result = session_file_exists(
            "/tmp/nonexistent".to_string(),
            "../../../etc/passwd".to_string(),
        );
        assert_eq!(result.unwrap(), false);
    }

    #[test]
    fn session_file_exists_returns_false_for_missing_file() {
        let result = session_file_exists(
            "/tmp/nonexistent-dir".to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
        );
        assert_eq!(result.unwrap(), false);
    }

    #[test]
    fn session_file_exists_returns_false_for_empty_id() {
        let result = session_file_exists("/tmp".to_string(), "".to_string());
        assert_eq!(result.unwrap(), false);
    }

    // ---- claude_project_dir ----

    #[test]
    fn claude_project_dir_rejects_empty_working_dir() {
        assert!(claude_project_dir("").is_err());
    }

    #[test]
    fn claude_project_dir_rejects_dotdot_traversal() {
        assert!(claude_project_dir("/Users/../etc").is_err());
    }

    // ---- resolve_session_path (integration) ----

    #[test]
    fn resolve_session_path_happy_path() {
        // Create a temp dir mimicking ~/.claude/projects/<key>/<id>.jsonl
        let home = std::env::var("HOME").expect("HOME must be set");
        let session_id = "test-resolve-happy-path-abcdef1234567890";
        let working_dir = "/tmp/chorus-test-resolve";
        let encoded = encode_project_dir(working_dir);
        let dir = std::path::PathBuf::from(&home)
            .join(".claude")
            .join("projects")
            .join(&encoded);
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&file_path, "{\"type\":\"system\"}\n").unwrap();

        let result = resolve_session_path(working_dir, session_id);
        let resolved = result.unwrap().expect("should return Some for existing file");
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with(format!("{session_id}.jsonl")));

        // Cleanup
        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn resolve_session_path_returns_none_for_missing_file() {
        let result = resolve_session_path(
            "/tmp/nonexistent-chorus-test",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        );
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn session_file_exists_returns_false_for_empty_working_dir() {
        let result = session_file_exists("".to_string(), "abcd-1234".to_string());
        assert_eq!(result.unwrap(), false);
    }

    // ---- cache_session_file / restore_session_file ----

    #[test]
    fn cache_and_restore_round_trip() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let session_id = "test-cache-roundtrip-aabbccdd11223344";
        let working_dir = "/tmp/chorus-test-cache";
        let encoded = encode_project_dir(working_dir);

        // Create a fake session file in ~/.claude/projects/
        let project_dir = std::path::PathBuf::from(&home)
            .join(".claude")
            .join("projects")
            .join(&encoded);
        std::fs::create_dir_all(&project_dir).unwrap();
        let original = project_dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&original, "{\"type\":\"system\"}\n").unwrap();

        // Cache it
        let result = cache_session_file_sync(working_dir, session_id);
        assert!(result.is_ok());

        // Verify cache file exists
        let cache_dir = session_cache_dir(working_dir).unwrap();
        let cached = cache_dir.join(format!("{session_id}.jsonl"));
        assert!(cached.is_file());

        // Delete original
        std::fs::remove_file(&original).unwrap();
        assert!(!original.exists());

        // Restore should succeed
        let restored = restore_session_file_sync(working_dir, session_id);
        assert_eq!(restored.unwrap(), true);
        assert!(original.exists());

        // Restore again should return false (original already exists)
        let again = restore_session_file_sync(working_dir, session_id);
        assert_eq!(again.unwrap(), false);

        // Cleanup
        let _ = std::fs::remove_file(&original);
        let _ = std::fs::remove_dir(&project_dir);
        let _ = std::fs::remove_file(&cached);
        let _ = std::fs::remove_dir(&cache_dir);
    }

    #[test]
    fn cache_session_file_noop_for_missing_source() {
        let result = cache_session_file_sync(
            "/tmp/nonexistent-dir",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        );
        assert!(result.is_ok());
    }

    #[test]
    fn restore_session_file_returns_false_when_no_cache() {
        let result = restore_session_file_sync(
            "/tmp/nonexistent-dir",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        );
        assert_eq!(result.unwrap(), false);
    }

    #[test]
    fn session_cache_dir_rejects_empty_working_dir() {
        assert!(session_cache_dir("").is_err());
    }

    #[test]
    fn session_cache_dir_builds_correct_path() {
        let dir = session_cache_dir("/tmp/my-project").unwrap();
        assert!(dir.ends_with("session-cache/-tmp-my-project"));
    }
}
