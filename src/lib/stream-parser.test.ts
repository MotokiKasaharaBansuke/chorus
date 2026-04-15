import { describe, it, expect } from "vitest";
import { StreamParser } from "./stream-parser";

// ---- helpers ----

function assistantLine(text: string, model?: string) {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      model: model ?? "claude-3-5-sonnet",
      content: [{ type: "text", text }],
    },
  });
}

function userLine(text: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function resultLine(costUsd: number, durationMs: number, inputTokens: number, outputTokens: number) {
  return JSON.stringify({
    type: "result",
    total_cost_usd: costUsd,
    duration_ms: durationMs,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

function codexUserLine(message: string) {
  return JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } });
}

function codexAgentLine(message: string) {
  return JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message } });
}

// ---- loadSession: Claude Code format ----

describe("StreamParser.loadSession — Claude Code format", () => {
  it("parses user messages from array content", () => {
    const parser = new StreamParser();
    parser.loadSession([userLine("hello")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "hello" });
  });

  it("parses assistant messages", () => {
    const parser = new StreamParser();
    parser.loadSession([assistantLine("hi there")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "hi there" });
  });

  it("parses multiple messages in order", () => {
    const parser = new StreamParser();
    parser.loadSession([userLine("q1"), assistantLine("a1"), userLine("q2")]);
    const msgs = parser.getMessages();
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("skips user messages with XML-like content only", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "<context>...</context>" }] },
    });
    const parser = new StreamParser();
    parser.loadSession([line]);
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("skips malformed JSON lines gracefully", () => {
    const parser = new StreamParser();
    parser.loadSession(["not json", userLine("valid"), "{broken"]);
    expect(parser.getMessages()).toHaveLength(1);
  });

  it("resets messages on each loadSession call", () => {
    const parser = new StreamParser();
    parser.loadSession([userLine("first")]);
    parser.loadSession([userLine("second")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "second" });
  });
});

// ---- loadSession: Codex format ----

describe("StreamParser.loadSession — Codex format", () => {
  it("parses user_message events", () => {
    const parser = new StreamParser();
    parser.loadSession([codexUserLine("hello codex")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "hello codex" });
  });

  it("parses agent_message events", () => {
    const parser = new StreamParser();
    parser.loadSession([codexAgentLine("codex reply")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "codex reply" });
  });

  it("skips /model slash commands", () => {
    const parser = new StreamParser();
    parser.loadSession([codexUserLine("/model gpt-4o"), codexUserLine("real message")]);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "real message" });
  });

  it("skips empty messages", () => {
    const parser = new StreamParser();
    parser.loadSession([codexUserLine("   "), codexAgentLine("")]);
    expect(parser.getMessages()).toHaveLength(0);
  });
});

// ---- processLine ----

describe("StreamParser.processLine", () => {
  it("adds assistant message via 'assistant' event", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("streamed reply"));
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
  });

  it("attaches cost/token info from 'result' event", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("reply"));
    parser.processLine(resultLine(0.005, 1200, 100, 50));
    const msgs = parser.getMessages();
    expect(msgs[0].costUsd).toBe(0.005);
    expect(msgs[0].durationMs).toBe(1200);
    expect(msgs[0].inputTokens).toBe(100);
    expect(msgs[0].outputTokens).toBe(50);
  });

  it("marks last assistant message complete on 'turn_complete'", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("reply"));
    parser.processLine(JSON.stringify({ type: "turn_complete" }));
    const msgs = parser.getMessages();
    expect(msgs[0].isStreaming).toBe(false);
  });

  it("shows stderr as system message", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({ type: "stderr", text: "error output" }));
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "stderr", text: "error output" });
  });

  it("ignores unknown event types silently", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({ type: "rate_limit_event", data: {} }));
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("ignores malformed JSON", () => {
    const parser = new StreamParser();
    parser.processLine("not valid json");
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("ignores stderr with empty text", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({ type: "stderr", text: "" }));
    expect(parser.getMessages()).toHaveLength(0);
  });
});

// ---- processLine: tool_use / tool_result ----

