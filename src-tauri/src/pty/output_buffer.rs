use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

const MAX_BUFFER_BYTES: usize = 256 * 1024;
const BATCH_FLUSH_TIMEOUT: Duration = Duration::from_millis(16);

#[derive(Clone, Serialize)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
pub struct PtyOutputBatchPayload {
    pub id: String,
    pub chunks: Vec<String>,
}

struct DecoderState {
    pending: Vec<u8>,
    utf8_carry: Vec<u8>,
    overflow_warned: bool,
}

impl DecoderState {
    fn new() -> Self {
        Self {
            pending: Vec::with_capacity(8192),
            utf8_carry: Vec::new(),
            overflow_warned: false,
        }
    }

    fn decode_chunk(&mut self, chunk: Vec<u8>) -> Option<String> {
        let remaining_capacity = MAX_BUFFER_BYTES.saturating_sub(self.pending.len());
        if remaining_capacity == 0 {
            if !self.overflow_warned {
                tracing::warn!("PTY output buffer full — data dropped");
                self.overflow_warned = true;
            }
            self.utf8_carry.clear();
            return None;
        }

        let data = if self.utf8_carry.is_empty() {
            chunk
        } else {
            let mut v = std::mem::take(&mut self.utf8_carry);
            v.extend_from_slice(&chunk);
            v
        };

        let bytes_to_take = data.len().min(remaining_capacity);
        self.pending.extend_from_slice(&data[..bytes_to_take]);
        self.overflow_warned = false;

        let (text, carry) = decode_utf8_carrying(&self.pending);
        self.utf8_carry = carry;
        self.pending.clear();

        if text.is_empty() { None } else { Some(text) }
    }
}

/// Per-session output buffer with 16ms batching.
///
/// Collects raw PTY chunks and flushes them as a single IPC batch event
/// every 16ms (one frame at 60fps), reducing IPC overhead from N events
/// per frame to 1 — critical when 20 sessions run concurrently.
pub struct OutputBuffer {
    tx: mpsc::Sender<Vec<u8>>,
}

impl OutputBuffer {
    pub fn new(pty_id: String, app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        let id_clone = pty_id.clone();
        let thread_name = format!("pty-output-buffer[{pty_id}]");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut state = DecoderState::new();
                let mut batch: Vec<String> = Vec::with_capacity(8);

                loop {
                    match rx.recv() {
                        Ok(chunk) => {
                            if let Some(text) = state.decode_chunk(chunk) {
                                batch.push(text);
                            }

                            loop {
                                match rx.recv_timeout(BATCH_FLUSH_TIMEOUT) {
                                    Ok(more) => {
                                        if let Some(text) = state.decode_chunk(more) {
                                            batch.push(text);
                                        }
                                    }
                                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                                        flush_batch(&app, &pty_id, &mut batch);
                                        return;
                                    }
                                }
                            }

                            flush_batch(&app, &pty_id, &mut batch);
                        }
                        Err(_) => break,
                    }
                }
            })
            .unwrap_or_else(|e| {
                tracing::error!(pty_id = %id_clone, error = %e, "Failed to spawn output buffer thread");
                panic!("output buffer thread spawn failed for {id_clone}: {e}");
            });

        Self { tx }
    }

    pub fn push(&self, data: &[u8]) {
        if let Err(e) = self.tx.send(data.to_vec()) {
            tracing::warn!(error = %e, "output buffer send failed (session closed?)");
        }
    }
}

fn flush_batch(app: &AppHandle, pty_id: &str, batch: &mut Vec<String>) {
    if batch.is_empty() {
        return;
    }
    let chunks = std::mem::take(batch);
    if let Err(e) = app.emit("pty-output-batch", PtyOutputBatchPayload {
        id: pty_id.to_string(),
        chunks,
    }) {
        tracing::warn!(pty_id = %pty_id, error = %e, "pty output batch emit failed");
    }
}

#[cfg(test)]
mod tests {
    use super::decode_utf8_carrying;

    #[test]
    fn ascii_returns_no_carry() {
        let (text, carry) = decode_utf8_carrying(b"hello");
        assert_eq!(text, "hello");
        assert!(carry.is_empty());
    }

    #[test]
    fn complete_multibyte_returns_no_carry() {
        let (text, carry) = decode_utf8_carrying("あ".as_bytes());
        assert_eq!(text, "あ");
        assert!(carry.is_empty());
    }

    #[test]
    fn incomplete_multibyte_carried_over() {
        let partial = &"あ".as_bytes()[..2];
        let (text, carry) = decode_utf8_carrying(partial);
        assert!(text.is_empty());
        assert_eq!(carry, partial);
    }

    #[test]
    fn carry_resolves_on_next_chunk() {
        let bytes = "あ".as_bytes();
        let (_, carry) = decode_utf8_carrying(&bytes[..2]);
        let mut combined = carry;
        combined.extend_from_slice(&bytes[2..]);
        let (text, carry2) = decode_utf8_carrying(&combined);
        assert_eq!(text, "あ");
        assert!(carry2.is_empty());
    }

    #[test]
    fn invalid_bytes_dropped_not_carried() {
        let (text, carry) = decode_utf8_carrying(&[0xFF]);
        assert!(text.is_empty());
        assert!(carry.is_empty());
    }

    #[test]
    fn mixed_valid_then_incomplete() {
        let mut bytes = b"hi".to_vec();
        bytes.extend_from_slice(&"あ".as_bytes()[..2]);
        let (text, carry) = decode_utf8_carrying(&bytes);
        assert_eq!(text, "hi");
        assert_eq!(carry, &"あ".as_bytes()[..2]);
    }

    #[test]
    fn empty_input_returns_empty() {
        let (text, carry) = decode_utf8_carrying(b"");
        assert!(text.is_empty());
        assert!(carry.is_empty());
    }
}

/// Decode `bytes` as UTF-8, returning `(valid_text, incomplete_tail)`.
///
/// If the bytes end with an incomplete multi-byte sequence (not enough continuation
/// bytes yet), those trailing bytes are returned as `incomplete_tail` to be prepended
/// to the next chunk instead of being replaced with U+FFFD.
///
/// Truly invalid bytes (wrong encoding, not just truncated) are dropped silently.
pub(crate) fn decode_utf8_carrying(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let carry = if e.error_len().is_none() {
                bytes[valid_up_to..].to_vec()
            } else {
                Vec::new()
            };
            let text = String::from_utf8(bytes[..valid_up_to].to_vec()).unwrap_or_default();
            (text, carry)
        }
    }
}
