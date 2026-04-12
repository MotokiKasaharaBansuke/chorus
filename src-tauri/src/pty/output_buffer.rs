use std::sync::mpsc;
use tauri::{AppHandle, Emitter};
use serde::Serialize;

const MAX_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

/// Per-session output buffer.
///
/// Uses an mpsc channel instead of Mutex+sleep: the flush thread wakes up
/// immediately when data arrives (not on a fixed 16ms timer), reducing latency
/// for all 20 sessions running concurrently.
pub struct OutputBuffer {
    tx: mpsc::Sender<Vec<u8>>,
}

impl OutputBuffer {
    pub fn new(pty_id: String, app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        let thread_name = format!("pty-output-buffer[{pty_id}]");
        let _ = std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let mut pending: Vec<u8> = Vec::with_capacity(8192);
                // Carries an incomplete multi-byte UTF-8 sequence across chunk boundaries
                let mut utf8_carry: Vec<u8> = Vec::new();
                let mut overflow_warned = false;

                loop {
                    // Block until data arrives (zero CPU when idle)
                    match rx.recv() {
                        Ok(chunk) => {
                            let space = MAX_BUFFER_BYTES.saturating_sub(pending.len());
                            if space == 0 {
                                if !overflow_warned {
                                    tracing::warn!(id = %pty_id, "PTY output buffer full — data dropped");
                                    overflow_warned = true;
                                }
                                // Continuation bytes for any carry were in the dropped data;
                                // clear carry to avoid prepending stale bytes to the next valid chunk.
                                utf8_carry.clear();
                                // Drain the channel to avoid backing up the sender.
                                while rx.try_recv().is_ok() {}
                            } else {
                                // Prepend carry-over from previous iteration before accepting new data
                                let data = if utf8_carry.is_empty() {
                                    chunk
                                } else {
                                    let mut v = std::mem::take(&mut utf8_carry);
                                    v.extend_from_slice(&chunk);
                                    v
                                };

                                let n = data.len().min(space);
                                pending.extend_from_slice(&data[..n]);
                                overflow_warned = false;

                                // Drain additional queued chunks
                                while let Ok(more) = rx.try_recv() {
                                    let space = MAX_BUFFER_BYTES.saturating_sub(pending.len());
                                    if space == 0 { break; }
                                    let n = more.len().min(space);
                                    pending.extend_from_slice(&more[..n]);
                                }

                                // Decode, carrying any incomplete trailing sequence to the next cycle
                                let (text, carry) = decode_utf8_carrying(&pending);
                                utf8_carry = carry;
                                pending.clear();

                                if !text.is_empty() {
                                    let _ = app.emit("pty-output", PtyOutputPayload {
                                        id: pty_id.clone(),
                                        data: text,
                                    });
                                }
                            }
                        }
                        Err(_) => break, // sender dropped → session closed
                    }
                }
            });

        Self { tx }
    }

    pub fn push(&self, data: &[u8]) {
        // Non-blocking: if the channel is disconnected we silently drop
        let _ = self.tx.send(data.to_vec());
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
        // U+3042 HIRAGANA LETTER A = 0xE3 0x81 0x82
        let (text, carry) = decode_utf8_carrying("あ".as_bytes());
        assert_eq!(text, "あ");
        assert!(carry.is_empty());
    }

    #[test]
    fn incomplete_multibyte_carried_over() {
        // Send first 2 of 3 bytes for U+3042
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
        // 0xFF is not a valid UTF-8 start byte → dropped, no carry
        let (text, carry) = decode_utf8_carrying(&[0xFF]);
        assert!(text.is_empty());
        assert!(carry.is_empty());
    }

    #[test]
    fn mixed_valid_then_incomplete() {
        // "hi" + 2-of-3 bytes of U+3042
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
            // error_len() == None  → sequence is incomplete (not enough bytes yet) → carry over
            // error_len() == Some  → sequence is invalid (wrong bytes) → drop
            let carry = if e.error_len().is_none() {
                bytes[valid_up_to..].to_vec()
            } else {
                Vec::new()
            };
            // bytes[..valid_up_to] is verified valid UTF-8 by the preceding from_utf8 call
            let text = String::from_utf8(bytes[..valid_up_to].to_vec()).unwrap_or_default();
            (text, carry)
        }
    }
}
