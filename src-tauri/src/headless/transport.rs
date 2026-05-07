//! Transport abstraction over the JSONL pipe between Chorus and the CLI.
//!
//! `JsonlTransport` factors out "talk to a child process over stdin/stdout"
//! so session lifecycle, request/response correlation, and reconnect logic
//! can be unit-tested without spawning real `claude` or `codex` processes.
//!
//! Phase 1a ships `MockTransport` only. The `ChildProcessTransport` lives in
//! Phase 1b and will wrap `tokio::process::Command` + `LineReader`.

use std::io;

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::line_reader::LineRecord;

/// Result of a send operation. Distinct from `LineRecord` to keep the
/// "send failure" and "receive payload" type axes orthogonal.
#[derive(Debug)]
pub enum SendError {
    /// The peer closed its stdin / the channel is gone. Caller should treat
    /// the session as dead and decide whether to respawn.
    PeerClosed,
    /// Something else went wrong at the IO layer (rare on stdin writes).
    Io(io::Error),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PeerClosed => write!(f, "peer closed transport"),
            Self::Io(e) => write!(f, "transport io error: {e}"),
        }
    }
}

impl std::error::Error for SendError {}

impl From<io::Error> for SendError {
    /// Map common "peer closed stdin" errors onto the explicit `PeerClosed`
    /// variant so callers can react with reconnect logic instead of treating
    /// every IO failure as fatal.
    fn from(err: io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof => Self::PeerClosed,
            _ => Self::Io(err),
        }
    }
}

/// Bidirectional JSONL pipe.
///
/// Implementations must guarantee:
/// * `send_line` writes exactly one line **including** the trailing newline,
///   so the peer's `LinesCodec` framing stays intact.
/// * `next_record` returns records in the order the peer emitted them,
///   yielding `Violation` instead of erroring out so a single bad payload
///   does not kill the session.
/// * Both methods are cancel-safe: dropping a future at an `await` point
///   does not corrupt internal buffering.
#[async_trait]
pub trait JsonlTransport: Send {
    /// Write a single JSONL line to the peer. The caller is responsible for
    /// JSON-encoding; this layer only worries about framing.
    async fn send_line(&mut self, line: &str) -> Result<(), SendError>;

    /// Yield the next record from the peer, or `None` once the stream closes.
    async fn next_record(&mut self) -> Option<LineRecord>;

    /// Close the write half. Some CLIs interpret EOF on stdin as "end of
    /// turn"; others as "shut down". Callers must know which.
    async fn close_send(&mut self) -> Result<(), SendError>;
}

/// In-memory transport for tests.
///
/// * Lines passed to `send_line` are appended to an internal log readable
///   via `drain_sent` / `sent_snapshot`.
/// * Pre-seed reads with `from_lines` / `push_line` / `push_record`. Call
///   `close_incoming` to make `next_record` yield `None` once the queue
///   drains.
pub struct MockTransport {
    sent: Mutex<Vec<String>>,
    incoming_tx: Option<mpsc::UnboundedSender<LineRecord>>,
    incoming_rx: mpsc::UnboundedReceiver<LineRecord>,
    send_should_fail: Mutex<Option<SendError>>,
    close_called: Mutex<bool>,
}

impl MockTransport {
    /// Build an empty transport.
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            sent: Mutex::new(Vec::new()),
            incoming_tx: Some(tx),
            incoming_rx: rx,
            send_should_fail: Mutex::new(None),
            close_called: Mutex::new(false),
        }
    }

    /// Pre-seed multiple lines that will be returned in order from
    /// `next_record`. Convenience for fixture-driven tests.
    pub fn from_lines<I, S>(lines: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let me = Self::new();
        for line in lines {
            me.push_line(line.into());
        }
        me
    }

    /// Queue a single line as the next item from `next_record`. Panics if
    /// called after `close_incoming` — this is a test-only helper and the
    /// silent no-op semantics in earlier drafts hid bugs in test setup.
    pub fn push_line(&self, line: String) {
        let tx = self
            .incoming_tx
            .as_ref()
            .expect("push_line called after close_incoming");
        tx.send(LineRecord::Line(line))
            .expect("MockTransport receiver dropped before sender");
    }

    /// Queue a raw record (line or violation). Same semantics as `push_line`.
    pub fn push_record(&self, record: LineRecord) {
        let tx = self
            .incoming_tx
            .as_ref()
            .expect("push_record called after close_incoming");
        tx.send(record)
            .expect("MockTransport receiver dropped before sender");
    }

    /// Drop the internal sender so `next_record` returns `None` once the
    /// pre-seeded queue drains.
    pub fn close_incoming(&mut self) {
        self.incoming_tx = None;
    }

    /// Drain everything sent so far. Tests typically call this once after
    /// the system-under-test finishes a turn.
    pub fn drain_sent(&self) -> Vec<String> {
        std::mem::take(&mut *self.sent.lock())
    }

    /// Snapshot of every line that has been sent, without clearing.
    pub fn sent_snapshot(&self) -> Vec<String> {
        self.sent.lock().clone()
    }

    /// Configure the next `send_line` call to fail with the given error
    /// (consumed once, then send goes back to succeeding).
    pub fn fail_next_send(&self, err: SendError) {
        *self.send_should_fail.lock() = Some(err);
    }

    /// True if `close_send` has been called.
    pub fn was_closed(&self) -> bool {
        *self.close_called.lock()
    }
}

