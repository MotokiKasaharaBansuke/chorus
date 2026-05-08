//! Translate the upstream stream-json output into typed `HeadlessEvent`s.
//!
//! Two CLI vocabularies are accepted — they share the same parser
//! because their `type` values are disjoint, so dispatch by string is
//! unambiguous:
//!
//! - **Claude Code** (Anthropic Messages streaming envelope):
//!   `stream_event`, `assistant`, `user`, `result`. Documented at
//!   <https://docs.anthropic.com/en/docs/claude-code/output>.
//! - **Codex** (`codex exec --json`): `thread.started`,
//!   `turn.started`, `item.completed`, `turn.completed`. Codex emits
//!   the assistant turn as a single `agent_message` `item.completed`
//!   (no streaming deltas as of `codex-cli 0.66`), so we synthesize
//!   one `MessageDelta` + `MessageComplete` pair from each item.
//!
//! ## Claude envelope shapes:
//!
//! - `system.init` — captured upstream (session id continuity); not
//!   produced by this parser.
//! - `stream_event` (only present with `--include-partial-messages`):
//!   - `event.message_start` — opens an assistant message; we record
//!     the `message_id` so downstream deltas can attach to it.
//!   - `event.content_block_delta` with `text_delta` — emit
//!     `MessageDelta` (the streaming UX is what the chat panel renders).
//!   - `event.message_stop` — emit `MessageComplete{ Stop }`.
//! - `assistant.message.content[]` — emit `MessageToolUse` for each
//!   `tool_use` block. We deliberately use this snapshot instead of
//!   `stream_event.content_block_start`: the latter fires before
//!   claude has streamed the tool input via `input_json_delta`, so
//!   the input would always be `{}` in the UI. The `assistant`
//!   envelope arrives once per turn with the fully-assembled inputs.
//! - `user.message.content[].tool_result` — emit `MessageToolResult`.
//! - `result` — emit `Usage` (token accounting for the just-finished turn).
//!
//! Lines we do not recognise (or fields we cannot find) are silently
//! ignored: the caller still forwards every line via `unknown_event`,
//! so nothing is lost — debugging just falls back to the raw payload.

use std::collections::HashSet;

use serde_json::Value;

use super::event::{FinishReason, HeadlessEvent, MessageId, TabId, ToolUseId, UsageReport};

/// Per-turn parser state. One instance per `run_turn`. Tracks the
/// in-flight assistant `message_id`, a monotonic delta counter so the
/// frontend store can detect out-of-order delivery, and dedupe sets
/// for repeated envelopes.
///
/// `emitted_tool_uses` is shared between the claude `tool_use_id`
/// space (`tu_xxx`) and the codex `call_id` space (`call_xxx`) — the
/// two id formats are documented as disjoint, so a single `HashSet`
/// is safe and saves an allocation.
///
/// `emitted_agent_messages` mirrors the same protection for codex's
/// `agent_message` items: a future codex CLI version that re-emits
/// the same `item.id` (e.g. for retry / partial replay) must not
/// double-render the bubble or re-fire `MessageComplete`.
#[derive(Default)]
pub(super) struct StreamParser {
    message_id: Option<MessageId>,
    next_delta_index: u32,
    emitted_tool_uses: HashSet<String>,
    emitted_agent_messages: HashSet<String>,
}

impl StreamParser {
    pub(super) fn new() -> Self {
        Self::default()
    }

    /// Convert one JSONL line into zero or more typed events. Returns
    /// an empty `Vec` for envelopes we do not recognise — the caller
    /// is responsible for surfacing the raw line via `unknown_event`.
    pub(super) fn translate(&mut self, value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
        let Some(t) = value.get("type").and_then(|v| v.as_str()) else {
            return vec![];
        };
        match t {
            // --- Claude ---
            "stream_event" => self.handle_stream_event(value, tab_id),
            "assistant" => self.handle_assistant_snapshot(value, tab_id),
            "user" => extract_tool_results(value, tab_id),
            "result" => extract_usage(value, tab_id),
            // --- Codex ---
            "item.completed" => self.handle_codex_item(value, tab_id),
            "turn.completed" => extract_codex_usage(value, tab_id),
            // `thread.started` carries `thread_id` which `session.rs`
            // captures via `capture_session_id`. `turn.started` /
            // `turn.failed` / `error` are surfaced through the
            // `Status::Idle | Status::Error` lifecycle the run task
            // already manages from the child's exit code, so the
            // parser stays silent on them.
            _ => vec![],
        }
    }

