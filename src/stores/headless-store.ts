/**
 * SolidJS store for headless agent sessions.
 *
 * One entry per `tabId`. Receives `HeadlessEvent`s from the per-tab Tauri
 * channel (wired up in `lib/headless/event-channel.ts`) and folds them
 * into a per-session view model the components can render.
 *
 * Mirrors the pattern of `usage-store.ts`: `produce()` for batched
 * mutation, single `useHeadlessStore()` accessor exporting both readers
 * and mutators.
 */

import { createStore, produce } from "solid-js/store";

import type {
  HeadlessEvent,
  HeadlessMessage,
  HeadlessSessionState,
  TabId,
  UsageReport,
} from "../types/headless";
import {
  clearPersistedSession,
  loadPersistedSession,
  savePersistedSession,
} from "./headless-persist";

interface HeadlessState {
  sessions: Record<TabId, HeadlessSessionState>;
}

const ZERO_USAGE: UsageReport = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const [store, setStore] = createStore<HeadlessState>({ sessions: {} });

/**
 * Per-tab debounced writer to localStorage. Coalesces a burst of
 * events (text deltas during streaming) into a single save 200 ms
 * after the last mutation, so we do not run the JSON serialiser on
 * every keystroke-sized delta.
 */
const PERSIST_DEBOUNCE_MS = 200;
const persistTimers = new Map<TabId, ReturnType<typeof setTimeout>>();

