import { listen } from "@tauri-apps/api/event";

type Handler<T> = (payload: T) => void;

interface BatchSource<T> {
  eventName: string;
  unpack: (payload: unknown) => T[];
}

function createBatchUnpack(
  field: string,
): (payload: unknown) => Array<{ id: string; data: string }> {
  return (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const p = payload as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : "";
    const items = Array.isArray(p[field]) ? (p[field] as unknown[]) : [];
    return items
      .filter((v): v is string => typeof v === "string")
      .map((data) => ({ id, data }));
  };
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
            for (const item of src.unpack(event.payload)) {
              handlers.get(item.id)?.(item);
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

export const ptyOutputDispatcher = createDispatcher<{ id: string; data: string }>(
  "pty-output",
  { eventName: "pty-output-batch", unpack: createBatchUnpack("chunks") },
);
export const ptyExitDispatcher = createDispatcher<{ id: string; code: number | null }>("pty-exit");
export const streamEventDispatcher = createDispatcher<{ id: string; data: string }>(
  "stream-event",
  { eventName: "stream-event-batch", unpack: createBatchUnpack("lines") },
);
