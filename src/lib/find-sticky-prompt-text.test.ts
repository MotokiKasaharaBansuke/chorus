import { describe, it, expect } from "vitest";
import { findStickyPromptText, BOTTOM_PROXIMITY_PX } from "./find-sticky-prompt-text";
import type { ChatMessage } from "../types";

function makeMsg(role: ChatMessage["role"], text?: string, imageOnly?: boolean): ChatMessage {
  const blocks: ChatMessage["blocks"] = imageOnly
    ? [{ kind: "image", path: "/tmp/img.png", name: "img.png" }]
    : text !== undefined
      ? [{ kind: "text", text }]
      : [];
  return { role, blocks, isStreaming: false, costUsd: 0 };
}

function makeVirtualItems(count: number, height: number) {
  return Array.from({ length: count }, (_, i) => ({ index: i, start: i * height }));
}

const H = 80; // estimated height

describe("findStickyPromptText", () => {
  it("returns null for empty messages", () => {
    const result = findStickyPromptText([], [], { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("returns null when no user messages exist", () => {
    const msgs = [makeMsg("assistant", "hello"), makeMsg("system", "info")];
    const items = makeVirtualItems(2, H);
    const result = findStickyPromptText(msgs, items, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("returns null when near the bottom (within BOTTOM_PROXIMITY_PX)", () => {
    const msgs = [makeMsg("user", "prompt"), makeMsg("assistant", "reply")];
    const items = makeVirtualItems(2, H);
    // distToBottom = 1000 - 400 - 521 = 79 < 80 → near bottom
    const result = findStickyPromptText(msgs, items, { scrollTop: 521, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("returns text at exact BOTTOM_PROXIMITY_PX boundary", () => {
    const msgs = [makeMsg("user", "prompt"), makeMsg("assistant", "reply")];
    const items = makeVirtualItems(2, H);
    // distToBottom = 1000 - 400 - 520 = 80, NOT < 80 → sticky is shown
    const result = findStickyPromptText(msgs, items, { scrollTop: 520, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBe("prompt");
  });

  it("returns user message text when scrolled past it", () => {
    const msgs = [makeMsg("user", "my question"), makeMsg("assistant", "answer")];
    const items = makeVirtualItems(2, H);
    // scrollTop=100 > item[0].start=0, distToBottom = 1000 - 400 - 100 = 500 > 80
    const result = findStickyPromptText(msgs, items, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBe("my question");
  });

  it("returns the LAST scrolled-past user message", () => {
    const msgs = [
      makeMsg("user", "first"),
      makeMsg("assistant", "reply1"),
      makeMsg("user", "second"),
      makeMsg("assistant", "reply2"),
    ];
    const items = makeVirtualItems(4, H);
    // scrollTop=200, items at 0, 80, 160, 240. User msgs at 0 and 160, both < 200
    const result = findStickyPromptText(msgs, items, { scrollTop: 200, scrollHeight: 2000, clientHeight: 400 }, H);
    expect(result).toBe("second");
  });

  it("returns null for user message not yet scrolled past", () => {
    const msgs = [makeMsg("user", "visible")];
    const items = [{ index: 0, start: 200 }];
    // scrollTop=100, item start=200, 200 < 100 is false
    const result = findStickyPromptText(msgs, items, { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("falls back to estimatedHeight when virtualItem is not in the map", () => {
    const msgs = [makeMsg("user", "prompt"), makeMsg("assistant", "reply")];
    // Empty virtual items — all positions estimated
    const result = findStickyPromptText(msgs, [], { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 }, H);
    // index 0 → estimated start = 0 * 80 = 0 < 100 → match
    expect(result).toBe("prompt");
  });

  it("skips image-only user messages (no text blocks)", () => {
    const msgs = [
      makeMsg("user", undefined, true), // image-only
      makeMsg("assistant", "reply"),
    ];
    const items = makeVirtualItems(2, H);
    const result = findStickyPromptText(msgs, items, { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("handles elastic overscroll (negative distToBottom)", () => {
    const msgs = [makeMsg("user", "prompt"), makeMsg("assistant", "reply")];
    const items = makeVirtualItems(2, H);
    // scrollTop overshoots: distToBottom = 1000 - 400 - 700 = -100 → clamped to 0 < 80
    const result = findStickyPromptText(msgs, items, { scrollTop: 700, scrollHeight: 1000, clientHeight: 400 }, H);
    expect(result).toBeNull();
  });

  it("handles zero-size container", () => {
    const msgs = [makeMsg("user", "prompt")];
    const items = makeVirtualItems(1, H);
    const result = findStickyPromptText(msgs, items, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, H);
    expect(result).toBeNull();
  });

  it("exports BOTTOM_PROXIMITY_PX constant", () => {
    expect(BOTTOM_PROXIMITY_PX).toBe(80);
  });
});
