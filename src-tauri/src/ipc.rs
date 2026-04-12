use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub const SOCKET_PATH: &str = "/tmp/multi-llm.sock";

/// Start a Unix socket IPC server.
/// When a message `{"action":"open","dir":"/path"}` is received,
/// emit a `mlm-open-dir` event to the frontend.
pub fn start(app: AppHandle) {
    // Remove stale socket from previous run
    if Path::new(SOCKET_PATH).exists() {
        let _ = std::fs::remove_file(SOCKET_PATH);
    }

    let listener = match UnixListener::bind(SOCKET_PATH) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("IPC socket bind failed: {}", e);
            return;
        }
    };

    // Restrict socket to owner-only (rw-------)
    if let Err(e) = std::fs::set_permissions(
        SOCKET_PATH,
        std::fs::Permissions::from_mode(0o600),
    ) {
        tracing::warn!("IPC socket permission set failed: {}", e);
    }

    tracing::info!("IPC socket listening at {}", SOCKET_PATH);

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(mut stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let reader = BufReader::new(&stream);
                        // Process only the first valid line per connection
                        for line in reader.lines().take(1).map_while(Result::ok) {
                            if line.len() > 4096 {
                                tracing::warn!("IPC: oversized message, ignoring");
                                break;
                            }
                            if let Ok(msg) =
                                serde_json::from_str::<serde_json::Value>(&line)
                            {
                                if msg["action"] == "open" {
                                    if let Some(dir) = msg["dir"].as_str() {
                                        // Validate: must be absolute, no null bytes, reasonable length
                                        if !dir.starts_with('/') || dir.contains('\0') || dir.len() > 1024 {
                                            tracing::warn!("IPC: invalid dir rejected: {:?}", dir);
                                            break;
                                        }
                                        let cli_type = match msg["cliType"].as_str() {
                                            Some("codex") => "codex",
                                            _ => "claude-code",
                                        };
                                        tracing::info!(
                                            "IPC: open dir={} cliType={}",
                                            dir, cli_type
                                        );
                                        let payload = serde_json::json!({
                                            "dir": dir,
                                            "cliType": cli_type,
                                        });
                                        let _ = app.emit(
                                            "mlm-open-dir",
                                            payload.to_string(),
                                        );
                                    }
                                }
                            }
                        }
                        // Acknowledge
                        let _ = stream.write_all(b"ok\n");
                    });
                }
                Err(e) => tracing::error!("IPC socket accept error: {}", e),
            }
        }
    });
}

pub fn cleanup() {
    let _ = std::fs::remove_file(SOCKET_PATH);
}