describe("StreamParser.processLine — tool calls", () => {
  it("parses tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool-123",
          name: "Bash",
          input: { command: "ls" },
        }],
      },
    });
    const parser = new StreamParser();
    parser.processLine(line);
    const block = parser.getMessages()[0].blocks[0];
    expect(block).toMatchObject({ kind: "tool_use", toolName: "Bash", toolId: "tool-123" });
  });

  it("attaches tool_result to last assistant message via block.content", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("thinking"));
    const toolResultLine = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-123",
          content: "file list output",
        }],
      },
    });
    parser.processLine(toolResultLine);
    const blocks = parser.getMessages()[0].blocks;
    const result = blocks.find(b => b.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", toolId: "tool-123", output: "file list output" });
  });

  it("prefers tool_use_result.stdout over block.content for tool output", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("thinking"));
    const toolResultLine = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-456",
          content: "raw content",
        }],
      },
      tool_use_result: { stdout: "clean stdout output" },
    });
    parser.processLine(toolResultLine);
    const blocks = parser.getMessages()[0].blocks;
    const result = blocks.find(b => b.kind === "tool_result");
    expect(result).toMatchObject({ output: "clean stdout output" });
  });

  it("marks tool_result as error when is_error is true", () => {
    const parser = new StreamParser();
    parser.processLine(assistantLine("thinking"));
    const toolResultLine = JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-789",
          content: "error details",
          is_error: true,
        }],
      },
    });
    parser.processLine(toolResultLine);
    const blocks = parser.getMessages()[0].blocks;
    const result = blocks.find(b => b.kind === "tool_result");
    expect(result).toMatchObject({ isError: true });
  });
});

// ---- edge cases ----

describe("StreamParser edge cases", () => {
  it("handles result event with no prior assistant message gracefully", () => {
    const parser = new StreamParser();
    // No assistant message added first
    expect(() => parser.processLine(resultLine(0.001, 100, 10, 5))).not.toThrow();
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("loadSession with empty array produces no messages", () => {
    const parser = new StreamParser();
    parser.loadSession([]);
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("turn_complete with no prior assistant message does not throw", () => {
    const parser = new StreamParser();
    expect(() => parser.processLine(JSON.stringify({ type: "turn_complete" }))).not.toThrow();
    expect(parser.getMessages()).toHaveLength(0);
  });
});

// ---- notify / onUpdate ----

describe("StreamParser.onUpdate", () => {
  it("fires listener with snapshot on addUserMessage", () => {
    const parser = new StreamParser();
    let received: unknown[] = [];
    parser.onUpdate(msgs => { received = msgs; });
    parser.addUserMessage("test");
    expect(received).toHaveLength(1);
  });

  it("snapshot is independent from internal state (deep copy)", () => {
    const parser = new StreamParser();
    let snapshot: ReturnType<typeof parser.getMessages> = [];
    parser.onUpdate(msgs => { snapshot = msgs; });
    parser.addUserMessage("original");
    const firstSnapshot = snapshot;
    parser.addUserMessage("second");
    // First snapshot should still have length 1 (not mutated by subsequent updates)
    expect(firstSnapshot).toHaveLength(1);
  });
});

describe("StreamParser.addUserMessage with images", () => {
  it("places image blocks before text block", () => {
    const parser = new StreamParser();
    const images = [
      { path: "/tmp/chorus-images/a.png", name: "a.png" },
      { path: "/tmp/chorus-images/b.jpg", name: "b.jpg" },
    ];
    parser.addUserMessage("hello", images);
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    const blocks = msgs[0].blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ kind: "image", path: "/tmp/chorus-images/a.png", name: "a.png" });
    expect(blocks[1]).toEqual({ kind: "image", path: "/tmp/chorus-images/b.jpg", name: "b.jpg" });
    expect(blocks[2]).toEqual({ kind: "text", text: "hello" });
  });

  it("produces no image blocks when images is an empty array", () => {
    const parser = new StreamParser();
    parser.addUserMessage("hello", []);
    const blocks = parser.getMessages()[0].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "text", text: "hello" });
  });

  it("produces no image blocks when images is undefined", () => {
    const parser = new StreamParser();
    parser.addUserMessage("hello");
    const blocks = parser.getMessages()[0].blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "text", text: "hello" });
  });
});

// ---- system events ----

describe("StreamParser system events", () => {
  it("renders non-init system events with a message as system messages", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({
      type: "system",
      subtype: "compact",
      message: "Conversation compacted: 45k → 12k tokens",
    }));
    const msgs = parser.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].blocks[0]).toMatchObject({ kind: "text", text: "Conversation compacted: 45k → 12k tokens" });
  });

  it("ignores non-init system events without a message field", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({ type: "system", subtype: "unknown" }));
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("ignores non-init system events with non-string message", () => {
    const parser = new StreamParser();
    parser.processLine(JSON.stringify({ type: "system", subtype: "other", message: 42 }));
    parser.processLine(JSON.stringify({ type: "system", subtype: "other", message: { text: "hi" } }));
    expect(parser.getMessages()).toHaveLength(0);
  });

  it("still triggers streaming status on system.init", () => {
    const parser = new StreamParser();
    const statuses: string[] = [];
    parser.onStatusChange((s) => statuses.push(s));
    parser.processLine(JSON.stringify({ type: "system", subtype: "init" }));
    expect(statuses).toContain("streaming");
    expect(parser.getMessages()).toHaveLength(0);
  });
});
