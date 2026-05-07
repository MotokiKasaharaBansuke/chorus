//! Bounded line reader for JSONL streams.
//!
//! Wraps `tokio_util::codec::LinesCodec` so a malicious or buggy CLI cannot
//! OOM Chorus by emitting an unbounded "line". Each record returned is either
//! a complete UTF-8 `Line` or a `Violation` describing why the upstream
//! emission was rejected — the stream stays alive across violations so a
//! single oversized payload does not kill the session.

use tokio::io::AsyncRead;
use tokio_stream::StreamExt;
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};

/// 8 MiB. Chosen to fit a Read-tool result on a typical source file with
/// margin, while still being far below the OS page-cache pressure point.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// One record produced by the reader.
#[derive(Debug, PartialEq, Eq)]
pub enum LineRecord {
    /// A complete line of valid UTF-8, with the trailing newline stripped.
    Line(String),
    /// An emission that violated the protocol contract — too long, invalid
    /// UTF-8, or upstream IO error. Caller should surface this as a
    /// `protocol_violation` event but keep the stream alive.
    Violation(LineViolation),
}

/// Why a line was rejected.
#[derive(Debug, PartialEq, Eq)]
pub enum LineViolation {
    /// Exceeded `MAX_LINE_BYTES` before a newline arrived.
    LineTooLong,
    /// Underlying read error (e.g. broken pipe, invalid UTF-8). The source
    /// is unrecoverable; the stream will terminate after this record.
    Io(String),
}

/// Async line reader over an `AsyncRead`. Use `next_record().await` until it
/// returns `None`.
pub struct LineReader<R: AsyncRead + Unpin> {
    inner: FramedRead<R, LinesCodec>,
}

impl<R: AsyncRead + Unpin> LineReader<R> {
    /// Build a reader with the default 8 MiB per-line cap.
    pub fn new(reader: R) -> Self {
        Self::with_max_length(reader, MAX_LINE_BYTES)
    }

    /// Build a reader with a custom cap. Used by tests; production callers
    /// must use `new` so the 8 MiB invariant cannot be relaxed by accident.
    pub(crate) fn with_max_length(reader: R, max_line_bytes: usize) -> Self {
        Self {
            inner: FramedRead::new(reader, LinesCodec::new_with_max_length(max_line_bytes)),
        }
    }

    /// Yield the next record, or `None` once the underlying stream closes.
    pub async fn next_record(&mut self) -> Option<LineRecord> {
        match self.inner.next().await {
            None => None,
            Some(Ok(line)) => Some(LineRecord::Line(line)),
            Some(Err(LinesCodecError::MaxLineLengthExceeded)) => {
                Some(LineRecord::Violation(LineViolation::LineTooLong))
            }
            Some(Err(LinesCodecError::Io(err))) => {
                Some(LineRecord::Violation(LineViolation::Io(err.to_string())))
            }
        }
    }
}

/// Synchronous helper for tests and small in-memory buffers — splits on `\n`
/// with the same length cap as the streaming reader.
pub(crate) fn split_lines_bounded(buf: &str) -> Vec<LineRecord> {
    let mut out = Vec::new();
    for chunk in buf.split_inclusive('\n') {
        let has_newline = chunk.ends_with('\n');
        let body = chunk.strip_suffix('\n').unwrap_or(chunk);
        if body.len() > MAX_LINE_BYTES {
            out.push(LineRecord::Violation(LineViolation::LineTooLong));
            continue;
        }
        // Suppress the empty-tail emitted when the input ends with `\n`.
        if body.is_empty() && !has_newline {
            break;
        }
        out.push(LineRecord::Line(body.to_string()));
    }
    out
}

