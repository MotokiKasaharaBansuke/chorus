/**
 * localStorage-backed persistence for `HeadlessSessionState`.
 *
 * The backend `Session` is process-scoped — every chorus restart loses
 * the in-memory `HeadlessManager` and the live claude child. This module
 * keeps just enough state on disk that the next launch can:
 *
 * - render the prior message history immediately on panel mount, and
 * - re-spawn the backend session with `resumeSessionAt = upstreamSessionId`
 *   so claude continues the conversation rather than starting fresh.
 *
 * We deliberately use `localStorage` rather than the Tauri filesystem:
 * the dataset is small (handful of MB at most), the API is synchronous
 * (matches SolidJS reactivity), and it survives app restart without
 * touching the Rust side. If a user clears the WebView origin storage
 * the conversation history is lost — that is acceptable; the upstream
 * `claude` session file under `~/.claude/projects/` is still authoritative
 * for the *content*, this layer is just for chorus's own UI state.
 *
 * Schema is versioned so a future field rename can drop incompatible
 * payloads cleanly instead of throwing inside `applyEvent`.
 */

import type { HeadlessSessionState, TabId } from "../types/headless";

const STORAGE_PREFIX = "chorus:headless-session:v1:";
/** Outer payload size cap. Generous (500 KiB) but bounded so a single
 *  rogue session cannot silently exhaust the per-origin quota. */
const MAX_PAYLOAD_BYTES = 500 * 1024;

interface PersistedEnvelope {
  version: 1;
  tabId: TabId;
  state: HeadlessSessionState;
}

function storageKey(tabId: TabId): string {
  return `${STORAGE_PREFIX}${tabId}`;
}

/** Read and parse the saved state for `tabId`, if any. */
export function loadPersistedSession(
  tabId: TabId,
): HeadlessSessionState | null {
  try {
    const raw = localStorage.getItem(storageKey(tabId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (parsed.version !== 1 || parsed.tabId !== tabId || !parsed.state) {
      // Stale or future-incompatible payload — drop it so a clean
      // session takes over rather than crashing in `applyEvent`.
      localStorage.removeItem(storageKey(tabId));
      return null;
    }
    return sanitizeRestoredState(parsed.state);
  } catch {
    // Quota error / corrupted JSON / disabled storage. Treat all of
    // these as "no saved state" so the panel renders normally.
    return null;
  }
}

/**
 * Normalise any state field that cannot logically survive an app
 * restart. Today that is just the lifecycle status: a previous
 * process may have crashed mid-turn with `status="thinking"` or
 * `"running"`, but the new process owns no live child for that tab,
 * so showing the user a busy spinner indefinitely would deadlock the
 * input. Coercing to `"idle"` lets `ensureBackendSession` re-spawn
 * cleanly and keeps the input gating honest.
 */
function sanitizeRestoredState(
  state: HeadlessSessionState,
): HeadlessSessionState {
  if (state.status !== "thinking" && state.status !== "running") {
    return state;
  }
  return {
    ...state,
    status: "idle",
    errorKind: undefined,
    errorMessage: undefined,
  };
}

/**
 * Persist `state` for `tabId`. No-op when serialisation fails or the
 * payload exceeds the per-tab byte cap (running over silently would
 * leave the user with a stale session id from earlier).
 */
export function savePersistedSession(state: HeadlessSessionState): void {
  const envelope: PersistedEnvelope = {
    version: 1,
    tabId: state.tabId,
    state,
  };
  let serialised: string;
  try {
    serialised = JSON.stringify(envelope);
  } catch {
    return;
  }
  if (serialised.length > MAX_PAYLOAD_BYTES) {
    // Rather than truncate (which would corrupt the message stream),
    // drop the saved entry so the next launch starts fresh. A future
    // pass can compact long messages instead.
    try {
      localStorage.removeItem(storageKey(state.tabId));
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    localStorage.setItem(storageKey(state.tabId), serialised);
  } catch {
    // Quota / disabled storage. There is no good recovery path; the
    // next mutation will simply retry.
  }
}

/** Remove the saved state for `tabId`. Called on tab close so the
 *  localStorage footprint stays bounded by the live tab count. */
export function clearPersistedSession(tabId: TabId): void {
  try {
    localStorage.removeItem(storageKey(tabId));
  } catch {
    /* ignore */
  }
}
