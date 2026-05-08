import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from "./headless-persist";
import type { HeadlessSessionState } from "../types/headless";

/**
 * Minimal in-memory `localStorage` shim. Vitest runs under the Node
 * environment (`vite.config.ts` test.environment = "node") which does
 * not provide `localStorage`. The persistence module catches access
 * errors and treats them as "no saved state", so we install a real
 * shim here to exercise the happy paths and the size-cap branch.
 */
function installFakeStorage(): { items: Map<string, string> } {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        return items.has(key) ? items.get(key)! : null;
      },
      setItem(key: string, value: string) {
        items.set(key, value);
      },
      removeItem(key: string) {
        items.delete(key);
      },
    },
  });
  return { items };
}

function uninstallFakeStorage(): void {
  Reflect.deleteProperty(globalThis, "localStorage");
}

function makeSession(
  overrides: Partial<HeadlessSessionState> = {},
): HeadlessSessionState {
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

describe("headless-persist", () => {
  let storage: { items: Map<string, string> };

  beforeEach(() => {
    storage = installFakeStorage();
  });

  afterEach(() => {
    uninstallFakeStorage();
  });

  it("returns null when no session has been saved", () => {
    expect(loadPersistedSession("tab-x")).toBeNull();
  });

  it("round-trips a session through save → load", () => {
    const original = makeSession({
      messages: [{ role: "user", id: "req-1", text: "hi", sentAt: 100 }],
      upstreamSessionId: "claude-abc",
    });
    savePersistedSession(original);
    const restored = loadPersistedSession("tab-1");
    expect(restored).toEqual(original);
  });

  it("namespaces saves by tabId so siblings do not interfere", () => {
    savePersistedSession(makeSession({ tabId: "a", upstreamSessionId: "id-a" }));
    savePersistedSession(makeSession({ tabId: "b", upstreamSessionId: "id-b" }));
    expect(loadPersistedSession("a")?.upstreamSessionId).toBe("id-a");
    expect(loadPersistedSession("b")?.upstreamSessionId).toBe("id-b");
  });

  it("clearPersistedSession removes the entry", () => {
    savePersistedSession(makeSession({ upstreamSessionId: "x" }));
    expect(loadPersistedSession("tab-1")).not.toBeNull();
    clearPersistedSession("tab-1");
    expect(loadPersistedSession("tab-1")).toBeNull();
  });

  it("drops a stale payload whose version field does not match", () => {
    storage.items.set(
      "chorus:headless-session:v1:tab-1",
      JSON.stringify({ version: 99, tabId: "tab-1", state: makeSession() }),
    );
    expect(loadPersistedSession("tab-1")).toBeNull();
    // Stale entry is also evicted so it cannot poison subsequent loads.
    expect(storage.items.has("chorus:headless-session:v1:tab-1")).toBe(false);
  });

  it("drops a payload whose tabId field disagrees with the lookup key", () => {
    storage.items.set(
      "chorus:headless-session:v1:tab-1",
      JSON.stringify({ version: 1, tabId: "tab-2", state: makeSession() }),
    );
    expect(loadPersistedSession("tab-1")).toBeNull();
  });

  it("returns null instead of throwing on corrupted JSON", () => {
    storage.items.set("chorus:headless-session:v1:tab-1", "{not json");
    expect(loadPersistedSession("tab-1")).toBeNull();
  });

  it("normalises a restored thinking status back to idle", () => {
    // A previous process may have crashed mid-turn; loading that state
    // verbatim would lock the input forever because the new process
    // owns no live backend child for the saved `Status::Thinking`.
    savePersistedSession(
      makeSession({ status: "thinking", errorMessage: "stale" }),
    );
    const restored = loadPersistedSession("tab-1");
    expect(restored?.status).toBe("idle");
    expect(restored?.errorMessage).toBeUndefined();
  });

  it("normalises a restored running status back to idle", () => {
    savePersistedSession(makeSession({ status: "running" }));
    expect(loadPersistedSession("tab-1")?.status).toBe("idle");
  });

  it("does not rewrite an idle or error status on restore", () => {
    savePersistedSession(
      makeSession({ status: "error", errorKind: "agent_crashed", errorMessage: "boom" }),
    );
    const restored = loadPersistedSession("tab-1");
    expect(restored?.status).toBe("error");
    expect(restored?.errorMessage).toBe("boom");
  });

  it("evicts the entry when the new payload exceeds the byte cap", () => {
    // Pre-populate so the eviction branch has something to remove.
    savePersistedSession(makeSession({ upstreamSessionId: "old" }));
    expect(loadPersistedSession("tab-1")).not.toBeNull();

    // 600 KiB user message — well above the 500 KiB cap, so the save
    // should drop the existing entry rather than persist a giant blob.
    const huge = "x".repeat(600 * 1024);
    savePersistedSession(
      makeSession({ messages: [{ role: "user", id: "r", text: huge, sentAt: 0 }] }),
    );
    expect(loadPersistedSession("tab-1")).toBeNull();
  });
});

describe("headless-persist (no localStorage)", () => {
  // No fake shim — exercise the "storage absent" path that runs in
  // hardened webviews / private mode where localStorage throws.
  it("loadPersistedSession returns null without throwing", () => {
    expect(loadPersistedSession("tab-x")).toBeNull();
  });

  it("savePersistedSession is a no-op without throwing", () => {
    expect(() => savePersistedSession(makeSession())).not.toThrow();
  });

  it("clearPersistedSession is a no-op without throwing", () => {
    expect(() => clearPersistedSession("tab-1")).not.toThrow();
  });
});
