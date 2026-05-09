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

  it("expands attached images into trailing image blocks", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "user",
            id: "req-1",
            text: "look at this",
            sentAt: 0,
            images: [
              { path: "/tmp/chorus-images/a.png", name: "a.png" },
              { path: "/tmp/chorus-images/b.png", name: "b.png" },
            ],
          },
        ],
      }),
    );
    expect(m!.blocks).toEqual([
      { kind: "text", text: "look at this" },
      { kind: "image", path: "/tmp/chorus-images/a.png", name: "a.png" },
      { kind: "image", path: "/tmp/chorus-images/b.png", name: "b.png" },
    ]);
  });

  it("renders an image-only user message (no leading empty text block)", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "user",
            id: "req-1",
            text: "",
            sentAt: 0,
            images: [{ path: "/tmp/chorus-images/x.png", name: "x.png" }],
          },
        ],
      }),
    );
    expect(m!.blocks).toEqual([
      { kind: "image", path: "/tmp/chorus-images/x.png", name: "x.png" },
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

  it("converts AskUserQuestion tool_use into an ask_user_question block", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              {
                toolUseId: "tu-q",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      header: "Choose style",
                      multiSelect: false,
                      options: [
                        { description: "Option A" },
                        { description: "Option B" },
                      ],
                    },
                  ],
                },
              },
            ],
            streaming: false,
          },
        ],
      }),
    );
    expect(m!.blocks).toHaveLength(1);
    const block = m!.blocks[0]!;
    expect(block.kind).toBe("ask_user_question");
    if (block.kind === "ask_user_question") {
      expect(block.toolId).toBe("tu-q");
      expect(block.answered).toBe(false);
      expect(block.questions).toHaveLength(1);
      expect(block.questions[0]!.header).toBe("Choose style");
      expect(block.questions[0]!.isMultiSelect).toBe(false);
      expect(block.questions[0]!.options).toEqual([
        { description: "Option A" },
        { description: "Option B" },
      ]);
    }
  });

  it("suppresses error tool_result for AskUserQuestion", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              {
                toolUseId: "tu-q",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      header: "Pick",
                      multiSelect: false,
                      options: [{ description: "Yes" }],
                    },
                  ],
                },
                result: { output: "Answer questions?", isError: true },
              },
            ],
            streaming: false,
          },
        ],
      }),
    );
    // Should be ask_user_question only, no tool_result block
    expect(m!.blocks).toHaveLength(1);
    expect(m!.blocks[0]!.kind).toBe("ask_user_question");
    if (m!.blocks[0]!.kind === "ask_user_question") {
      expect(m!.blocks[0]!.answered).toBe(true);
    }
  });

  it("suppresses error system row when AskUserQuestion is pending", () => {
    const out = adaptHeadlessMessages(
      emptySession({
        status: "error",
        errorKind: "agent_crashed",
        errorMessage: "child exited with no status",
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "Let me ask",
            toolCalls: [
              {
                toolUseId: "tu-q",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      header: "Pick",
                      multiSelect: false,
                      options: [{ description: "A" }],
                    },
                  ],
                },
                result: { output: "Answer questions?", isError: true },
              },
            ],
            streaming: false,
          },
        ],
      }),
    );
    // No system error row — only the assistant message
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
  });

  it("falls back to generic tool_use when AskUserQuestion input is malformed", () => {
    const [m] = adaptHeadlessMessages(
      emptySession({
        messages: [
          {
            role: "assistant",
            id: "msg-1",
            text: "",
            toolCalls: [
              {
                toolUseId: "tu-q",
                name: "AskUserQuestion",
                input: { unexpected: "shape" },
              },
            ],
            streaming: false,
          },
        ],
      }),
    );
    expect(m!.blocks[0]!.kind).toBe("tool_use");
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
