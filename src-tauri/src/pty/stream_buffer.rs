use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

/// Aligned to vsync (60fps) to batch lines arriving within one frame.
const BATCH_FLUSH_TIMEOUT: Duration = Duration::from_millis(16);
/// Cap per-batch line count to keep each IPC event small enough that the JS
/// main thread can process it within ~3ms.  With multiple panes streaming
/// simultaneously, large batches starve the browser event loop during output
/// bursts.  20 lines ≈ 2-3ms of synchronous JSON.parse, leaving room for
/// rendering and user-input handling between events.  Throughput is unaffected
/// because the outer loop immediately starts the next batch.
const MAX_LINES_PER_BATCH: usize = 20;

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
        if let Err(e) = std::thread::Builder::new()
            .name(thread_name)
            .stack_size(128 * 1024) // 128 KB — batching + IPC emit only
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
        {
            // rx is dropped with the closure — push() will log a warning per
            // line, which is noisy but safe. Crashing the app (panic) under
            // thread exhaustion would be worse.
            tracing::error!(stream_id = %id_clone, error = %e, "Failed to spawn stream buffer thread");
        }

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
