import { describe, it, expect } from "vitest";
import { findStickyUserMessage } from "./find-sticky-user-message";
import type { ChatMessage } from "../types";

function makeMsg(role: ChatMessage["role"], text = ""): ChatMessage {
  return {
    role,
    blocks: text ? [{ kind: "text", text }] : [],
    isStreaming: false,
  };
}

describe("findStickyUserMessage", () => {
  it("returns null for empty messages", () => {
    expect(findStickyUserMessage([], [], 0, 80)).toBeNull();
  });

  it("returns null when no user messages exist", () => {
    const msgs = [makeMsg("assistant", "hello")];
    const items = [{ index: 0, start: 0 }];
    expect(findStickyUserMessage(msgs, items, 100, 80)).toBeNull();
  });

  it("returns null when no user message has scrolled past top", () => {
    const msgs = [makeMsg("user", "q1"), makeMsg("assistant", "a1")];
    const items = [{ index: 0, start: 0 }, { index: 1, start: 80 }];
    expect(findStickyUserMessage(msgs, items, 0, 80)).toBeNull();
  });

  it("returns user message that scrolled past top", () => {
    const msgs = [makeMsg("user", "q1"), makeMsg("assistant", "a1")];
    const items = [{ index: 0, start: 0 }, { index: 1, start: 80 }];
    expect(findStickyUserMessage(msgs, items, 50, 80)).toBe(msgs[0]);
  });

  it("returns the latest user message that scrolled past top", () => {
    const msgs = [
      makeMsg("user", "q1"),
      makeMsg("assistant", "a1"),
      makeMsg("user", "q2"),
      makeMsg("assistant", "a2"),
    ];
    const items = [
      { index: 0, start: 0 },
      { index: 1, start: 80 },
      { index: 2, start: 160 },
      { index: 3, start: 240 },
    ];
    expect(findStickyUserMessage(msgs, items, 200, 80)).toBe(msgs[2]);
  });

  it("uses estimateSize as fallback when virtualItem is not rendered", () => {
    const msgs = [
      makeMsg("user", "q1"),
      makeMsg("assistant", "a1"),
      makeMsg("user", "q2"),
    ];
    // Only the last item is rendered (others are outside viewport)
    const items = [{ index: 2, start: 160 }];
    // scrollTop = 100, so q1 (estimated at 0*80=0) should be sticky
    // but q2 (at 160) should not
    expect(findStickyUserMessage(msgs, items, 100, 80)).toBe(msgs[0]);
  });

  it("does not pin messages at exact scrollTop boundary", () => {
    const msgs = [makeMsg("user", "q1"), makeMsg("assistant", "a1")];
    const items = [{ index: 0, start: 50 }, { index: 1, start: 130 }];
    // scrollTop === itemStart → not sticky (needs to be strictly past)
    expect(findStickyUserMessage(msgs, items, 50, 80)).toBeNull();
  });

  it("handles multiple user messages in sequence", () => {
    const msgs = [
      makeMsg("user", "q1"),
      makeMsg("user", "q2"),
      makeMsg("user", "q3"),
      makeMsg("assistant", "a1"),
    ];
    const items = [
      { index: 0, start: 0 },
      { index: 1, start: 40 },
      { index: 2, start: 80 },
      { index: 3, start: 120 },
    ];
    expect(findStickyUserMessage(msgs, items, 60, 80)).toBe(msgs[1]);
  });
});
