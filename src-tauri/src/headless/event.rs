//! Wire vocabulary for headless agent events.
//!
//! Every record emitted to the frontend is one variant of `HeadlessEvent`.
//! Frontend TS types in `src/types/headless.ts` mirror this — keep both in
//! sync; Rust is the source of truth via `serde`.
//!
//! Naming follows existing payload conventions in `src-tauri/src/pty/*`:
//! `#[serde(rename_all = "camelCase")]` on every struct, `tabId` for the
//! Chorus tab/session identifier.

use serde::{Deserialize, Serialize};

/// Tab identifier. Tab ID = headless session ID (1:1), preserving the
/// existing "Tab ID = PTY ID" invariant from the PTY pipeline.
pub type TabId = String;

/// Identifier of an in-flight assistant message. Stable across delta + final.
pub type MessageId = String;

/// Identifier of a single tool invocation within an assistant message.
pub type ToolUseId = String;

/// Lifecycle state of a session, separate from message-level events so the
/// UI can show busy indicators without parsing message stream contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// No work in flight, waiting for user input.
    Idle,
    /// Model is generating tokens but no tool call has fired yet.
    Thinking,
    /// At least one tool call is executing.
    Running,
    /// Last turn ended with an error; see the accompanying `errorKind`.
    Error,
}

/// Reason for an `Error` status. Discriminated so the UI can pick a recovery
/// action without parsing strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// CLI binary missing / version too old / refused to start.
    CliIncompatible,
    /// CLI exited unexpectedly mid-turn.
    AgentCrashed,
    /// Provider rate-limited; recovery via `RateLimit` event details.
    RateLimited,
    /// Network failure or transient provider error.
    Network,
    /// JSONL stream emitted a record we could not parse safely.
    ProtocolViolation,
    /// Anything else; the message provides detail for logs only.
    Other,
}

/// Token accounting for a turn.
///
/// Mirrors the shape used by `src/types/usage.ts::TabUsage`. We carry the
/// full set even when a provider only reports a subset — missing fields are
/// zero so the frontend can reduce without branching.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// Detail attached to a `RateLimit` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitDetail {
    /// Unix epoch seconds when the limit resets, if reported by the provider.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<u64>,
    /// Suggested wait before retry. Zero means "unknown — back off manually".
    pub retry_after_ms: u64,
}

/// One event emitted on the Tauri channel `headless:<tabId>:event`.
///
/// Discriminated by `type`. Tag values use **dash-separated kebab-case**
/// to match the existing PTY-era event names (`pty-output`, `pty-exit`,
/// `stream-event-batch`); a `grep` for `message-delta` finds frontend and
/// backend together.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HeadlessEvent {
    /// Incremental text appended to an in-flight assistant message.
    /// Emit one per chunk; the frontend concatenates by `messageId`.
    #[serde(rename = "message-delta")]
    #[serde(rename_all = "camelCase")]
    MessageDelta {
        tab_id: TabId,
        message_id: MessageId,
        /// Monotonically increasing per `message_id`; lets the UI detect
        /// out-of-order delivery (which should not happen, but defensive).
        index: u32,
        delta: String,
    },

    /// The assistant message identified by `messageId` is complete. No more
    /// `MessageDelta` will arrive for it. The frontend may now persist or
    /// commit the assembled text.
    #[serde(rename = "message-complete")]
    #[serde(rename_all = "camelCase")]
    MessageComplete {
        tab_id: TabId,
        message_id: MessageId,
        finish_reason: FinishReason,
    },

    /// The assistant requested a tool invocation. Frontend renders a tool
    /// card; backend (or CLI) will follow up with `MessageToolResult`.
    #[serde(rename = "tool-use")]
    #[serde(rename_all = "camelCase")]
    MessageToolUse {
        tab_id: TabId,
        message_id: MessageId,
        tool_use_id: ToolUseId,
        name: String,
        /// Tool-specific JSON. Frontend dispatches by `name` to a typed
        /// renderer, falling back to a generic JSON pretty-printer.
        input: serde_json::Value,
    },

    /// Result of a tool call — either success output or an error.
    #[serde(rename = "tool-result")]
    #[serde(rename_all = "camelCase")]
    MessageToolResult {
        tab_id: TabId,
        tool_use_id: ToolUseId,
        /// Always rendered as plain text in `<pre>` — never as markdown,
        /// never as HTML. Tool output is the highest-risk path for prompt
        /// injection / XSS, so the wire type stays a string.
        output: String,
        is_error: bool,
    },

    /// Token accounting update. Emitted at most once per turn; frontend
    /// reduces into the running `TabUsage`.
    #[serde(rename = "usage")]
    #[serde(rename_all = "camelCase")]
    Usage { tab_id: TabId, usage: UsageReport },

    /// Lifecycle transition. The UI uses this — not the message stream — to
    /// drive busy spinners, "stop" buttons, etc.
    #[serde(rename = "status")]
    #[serde(rename_all = "camelCase")]
    Status {
        tab_id: TabId,
        status: SessionStatus,
        /// Present only when `status == Error`.
        #[serde(skip_serializing_if = "Option::is_none")]
        error_kind: Option<ErrorKind>,
        /// Human-readable detail for logs/UI. Free-form text; never trusted
        /// as markup.
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },

    /// Provider reported a rate limit. Status will follow with
    /// `Error{ errorKind: RateLimited }`; this event carries the timing
    /// detail so the UI can offer "Retry in 12s".
    #[serde(rename = "rate-limit")]
    #[serde(rename_all = "camelCase")]
    RateLimit { tab_id: TabId, detail: RateLimitDetail },

    /// Forward-compat envelope for events the CLI emits that we do not
    /// recognize. Frontend logs and ignores.
    ///
    /// `raw` is capped at `MAX_UNKNOWN_RAW_BYTES` UTF-8 bytes; payloads above
    /// that arrive truncated with a marker. Use `unknown_event` to construct
    /// these — never go through `serde_json::to_value` blindly on a giant
    /// line, which would defeat the line reader's 8 MiB cap.
    #[serde(rename = "unknown")]
    #[serde(rename_all = "camelCase")]
    Unknown {
        tab_id: TabId,
        raw: serde_json::Value,
    },
}

