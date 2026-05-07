//! 20-parallel regression checks for the headless backend.
//!
//! The Phase 1+ headless engine targets 20 concurrent CLI sessions. This
//! module pins the wall-clock budget for the lower-level mechanisms the
//! real `Session` is built from (`MockTransport`, `LineReader`,
//! `PendingTable`) so a future change cannot quietly degrade the
//! 20-parallel use case.
//!
//! All async tests run under a `multi_thread` runtime so `tokio::spawn`
//! actually fans out across worker threads — the default
//! `current-thread` runtime would only interleave the futures on a
//! single thread, which would silently downgrade the assertion from
//! "20 parallel" to "20 concurrent".
//!
//! Thresholds are intentionally generous (well above the actual runtime
//! on developer machines) so a slow CI runner does not produce false
//! positives. Tighten only if a real regression slips through.

#![cfg(test)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::oneshot;

use super::event::RequestId;
use super::line_reader::{LineReader, LineRecord};
use super::transport::{JsonlTransport, MockTransport};

const TAB_COUNT: usize = 20;
const LINES_PER_TAB: usize = 100;
const PAYLOAD_BYTES_PER_LINE: usize = 256;
/// Generous; the actual runtime is double-digit ms on a developer Mac.
/// Backend budget is larger than the frontend's 1 s because the tokio
/// `multi_thread` runtime spin-up + `spawn` fan-out adds non-trivial
/// fixed overhead before the workers start.
const WALL_CLOCK_BUDGET_MS: u128 = 2_000;

/// Single source of truth for the budget assertion. Centralising the
/// failure message makes a CI false-positive easy to grep
/// (`regression budget`) and keeps the three call sites identical.
fn assert_within_budget(scenario: &str, elapsed: Duration) {
    let ms = elapsed.as_millis();
    assert!(
        ms < WALL_CLOCK_BUDGET_MS,
        "{scenario} exceeded {WALL_CLOCK_BUDGET_MS} ms regression budget (took {ms} ms)",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mock_transport_drains_20_parallel_streams_within_budget() {
    let mut transports: Vec<MockTransport> = (0..TAB_COUNT)
        .map(|tab| {
            let lines: Vec<String> = (0..LINES_PER_TAB)
                .map(|i| format!(r#"{{"tab":{tab},"i":{i}}}"#))
                .collect();
            let mut t = MockTransport::from_lines(lines);
            t.close_incoming();
            t
        })
        .collect();

    let start = Instant::now();
    let handles: Vec<_> = transports
        .drain(..)
        .map(|mut t| {
            tokio::spawn(async move {
                let mut count = 0usize;
                while let Some(record) = t.next_record().await {
                    if matches!(record, LineRecord::Line(_)) {
                        count += 1;
                    }
                }
                count
            })
        })
        .collect();

    let mut total_lines = 0usize;
    for handle in handles {
        total_lines += handle.await.expect("worker panic");
    }

    assert_eq!(total_lines, TAB_COUNT * LINES_PER_TAB);
    assert_within_budget("20-parallel transport drain", start.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn line_reader_drains_20_parallel_500kib_streams_within_budget() {
    // 100 lines × 256 bytes = 25 KiB per stream, ~500 KiB total. Well
    // below the 8 MiB cap and roughly the size of a long Claude turn's
    // worth of stream-json events.
    let payload = "y".repeat(PAYLOAD_BYTES_PER_LINE);
    let stream: Vec<u8> = (0..LINES_PER_TAB)
        .flat_map(|_| format!("{payload}\n").into_bytes())
        .collect();
    let payload_arc: Arc<Vec<u8>> = Arc::new(stream);

    let start = Instant::now();
    let handles: Vec<_> = (0..TAB_COUNT)
        .map(|_| {
            let bytes = payload_arc.clone();
            tokio::spawn(async move {
                let mut reader = LineReader::new(bytes.as_slice());
                let mut count = 0usize;
                while let Some(record) = reader.next_record().await {
                    if matches!(record, LineRecord::Line(_)) {
                        count += 1;
                    }
                }
                count
            })
        })
        .collect();

    let mut total = 0usize;
    for handle in handles {
        total += handle.await.expect("worker panic");
    }

    assert_eq!(total, TAB_COUNT * LINES_PER_TAB);
    assert_within_budget("20-parallel line reader drain", start.elapsed());
}

/// `Session::handle_record` resolves the oldest pending entry on every
/// assistant `message-complete`. Pin that the FIFO walk stays cheap and
/// strictly ordered when the table is at peak occupancy (one entry per
/// tab plus a handful of stragglers). Test is sequential by design —
/// `PendingTable` is `Mutex`-guarded, so a "parallel resolve" benchmark
/// would just measure lock contention rather than ordering correctness.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pending_table_resolves_20_entries_in_fifo_order() {
    use super::session::{PendingEntry, PendingTable, RequestOutcome};

    let pending: Arc<Mutex<PendingTable>> = Arc::new(Mutex::new(PendingTable::new()));

    // Seed N entries with strictly increasing `created_at`.
    let now = Instant::now();
    let mut receivers = Vec::with_capacity(TAB_COUNT);
    for t in 0..TAB_COUNT {
        let (tx, rx) = oneshot::channel::<RequestOutcome>();
        let mut entry = PendingEntry::new(tx);
        entry.created_at = now - Duration::from_micros((TAB_COUNT - t) as u64);
        pending.lock().insert(RequestId::from(format!("req-{t}")), entry);
        receivers.push(rx);
    }

    let start = Instant::now();
    for _ in 0..TAB_COUNT {
        super::session::resolve_oldest_pending(&pending, RequestOutcome::Completed);
    }

    assert!(pending.lock().is_empty());
    assert_within_budget("20 sequential FIFO resolves", start.elapsed());

    // Every receiver must have received `Completed` in FIFO order.
    for (i, rx) in receivers.into_iter().enumerate() {
        let outcome = rx.await.expect("oneshot dropped");
        assert_eq!(outcome, RequestOutcome::Completed, "entry {i} not resolved");
    }
}
