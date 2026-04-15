use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

/// Aligned to vsync (60fps) to batch lines arriving within one frame.
const BATCH_FLUSH_TIMEOUT: Duration = Duration::from_millis(16);
/// Prevents oversized IPC payloads when a CLI produces many lines rapidly.
const MAX_LINES_PER_BATCH: usize = 200;

#[derive(Clone, Serialize)]
pub struct StreamBatchPayload {
    pub id: String,
    pub lines: Vec<String>,
}

pub struct StreamBuffer {
    tx: mpsc::Sender<String>,
}

impl StreamBuffer {
    pub fn new(stream_id: String, app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<String>();
        let id_clone = stream_id.clone();

        let thread_name = format!("stream-buffer[{stream_id}]");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut batch: Vec<String> = Vec::with_capacity(32);

                loop {
                    match rx.recv() {
                        Ok(line) => {
                            batch.push(line);

                            while batch.len() < MAX_LINES_PER_BATCH {
                                match rx.recv_timeout(BATCH_FLUSH_TIMEOUT) {
                                    Ok(more) => batch.push(more),
                                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                                        flush(&app, &stream_id, &mut batch);
                                        return;
                                    }
                                }
                            }

                            flush(&app, &stream_id, &mut batch);
                        }
                        Err(_) => break,
                    }
                }
            })
            .unwrap_or_else(|e| {
                tracing::error!(stream_id = %id_clone, error = %e, "Failed to spawn stream buffer thread");
                panic!("stream buffer thread spawn failed for {id_clone}: {e}");
            });

        Self { tx }
    }

    pub fn push(&self, line: String) {
        if let Err(e) = self.tx.send(line) {
            tracing::warn!(error = %e, "stream buffer send failed (session closed?)");
        }
    }
}

fn flush(app: &AppHandle, stream_id: &str, batch: &mut Vec<String>) {
    if batch.is_empty() {
        return;
    }
    let lines = std::mem::take(batch);
    if let Err(e) = app.emit("stream-event-batch", StreamBatchPayload {
        id: stream_id.to_string(),
        lines,
    }) {
        tracing::warn!(stream_id = %stream_id, error = %e, "stream batch emit failed");
    }
}