/// 64 KiB. Anything an unknown event would carry beyond that is debug-only;
/// the full byte stream is still in the line reader for diagnostics.
pub const MAX_UNKNOWN_RAW_BYTES: usize = 64 * 1024;

/// Build an `Unknown` event with a size cap on the captured payload.
///
/// If `raw` serializes to more than `MAX_UNKNOWN_RAW_BYTES` bytes — or if it
/// fails to serialize at all (e.g. NaN floats) — the payload is replaced
/// with a structured truncation marker so the frontend can render
/// "(truncated)" without parsing the raw blob. Fail-closed: a non-
/// serializable Value never reaches the wire.
pub fn unknown_event(tab_id: TabId, raw: serde_json::Value) -> HeadlessEvent {
    let bounded = match serde_json::to_string(&raw) {
        Ok(s) if s.len() <= MAX_UNKNOWN_RAW_BYTES => raw,
        Ok(s) => serde_json::json!({
            "truncated": true,
            "originalBytes": s.len(),
            "limitBytes": MAX_UNKNOWN_RAW_BYTES,
        }),
        Err(_) => serde_json::json!({
            "truncated": true,
            "reason": "serialize_failed",
            "limitBytes": MAX_UNKNOWN_RAW_BYTES,
        }),
    };
    HeadlessEvent::Unknown { tab_id, raw: bounded }
}

