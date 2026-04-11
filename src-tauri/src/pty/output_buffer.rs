use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

const FLUSH_INTERVAL_MS: u64 = 16;
const MAX_BUFFER_BYTES: usize = 256 * 1024; // 256KB per flush

#[derive(Clone, Serialize)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

pub struct OutputBuffer {
    buffer: Arc<Mutex<Vec<u8>>>,
}

impl OutputBuffer {
    pub fn new(pty_id: String, app: AppHandle) -> Self {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let buffer_clone = Arc::clone(&buffer);

        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(FLUSH_INTERVAL_MS));
                let data = {
                    let mut buf = buffer_clone.lock();
                    if buf.is_empty() {
                        continue;
                    }
                    let data = buf.clone();
                    buf.clear();
                    data
                };

                let text = String::from_utf8_lossy(&data).to_string();
                let _ = app.emit("pty-output", PtyOutputPayload {
                    id: pty_id.clone(),
                    data: text,
                });
            }
        });

        Self { buffer }
    }

    pub fn push(&self, data: &[u8]) {
        let mut buf = self.buffer.lock();
        let remaining = MAX_BUFFER_BYTES.saturating_sub(buf.len());
        if remaining > 0 {
            let to_push = data.len().min(remaining);
            buf.extend_from_slice(&data[..to_push]);
        }
    }
}
