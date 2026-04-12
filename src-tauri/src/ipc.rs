use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const SOCKET_PATH: &str = "/tmp/multi-llm.sock";

/// Maximum number of concurrent IPC connections processed at once.
const MAX_CONCURRENT_CONNECTIONS: usize = 4;

/// Maximum accepted message size in bytes.
const MAX_MESSAGE_SIZE: usize = 4096;

// ─── RAII guard: decrements the active-connection counter on drop ─────────
struct ConnectionGuard(Arc<Mutex<usize>>);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut n) = self.0.lock() {
            *n = n.saturating_sub(1);
        }
    }
}

/// Start a Unix socket IPC server.
/// When a message `{"action":"open","dir":"/path"}` is received,
/// emit a `mlm-open-dir` event to the frontend.
pub fn start(app: AppHandle) {
    let Some(listener) = bind_socket() else { return };

    tracing::info!("IPC socket listening at {}", SOCKET_PATH);

    let active = Arc::new(Mutex::new(0usize));

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    // Reject connections when at capacity
                    {
                        let Ok(mut n) = active.lock() else { continue };
                        if *n >= MAX_CONCURRENT_CONNECTIONS {
                            tracing::warn!("IPC: connection limit reached, dropping");
                            continue;
                        }
                        *n += 1;
                    }
                    // RAII guard: decrements counter when this thread exits (even on panic)
                    let _guard = ConnectionGuard(Arc::clone(&active));

                    let app = app.clone();
                    std::thread::spawn(move || {
                        let _guard = _guard; // move guard into worker thread
                        let mut reader = BufReader::new(&stream);
                        let mut line = String::new();
                        let result = reader
                            .by_ref()
                            .take((MAX_MESSAGE_SIZE + 1) as u64)
                            .read_line(&mut line);
                        match result {
                            Ok(_) if line.len() <= MAX_MESSAGE_SIZE => {
                                handle_open_request(&app, line.trim());
                                let _ = stream.write_all(b"ok\n");
                            }
                            Ok(_) => tracing::warn!("IPC: oversized message, ignoring"),
                            Err(e) => tracing::warn!("IPC: read error: {}", e),
                        }
                    });
                }
                Err(e) => tracing::error!("IPC socket accept error: {}", e),
            }
        }
    });
}

/// Bind and secure the Unix socket, recovering from stale socket files.
fn bind_socket() -> Option<UnixListener> {
    match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => Some(secured(l)),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            tracing::info!("IPC socket exists, removing stale file");
            let _ = std::fs::remove_file(SOCKET_PATH);
            match UnixListener::bind(SOCKET_PATH) {
                Ok(l) => Some(secured(l)),
                Err(e2) => {
                    tracing::error!("IPC socket bind failed after cleanup: {}", e2);
                    None
                }
            }
        }
        Err(e) => {
            tracing::error!("IPC socket bind failed: {}", e);
            None
        }
    }
}

/// Apply owner-only permissions (0o600) to the socket and return it.
fn secured(listener: UnixListener) -> UnixListener {
    if let Err(e) = std::fs::set_permissions(
        SOCKET_PATH,
        std::fs::Permissions::from_mode(0o600),
    ) {
        tracing::warn!("IPC socket permission set failed: {}", e);
    }
    listener
}

/// Returns true if `dir` is a safe absolute path to open.
///
/// Rejects relative paths, null bytes, oversized strings, and parent-directory traversal.
fn validate_dir(dir: &str) -> bool {
    if !dir.starts_with('/') || dir.contains('\0') || dir.len() > 1024 {
        return false;
    }
    !std::path::Path::new(dir)
        .components()
        .any(|c| c == std::path::Component::ParentDir)
}

/// Validate and dispatch a single `{"action":"open",...}` IPC message.
fn handle_open_request(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    if msg["action"] != "open" {
        return;
    }
    let Some(dir) = msg["dir"].as_str() else {
        return;
    };
    if !validate_dir(dir) {
        tracing::warn!("IPC: invalid dir rejected: {:?}", dir);
        return;
    }
    let cli_type = match msg["cliType"].as_str() {
        Some("codex") => "codex",
        _ => "claude-code",
    };
    tracing::info!("IPC: open dir={} cliType={}", dir, cli_type);
    // Emit Value directly — Tauri serializes it; no double-encoding
    let _ = app.emit("mlm-open-dir", serde_json::json!({ "dir": dir, "cliType": cli_type }));
}

pub fn cleanup() {
    let _ = std::fs::remove_file(SOCKET_PATH);
}

#[cfg(test)]
mod tests {
    use super::validate_dir;

    #[test]
    fn valid_absolute_path() {
        assert!(validate_dir("/Users/alice/project"));
    }

    #[test]
    fn rejects_relative_path() {
        assert!(!validate_dir("relative/path"));
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(!validate_dir("/Users/alice/../etc/passwd"));
    }

    #[test]
    fn rejects_null_byte() {
        assert!(!validate_dir("/valid/path\0evil"));
    }

    #[test]
    fn rejects_oversized_path() {
        let long = format!("/{}", "a".repeat(1025));
        assert!(!validate_dir(&long));
    }

    #[test]
    fn accepts_path_at_max_length() {
        let max = format!("/{}", "a".repeat(1023));
        assert!(validate_dir(&max));
    }
}