    /// Codex emits one `item.completed` envelope per high-level
    /// thing it produced this turn (assistant message, tool call,
    /// tool result). Dispatch by the inner `item.type`.
    fn handle_codex_item(&mut self, value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
        let Some(item) = value.get("item") else {
            return vec![];
        };
        let Some(item_type) = item.get("type").and_then(|v| v.as_str()) else {
            return vec![];
        };
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            return vec![];
        }

        match item_type {
            "agent_message" => {
                // Codex non-streaming: a full `text` field arrives
                // once. Synthesize a single `MessageDelta` + the
                // matching `MessageComplete` so the renderer treats
                // it identically to a streamed claude turn.
                let text = item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if text.is_empty() {
                    return vec![];
                }
                if !self.emitted_agent_messages.insert(id.clone()) {
                    // A repeated `item.id` would otherwise concatenate
                    // its text onto the existing bubble (frontend
                    // store sums deltas by message id) and re-fire
                    // `MessageComplete`. Drop the duplicate.
                    return vec![];
                }
                let message_id = MessageId::new(id);
                vec![
                    HeadlessEvent::MessageDelta {
                        tab_id: tab_id.clone(),
                        message_id: message_id.clone(),
                        index: 0,
                        delta: text,
                    },
                    HeadlessEvent::MessageComplete {
                        tab_id: tab_id.clone(),
                        message_id,
                        finish_reason: FinishReason::Stop,
                    },
                ]
            }
            "function_call" => {
                // OpenAI tool-calling convention: `arguments` is a
                // JSON-encoded string. Try to parse so the typed
                // tool renderer sees structured input; fall back to
                // the raw string so we never lose payload.
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if call_id.is_empty() {
                    return vec![];
                }
                if !self.emitted_tool_uses.insert(call_id.clone()) {
                    return vec![];
                }
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    return vec![];
                }
                let input = match item.get("arguments") {
                    Some(Value::String(s)) => {
                        serde_json::from_str::<Value>(s).unwrap_or(Value::String(s.clone()))
                    }
                    Some(other) => other.clone(),
                    None => Value::Null,
                };
                vec![HeadlessEvent::MessageToolUse {
                    tab_id: tab_id.clone(),
                    message_id: MessageId::new(id),
                    tool_use_id: ToolUseId::new(call_id),
                    name,
                    input,
                }]
            }
            "function_call_output" => {
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if call_id.is_empty() {
                    return vec![];
                }
                let output = item
                    .get("output")
                    .and_then(|v| match v {
                        Value::String(s) => Some(s.clone()),
                        other => Some(other.to_string()),
                    })
                    .unwrap_or_default();
                vec![HeadlessEvent::MessageToolResult {
                    tab_id: tab_id.clone(),
                    tool_use_id: ToolUseId::new(call_id),
                    output,
                    is_error: false,
                }]
            }
            _ => vec![],
        }
    }

    fn handle_stream_event(&mut self, value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
        let Some(event) = value.get("event") else {
            return vec![];
        };
        let Some(et) = event.get("type").and_then(|v| v.as_str()) else {
            return vec![];
        };

        match et {
            "message_start" => {
                if let Some(id) = event
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(|v| v.as_str())
                {
                    self.message_id = Some(MessageId::new(id));
                    self.next_delta_index = 0;
                }
                vec![]
            }
            "content_block_delta" => self.text_delta(event, tab_id),
            "message_stop" => self.finish_message(tab_id),
            // `content_block_start` is intentionally ignored — for
            // tool_use blocks the input arrives later via
            // `input_json_delta` events, so the start envelope's
            // input is always `{}`. We pick up tool calls from the
            // `assistant` snapshot instead, which carries the fully
            // assembled input.
            _ => vec![],
        }
    }

    /// Walk `assistant.message.content[]` and emit one
    /// `MessageToolUse` per `tool_use` block we have not seen before.
    /// Skips text blocks (already streamed via `content_block_delta`)
    /// and dedupes by `tool_use_id` so a repeated snapshot does not
    /// duplicate cards in the UI.
    fn handle_assistant_snapshot(
        &mut self,
        value: &Value,
        tab_id: &TabId,
    ) -> Vec<HeadlessEvent> {
        let Some(message) = value.get("message") else {
            return vec![];
        };
        let Some(message_id) = message
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(MessageId::new)
        else {
            return vec![];
        };
        let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
            return vec![];
        };

        let mut out = Vec::new();
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let Some(id) = block
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if !self.emitted_tool_uses.insert(id.to_string()) {
                continue;
            }
            let name = block
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            out.push(HeadlessEvent::MessageToolUse {
                tab_id: tab_id.clone(),
                message_id: message_id.clone(),
                tool_use_id: ToolUseId::new(id.to_string()),
                name,
                input,
            });
        }
        out
    }

    fn text_delta(&mut self, event: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
        let Some(delta) = event.get("delta") else {
            return vec![];
        };
        if delta.get("type").and_then(|v| v.as_str()) != Some("text_delta") {
            return vec![];
        }
        let text = delta
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if text.is_empty() {
            return vec![];
        }
        let Some(message_id) = self.message_id.clone() else {
            return vec![];
        };
        let index = self.next_delta_index;
        self.next_delta_index += 1;
        vec![HeadlessEvent::MessageDelta {
            tab_id: tab_id.clone(),
            message_id,
            index,
            delta: text,
        }]
    }

    fn finish_message(&mut self, tab_id: &TabId) -> Vec<HeadlessEvent> {
        let Some(message_id) = self.message_id.take() else {
            return vec![];
        };
        self.next_delta_index = 0;
        vec![HeadlessEvent::MessageComplete {
            tab_id: tab_id.clone(),
            message_id,
            finish_reason: FinishReason::Stop,
        }]
    }
}