/// How an assistant message ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    /// Model finished naturally.
    Stop,
    /// User pressed cancel; partial output is still in the message buffer.
    Cancel,
    /// Provider returned an error mid-message.
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(event: &HeadlessEvent) -> HeadlessEvent {
        let s = serde_json::to_string(event).expect("serialize");
        serde_json::from_str(&s).expect("deserialize")
    }

    #[test]
    fn message_delta_serializes_with_camel_case_and_type_tag() {
        let event = HeadlessEvent::MessageDelta {
            tab_id: "tab-1".into(),
            message_id: "msg-1".into(),
            index: 3,
            delta: "hello".into(),
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "message-delta");
        assert_eq!(value["tabId"], "tab-1");
        assert_eq!(value["messageId"], "msg-1");
        assert_eq!(value["index"], 3);
        assert_eq!(value["delta"], "hello");
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn message_complete_carries_finish_reason() {
        let event = HeadlessEvent::MessageComplete {
            tab_id: "tab".into(),
            message_id: "m".into(),
            finish_reason: FinishReason::Stop,
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "message-complete");
        assert_eq!(value["finishReason"], "stop");
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn tool_use_carries_arbitrary_input_json() {
        let event = HeadlessEvent::MessageToolUse {
            tab_id: "tab".into(),
            message_id: "m".into(),
            tool_use_id: "tu-1".into(),
            name: "Edit".into(),
            input: json!({"file_path": "/x.rs", "old_string": "a", "new_string": "b"}),
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "tool-use");
        assert_eq!(value["name"], "Edit");
        assert_eq!(value["input"]["file_path"], "/x.rs");
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn tool_result_output_is_string() {
        let event = HeadlessEvent::MessageToolResult {
            tab_id: "tab".into(),
            tool_use_id: "tu-1".into(),
            output: "<script>alert('xss')</script>".into(),
            is_error: false,
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        // Output is preserved verbatim — sanitization is the renderer's job.
        assert_eq!(value["output"], "<script>alert('xss')</script>");
        assert_eq!(value["isError"], false);
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn usage_defaults_to_zero() {
        let usage = UsageReport::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.cache_read_tokens, 0);
        assert_eq!(usage.cache_creation_tokens, 0);
        let event = HeadlessEvent::Usage { tab_id: "t".into(), usage };
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn status_omits_error_fields_when_idle() {
        let event = HeadlessEvent::Status {
            tab_id: "t".into(),
            status: SessionStatus::Idle,
            error_kind: None,
            message: None,
        };
        let s = serde_json::to_string(&event).unwrap();
        assert!(!s.contains("errorKind"));
        assert!(!s.contains("\"message\""));
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn status_includes_error_kind_when_present() {
        let event = HeadlessEvent::Status {
            tab_id: "t".into(),
            status: SessionStatus::Error,
            error_kind: Some(ErrorKind::CliIncompatible),
            message: Some("requires claude >= 2.0".into()),
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["status"], "error");
        assert_eq!(value["errorKind"], "cli_incompatible");
        assert_eq!(value["message"], "requires claude >= 2.0");
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn rate_limit_omits_reset_at_when_unknown() {
        let event = HeadlessEvent::RateLimit {
            tab_id: "t".into(),
            detail: RateLimitDetail { reset_at: None, retry_after_ms: 1500 },
        };
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "rate-limit");
        assert_eq!(value["detail"]["retryAfterMs"], 1500);
        assert!(value["detail"].get("resetAt").is_none());
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn unknown_event_round_trips_small_payload() {
        let event = unknown_event(
            "t".into(),
            json!({"type": "future.thing", "anything": [1, 2, 3]}),
        );
        let value: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "unknown");
        assert_eq!(value["raw"]["type"], "future.thing");
        assert_eq!(round_trip(&event), event);
    }

    #[test]
    fn unknown_event_truncates_oversized_payload() {
        let big = "x".repeat(MAX_UNKNOWN_RAW_BYTES + 1024);
        let event = unknown_event("t".into(), json!({ "blob": big }));
        match event {
            HeadlessEvent::Unknown { raw, .. } => {
                assert_eq!(raw["truncated"], true);
                assert!(raw["originalBytes"].as_u64().unwrap() > MAX_UNKNOWN_RAW_BYTES as u64);
                assert_eq!(raw["limitBytes"], MAX_UNKNOWN_RAW_BYTES as u64);
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn unknown_event_passes_through_when_under_cap() {
        let payload = json!({"a": 1, "b": [2, 3]});
        let event = unknown_event("t".into(), payload.clone());
        match event {
            HeadlessEvent::Unknown { raw, .. } => assert_eq!(raw, payload),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// `serde_json::Value` itself is typically infallible to serialize, so
    /// reaching `unknown_event`'s `Err` arm in a unit test is impractical
    /// without a custom Value type. The fail-closed design is reviewed at
    /// the implementation site instead — see the `Err(_)` arm above.
    #[test]
    fn unknown_event_truncation_marker_is_well_typed() {
        let big = "x".repeat(MAX_UNKNOWN_RAW_BYTES + 100);
        let event = unknown_event("t".into(), json!({ "blob": big }));
        let value = serde_json::to_value(&event).unwrap();
        // Whatever shape the marker takes, it must be valid JSON that the
        // frontend can deserialize against `HeadlessEvent::Unknown`.
        assert_eq!(value["type"], "unknown");
        assert!(value["raw"]["truncated"].as_bool().unwrap_or(false));
    }

    #[test]
    fn deserialize_rejects_missing_type_tag() {
        let bad = json!({ "tabId": "t", "messageId": "m", "delta": "x", "index": 0 });
        let err = serde_json::from_value::<HeadlessEvent>(bad).unwrap_err();
        assert!(err.to_string().contains("missing field") || err.to_string().contains("type"));
    }

    #[test]
    fn deserialize_rejects_unknown_finish_reason() {
        let bad = json!({
            "type": "message.complete",
            "tabId": "t",
            "messageId": "m",
            "finishReason": "exploded",
        });
        assert!(serde_json::from_value::<HeadlessEvent>(bad).is_err());
    }
}
