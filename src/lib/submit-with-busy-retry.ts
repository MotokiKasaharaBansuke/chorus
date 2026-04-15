/**
 * Busy-retry policy for CLI send operations.
 *
 * Background: the Rust-side `running_since` lock is cleared by an RAII guard
 * when the reader thread exits. Between the CLI's final `result` event and
 * the guard drop there is a short window (~50–300ms on typical hardware)
 * where `send_message` returns `StreamSessionBusy`. A rarer failure mode is
 * the CLI genuinely hanging — then `running_since` never clears and every
 * send fails forever. This helper handles both: silent backoff for the
 * transient race, then a force kill+respawn fallback.
 */

/** Outcome of a single send attempt, mirroring the wire-level protocol. */
export type SendOutcome = "sent" | "busy" | "error";

/** Total retry budget covers ~3s (6 × 500ms) — 99th percentile of the
 *  observed end-of-turn race window. Beyond this the CLI is assumed stuck. */
export const MAX_BUSY_RETRIES = 6;
export const BUSY_RETRY_DELAY_MS = 500;

export interface SubmitWithBusyRetryDeps {
  /** Performs a single send. Returns "busy" to request retry, "error" to
   *  abort, "sent" on success (spinner stays on — CLI now owns the turn). */
  send: () => Promise<SendOutcome>;
  /** Called exactly once, after all retries are exhausted, to recover a
   *  stuck session. Failure is silently swallowed; the follow-up `send` will
   *  hit the `not_found` path which triggers a respawn. */
  forceReset: () => Promise<void>;
  /** Delay between retries. Injected for testability. */
  sleep: (ms: number) => Promise<void>;
  /** Returns true if the caller has been torn down (tab closed) or the user
   *  interrupted. When true, the helper exits without further side effects. */
  isCancelled: () => boolean;
  /** Hook invoked right before force-reset so the UI can post a user-visible
   *  notice. Called at most once per submission. */
  onForceReset?: () => void;
  /** Hook invoked when the final fallback send also fails, so the UI can
   *  post an error notice. */
  onResetFailed?: () => void;
}

/** Result of the submission: whether the CLI accepted the message, or how it
 *  failed. The caller uses this to decide whether to turn the spinner off. */
export type SubmitResult = "sent" | "error" | "cancelled";

/**
 * Send a message, silently retrying on transient "busy" and force-resetting
 * a stuck session before giving up.
 *
 * - "sent": CLI accepted the message; spinner stays on
 * - "error": send failed deterministically; caller should turn spinner off
 * - "cancelled": caller was torn down mid-flight; no further work should run
 */
export async function submitWithBusyRetry(deps: SubmitWithBusyRetryDeps): Promise<SubmitResult> {
  for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt++) {
    if (deps.isCancelled()) return "cancelled";
    const result = await deps.send();
    if (result === "sent") return "sent";
    if (result === "error") return "error";
    // busy: wait and retry
    await deps.sleep(BUSY_RETRY_DELAY_MS);
  }

  if (deps.isCancelled()) return "cancelled";

  // Retries exhausted — CLI is likely stuck. Force kill and let the next
  // send hit the respawn path. Swallow forceReset failures so a broken kill
  // still lets us attempt the fallback send (often the CLI is already dead).
  deps.onForceReset?.();
  try {
    await deps.forceReset();
  } catch { /* best-effort — proceed to fallback send */ }
  if (deps.isCancelled()) return "cancelled";

  const retried = await deps.send();
  if (retried === "sent") return "sent";

  deps.onResetFailed?.();
  return "error";
}