/// `type=user` lines from claude carry tool results inside
/// `message.content[]` items of shape
/// `{type:"tool_result", tool_use_id, content, is_error?}`.
fn extract_tool_results(value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return vec![];
    };
    content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                return None;
            }
            let id = block.get("tool_use_id").and_then(|v| v.as_str())?;
            let is_error = block
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let output = read_tool_result_text(block);
            Some(HeadlessEvent::MessageToolResult {
                tab_id: tab_id.clone(),
                tool_use_id: ToolUseId::new(id.to_string()),
                output,
                is_error,
            })
        })
        .collect()
}

/// Tool result `content` may be a plain string or a list of typed
/// blocks; we currently only render the `text` blocks (image / json
/// blocks are rare and would need bespoke renderers anyway).
fn read_tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("text"))
            .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// `result` envelopes come at the very end of a turn and carry the
/// authoritative usage block (claude's own running tally is the source
/// of truth for billing UI).
fn extract_usage(value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
    let Some(usage) = value.get("usage") else {
        return vec![];
    };
    let report = UsageReport {
        input_tokens: read_u64(usage, "input_tokens"),
        output_tokens: read_u64(usage, "output_tokens"),
        cache_read_tokens: read_u64(usage, "cache_read_input_tokens"),
        cache_creation_tokens: read_u64(usage, "cache_creation_input_tokens"),
    };
    vec![HeadlessEvent::Usage {
        tab_id: tab_id.clone(),
        usage: report,
    }]
}

