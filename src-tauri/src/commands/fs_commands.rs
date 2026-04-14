use std::io::{BufRead, BufReader};
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

/// List past Claude Code sessions for a project directory
#[tauri::command]
pub fn list_sessions(working_dir: String) -> Result<Vec<SessionInfo>, AppError> {
    let home = home_dir()?;
    // Claude Code stores sessions with dir path encoded (slashes → dashes)
    let encoded = working_dir.replace('/', "-");
    let allowed_root = home.join(".claude").join("projects");
    let dir = allowed_root.join(&encoded);

    if !dir.exists() {
        return Ok(vec![]);
    }

    // Guard against path traversal: ensure dir is within ~/.claude/projects/
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
            // Validate session_id is UUID-like (alphanumeric + dashes) to reject crafted filenames
            if !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { continue; }

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

/// Read a session's JSONL file and return lines as JSON strings
#[tauri::command]
pub fn read_session(working_dir: String, session_id: String) -> Result<Vec<String>, AppError> {
    // Validate session_id: UUID-like (alphanumeric + dashes), max 64 chars
    if session_id.len() > 64 || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::FileSystemError("Invalid session id".into()));
    }
    let home = home_dir()?;
    let encoded = working_dir.replace('/', "-");
    // Guard against path traversal via working_dir encoding
    if encoded.contains("..") {
        return Err(AppError::FileSystemError("Invalid working directory".into()));
    }
    let allowed_root = home.join(".claude").join("projects").join(&encoded);
    let canonical_allowed = allowed_root.canonicalize()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    let path = canonical_allowed.join(format!("{session_id}.jsonl"));
    let canonical_path = path.canonicalize()
        .map_err(|_| AppError::FileSystemError("Invalid session path".into()))?;

    if !canonical_path.starts_with(&canonical_allowed) {
        return Err(AppError::FileSystemError("Access denied: path outside allowed directory".into()));
    }

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
