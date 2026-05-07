//! Headless agent execution layer.
//!
//! Replaces the PTY-scraping pipeline with a JSONL-based pipe to
//! `claude -p --output-format stream-json --input-format stream-json` and
//! `codex exec --json`. See `docs/` once Phase 4 stabilizes.
//!
//! Phase 1a deposits only the foundation: validation, secret redaction,
//! line reading, transport trait + mock, and the wire-event vocabulary.
//! No process spawning here yet — that lives in Phase 1b. The
//! `dead_code` allow is scoped to this module only and will go away
//! once `commands/headless_commands.rs` lands and exercises the API.
//!
//! ## Phase 1b convergence plan (must read before that PR)
//!
//! The PTY layer (`pty/session.rs`) currently has its own copy of
//! `is_valid_session_id` (`:131`) and `is_sensitive_env_key` (`:1033`).
//! `validation::is_sensitive_env_key` here is **stricter**: it blocks
//! `*_TOKEN` by default and only allowlists `GITHUB_TOKEN` / `GH_TOKEN`.
//! The PTY copy permits all `*_TOKEN`. Phase 1b must:
//! 1. Make `validation::is_sensitive_env_key` and `validation::is_valid_session_id`
//!    the single source of truth, with `pty/session.rs` delegating to them.
//! 2. Document the behavioural change ("`OAUTH_TOKEN` no longer forwarded
//!    to the CLI") in the Phase 1b PR description so users who rely on
//!    those names can migrate.
//!
//! `validate_cwd` returns a `PathBuf` today; Phase 1b should wrap it in a
//! `ValidatedCwd` newtype that the spawn site is forced to consume, so the
//! "canonicalize after lock acquisition" contract is enforceable in types
//! rather than comments.

#![allow(dead_code)]

pub mod event;
pub mod line_reader;
pub mod redaction;
pub mod transport;
pub mod validation;
