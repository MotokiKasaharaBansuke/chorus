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
//! ## Outstanding work (Phase 1c)
//!
//! * Health-check on spawn (no-op JSONL → wait for `system-init` within 5s)
//! * `resume_headless` / `fork_headless` commands with stale-lock detection
//! * Fixture-driven integration tests in `tests/fixtures/claude/*.jsonl`

pub mod child_transport;
pub mod event;
pub mod line_reader;
pub mod manager;
pub mod redaction;
pub mod session;
pub mod system;
pub mod transport;
pub mod validation;
