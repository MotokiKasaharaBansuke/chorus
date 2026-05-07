import { describe, it, expect, beforeEach } from "vitest";
import { createRoot } from "solid-js";

import { useHeadlessStore } from "./headless-store";
import type { HeadlessEvent } from "../types/headless";

describe("useHeadlessStore", () => {
  beforeEach(() => {
    createRoot((dispose) => {
      useHeadlessStore()._reset();
      dispose();
    });
  });

  it("registerSession seeds an idle row with zero usage", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.registerSession("t1");
      const session = store.sessionFor("t1");
      expect(session?.status).toBe("idle");
      expect(session?.messages).toEqual([]);
      expect(session?.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      dispose();
    });
  });

  it("appendUserMessage adds a user turn", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.appendUserMessage("t1", "req-1", "hello");
      const session = store.sessionFor("t1");
      expect(session?.messages).toHaveLength(1);
      const msg = session!.messages[0]!;
      expect(msg.role).toBe("user");
      if (msg.role === "user") {
        expect(msg.id).toBe("req-1");
        expect(msg.text).toBe("hello");
      }
      dispose();
    });
  });

  it("message-delta concatenates onto an existing assistant turn with the same id", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      const events: HeadlessEvent[] = [
        { type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "hello " },
        { type: "message-delta", tabId: "t1", messageId: "m-1", index: 1, delta: "world" },
      ];
      events.forEach((e) => store.applyEvent(e));
      const session = store.sessionFor("t1");
      expect(session?.messages).toHaveLength(1);
      const msg = session!.messages[0]!;
      expect(msg.role).toBe("assistant");
      if (msg.role === "assistant") {
        expect(msg.text).toBe("hello world");
        expect(msg.streaming).toBe(true);
      }
      expect(session?.status).toBe("thinking");
      dispose();
    });
  });

  it("message-complete clears the streaming flag and reverts status to idle", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "x" });
      store.applyEvent({
        type: "message-complete",
        tabId: "t1",
        messageId: "m-1",
        finishReason: "stop",
      });
      const msg = store.sessionFor("t1")!.messages[0]!;
      expect(msg.role).toBe("assistant");
      if (msg.role === "assistant") {
        expect(msg.streaming).toBe(false);
        expect(msg.finishReason).toBe("stop");
      }
      expect(store.sessionFor("t1")?.status).toBe("idle");
      dispose();
    });
  });

  it("tool-use attaches to the matching assistant message and flips status to running", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "x" });
      store.applyEvent({
        type: "tool-use",
        tabId: "t1",
        messageId: "m-1",
        toolUseId: "tu-1",
        name: "Edit",
        input: { file_path: "/x.rs" },
      });
      const msg = store.sessionFor("t1")!.messages[0]!;
      expect(msg.role).toBe("assistant");
      if (msg.role === "assistant") {
        expect(msg.toolCalls).toHaveLength(1);
        expect(msg.toolCalls[0]!.name).toBe("Edit");
        expect(msg.toolCalls[0]!.toolUseId).toBe("tu-1");
      }
      expect(store.sessionFor("t1")?.status).toBe("running");
      dispose();
    });
  });

  it("tool-result populates the output of the matching tool call", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "x" });
      store.applyEvent({
        type: "tool-use",
        tabId: "t1",
        messageId: "m-1",
        toolUseId: "tu-1",
        name: "Edit",
        input: {},
      });
      store.applyEvent({
        type: "tool-result",
        tabId: "t1",
        toolUseId: "tu-1",
        output: "applied",
        isError: false,
      });
      const msg = store.sessionFor("t1")!.messages[0]!;
      if (msg.role === "assistant") {
        expect(msg.toolCalls[0]!.result).toEqual({ output: "applied", isError: false });
      }
      dispose();
    });
  });

  it("status events propagate to the session row", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({
        type: "status",
        tabId: "t1",
        status: "error",
        errorKind: "agent_crashed",
        message: "child exited",
      });
      const session = store.sessionFor("t1");
      expect(session?.status).toBe("error");
      expect(session?.errorKind).toBe("agent_crashed");
      expect(session?.errorMessage).toBe("child exited");
      dispose();
    });
  });

  it("usage events overwrite the running counters", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({
        type: "usage",
        tabId: "t1",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
        },
      });
      expect(store.sessionFor("t1")?.usage.inputTokens).toBe(100);
      expect(store.sessionFor("t1")?.usage.outputTokens).toBe(50);
      dispose();
    });
  });

  it("removeSession drops the row entirely", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.registerSession("t1");
      expect(store.sessionFor("t1")).toBeTruthy();
      store.removeSession("t1");
      expect(store.sessionFor("t1")).toBeUndefined();
      dispose();
    });
  });

  it("rate-limit events stash detail on the session row", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({
        type: "rate-limit",
        tabId: "t1",
        detail: { resetAt: 1700000000, retryAfterMs: 12000 },
      });
      const rl = store.sessionFor("t1")?.rateLimit;
      expect(rl?.retryAfterMs).toBe(12000);
      expect(rl?.resetAt).toBe(1700000000);
      dispose();
    });
  });

  it("unknown events leave the session unchanged (fail-soft)", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.registerSession("t1");
      const before = JSON.stringify(store.sessionFor("t1"));
      store.applyEvent({ type: "unknown", tabId: "t1", raw: { surprise: true } });
      const after = JSON.stringify(store.sessionFor("t1"));
      expect(after).toBe(before);
      dispose();
    });
  });

  it("events for distinct tabs do not interfere", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "a" });
      store.applyEvent({ type: "message-delta", tabId: "t2", messageId: "m-2", index: 0, delta: "b" });
      const t1 = store.sessionFor("t1")!.messages[0]!;
      const t2 = store.sessionFor("t2")!.messages[0]!;
      if (t1.role === "assistant") expect(t1.text).toBe("a");
      if (t2.role === "assistant") expect(t2.text).toBe("b");
      dispose();
    });
  });

  it("message-delta with a different messageId pushes a new assistant turn", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "first" });
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-2", index: 0, delta: "second" });
      const session = store.sessionFor("t1");
      expect(session?.messages).toHaveLength(2);
      dispose();
    });
  });

  it("tool-result for an unknown toolUseId is silently ignored", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      store.applyEvent({ type: "message-delta", tabId: "t1", messageId: "m-1", index: 0, delta: "x" });
      store.applyEvent({
        type: "tool-result",
        tabId: "t1",
        toolUseId: "tu-orphan",
        output: "stale",
        isError: false,
      });
      const msg = store.sessionFor("t1")?.messages[0];
      if (msg?.role === "assistant") {
        expect(msg.toolCalls).toHaveLength(0);
      }
      dispose();
    });
  });
});
