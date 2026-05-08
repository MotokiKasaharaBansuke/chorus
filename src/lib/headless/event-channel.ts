/**
 * Subscribe to a single tab's headless event channel and dispatch into
 * the headless store.
 *
 * The Tauri side emits on `headless:<tabId>:event` (per-tab) plus a
 * sticky `headless:event` blanket channel. Frontend leaves listen to the
 * per-tab name and route through `useHeadlessStore().applyEvent`.
 *
 * Returns an `unsubscribe` function — callers wire it to `onCleanup` so
 * tab destruction tears the listener down promptly.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useHeadlessStore } from "../../stores/headless-store";
import { isHeadlessEvent, type HeadlessEvent, type TabId } from "../../types/headless";

/** Compose the per-tab channel name. Mirrors `session.rs::emit`. */
export function headlessChannelName(tabId: TabId): string {
  return `headless:${tabId}:event`;
}

/**
 * Subscribe to the per-tab channel and forward events into the store.
 *
 * The returned promise resolves to an `unsubscribe` once the listen
 * handle is established. Caller should typically `await` it inside a
 * tab-creation effect:
 *
 *   const off = await subscribeToHeadlessTab(tabId);
 *   onCleanup(off);
 */
export async function subscribeToHeadlessTab(tabId: TabId): Promise<UnlistenFn> {
  const store = useHeadlessStore();
  store.registerSession(tabId);
  return listen<unknown>(headlessChannelName(tabId), (msg) => {
    const payload = msg.payload;
    if (!isHeadlessEvent(payload)) {
      // The CLI may emit a future event shape we don't yet recognize.
      // The Rust side already truncates oversized "unknown" payloads,
      // so the worst case here is a console warning, not a crash.
      console.warn("[headless] dropped malformed event", payload);
      return;
    }
    if (payload.tabId !== tabId) {
      // Per-tab channel should never deliver events for other tabs, but
      // guard against an upstream emit() bug rather than corrupting the
      // wrong session row.
      console.warn("[headless] tabId mismatch on per-tab channel", { expected: tabId, got: payload.tabId });
      return;
    }
    store.applyEvent(payload as HeadlessEvent);
  });
}
