import { describe, it, expect, beforeEach } from "vitest";
import { useUsageStore } from "./usage-store";

describe("usage-store", () => {
  const store = useUsageStore();

  beforeEach(() => {
    for (const tab of store.tabs) {
      store.removeTab(tab.tabId);
    }
  });

  it("starts with empty summary", () => {
    const s = store.summary;
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalInputTokens).toBe(0);
    expect(s.totalOutputTokens).toBe(0);
    expect(s.totalTurns).toBe(0);
    expect(s.tabs).toHaveLength(0);
  });

  it("tracks a single tab", () => {
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Claude 1",
      cliType: "claude-code",
      costUsd: 0.005,
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 1,
    });

    const s = store.summary;
    expect(s.totalCostUsd).toBe(0.005);
    expect(s.totalInputTokens).toBe(100);
    expect(s.totalOutputTokens).toBe(50);
    expect(s.totalTurns).toBe(1);
    expect(s.tabs).toHaveLength(1);
  });

  it("aggregates multiple tabs", () => {
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Claude 1",
      cliType: "claude-code",
      costUsd: 0.01,
      inputTokens: 200,
      outputTokens: 100,
      turnCount: 2,
    });
    store.updateTabUsage({
      tabId: "t2",
      tabTitle: "Codex 1",
      cliType: "codex",
      costUsd: 0.02,
      inputTokens: 300,
      outputTokens: 150,
      turnCount: 3,
    });

    const s = store.summary;
    expect(s.totalCostUsd).toBe(0.03);
    expect(s.totalInputTokens).toBe(500);
    expect(s.totalOutputTokens).toBe(250);
    expect(s.totalTurns).toBe(5);
    expect(s.tabs).toHaveLength(2);
  });

  it("overwrites tab on update", () => {
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Claude 1",
      cliType: "claude-code",
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 1,
    });
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Claude 1",
      cliType: "claude-code",
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 250,
      turnCount: 5,
    });

    const s = store.summary;
    expect(s.totalCostUsd).toBe(0.05);
    expect(s.totalInputTokens).toBe(500);
    expect(s.tabs).toHaveLength(1);
  });

  it("removes tab", () => {
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Claude 1",
      cliType: "claude-code",
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      turnCount: 1,
    });

    store.removeTab("t1");
    expect(store.summary.tabs).toHaveLength(0);
    expect(store.summary.totalCostUsd).toBe(0);
  });

  it("removing non-existent tab is safe", () => {
    store.removeTab("non-existent");
    expect(store.summary.tabs).toHaveLength(0);
  });

  it("rounds accumulated costs to avoid floating-point artifacts", () => {
    store.updateTabUsage({
      tabId: "t1",
      tabTitle: "Tab 1",
      cliType: "claude-code",
      costUsd: 0.1,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 1,
    });
    store.updateTabUsage({
      tabId: "t2",
      tabTitle: "Tab 2",
      cliType: "claude-code",
      costUsd: 0.2,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 1,
    });

    expect(store.summary.totalCostUsd).toBe(0.3);
  });
});
