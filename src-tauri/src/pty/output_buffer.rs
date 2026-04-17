use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use serde::Serialize;

const MAX_BUFFER_BYTES: usize = 256 * 1024;
/// Window during which incoming PTY chunks are coalesced into one IPC emit.
///
/// Without this, each chunk becomes its own `pty-output` event — with 20 busy
/// panes emitting hundreds of chunks per second, the webview IPC queue
/// saturates and blocks `write_pty` invokes, causing visible input lag.
const BATCH_FLUSH_TIMEOUT: Duration = Duration::from_millis(8);

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
        let emit_id = pty_id.clone();
        let overflow_id = pty_id.clone();
        // Both closures need their own copy of the id; sharing via Arc<str> would
        // be cheaper but obscures the intent.
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                run_batch_loop(
                    rx,
                    move |text| {
                        let _ = app.emit("pty-output", PtyOutputPayload {
                            id: emit_id.clone(),
                            data: text,
                        });
                    },
                    move || tracing::warn!(id = %overflow_id, "PTY output buffer full — data dropped"),
                    BATCH_FLUSH_TIMEOUT,
                );
            })
            // Spawn failure leaves the PTY appearing frozen; log loudly rather
            // than silently swallow the error.
            .unwrap_or_else(|e| {
                tracing::error!(id = %pty_id, error = %e, "Failed to spawn PTY output buffer thread");
                panic!("pty output buffer thread spawn failed for {pty_id}: {e}");
            });

        Self { tx }
    }

    pub fn push(&self, data: &[u8]) {
        // Silent drop on disconnect: the sender fires per PTY chunk during
        // teardown, and the reader thread has already exited — logging would
        // flood on every session close.
        let _ = self.tx.send(data.to_vec());
    }
}

