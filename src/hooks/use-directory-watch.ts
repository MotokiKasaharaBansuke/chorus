import { createEffect, onCleanup } from "solid-js";
import { subscribeFsChange } from "../lib/fs-change-bus";
import { parentDir } from "../lib/path-utils";

const TRAILING_DEBOUNCE_MS = 120;

interface WatchOptions {
  dir: () => string | undefined;
  onDirectoryChanged: () => void;
}

/**
 * Subscribe to `fs-change` events and invoke `onDirectoryChanged`
 * when any emitted path is a direct child of `dir`.
 *
 * Events are trailing-debounced to coalesce editor-save bursts
 * (swap files, atomic rename + delete).
 *
 * This hook does not start a native watcher — it only consumes events
 * emitted by the single global watcher owned by `Sidebar`
 * (see `watchDirectory` in `sidebar.tsx`). Multiple consumers share that
 * one Rust-side recursive watcher and filter client-side.
 */
export function useDirectoryWatch(options: WatchOptions): void {
  createEffect(() => {
    const dir = options.dir();
    if (!dir) return;

    let pending: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        options.onDirectoryChanged();
      }, TRAILING_DEBOUNCE_MS);
    };

    const unsubscribe = subscribeFsChange((payload) => {
      if (payload.paths.some((p) => parentDir(p) === dir)) {
        schedule();
      }
    });

    onCleanup(() => {
      if (pending !== null) clearTimeout(pending);
      unsubscribe();
    });
  });
}