impl Default for MockTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl JsonlTransport for MockTransport {
    async fn send_line(&mut self, line: &str) -> Result<(), SendError> {
        if let Some(err) = self.send_should_fail.lock().take() {
            return Err(err);
        }
        // Strip a trailing newline if the caller passed one — we record the
        // logical payload regardless of whether the test included framing.
        let stored = line.strip_suffix('\n').unwrap_or(line).to_string();
        self.sent.lock().push(stored);
        Ok(())
    }

    async fn next_record(&mut self) -> Option<LineRecord> {
        self.incoming_rx.recv().await
    }

    async fn close_send(&mut self) -> Result<(), SendError> {
        *self.close_called.lock() = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headless::line_reader::LineViolation;

    #[tokio::test]
    async fn send_line_records_payload_without_trailing_newline() {
        let mut t = MockTransport::new();
        t.send_line("{\"type\":\"user\",\"text\":\"hi\"}\n").await.unwrap();
        t.send_line("{\"type\":\"user\",\"text\":\"again\"}").await.unwrap();
        assert_eq!(
            t.drain_sent(),
            vec![
                r#"{"type":"user","text":"hi"}"#.to_string(),
                r#"{"type":"user","text":"again"}"#.to_string(),
            ],
        );
    }

    #[tokio::test]
    async fn next_record_returns_seeded_lines_in_order() {
        let mut t = MockTransport::from_lines(["a", "b", "c"]);
        t.close_incoming();
        assert_eq!(t.next_record().await, Some(LineRecord::Line("a".into())));
        assert_eq!(t.next_record().await, Some(LineRecord::Line("b".into())));
        assert_eq!(t.next_record().await, Some(LineRecord::Line("c".into())));
        assert!(t.next_record().await.is_none());
    }

    #[tokio::test]
    async fn next_record_yields_none_after_close_incoming_when_queue_empty() {
        let mut t = MockTransport::new();
        t.close_incoming();
        assert!(t.next_record().await.is_none());
    }

    #[tokio::test]
    async fn fail_next_send_consumes_once() {
        let mut t = MockTransport::new();
        t.fail_next_send(SendError::PeerClosed);
        let err = t.send_line("x").await.expect_err("expected failure");
        assert!(matches!(err, SendError::PeerClosed));
        // Subsequent send works again.
        t.send_line("y").await.unwrap();
        assert_eq!(t.drain_sent(), vec!["y".to_string()]);
    }

    #[tokio::test]
    async fn close_send_is_observable() {
        let mut t = MockTransport::new();
        assert!(!t.was_closed());
        t.close_send().await.unwrap();
        assert!(t.was_closed());
    }

    #[tokio::test]
    async fn push_record_can_inject_violation() {
        let mut t = MockTransport::from_lines(["ok"]);
        t.push_record(LineRecord::Violation(LineViolation::LineTooLong));
        t.push_line("after-violation".into());
        t.close_incoming();

        assert_eq!(t.next_record().await, Some(LineRecord::Line("ok".into())));
        assert!(matches!(
            t.next_record().await,
            Some(LineRecord::Violation(LineViolation::LineTooLong)),
        ));
        assert_eq!(
            t.next_record().await,
            Some(LineRecord::Line("after-violation".into())),
        );
        assert!(t.next_record().await.is_none());
    }

    #[tokio::test]
    async fn from_io_error_classifies_broken_pipe_as_peer_closed() {
        let err: SendError = io::Error::new(io::ErrorKind::BrokenPipe, "boom").into();
        assert!(matches!(err, SendError::PeerClosed));
        let err: SendError = io::Error::new(io::ErrorKind::UnexpectedEof, "eof").into();
        assert!(matches!(err, SendError::PeerClosed));
        let err: SendError = io::Error::new(io::ErrorKind::Other, "other").into();
        assert!(matches!(err, SendError::Io(_)));
    }

    #[tokio::test]
    #[should_panic(expected = "push_line called after close_incoming")]
    async fn push_line_after_close_incoming_panics() {
        let mut t = MockTransport::new();
        t.close_incoming();
        t.push_line("late".into());
    }

    #[tokio::test]
    async fn sent_snapshot_does_not_clear() {
        let mut t = MockTransport::new();
        t.send_line("a").await.unwrap();
        t.send_line("b").await.unwrap();
        assert_eq!(t.sent_snapshot(), vec!["a".to_string(), "b".to_string()]);
        // Snapshot is non-destructive.
        assert_eq!(t.sent_snapshot().len(), 2);
        // Drain clears.
        assert_eq!(t.drain_sent().len(), 2);
        assert!(t.sent_snapshot().is_empty());
    }
}
