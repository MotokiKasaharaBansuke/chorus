import { listen } from "@tauri-apps/api/event";

type Handler<T> = (payload: T) => void;

/**
 * Global singleton dispatcher for a Tauri event.
 *
 * Maintains a single `listen()` subscription per event type and dispatches
 * each event to the registered handler by ID in O(1). This replaces the
 * previous pattern where every component called `listen()` independently,
 * causing N listeners to wake on every event (N = number of open sessions).
 */
function createDispatcher<T extends { id: string }>(eventName: string) {
  const handlers = new Map<string, Handler<T>>();
  let initialized = false;

  async function ensureInit() {
    if (initialized) return;
    initialized = true;
    try {
      // Tauri registers the IPC channel before resolving, so no events are missed.
      // The returned unlisten fn is intentionally not called — dispatchers live for the app lifetime.
      await listen<T>(eventName, (event) => {
        handlers.get(event.payload.id)?.(event.payload);
      });
    } catch (err: unknown) {
      // Allow the next subscribe() call to retry initialization
      initialized = false;
      console.error(`[event-dispatcher] Failed to initialize listener for "${eventName}":`, err);
    }
  }

  return {
    subscribe(id: string, fn: Handler<T>): () => void {
      ensureInit();
      handlers.set(id, fn);
      return () => handlers.delete(id);
    },
  };
}

export const ptyOutputDispatcher = createDispatcher<{ id: string; data: string }>("pty-output");
export const ptyExitDispatcher = createDispatcher<{ id: string; code: number | null }>("pty-exit");
export const streamEventDispatcher = createDispatcher<{ id: string; data: string }>("stream-event");
