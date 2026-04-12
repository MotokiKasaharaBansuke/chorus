use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use tauri::{AppHandle, Emitter};

pub const SOCKET_PATH: &str = "/tmp/multi-llm.sock";

/// Start a Unix socket IPC server.
/// When a message `{"action":"open","dir":"/path"}` is received,
/// emit a `mlm-open-dir` event to the frontend.
pub fn start(app: AppHandle) {
    let listener = bind_socket();
    let Some(listener) = listener else { return };

    tracing::info!("IPC socket listening at {}", SOCKET_PATH);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        // Limit reads to 4097 bytes before any heap allocation
                        let mut limited = (&stream).take(4097);
                        let mut buf = String::new();
                        if limited.read_to_string(&mut buf).is_err() {
                            return;
                        }
                        // Take only the first line
                        let line = buf.lines().next().unwrap_or("").to_string();
                        if line.len() > 4096 {
                            tracing::warn!("IPC: oversized message, ignoring");
                            return;
                        }
                        handle_message(&app, &line);
                        let _ = stream.write_all(b"ok\n");
                    });
                }
                Err(e) => tracing::error!("IPC socket accept error: {}", e),
            }
        }
    });
}

fn bind_socket() -> Option<UnixListener> {
    // Try to bind first. If the address is already in use, check if it's stale.
    match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => {
            set_socket_permissions();
            Some(l)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Stale socket — remove and retry once
            tracing::info!("IPC socket exists, removing stale file");
            let _ = std::fs::remove_file(SOCKET_PATH);
            match UnixListener::bind(SOCKET_PATH) {
                Ok(l) => {
                    set_socket_permissions();
                    Some(l)
                }
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

fn set_socket_permissions() {
    if let Err(e) = std::fs::set_permissions(
        SOCKET_PATH,
        std::fs::Permissions::from_mode(0o600),
    ) {
        tracing::warn!("IPC socket permission set failed: {}", e);
    }
}

fn handle_message(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    if msg["action"] != "open" {
        return;
    }
    let Some(dir) = msg["dir"].as_str() else {
        return;
    };
    // Validate: must be absolute, no null bytes, reasonable length, no parent traversal
    if !dir.starts_with('/') || dir.contains('\0') || dir.len() > 1024 {
        tracing::warn!("IPC: invalid dir rejected: {:?}", dir);
        return;
    }
    if std::path::Path::new(dir)
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        tracing::warn!("IPC: path traversal rejected: {:?}", dir);
        return;
    }
    let cli_type = match msg["cliType"].as_str() {
        Some("codex") => "codex",
        _ => "claude-code",
    };
    tracing::info!("IPC: open dir={} cliType={}", dir, cli_type);
    let payload = serde_json::json!({ "dir": dir, "cliType": cli_type });
    // Emit the Value directly — Tauri serializes it; no double-encoding
    let _ = app.emit("mlm-open-dir", payload);
}

pub fn cleanup() {
    let _ = std::fs::remove_file(SOCKET_PATH);
}