/// Drive the batching loop: block for the first chunk, then coalesce any
/// further chunks that arrive within `batch_timeout` into a single `emit`.
///
/// Pure with respect to I/O: `emit` and `on_overflow` are the only side-effect
/// sinks, which keeps the loop unit-testable without Tauri.
pub(crate) fn run_batch_loop<F, O>(
    rx: mpsc::Receiver<Vec<u8>>,
    mut emit: F,
    on_overflow: O,
    batch_timeout: Duration,
)
where
    F: FnMut(String),
    O: Fn(),
{
    let mut pending: Vec<u8> = Vec::with_capacity(8192);
    // Carries an incomplete multi-byte UTF-8 sequence across batches.
    let mut utf8_carry: Vec<u8> = Vec::new();
    let mut overflow_reported = false;

    loop {
        // Block until the first chunk arrives (zero CPU when idle).
        let first = match rx.recv() {
            Ok(c) => c,
            Err(_) => return,
        };

        // Prepend any carry from the last cycle so multi-byte sequences stay intact.
        if !utf8_carry.is_empty() {
            pending.extend_from_slice(&utf8_carry);
            utf8_carry.clear();
        }
        if !append_bounded(&mut pending, &first) && !overflow_reported {
            on_overflow();
            overflow_reported = true;
        }

        // Coalesce additional chunks arriving inside the batch window.
        let deadline = Instant::now() + batch_timeout;
        while pending.len() < MAX_BUFFER_BYTES {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { break; }
            match rx.recv_timeout(remaining) {
                Ok(chunk) => {
                    if !append_bounded(&mut pending, &chunk) && !overflow_reported {
                        on_overflow();
                        overflow_reported = true;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    flush_pending(&mut pending, &mut utf8_carry, &mut emit);
                    return;
                }
            }
        }

        flush_pending(&mut pending, &mut utf8_carry, &mut emit);
        // Reset the overflow latch after a successful flush so a later overflow re-warns.
        overflow_reported = false;
    }
}

/// Append `chunk` to `pending`, truncating to fit `MAX_BUFFER_BYTES`.
/// Returns `true` iff the entire chunk was appended without truncation.
fn append_bounded(pending: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let space = MAX_BUFFER_BYTES.saturating_sub(pending.len());
    let n = chunk.len().min(space);
    pending.extend_from_slice(&chunk[..n]);
    n == chunk.len()
}

fn flush_pending<F: FnMut(String)>(
    pending: &mut Vec<u8>,
    utf8_carry: &mut Vec<u8>,
    emit: &mut F,
) {
    let (text, carry) = decode_utf8_carrying(pending);
    *utf8_carry = carry;
    pending.clear();
    if !text.is_empty() {
        emit(text);
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_utf8_carrying, run_batch_loop, MAX_BUFFER_BYTES};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    /// Collects `emit` calls in a thread-safe Vec so tests can assert on them.
    fn collector() -> (Arc<Mutex<Vec<String>>>, impl FnMut(String)) {
        let sink = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_clone = Arc::clone(&sink);
        let emit = move |text: String| sink_clone.lock().unwrap().push(text);
        (sink, emit)
    }

    #[test]
    fn chunks_within_window_coalesce_into_single_emit() {
        // Three chunks pushed inside the batch window should merge into one emit.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();

        let handle = thread::spawn(move || {
            run_batch_loop(rx, emit, || {}, Duration::from_millis(40));
        });

        // All three arrive well before the 40 ms deadline elapses.
        tx.send(b"foo".to_vec()).unwrap();
        tx.send(b"bar".to_vec()).unwrap();
        tx.send(b"baz".to_vec()).unwrap();
        drop(tx);
        handle.join().unwrap();

        let emits = sink.lock().unwrap();
        assert_eq!(emits.len(), 1, "expected one coalesced emit, got {emits:?}");
        assert_eq!(emits[0], "foobarbaz");
    }

    #[test]
    fn incomplete_utf8_carry_emerges_in_next_cycle() {
        // Split a 3-byte char across two batches; the second batch produces the full char.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();

        let handle = thread::spawn(move || {
            run_batch_loop(rx, emit, || {}, Duration::from_millis(10));
        });

        let bytes = "あ".as_bytes();
        tx.send(bytes[..2].to_vec()).unwrap();
        // Let the first batch window expire before sending the tail.
        thread::sleep(Duration::from_millis(30));
        tx.send(bytes[2..].to_vec()).unwrap();
        drop(tx);
        handle.join().unwrap();

        let emits = sink.lock().unwrap();
        let joined: String = emits.concat();
        assert_eq!(joined, "あ", "carry should resolve on next cycle: {emits:?}");
    }

    #[test]
    fn disconnected_channel_flushes_remaining_batch() {
        // Even if the sender drops without a timeout firing, pending bytes are emitted.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();

        let handle = thread::spawn(move || {
            run_batch_loop(rx, emit, || {}, Duration::from_millis(500));
        });

        tx.send(b"tail".to_vec()).unwrap();
        drop(tx);
        handle.join().unwrap();

        let emits = sink.lock().unwrap();
        assert_eq!(emits.concat(), "tail");
    }

    #[test]
    fn zero_byte_chunk_produces_no_emit() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();

        let handle = thread::spawn(move || {
            run_batch_loop(rx, emit, || {}, Duration::from_millis(10));
        });

        tx.send(Vec::new()).unwrap();
        drop(tx);
        handle.join().unwrap();

        assert!(sink.lock().unwrap().is_empty(), "empty chunk must not trigger emit");
    }

    #[test]
    fn chunk_exactly_at_cap_emits_without_overflow() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();
        let overflow_count = Arc::new(Mutex::new(0u32));
        let overflow_count_clone = Arc::clone(&overflow_count);

        let handle = thread::spawn(move || {
            run_batch_loop(
                rx,
                emit,
                move || *overflow_count_clone.lock().unwrap() += 1,
                Duration::from_millis(10),
            );
        });

        tx.send(vec![b'y'; MAX_BUFFER_BYTES]).unwrap();
        drop(tx);
        handle.join().unwrap();

        let emits = sink.lock().unwrap();
        assert_eq!(emits.iter().map(|s| s.len()).sum::<usize>(), MAX_BUFFER_BYTES);
        assert_eq!(*overflow_count.lock().unwrap(), 0, "exactly-at-cap must not trigger overflow");
    }

    #[test]
    fn overflow_re_warns_after_flush() {
        // A second overflow in a later batch should trigger a second warning —
        // the latch resets after each successful flush.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (_sink, emit) = collector();
        let overflow_count = Arc::new(Mutex::new(0u32));
        let overflow_count_clone = Arc::clone(&overflow_count);

        let handle = thread::spawn(move || {
            run_batch_loop(
                rx,
                emit,
                move || *overflow_count_clone.lock().unwrap() += 1,
                Duration::from_millis(10),
            );
        });

        tx.send(vec![b'a'; MAX_BUFFER_BYTES + 1]).unwrap();
        // Let the first batch flush before triggering a second overflow.
        thread::sleep(Duration::from_millis(30));
        tx.send(vec![b'b'; MAX_BUFFER_BYTES + 1]).unwrap();
        drop(tx);
        handle.join().unwrap();

        assert_eq!(*overflow_count.lock().unwrap(), 2, "each overflow in a new batch should re-warn");
    }

    #[test]
    fn overflow_reports_once_and_drops_excess() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let (sink, emit) = collector();
        let overflow_count = Arc::new(Mutex::new(0u32));
        let overflow_count_clone = Arc::clone(&overflow_count);

        let handle = thread::spawn(move || {
            run_batch_loop(
                rx,
                emit,
                move || *overflow_count_clone.lock().unwrap() += 1,
                Duration::from_millis(10),
            );
        });

        // Fill past MAX_BUFFER_BYTES in a single cycle
        let big = vec![b'x'; MAX_BUFFER_BYTES + 1024];
        tx.send(big).unwrap();
        drop(tx);
        handle.join().unwrap();

        let emits = sink.lock().unwrap();
        let total: usize = emits.iter().map(|s| s.len()).sum();
        assert!(total <= MAX_BUFFER_BYTES, "emitted more than the cap: {total}");
        assert_eq!(*overflow_count.lock().unwrap(), 1, "overflow callback should fire exactly once");
    }

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