fn read_u64(obj: &Value, key: &str) -> u64 {
    obj.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Codex `turn.completed` envelope shape:
/// `{"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,"output_tokens":...}}`
/// Codex does not separate cache-creation from cache-read tokens, so
/// `cache_creation_tokens` ends up zero — the chat usage bar shows
/// the same total either way.
fn extract_codex_usage(value: &Value, tab_id: &TabId) -> Vec<HeadlessEvent> {
    let Some(usage) = value.get("usage") else {
        return vec![];
    };
    let report = UsageReport {
        input_tokens: read_u64(usage, "input_tokens"),
        output_tokens: read_u64(usage, "output_tokens"),
        cache_read_tokens: read_u64(usage, "cached_input_tokens"),
        cache_creation_tokens: 0,
    };
    vec![HeadlessEvent::Usage {
        tab_id: tab_id.clone(),
        usage: report,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab() -> TabId {
        "tab-1".to_string()
    }

    #[test]
    fn message_start_records_id_without_emitting() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "stream_event",
                "event": { "type": "message_start", "message": { "id": "msg_abc" } }
            }),
            &tab(),
        );
        assert!(events.is_empty());
        // Subsequent text deltas should attach to msg_abc.
        let events = p.translate(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "hi" }
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageDelta { message_id, delta, index, .. } => {
                assert_eq!(message_id.as_str(), "msg_abc");
                assert_eq!(delta, "hi");
                assert_eq!(*index, 0);
            }
            other => panic!("expected MessageDelta, got {other:?}"),
        }
    }

    #[test]
    fn delta_index_increments_per_chunk() {
        let mut p = StreamParser::new();
        p.translate(
            &json!({
                "type": "stream_event",
                "event": { "type": "message_start", "message": { "id": "m" } }
            }),
            &tab(),
        );
        let mk = |t: &str| {
            json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": t }
                }
            })
        };
        let a = p.translate(&mk("a"), &tab());
        let b = p.translate(&mk("b"), &tab());
        let c = p.translate(&mk("c"), &tab());
        let idx = |events: &[HeadlessEvent]| match &events[0] {
            HeadlessEvent::MessageDelta { index, .. } => *index,
            _ => panic!(),
        };
        assert_eq!((idx(&a), idx(&b), idx(&c)), (0, 1, 2));
    }

    #[test]
    fn delta_without_message_start_is_dropped() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "orphan" }
                }
            }),
            &tab(),
        );
        assert!(events.is_empty(), "delta without message_start must drop");
    }

    #[test]
    fn empty_text_delta_is_dropped() {
        let mut p = StreamParser::new();
        p.translate(
            &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
            &tab(),
        );
        let events = p.translate(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "" }
                }
            }),
            &tab(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn content_block_start_for_tool_use_does_not_emit() {
        // Tool inputs stream in via later `input_json_delta` events,
        // so the start envelope alone always carries an empty `{}`
        // input. We deliberately skip emission here to avoid showing
        // an empty IN in the UI; the `assistant` snapshot path picks
        // it up with the fully-assembled input.
        let mut p = StreamParser::new();
        p.translate(
            &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
            &tab(),
        );
        let events = p.translate(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {
                        "type": "tool_use",
                        "id": "tu_1",
                        "name": "Bash",
                        "input": {}
                    }
                }
            }),
            &tab(),
        );
        assert!(events.is_empty(), "content_block_start must not emit tool_use");
    }

    #[test]
    fn assistant_snapshot_emits_tool_use_with_full_input() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "running a command" },
                        {
                            "type": "tool_use",
                            "id": "tu_1",
                            "name": "Bash",
                            "input": { "command": "ls -la" }
                        }
                    ]
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageToolUse { tool_use_id, name, input, message_id, .. } => {
                assert_eq!(tool_use_id.as_str(), "tu_1");
                assert_eq!(name, "Bash");
                assert_eq!(input["command"], "ls -la");
                assert_eq!(message_id.as_str(), "msg_1");
            }
            other => panic!("expected MessageToolUse, got {other:?}"),
        }
    }

    #[test]
    fn assistant_snapshot_dedupes_repeated_tool_use_ids() {
        let mut p = StreamParser::new();
        let snapshot = json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tu_1",
                    "name": "Read",
                    "input": { "path": "/x" }
                }]
            }
        });
        let first = p.translate(&snapshot, &tab());
        let second = p.translate(&snapshot, &tab());
        assert_eq!(first.len(), 1, "first snapshot emits the tool_use");
        assert!(second.is_empty(), "repeated snapshot must not duplicate");
    }

    #[test]
    fn assistant_snapshot_emits_multiple_tool_uses_in_order() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [
                        {"type": "tool_use", "id": "a", "name": "Read",  "input": {"path": "/1"}},
                        {"type": "tool_use", "id": "b", "name": "Write", "input": {"path": "/2"}}
                    ]
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 2);
        let ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                HeadlessEvent::MessageToolUse { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn assistant_snapshot_skips_blocks_without_id_or_name() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "assistant",
                "message": {
                    "id": "m",
                    "content": [
                        {"type": "tool_use", "id": "",     "name": "Bash", "input": {}},
                        {"type": "tool_use", "id": "tu_2", "name": "",     "input": {}}
                    ]
                }
            }),
            &tab(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn message_stop_emits_complete_and_clears_id() {
        let mut p = StreamParser::new();
        p.translate(
            &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
            &tab(),
        );
        let events = p.translate(
            &json!({"type": "stream_event", "event": { "type": "message_stop" }}),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageComplete { message_id, finish_reason, .. } => {
                assert_eq!(message_id.as_str(), "m");
                assert_eq!(*finish_reason, FinishReason::Stop);
            }
            other => panic!("expected MessageComplete, got {other:?}"),
        }
        // After stop, a stray delta should not emit (id was cleared).
        let stray = p.translate(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "z" }
                }
            }),
            &tab(),
        );
        assert!(stray.is_empty());
    }

    #[test]
    fn user_tool_result_string_content_is_extracted() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tu_42",
                        "content": "ok",
                        "is_error": false
                    }]
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageToolResult { tool_use_id, output, is_error, .. } => {
                assert_eq!(tool_use_id.as_str(), "tu_42");
                assert_eq!(output, "ok");
                assert!(!is_error);
            }
            other => panic!("expected MessageToolResult, got {other:?}"),
        }
    }

    #[test]
    fn user_tool_result_array_content_concatenates_text_blocks() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tu",
                        "content": [
                            { "type": "text", "text": "hello " },
                            { "type": "image", "source": {} },
                            { "type": "text", "text": "world" }
                        ]
                    }]
                }
            }),
            &tab(),
        );
        match &events[0] {
            HeadlessEvent::MessageToolResult { output, .. } => assert_eq!(output, "hello world"),
            _ => panic!(),
        }
    }

    #[test]
    fn result_envelope_emits_usage() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "result",
                "subtype": "success",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 34,
                    "cache_read_input_tokens": 5,
                    "cache_creation_input_tokens": 6
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::Usage { usage, .. } => {
                assert_eq!(usage.input_tokens, 12);
                assert_eq!(usage.output_tokens, 34);
                assert_eq!(usage.cache_read_tokens, 5);
                assert_eq!(usage.cache_creation_tokens, 6);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn unknown_envelope_returns_empty() {
        let mut p = StreamParser::new();
        assert!(p.translate(&json!({"type": "system", "subtype": "init"}), &tab()).is_empty());
        assert!(p.translate(&json!({"foo": "bar"}), &tab()).is_empty());
    }

    // --- Codex ----------------------------------------------------

    #[test]
    fn codex_agent_message_emits_delta_then_complete() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "item.completed",
                "item": {
                    "id": "item_0",
                    "type": "agent_message",
                    "text": "Hi there"
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 2, "expect delta + complete");
        match &events[0] {
            HeadlessEvent::MessageDelta { delta, message_id, index, .. } => {
                assert_eq!(delta, "Hi there");
                assert_eq!(message_id.as_str(), "item_0");
                assert_eq!(*index, 0);
            }
            other => panic!("expected MessageDelta, got {other:?}"),
        }
        match &events[1] {
            HeadlessEvent::MessageComplete { message_id, finish_reason, .. } => {
                assert_eq!(message_id.as_str(), "item_0");
                assert_eq!(*finish_reason, FinishReason::Stop);
            }
            other => panic!("expected MessageComplete, got {other:?}"),
        }
    }

    #[test]
    fn codex_agent_message_dedupes_repeated_item_ids() {
        // A future codex CLI that re-emits the same `item.id` (retry
        // / replay) must not double-render the bubble: the frontend
        // store would otherwise concatenate the text onto the
        // existing assistant turn and re-fire `MessageComplete`.
        let mut p = StreamParser::new();
        let line = json!({
            "type": "item.completed",
            "item": { "id": "item_0", "type": "agent_message", "text": "hi" }
        });
        let first = p.translate(&line, &tab());
        let second = p.translate(&line, &tab());
        assert_eq!(first.len(), 2, "first emission yields delta + complete");
        assert!(second.is_empty(), "repeated item_id must not duplicate");
    }

    #[test]
    fn codex_agent_message_with_empty_text_is_dropped() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "item.completed",
                "item": { "id": "item_0", "type": "agent_message", "text": "" }
            }),
            &tab(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn codex_function_call_emits_tool_use_with_parsed_arguments() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "item.completed",
                "item": {
                    "id": "item_1",
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "exec_command",
                    // OpenAI tool-calling convention: `arguments` is a
                    // JSON-encoded *string*, not a structured object.
                    "arguments": "{\"command\":\"ls -la\"}"
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageToolUse { tool_use_id, name, input, .. } => {
                assert_eq!(tool_use_id.as_str(), "call_1");
                assert_eq!(name, "exec_command");
                assert_eq!(input["command"], "ls -la");
            }
            other => panic!("expected MessageToolUse, got {other:?}"),
        }
    }

    #[test]
    fn codex_function_call_falls_back_to_raw_arguments_string() {
        // When `arguments` is not valid JSON we keep the raw payload
        // rather than dropping the tool call — losing the call would
        // be worse for the user than rendering it as a plain string.
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "item.completed",
                "item": {
                    "id": "item_1",
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "weird_tool",
                    "arguments": "not really json"
                }
            }),
            &tab(),
        );
        match &events[0] {
            HeadlessEvent::MessageToolUse { input, .. } => {
                assert_eq!(input.as_str(), Some("not really json"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn codex_function_call_dedupes_repeated_call_ids() {
        let mut p = StreamParser::new();
        let line = json!({
            "type": "item.completed",
            "item": {
                "id": "i1",
                "type": "function_call",
                "call_id": "c1",
                "name": "tool",
                "arguments": "{}"
            }
        });
        let first = p.translate(&line, &tab());
        let second = p.translate(&line, &tab());
        assert_eq!(first.len(), 1);
        assert!(second.is_empty(), "repeated call_id must not duplicate");
    }

    #[test]
    fn codex_function_call_output_emits_tool_result() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "item.completed",
                "item": {
                    "id": "item_2",
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "stdout: hi\n"
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::MessageToolResult { tool_use_id, output, is_error, .. } => {
                assert_eq!(tool_use_id.as_str(), "call_1");
                assert_eq!(output, "stdout: hi\n");
                assert!(!is_error);
            }
            other => panic!("expected MessageToolResult, got {other:?}"),
        }
    }

    #[test]
    fn codex_turn_completed_emits_usage() {
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({
                "type": "turn.completed",
                "usage": {
                    "input_tokens": 42,
                    "cached_input_tokens": 10,
                    "output_tokens": 7
                }
            }),
            &tab(),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HeadlessEvent::Usage { usage, .. } => {
                assert_eq!(usage.input_tokens, 42);
                assert_eq!(usage.output_tokens, 7);
                assert_eq!(usage.cache_read_tokens, 10);
                // Codex does not split cache-creation from cache-read.
                assert_eq!(usage.cache_creation_tokens, 0);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn codex_thread_started_does_not_emit_typed_event() {
        // `thread.started` carries the upstream thread_id which is
        // captured by `session::capture_session_id`, not by the
        // parser. Make sure it stays silent here.
        let mut p = StreamParser::new();
        let events = p.translate(
            &json!({"type": "thread.started", "thread_id": "abc-123"}),
            &tab(),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn codex_turn_started_and_lifecycle_events_are_silent() {
        // The Status::Idle / Status::Error transitions are owned by
        // the run_turn machinery — the parser should not synthesize
        // them from these envelopes.
        let mut p = StreamParser::new();
        for envelope in [
            json!({"type": "turn.started"}),
            json!({"type": "turn.failed", "error": {"message": "boom"}}),
            json!({"type": "error", "message": "x"}),
        ] {
            assert!(p.translate(&envelope, &tab()).is_empty());
        }
    }
}