#[cfg(test)]
async fn collect<R: AsyncRead + Unpin>(reader: R) -> Vec<LineRecord> {
    let mut lr = LineReader::new(reader);
    let mut out = Vec::new();
    while let Some(r) = lr.next_record().await {
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::ReadBuf;

    #[tokio::test]
    async fn yields_individual_lines() {
        let bytes: &[u8] = b"{\"a\":1}\n{\"b\":2}\n";
        let records = collect(bytes).await;
        assert_eq!(
            records,
            vec![
                LineRecord::Line("{\"a\":1}".into()),
                LineRecord::Line("{\"b\":2}".into()),
            ],
        );
    }

    #[tokio::test]
    async fn final_line_without_newline_is_yielded() {
        let bytes: &[u8] = b"{\"a\":1}";
        let records = collect(bytes).await;
        assert_eq!(records, vec![LineRecord::Line("{\"a\":1}".into())]);
    }

    #[tokio::test]
    async fn empty_input_yields_nothing() {
        let bytes: &[u8] = b"";
        assert!(collect(bytes).await.is_empty());
    }

    #[tokio::test]
    async fn line_at_max_length_is_accepted() {
        // Use a small max so the test runs in milliseconds.
        let max = 1024;
        let mut s = String::with_capacity(max + 1);
        s.extend(std::iter::repeat('a').take(max));
        s.push('\n');
        let bytes = s.into_bytes();
        let mut lr = LineReader::with_max_length(bytes.as_slice(), max);
        let first = lr.next_record().await.unwrap();
        match first {
            LineRecord::Line(line) => assert_eq!(line.len(), max),
            other => panic!("expected Line, got {other:?}"),
        }
        assert!(lr.next_record().await.is_none());
    }

    /// A line above the cap surfaces as a `LineTooLong` violation. Callers
    /// must treat this as session-fatal: `LinesCodec`'s discard window can
    /// swallow subsequent records. Production code surfaces a
    /// `protocol_violation` event and tears the session down, rather than
    /// trying to resync the stream.
    #[tokio::test]
    async fn line_over_max_length_yields_violation() {
        let max = 1024;
        let mut bytes = Vec::with_capacity(max + 8);
        bytes.extend(std::iter::repeat(b'a').take(max + 1));
        bytes.push(b'\n');

        let mut lr = LineReader::with_max_length(bytes.as_slice(), max);
        let mut records = Vec::new();
        while let Some(r) = lr.next_record().await {
            records.push(r);
        }
        assert!(matches!(
            records.first(),
            Some(LineRecord::Violation(LineViolation::LineTooLong)),
        ));
    }

    #[tokio::test]
    async fn invalid_utf8_yields_io_violation() {
        let bytes: &[u8] = &[0x68, 0x69, 0xff, 0xfe, b'\n'];
        let records = collect(bytes).await;
        assert!(records
            .iter()
            .any(|r| matches!(r, LineRecord::Violation(LineViolation::Io(_)))));
    }

    #[tokio::test]
    async fn underlying_reader_error_surfaces_as_io_violation() {
        struct FailingReader;
        impl AsyncRead for FailingReader {
            fn poll_read(
                self: Pin<&mut Self>,
                _cx: &mut Context<'_>,
                _buf: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "boom")))
            }
        }

        let records = collect(FailingReader).await;
        assert!(matches!(
            records.first(),
            Some(LineRecord::Violation(LineViolation::Io(_))),
        ));
    }

    #[test]
    fn split_lines_bounded_handles_short_input() {
        assert_eq!(
            split_lines_bounded("a\nb\nc"),
            vec![
                LineRecord::Line("a".into()),
                LineRecord::Line("b".into()),
                LineRecord::Line("c".into()),
            ],
        );
    }

    #[test]
    fn split_lines_bounded_marks_too_long_lines() {
        let line = "x".repeat(MAX_LINE_BYTES + 1);
        let input = format!("ok\n{line}\nok2\n");
        let out = split_lines_bounded(&input);
        assert_eq!(out[0], LineRecord::Line("ok".into()));
        assert_eq!(out[1], LineRecord::Violation(LineViolation::LineTooLong));
        assert_eq!(out[2], LineRecord::Line("ok2".into()));
    }

    #[test]
    fn split_lines_bounded_preserves_blank_lines_between_records() {
        let out = split_lines_bounded("a\n\nb\n");
        assert_eq!(
            out,
            vec![
                LineRecord::Line("a".into()),
                LineRecord::Line(String::new()),
                LineRecord::Line("b".into()),
            ],
        );
    }
}
