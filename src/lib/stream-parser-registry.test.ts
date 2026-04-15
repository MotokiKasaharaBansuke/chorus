import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateParser, removeParser } from "./stream-parser-registry";

describe("stream-parser-registry", () => {
  beforeEach(() => {
    // Clean up any leftover parsers from previous tests
    removeParser("tab-a");
    removeParser("tab-b");
  });

  it("returns the same instance for the same tab ID", () => {
    const first = getOrCreateParser("tab-a");
    const second = getOrCreateParser("tab-a");
    expect(first).toBe(second);
  });

  it("returns different instances for different tab IDs", () => {
    const a = getOrCreateParser("tab-a");
    const b = getOrCreateParser("tab-b");
    expect(a).not.toBe(b);
  });

  it("creates a new instance after removeParser", () => {
    const first = getOrCreateParser("tab-a");
    first.addUserMessage("hello");
    expect(first.getMessages()).toHaveLength(1);

    removeParser("tab-a");

    const second = getOrCreateParser("tab-a");
    expect(second).not.toBe(first);
    expect(second.getMessages()).toHaveLength(0);
  });

  it("does not throw when removing a non-existent parser", () => {
    expect(() => removeParser("non-existent")).not.toThrow();
  });

  it("preserves messages across getOrCreateParser calls", () => {
    const parser = getOrCreateParser("tab-a");
    parser.addUserMessage("first message");
    parser.addUserMessage("second message");

    const same = getOrCreateParser("tab-a");
    expect(same.getMessages()).toHaveLength(2);
    expect(same.getMessages()[0].blocks[0]).toMatchObject({ kind: "text", text: "first message" });
  });
});
