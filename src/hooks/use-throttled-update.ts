import { onCleanup } from "solid-js";
import type { ChatMessage } from "../types";

/** Minimum interval (ms) between DOM updates during streaming. ~20fps is
 *  sufficient for streaming text and keeps the UI responsive even with 20
 *  panes streaming simultaneously — above the ~24fps perception threshold
 *  while halving CPU load compared to 32ms. */
const DOM_UPDATE_THROTTLE_MS = 48;

interface ThrottledUpdateOptions {
  /** Called to apply a new message snapshot to the UI. */
  onApply: (msgs: ChatMessage[]) => void;
  /** When false, skip updates entirely (hidden tab optimisation).
   *  Events received while inactive are silently discarded — the caller is
   *  responsible for flushing the latest state on re-activation (e.g. by
   *  reading `parser.getMessages()` when `isActive` transitions to true). */
  isActive: () => boolean;
  /** Return true after the component is disposed to prevent post-unmount writes. */
  isDisposed: () => boolean;
}

/** Leading-edge + trailing-edge throttle for parser → DOM updates.
 *
 *  - **Leading**: the first event after the throttle window passes is applied
 *    immediately so the UI feels responsive.
 *  - **Trailing**: a deferred timer ensures the final state always reaches the
 *    UI even if no further events arrive within the window.
 *  - **Disposed guard**: both paths bail out if the component has unmounted,
 *    preventing writes to disposed SolidJS signals.
 *
 *  Returns an object with `handleUpdate` (the parser.onUpdate callback) and
 *  `reset` (call when the underlying PTY changes to clear stale state). */
export function useThrottledUpdate(options: ThrottledUpdateOptions) {
  let lastAppliedAt = -Infinity;
  let deferredMessages: ChatMessage[] | null = null;
  let trailingTimerId: ReturnType<typeof setTimeout> | null = null;

  function clearTrailingTimer() {
    if (trailingTimerId !== null) {
      clearTimeout(trailingTimerId);
      trailingTimerId = null;
    }
  }

  function handleUpdate(msgs: ChatMessage[]) {
    if (!options.isActive() || options.isDisposed()) return;

    const now = performance.now();
    const elapsed = now - lastAppliedAt;

    if (elapsed >= DOM_UPDATE_THROTTLE_MS) {
      lastAppliedAt = now;
      deferredMessages = null;
      clearTrailingTimer();
      options.onApply(msgs);
    } else {
      deferredMessages = msgs;
      if (trailingTimerId === null) {
        trailingTimerId = setTimeout(() => {
          trailingTimerId = null;
          if (options.isDisposed() || !options.isActive()) {
            deferredMessages = null;
            return;
          }
          if (deferredMessages) {
            lastAppliedAt = performance.now();
            const pending = deferredMessages;
            deferredMessages = null;
            options.onApply(pending);
          }
        }, Math.max(0, DOM_UPDATE_THROTTLE_MS - elapsed));
      }
    }
  }

  /** Clear stale throttle state — call when the underlying PTY changes so
   *  the first event from the new session is never delayed by a leftover
   *  timestamp from the old one. */
  function reset() {
    lastAppliedAt = -Infinity;
    deferredMessages = null;
    clearTrailingTimer();
  }

  onCleanup(clearTrailingTimer);

  return { handleUpdate, reset };
}
