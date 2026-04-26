import { listen } from "@tauri-apps/api/event";

type Handler<T> = (payload: T) => void;

interface BatchSource<T> {
  eventName: string;
  unpack: (payload: unknown) => T[];
}

/** Process batch items in chunks, yielding to the event loop between chunks
 *  so rendering and user input can proceed.  Without this, a large batch
 *  from 2+ concurrent panes blocks the main thread for 10-20ms per event —
 *  enough to starve the browser and cause crashes on resource-limited devices. */
const BATCH_CHUNK_SIZE = 8;

/** Generation counter incremented on each new batch — used to abandon
 *  in-flight chunked processing when a newer batch arrives or the handler
 *  is unsubscribed between ticks. */
let batchGeneration = 0;

function processBatchChunked<T extends { id: string }>(
  items: T[],
  handlers: Map<string, Handler<T>>,
) {
  const gen = ++batchGeneration;
  let i = 0;
  // Reuse a single MessageChannel for all chunks in this batch
  const ch = new MessageChannel();
  function processChunk() {
    if (gen !== batchGeneration) { ch.port1.close(); return; }
    const end = Math.min(i + BATCH_CHUNK_SIZE, items.length);
    while (i < end) {
      handlers.get(items[i].id)?.(items[i]);
      i++;
    }
    if (i < items.length) {
      ch.port2.postMessage(null);
    } else {
      ch.port1.close();
    }
  }
  ch.port1.onmessage = processChunk;
  processChunk();
}

function createDispatcher<T extends { id: string }>(
  eventName: string,
  batchSource?: BatchSource<T>,
) {
  const handlers = new Map<string, Handler<T>>();
  let initialized = false;

  async function ensureInit() {
    if (initialized) return;
    initialized = true;
    try {
      const listeners: Array<Promise<() => void>> = [
        listen<T>(eventName, (event) => {
          handlers.get(event.payload.id)?.(event.payload);
        }),
      ];
      if (batchSource) {
        const src = batchSource;
        listeners.push(
          listen(src.eventName, (event) => {
            const items = src.unpack(event.payload);
            // Increment generation even for small batches so any in-flight
            // chunked processing from a previous large batch is abandoned.
            batchGeneration++;
            if (items.length <= BATCH_CHUNK_SIZE) {
              // Small batch — process synchronously to avoid yielding overhead
              for (const item of items) handlers.get(item.id)?.(item);
            } else {
              processBatchChunked(items, handlers);
            }
          }),
        );
      }
      await Promise.all(listeners);
    } catch (err: unknown) {
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
export const streamEventDispatcher = createDispatcher<{ id: string; data: string }>(
  "stream-event",
  {
    eventName: "stream-event-batch",
    unpack: (payload) => {
      if (!payload || typeof payload !== "object") return [];
      const p = payload as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : "";
      const lines = Array.isArray(p.lines) ? p.lines : [];
      return lines
        .filter((l): l is string => typeof l === "string")
        .map((data) => ({ id, data }));
    },
  },
);
