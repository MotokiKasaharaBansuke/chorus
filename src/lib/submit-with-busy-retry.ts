/**
 * Event-driven retry policy for CLI send operations.
 *
 * With the guard-before-event fix (guard is dropped before turn_complete is
 * emitted), the transient "busy" race window no longer exists for normal
 * turn completion. The only remaining case where "busy" can occur is when
 * the user interrupts (Escape) and immediately sends a new message before
 * the SIGTERM-ed process has exited and the reader thread has dropped the
 * guard. This helper handles that by waiting for the turn to settle
 * (turn_complete event) before retrying once — no polling, no force-kill.
 */

/** Outcome of a single send attempt, mirroring the wire-level protocol. */
export type SendOutcome = "sent" | "busy" | "error";

export interface SubmitWithBusyRetryDeps {
  /** Performs a single send. Returns "busy" to request retry, "error" to
   *  abort, "sent" on success (spinner stays on — CLI now owns the turn). */
  send: () => Promise<SendOutcome>;
  /** Wait for the current turn to complete (turn_complete event from the
   *  parser). Resolves when idle, rejects on timeout. */
  waitForIdle: () => Promise<void>;
  /** Returns true if the caller has been torn down (tab closed) or the user
   *  interrupted. When true, the helper exits without further side effects. */
  isCancelled: () => boolean;
  /** Hook invoked when the retry send also fails, so the UI can post an
   *  error notice. */
  onResetFailed?: () => void;
}

/** Result of the submission: whether the CLI accepted the message, or how it
 *  failed. The caller uses this to decide whether to turn the spinner off. */
export type SubmitResult = "sent" | "error" | "cancelled";

/**
 * Send a message, waiting for the previous turn to settle if busy, then
 * retrying once.
 *
 * - "sent": CLI accepted the message; spinner stays on
 * - "error": send failed deterministically; caller should turn spinner off
 * - "cancelled": caller was torn down mid-flight; no further work should run
 */
export async function submitWithBusyRetry(deps: SubmitWithBusyRetryDeps): Promise<SubmitResult> {
  const result = await deps.send();
  if (result === "sent") return "sent";
  if (result === "error") return "error";
  if (deps.isCancelled()) return "cancelled";

  // busy: wait for the previous turn to settle, then retry once
  try { await deps.waitForIdle(); } catch { /* timeout — retry anyway */ }
  if (deps.isCancelled()) return "cancelled";

  const retry = await deps.send();
  if (retry === "sent") return "sent";

  deps.onResetFailed?.();
  return "error";
}
