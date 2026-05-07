//! Headless agent execution layer.
//!
//! Replaces the PTY-scraping pipeline with a JSONL-based pipe to
//! `claude -p --output-format stream-json --input-format stream-json` and
//! `codex exec --json`. See `docs/` once Phase 4 stabilizes.
//!
//! ## Submodules
//!
//! * `validation` — argument-injection guard, env-key allowlist, `ValidatedCwd`
//! * `redaction` — credential masking for `tracing` output
//! * `line_reader` — bounded JSONL framing on top of `tokio_util::codec`
//! * `transport` — `JsonlTransport` trait + `MockTransport`
//! * `child_transport` — production transport over `tokio::process::Child`
//! * `system` — `RLIMIT_NOFILE` and per-tab advisory locks
//! * `event` — `HeadlessEvent` wire vocabulary shared with the frontend
//! * `session` — actor-style per-tab session, owns reader task + pending table
//! * `manager` — process-wide registry of `Session`s
//!
//! ## Outstanding work (Phase 1d)
//!
//! * **Pending request lifecycle**: registration, message-id correlation
//!   so assistant replies resolve `RequestOutcome::Completed`, and cancel
//!   propagation that resolves `Cancelled`. Phase 1c intentionally ships
//!   without auto-registration to avoid an unbounded pending table.
//! * `resume_headless` / `fork_headless` commands with stale-lock detection
//! * Stronger spawn health-check: peek stderr inside the grace window so
//!   "auth required" / "rate-limited at startup" messages fail fast
//! * Fixture-driven integration tests in `tests/fixtures/claude/*.jsonl`
//! * `RequestId` / `MessageId` / `ToolUseId` newtypes (currently aliases)

pub mod child_transport;
pub mod event;
pub mod line_reader;
pub mod manager;
#[cfg(test)]
mod parallel_regression;
pub mod redaction;
pub mod session;
pub mod system;
pub mod transport;
pub mod validation;
