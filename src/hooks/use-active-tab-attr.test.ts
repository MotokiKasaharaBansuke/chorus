import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Tab } from "../types";

const effects: Array<() => void> = [];
const cleanups: Array<() => void> = [];
vi.mock("solid-js", () => ({
  createSignal: <T,>(initial: T) => {
    let value: T = initial;
    const getter = () => value;
    const setter = (next: T | ((prev: T) => T)) => {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      return value;
    };
    return [getter, setter];
  },
  createEffect: (fn: () => void) => effects.push(fn),
  onCleanup: (fn: () => void) => cleanups.push(fn),
}));

import { useActiveTabAttr } from "./use-active-tab-attr";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    title: "t",
    status: "waiting",
    cliConfig: { cliType: "claude-code", mode: "default", workingDir: "/repo" },
    ...overrides,
  };
}

function flushEffects() {
  for (const fn of effects.splice(0, effects.length)) fn();
}

function runCleanups() {
  for (const fn of cleanups.splice(0, cleanups.length)) fn();
}

describe("useActiveTabAttr", () => {
  beforeEach(() => {
    effects.length = 0;
    cleanups.length = 0;
  });
  afterEach(() => {
    effects.length = 0;
    cleanups.length = 0;
  });

  it("returns null when no active tab", () => {
    const resolve = vi.fn();
    const attr = useActiveTabAttr<string>({
      activeTab: () => null,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    expect(attr()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns the cached value when `pick` yields a value", () => {
    const resolve = vi.fn();
    const tab = makeTab({
      worktree: { path: "/w", branch: "feat/x", headSha: "abc", repoRoot: "/repo" },
    });
    const attr = useActiveTabAttr<string>({
      activeTab: () => tab,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    expect(attr()).toBe("feat/x");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves from workingDir when no cached value", async () => {
    const resolve = vi.fn(async () => "main");
    const tab = makeTab();
    const attr = useActiveTabAttr<string>({
      activeTab: () => tab,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledWith("/repo");
    expect(attr()).toBe("main");
  });

  it("swallows resolver errors and yields null", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });
    const tab = makeTab();
    const attr = useActiveTabAttr<string>({
      activeTab: () => tab,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    await Promise.resolve();
    await Promise.resolve();
    expect(attr()).toBeNull();
  });

  it("discards a stale resolve() result after cleanup (tab switched)", async () => {
    let resolveFirst: ((v: string | null) => void) | undefined;
    const resolve = vi.fn((_dir: string) =>
      new Promise<string | null>((r) => { resolveFirst = r; })
    );
    const tab = makeTab();
    const attr = useActiveTabAttr<string>({
      activeTab: () => tab,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    runCleanups();
    resolveFirst?.("stale-branch");
    await Promise.resolve();
    expect(attr()).toBeNull();
  });

  it("returns null when workingDir is empty", () => {
    const resolve = vi.fn();
    const tab = makeTab({ cliConfig: { cliType: "claude-code", mode: "default", workingDir: "" } });
    const attr = useActiveTabAttr<string>({
      activeTab: () => tab,
      pick: (t) => t.worktree?.branch,
      resolve,
    });
    flushEffects();
    expect(attr()).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
