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
  HeadlessSessionState,
  TabId,
  UsageReport,
} from "../types/headless";

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

function ensureSession(tabId: TabId): void {
  if (store.sessions[tabId]) return;
  setStore("sessions", tabId, {
    tabId,
    status: "idle",
    messages: [],
    usage: { ...ZERO_USAGE },
  });
}

/** Register a session row with default state. Idempotent. */
function registerSession(tabId: TabId): void {
  ensureSession(tabId);
}

/** Drop a session and its accumulated state. */
function removeSession(tabId: TabId): void {
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
function appendUserMessage(tabId: TabId, requestId: string, text: string): void {
  ensureSession(tabId);
  setStore(
    produce((s) => {
      s.sessions[tabId]?.messages.push({
        role: "user",
        id: requestId,
        text,
        sentAt: Date.now(),
      });
    }),
  );
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
}

/**
 * Reset the entire store. Test-only — call sites in production should
 * use `removeSession` per tab.
 */
function _reset(): void {
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
    _reset,
  } as const;
}
