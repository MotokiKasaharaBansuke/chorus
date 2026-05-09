import { describe, expect, it } from "vitest";

import { parseSessionJsonl } from "./jsonl-to-headless";

const VALID_UUID = "019e0581-dff2-7a42-942c-e85ce089694b";

describe("parseSessionJsonl — claude-code", () => {
  it("returns no messages and no upstream id for an empty input", () => {
    const result = parseSessionJsonl("claude-code", []);
    expect(result.messages).toEqual([]);
    expect(result.upstreamSessionId).toBeUndefined();
  });

  it("captures the upstream session_id from any line that carries one", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        session_id: VALID_UUID,
        message: { role: "user", content: "hi" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.upstreamSessionId).toBe(VALID_UUID);
  });

  it("rejects a malformed session_id rather than smuggling it onto resume", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        session_id: "../../etc/passwd",
        message: { role: "user", content: "hi" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.upstreamSessionId).toBeUndefined();
  });

  it("rejects a session_id with a leading dash so it cannot pose as a CLI flag", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        session_id: "-flag-injection",
        message: { role: "user", content: "hi" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.upstreamSessionId).toBeUndefined();
  });

  it("rejects a session_id longer than the 64-char allowlist", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        session_id: "a".repeat(65),
        message: { role: "user", content: "hi" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.upstreamSessionId).toBeUndefined();
  });

  it("reads a string-valued user message as a single user turn", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toEqual([
      {
        role: "user",
        id: "hydrated-user-0",
        text: "hello",
        sentAt: 0,
      },
    ]);
  });

  it("skips XML-shaped IDE-context blocks inside a user message", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<ide-context>...</ide-context>" },
            { type: "text", text: "real prompt" },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toEqual([
      {
        role: "user",
        id: "hydrated-user-0",
        text: "real prompt",
        sentAt: 0,
      },
    ]);
  });

  it("preserves a user prompt that legitimately starts with an angle bracket", () => {
    // Earlier versions silently dropped any text starting with `<`,
    // which deleted code-paste prompts like JSX components or HTML
    // snippets. The narrowed predicate must let these through.
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "<MyComponent foo='bar' />" }],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toEqual([
      {
        role: "user",
        id: "hydrated-user-0",
        text: "<MyComponent foo='bar' />",
        sentAt: 0,
      },
    ]);
  });

  it("collects assistant text + tool_use into a single message", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-1",
          content: [
            { type: "text", text: "let me look it up" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { path: "/tmp/foo" },
            },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toEqual([
      {
        role: "assistant",
        id: "asst-1",
        text: "let me look it up",
        toolCalls: [
          {
            toolUseId: "tool-1",
            name: "Read",
            input: { path: "/tmp/foo" },
          },
        ],
        streaming: false,
        finishReason: "stop",
      },
    ]);
  });

  it("joins multiple text blocks in an assistant message with a paragraph separator", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-1",
          content: [
            { type: "text", text: "first paragraph" },
            { type: "text", text: "second paragraph" },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages[0]?.role).toBe("assistant");
    if (result.messages[0]?.role === "assistant") {
      expect(result.messages[0].text).toBe("first paragraph\n\nsecond paragraph");
    }
  });

  it("attaches a tool_result to the matching tool_use even when it arrives later", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-1",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { path: "/tmp/foo" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file contents",
              is_error: false,
            },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          toolUseId: "tool-1",
          result: { output: "file contents", isError: false },
        },
      ],
    });
  });

  it("first-write-wins for duplicate tool_use_id so a tampered result cannot overwrite the original", () => {
    // A duplicate `tool_use_id` could come from a forked session re-using
    // an id, or from a tampered JSONL. Either way, the second result
    // must not flip the first call's `isError` flag or output.
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-1",
          content: [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "original",
              is_error: false,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "tampered",
              is_error: true,
            },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toHaveLength(1);
    if (result.messages[0]?.role === "assistant") {
      expect(result.messages[0].toolCalls[0]?.result).toEqual({
        output: "original",
        isError: false,
      });
    }
  });

  it("silently drops a tool_result with no matching tool_use rather than fabricating a call", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "orphan-1",
              content: "stranded",
              is_error: false,
            },
          ],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toEqual([]);
  });

  it("ignores reserved property keys without trusting them as plain data", () => {
    // `JSON.parse` correctly stores `__proto__` / `constructor` as
    // own data properties (it does not walk the prototype chain), so
    // these keys cannot poison Object.prototype. The assertion just
    // confirms the parser does not panic on them and produces the
    // turn that follows.
    const lines = [
      JSON.stringify({
        type: "user",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        __proto__: { polluted: true },
        message: { role: "user", content: "hello" },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toHaveLength(1);
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted)
      .toBeUndefined();
  });

  it("falls back to a synthetic id when the assistant message lacks one", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "anonymous" }],
        },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[0]?.id).toBe("hydrated-assistant-0");
  });

  it("ignores malformed lines without losing surrounding turns", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "first" },
      }),
      "{not valid json",
      JSON.stringify({
        type: "assistant",
        message: { id: "asst-1", content: [{ type: "text", text: "second" }] },
      }),
    ];
    const result = parseSessionJsonl("claude-code", lines);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[1]?.role).toBe("assistant");
  });
});

describe("parseSessionJsonl — codex", () => {
  it("extracts thread_id from a thread.started envelope", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: VALID_UUID }),
    ];
    const result = parseSessionJsonl("codex", lines);
    expect(result.upstreamSessionId).toBe(VALID_UUID);
  });

  it("first-write-wins: a later thread.started cannot redirect resume to a different conversation", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: VALID_UUID }),
      JSON.stringify({
        type: "thread.started",
        thread_id: "ffffffff-aaaa-bbbb-cccc-dddddddddddd",
      }),
    ];
    const result = parseSessionJsonl("codex", lines);
    expect(result.upstreamSessionId).toBe(VALID_UUID);
  });

  it("ignores a thread_id that does not belong to thread.started", () => {
    // Defensive: only `thread.started` carries an id we can trust as
    // the upstream thread for `codex exec resume`. This mirrors the
    // backend's `capture_session_id_ignores_thread_id_outside_thread_started`
    // unit test in `headless/session.rs`.
    const lines = [
      JSON.stringify({ type: "turn.started", thread_id: VALID_UUID }),
    ];
    const result = parseSessionJsonl("codex", lines);
    expect(result.upstreamSessionId).toBeUndefined();
  });

  it("converts user_message and agent_message events into messages", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "hello" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "hi back" },
      }),
    ];
    const result = parseSessionJsonl("codex", lines);
    expect(result.messages).toEqual([
      {
        role: "user",
        id: "hydrated-user-0",
        text: "hello",
        sentAt: 0,
      },
      {
        role: "assistant",
        id: "hydrated-assistant-0",
        text: "hi back",
        toolCalls: [],
        streaming: false,
        finishReason: "stop",
      },
    ]);
  });

  it("suppresses /model slash commands the way the live parser does", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "/model gpt-5" },
      }),
    ];
    const result = parseSessionJsonl("codex", lines);
    expect(result.messages).toEqual([]);
  });
});
