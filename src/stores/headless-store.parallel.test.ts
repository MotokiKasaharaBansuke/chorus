/**
 * 20-parallel regression test for the headless store.
 *
 * Pins the reactivity throughput that the Phase 1+ headless engine has
 * to clear in order to claim "20 panes do not melt the UI". This is not
 * a microbenchmark — vitest's wall-clock varies machine-to-machine — but
 * a *regression* gate: a future change that pushes the same workload
 * past the budget should fail CI rather than silently degrading the
 * 20-parallel use case.
 *
 * The threshold is intentionally generous (well above the actual
 * runtime on developer machines, ~tens of ms) so a slow CI runner does
 * not produce false positives. Tighten only if a real regression slips
 * through.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";

import { useHeadlessStore } from "./headless-store";
import type { HeadlessEvent } from "../types/headless";

const TAB_COUNT = 20;
/** Events emitted per tab during the burst. 5 bursts × 20 deltas/burst
 *  = 100 events per tab → 2 000 events overall, comfortably above the
 *  realistic peak of a single Claude turn streaming through the panel. */
const BURSTS_PER_TAB = 5;
const DELTAS_PER_BURST = 20;
/** Wall-clock budget for the full burst on the slowest CI runner. The
 *  measured runtime on a local M-series Mac is single-digit ms; 1 000 ms
 *  is enough headroom for a Linux runner under load. Treat as a
 *  regression alarm, not a tight latency target. */
const WALL_CLOCK_BUDGET_MS = 1_000;

describe("useHeadlessStore — 20-parallel regression", () => {
  beforeEach(() => {
    createRoot((dispose) => {
      useHeadlessStore()._reset();
      dispose();
    });
  });

  it("processes 20 tabs × 100 events under the wall-clock budget", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();

      // Pre-register every tab so the store does not race
      // `ensureSession` inside the hot loop.
      for (let t = 0; t < TAB_COUNT; t++) {
        store.registerSession(`tab-${t}`);
      }

      const start = performance.now();
      for (let burst = 0; burst < BURSTS_PER_TAB; burst++) {
        for (let t = 0; t < TAB_COUNT; t++) {
          const tabId = `tab-${t}`;
          // Each burst is one assistant message (`messageId` stable
          // across the burst, fresh between bursts) — matches how a
          // real Claude turn streams text deltas.
          const messageId = `msg-${t}-${burst}`;
          for (let i = 0; i < DELTAS_PER_BURST; i++) {
            const event: HeadlessEvent = {
              type: "message-delta",
              tabId,
              messageId,
              index: i,
              delta: "x".repeat(16),
            };
            store.applyEvent(event);
          }
          store.applyEvent({
            type: "message-complete",
            tabId,
            messageId,
            finishReason: "stop",
          });
        }
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(WALL_CLOCK_BUDGET_MS);

      // Sanity: every tab has the expected message count and shape.
      for (let t = 0; t < TAB_COUNT; t++) {
        const session = store.sessionFor(`tab-${t}`);
        expect(session).toBeTruthy();
        expect(session!.messages).toHaveLength(BURSTS_PER_TAB);
        for (const msg of session!.messages) {
          expect(msg.role).toBe("assistant");
          if (msg.role === "assistant") {
            // 16 chars per delta × DELTAS_PER_BURST.
            expect(msg.text.length).toBe(16 * DELTAS_PER_BURST);
            expect(msg.streaming).toBe(false);
            expect(msg.finishReason).toBe("stop");
          }
        }
      }

      dispose();
    });
  });

  it("survives an interleaved burst across all tabs without state mixup", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      for (let t = 0; t < TAB_COUNT; t++) {
        store.registerSession(`tab-${t}`);
      }

      // Interleave deltas: one delta per tab, repeat. Stress-tests the
      // store's per-tab routing under cross-tab churn.
      for (let i = 0; i < DELTAS_PER_BURST; i++) {
        for (let t = 0; t < TAB_COUNT; t++) {
          store.applyEvent({
            type: "message-delta",
            tabId: `tab-${t}`,
            messageId: `m-${t}`,
            index: i,
            delta: `t${t}-i${i};`,
          });
        }
      }

      // Each tab should hold exactly one assistant turn whose text is
      // a strict concatenation of its own deltas — no cross-tab bleed.
      for (let t = 0; t < TAB_COUNT; t++) {
        const session = store.sessionFor(`tab-${t}`);
        expect(session?.messages).toHaveLength(1);
        const msg = session!.messages[0]!;
        if (msg.role === "assistant") {
          for (let i = 0; i < DELTAS_PER_BURST; i++) {
            expect(msg.text).toContain(`t${t}-i${i};`);
          }
          // Other tabs' deltas must never appear here.
          for (let other = 0; other < TAB_COUNT; other++) {
            if (other === t) continue;
            expect(msg.text).not.toContain(`t${other}-i0;`);
          }
        }
      }

      dispose();
    });
  });

  it("removes a tab cleanly mid-burst without affecting siblings", () => {
    createRoot((dispose) => {
      const store = useHeadlessStore();
      for (let t = 0; t < TAB_COUNT; t++) {
        store.registerSession(`tab-${t}`);
      }
      // Drop tab-5 mid-flight. Subsequent events targeting tab-5 are
      // re-registered by `ensureSession`, but its prior history is
      // gone — the test asserts that the *other* tabs are unaffected.
      const droppedTab = "tab-5";

      for (let i = 0; i < DELTAS_PER_BURST; i++) {
        if (i === DELTAS_PER_BURST / 2) {
          store.removeSession(droppedTab);
        }
        for (let t = 0; t < TAB_COUNT; t++) {
          const tabId = `tab-${t}`;
          if (tabId === droppedTab) continue;
          store.applyEvent({
            type: "message-delta",
            tabId,
            messageId: `m-${t}`,
            index: i,
            delta: "x",
          });
        }
      }

      expect(store.sessionFor(droppedTab)).toBeUndefined();
      for (let t = 0; t < TAB_COUNT; t++) {
        const tabId = `tab-${t}`;
        if (tabId === droppedTab) continue;
        const session = store.sessionFor(tabId);
        expect(session?.messages).toHaveLength(1);
        const msg = session!.messages[0]!;
        if (msg.role === "assistant") {
          expect(msg.text.length).toBe(DELTAS_PER_BURST);
        }
      }

      dispose();
    });
  });
});