function persistTab(tabId: TabId): void {
  const existing = persistTimers.get(tabId);
  if (existing !== undefined) clearTimeout(existing);
  // Use the bare global `setTimeout` (not `window.setTimeout`) so the
  // module loads in the Node-based vitest environment too — the unit
  // tests run without a browser global.
  const handle = setTimeout(() => {
    persistTimers.delete(tabId);
    const session = store.sessions[tabId];
    if (session) savePersistedSession(session);
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(tabId, handle);
}

/**
 * Flush every pending debounced save synchronously. Call this from
 * the window `beforeunload` handler so a `Cmd+Q` or system shutdown
 * does not lose the last 200 ms of message-delta or the freshest
 * `upstreamSessionId` — without it, the next launch would resume the
 * conversation against a stale claude session id and the histories
 * would diverge.
 */
function flushAllPersist(): void {
  for (const [tabId, handle] of persistTimers) {
    clearTimeout(handle);
    const session = store.sessions[tabId];
    if (session) savePersistedSession(session);
  }
  persistTimers.clear();
}

function ensureSession(tabId: TabId): void {
  if (store.sessions[tabId]) return;
  // Hydrate from localStorage so a freshly-mounted panel after app
  // restart shows prior messages immediately, before the first
  // backend event arrives. `loadPersistedSession` returns `null` for
  // tabs we have not seen before — falling through to a clean state.
  const persisted = loadPersistedSession(tabId);
  setStore(
    "sessions",
    tabId,
    persisted ?? {
      tabId,
      status: "idle",
      messages: [],
      usage: { ...ZERO_USAGE },
    },
  );
}

/** Register a session row with default state. Idempotent. */
function registerSession(tabId: TabId): void {
  ensureSession(tabId);
}

/** Drop a session and its accumulated state. Also clears persisted
 *  storage so a closed tab does not occupy localStorage indefinitely
 *  and cancels any in-flight debounced save so a zombie writer
 *  cannot resurrect the entry after removal. */
function removeSession(tabId: TabId): void {
  const pending = persistTimers.get(tabId);
  if (pending !== undefined) {
    clearTimeout(pending);
    persistTimers.delete(tabId);
  }
  clearPersistedSession(tabId);
  setStore(
    produce((s) => {
      delete s.sessions[tabId];
    }),
  );
}

/**
 * Append a freshly-sent user message. Called from the chat input
 * component as soon as the user clicks "send", before the assistant
 * starts streaming. Carries the Chorus-side `requestId` so future
 * correlation work (Phase 1e) can pair it with the assistant turn.
 */
function appendUserMessage(
  tabId: TabId,
  requestId: string,
  text: string,
  images: ReadonlyArray<{ path: string; name: string }> = [],
): void {
  ensureSession(tabId);
  setStore(
    produce((s) => {
      const session = s.sessions[tabId];
      if (!session) return;
      session.messages.push({
        role: "user",
        id: requestId,
        text,
        sentAt: Date.now(),
        // Only carry the field when there is at least one image —
        // keeps legacy localStorage snapshots that pre-date image
        // support strictly equal to their adapted form, and avoids a
        // useless empty array on every text-only turn.
        ...(images.length > 0 ? { images: [...images] } : {}),
      });
      // Optimistic transition to "thinking" so the input gates
      // immediately, before the real `Status::Thinking` event arrives
      // through the Tauri IPC channel. Without this, a quick double
      // Enter races the channel and the second send hits the backend
      // `SendError::Busy` guard. Only flip from idle — never override
      // an existing error/running state.
      if (session.status === "idle") {
        session.status = "thinking";
        session.errorKind = undefined;
        session.errorMessage = undefined;
      }
    }),
  );
  persistTab(tabId);
}

/**
 * Replace the session's message list and upstream session id wholesale.
 * Used when the user picks a past JSONL via the session picker — the
 * UI must show the historical turns immediately and subsequent live
 * turns must `--resume` against the matching upstream id.
 *
 * Resets transient fields (`status`, `errorKind`, `errorMessage`,
 * `rateLimit`, `usage`) so a previously errored session does not
 * bleed its trailing system row or stale usage banner into the
 * freshly-loaded conversation.
 *
 * Caller-owned messages: the array is shallow-copied but inner
 * `HeadlessMessage` / `HeadlessToolCall` objects are shared by
 * reference. Callers must not mutate values they have handed in.
 */
function hydrateMessages(
  tabId: TabId,
  messages: HeadlessMessage[],
  upstreamSessionId: string | undefined,
): void {
  ensureSession(tabId);
  setStore(
    produce((s) => {
      const session = s.sessions[tabId];
      if (!session) return;
      session.messages = [...messages];
      session.upstreamSessionId = upstreamSessionId;
      session.status = "idle";
      session.errorKind = undefined;
      session.errorMessage = undefined;
      session.rateLimit = undefined;
      session.usage = { ...ZERO_USAGE };
    }),
  );
  persistTab(tabId);
}

/**
 * Apply one wire event to the matching session row.
 *
 * Unknown event types short-circuit to a `console.warn` rather than
 * throwing — fail-soft so a future CLI version that ships a new event
 * type cannot break the active session.
 */
function applyEvent(event: HeadlessEvent): void {
  ensureSession(event.tabId);
  setStore(
    produce((s) => {
      const session = s.sessions[event.tabId];
      if (!session) return;
      switch (event.type) {
        case "session-id": {
          session.upstreamSessionId = event.sessionId;
          break;
        }
        case "message-delta": {
          const last = session.messages[session.messages.length - 1];
          if (last?.role === "assistant" && last.id === event.messageId) {
            last.text += event.delta;
          } else {
            session.messages.push({
              role: "assistant",
              id: event.messageId,
              text: event.delta,
              toolCalls: [],
              streaming: true,
            });
          }
          if (session.status === "idle") session.status = "thinking";
          break;
        }
        case "message-complete": {
          const target = session.messages.find(
            (m) => m.role === "assistant" && m.id === event.messageId,
          );
          if (target && target.role === "assistant") {
            target.streaming = false;
            target.finishReason = event.finishReason;
          }
          if (session.status !== "error") session.status = "idle";
          break;
        }
        case "tool-use": {
          const target = session.messages.find(
            (m) => m.role === "assistant" && m.id === event.messageId,
          );
          if (target && target.role === "assistant") {
            target.toolCalls.push({
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
            });
          }
          if (session.status !== "error") session.status = "running";
          break;
        }
        case "tool-result": {
          for (const msg of session.messages) {
            if (msg.role !== "assistant") continue;
            const call = msg.toolCalls.find((c) => c.toolUseId === event.toolUseId);
            if (call) {
              call.result = { output: event.output, isError: event.isError };
              break;
            }
          }
          break;
        }
        case "usage": {
          session.usage = event.usage;
          break;
        }
        case "status": {
          session.status = event.status;
          session.errorKind = event.errorKind;
          session.errorMessage = event.message;
          break;
        }
        case "rate-limit": {
          session.rateLimit = event.detail;
          break;
        }
        case "unknown": {
          console.warn("[headless] unknown event ignored", event);
          break;
        }
      }
    }),
  );
  // `unknown` is the only event we don't bother persisting after —
  // its payload is opaque and wouldn't change rendered state anyway.
  if (event.type !== "unknown") {
    persistTab(event.tabId);
  }
}

/**
 * Reset the entire store. Test-only — call sites in production should
 * use `removeSession` per tab.
 */
function _reset(): void {
  for (const handle of persistTimers.values()) clearTimeout(handle);
  persistTimers.clear();
  setStore({ sessions: {} });
}

/**
 * Public store accessor. Frontend leaves call this rather than touching
 * `setStore` directly so all mutation paths stay in this file.
 */
export function useHeadlessStore() {
  return {
    sessions: store.sessions,
    sessionFor: (tabId: TabId) => store.sessions[tabId],
    registerSession,
    removeSession,
    appendUserMessage,
    applyEvent,
    hydrateMessages,
    flushAllPersist,
    _reset,
  } as const;
}
