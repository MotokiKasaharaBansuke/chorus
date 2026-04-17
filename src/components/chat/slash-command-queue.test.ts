import { describe, it, expect } from "vitest";
import { SlashCommandQueue } from "./slash-command-queue";

describe("SlashCommandQueue", () => {
  it("starts empty", () => {
    const q = new SlashCommandQueue();
    expect(q.hasPending()).toBe(false);
    expect(q.drain()).toBeNull();
  });

  it("returns the enqueued command on drain and empties the queue", () => {
    const q = new SlashCommandQueue();
    q.enqueue({ id: "compact", silent: true });
    expect(q.hasPending()).toBe(true);
    expect(q.drain()).toEqual({ id: "compact", silent: true });
    expect(q.hasPending()).toBe(false);
    expect(q.drain()).toBeNull();
  });

  it("replaces an earlier pending command — explicit user click wins over stale auto-compact", () => {
    const q = new SlashCommandQueue();
    q.enqueue({ id: "compact", silent: true });
    q.enqueue({ id: "model claude-sonnet-4-6", silent: false });
    expect(q.drain()).toEqual({ id: "model claude-sonnet-4-6", silent: false });
  });

  it("collapses repeat enqueues to a single execution", () => {
    const q = new SlashCommandQueue();
    q.enqueue({ id: "compact", silent: true });
    q.enqueue({ id: "compact", silent: true });
    q.enqueue({ id: "compact", silent: true });
    expect(q.drain()).toEqual({ id: "compact", silent: true });
    expect(q.drain()).toBeNull();
  });

  it("clear() drops a pending command without surfacing it", () => {
    const q = new SlashCommandQueue();
    q.enqueue({ id: "compact", silent: true });
    q.clear();
    expect(q.hasPending()).toBe(false);
    expect(q.drain()).toBeNull();
  });

  it("preserves silent flag through enqueue/drain", () => {
    const q = new SlashCommandQueue();
    q.enqueue({ id: "compact", silent: false });
    expect(q.drain()?.silent).toBe(false);
    q.enqueue({ id: "compact", silent: true });
    expect(q.drain()?.silent).toBe(true);
  });
});
