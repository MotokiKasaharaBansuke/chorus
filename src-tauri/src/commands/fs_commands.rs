use serde::Serialize;
use crate::error::AppError;
use crate::fs::tree::{self, FileNode};

#[tauri::command]
pub fn list_directory(path: String, depth: Option<usize>) -> Result<Vec<FileNode>, AppError> {
    tree::list_directory(&path, depth.unwrap_or(1))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, AppError> {
    tree::read_file_content(&path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub last_modified: u64,
    pub first_line: String,
}

/// List past Claude Code sessions for a project directory
#[tauri::command]
pub fn list_sessions(working_dir: String) -> Result<Vec<SessionInfo>, AppError> {
    let home = std::env::var("HOME").unwrap_or_default();
    // Claude Code stores sessions with dir path encoded
    let encoded = working_dir.replace('/', "-");
    let sessions_dir = format!("{home}/.claude/projects/{encoded}");
    let dir = std::path::Path::new(&sessions_dir);

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") { continue; }

            let session_id = name.trim_end_matches(".jsonl").to_string();
            let metadata = entry.metadata().map_err(|e| AppError::FileSystemError(e.to_string()))?;
            let modified = metadata.modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);

            // Read first user message for preview
            let mut first_line = String::new();
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                for line in content.lines().take(30) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
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
    let home = std::env::var("HOME").unwrap_or_default();
    let encoded = working_dir.replace('/', "-");
    let path = format!("{home}/.claude/projects/{encoded}/{session_id}.jsonl");

    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::FileSystemError(format!("Cannot read session: {e}")))?;

    Ok(content.lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}
