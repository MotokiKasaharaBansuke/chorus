import { describe, expect, it } from "vitest";

import { adaptHeadlessMessages } from "./adapt-messages";
import type {
  HeadlessSessionState,
  HeadlessToolCall,
} from "../../types/headless";

function emptySession(overrides: Partial<HeadlessSessionState> = {}): HeadlessSessionState {
  return {
    tabId: "tab-1",
    status: "idle",
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    ...overrides,
  };
}

describe("adaptHeadlessMessages", () => {
  it("returns empty array when the session is missing", () => {
    expect(adaptHeadlessMessages(undefined)).toEqual([]);
  });

  it("converts a user message into a single text block", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        messages: [{ role: "user", id: "req-1", text: "hello", sentAt: 0 }],
      }),
    );
    expect(out).toEqual([
      {
        role: "user",
        blocks: [{ kind: "text", text: "hello" }],
        isStreaming: false,
      },
    ]);
  });

  it("converts a streaming assistant message and preserves the streaming flag", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "hi there",
            toolCalls: [],
            streaming: true,
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.role).toBe("assistant");
    expect(m.isStreaming).toBe(true);
    expect(m.blocks).toEqual([{ kind: "text", text: "hi there" }]);
  });

  it("expands tool calls into matched tool_use + tool_result blocks", () => {
    const call: HeadlessToolCall = {
      toolUseId: "tu-1",
      name: "Edit",
      input: { path: "/x", old: "a", new: "b" },
      result: { output: "ok", isError: false },
    };
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [call],
            streaming: false,
          },
        ],
      }),
    );
    expect(m!.blocks).toEqual([
      {
        kind: "tool_use",
        toolName: "Edit",
        toolId: "tu-1",
        input: JSON.stringify(call.input),
        isStreaming: false,
      },
      {
        kind: "tool_result",
        toolId: "tu-1",
        output: "ok",
        isError: false,
      },
    ]);
  });

  it("marks tool_use as streaming until its result lands", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              { toolUseId: "tu", name: "Bash", input: { cmd: "ls" } },
            ],
            streaming: true,
          },
        ],
      }),
    );
    const block = m!.blocks[0]!;
    expect(block.kind).toBe("tool_use");
    if (block.kind === "tool_use") {
      expect(block.isStreaming).toBe(true);
    }
    // No tool_result row because the call has no result yet.
    expect(m!.blocks).toHaveLength(1);
  });

  it("passes through string tool input verbatim", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              {
                toolUseId: "tu",
                name: "Custom",
                input: "raw payload",
              },
            ],
            streaming: false,
          },
        ],
      }),
    );
    const block = m!.blocks[0]!;
    if (block.kind !== "tool_use") throw new Error("expected tool_use");
    expect(block.input).toBe("raw payload");
  });

  it("appends a system error row when the session is in error state", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "error",
        errorKind: "agent_crashed",
        errorMessage: "exit code 1",
        messages: [{ role: "user", id: "req-1", text: "hi", sentAt: 0 }],
      }),
    );
    expect(out).toHaveLength(2);
    const errRow = out[1]!;
    expect(errRow.role).toBe("system");
    expect(errRow.blocks).toEqual([
      { kind: "text", text: "agent_crashed: exit code 1" },
    ]);
  });

  it("does not append an error row when status is idle", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "idle",
        messages: [{ role: "user", id: "req-1", text: "hi", sentAt: 0 }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });

  it("falls back to errorKind without echoing it twice", () => {
    // Earlier behaviour rendered "rate_limited: rate_limited"; the
    // dedupe in `formatSystemRowText` now drops the message half when
    // it just echoes the kind string.
    const out = adaptHeadlessMessages(
      emptySession({
        status: "error",
        errorKind: "rate_limited",
        errorMessage: "rate_limited",
      }),
    );
    expect(out[0]!.blocks).toEqual([{ kind: "text", text: "rate_limited" }]);
  });

  it("renders just the errorKind when no message is present", () => {
    const out = adaptHeadlessMessages(
      emptySession({ status: "error", errorKind: "agent_crashed" }),
    );
    expect(out[0]!.blocks).toEqual([{ kind: "text", text: "agent_crashed" }]);
  });

  it("renders rate-limit advisory as a system row when not in error state", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "idle",
        rateLimit: { retryAfterMs: 12_000 },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("system");
    expect(out[0]!.blocks).toEqual([
      { kind: "text", text: "Rate limited — retry in 12s" },
    ]);
  });

  it("formats sub-second rate-limit waits in milliseconds", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "idle",
        rateLimit: { retryAfterMs: 750 },
      }),
    );
    expect(out[0]!.blocks).toEqual([
      { kind: "text", text: "Rate limited — retry in 750ms" },
    ]);
  });

  it("formats minute-scale rate-limit waits as minutes", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "idle",
        rateLimit: { retryAfterMs: 5 * 60 * 1000 },
      }),
    );
    expect(out[0]!.blocks).toEqual([
      { kind: "text", text: "Rate limited — retry in 5m" },
    ]);
  });

  it("error row outranks rate-limit when both are present", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "error",
        errorKind: "agent_crashed",
        errorMessage: "exit 1",
        rateLimit: { retryAfterMs: 1000 },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.blocks).toEqual([
      { kind: "text", text: "agent_crashed: exit 1" },
    ]);
  });

  it("does not push an empty text block when assistant text is empty", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              { toolUseId: "tu", name: "Read", input: { path: "/x" } },
            ],
            streaming: false,
          },
        ],
      }),
    );
    // Only the tool_use block — no leading empty text block.
    expect(m!.blocks).toHaveLength(1);
    expect(m!.blocks[0]!.kind).toBe("tool_use");
  });
});
