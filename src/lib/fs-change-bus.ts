import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface FsChangePayload {
  root: string;
  paths: string[];
}

type Listener = (payload: FsChangePayload) => void;

const listeners = new Set<Listener>();
let listenPromise: Promise<UnlistenFn> | null = null;

function ensureListening(): void {
  if (listenPromise) return;
  const p: Promise<UnlistenFn> = listen<FsChangePayload>("fs-change", (event) => {
    for (const fn of listeners) {
      try {
        fn(event.payload);
      } catch (e) {
        console.error("fs-change listener error:", e);
      }
    }
  }).catch((e) => {
    console.error("fs-change listen failed:", e);
    // Allow subsequent subscribers to retry.
    if (listenPromise === p) listenPromise = null;
    throw e;
  });
  listenPromise = p;
}

async function teardownIfIdle(): Promise<void> {
  if (listeners.size > 0) return;
  const p = listenPromise;
  if (!p) return;
  let fn: UnlistenFn;
  try {
    fn = await p;
  } catch {
    // ensureListening already logged and cleared listenPromise.
    return;
  }
  // A new subscriber may have arrived while `listen` was resolving —
  // keep the native listener alive in that case.
  if (listeners.size === 0 && listenPromise === p) {
    listenPromise = null;
    fn();
  }
}

export function subscribeFsChange(listener: Listener): () => void {
  listeners.add(listener);
  ensureListening();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      teardownIfIdle().catch(() => {});
    }
  };
}

/** Test-only reset hook. */
export function __resetFsChangeBusForTests(): void {
  listeners.clear();
  listenPromise = null;
}
