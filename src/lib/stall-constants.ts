/** Milliseconds of no backend events before auto-interrupting a stalled turn. */
export const STREAM_STALL_MS = 20_000;

/** How often the stall detector polls `lastActivityAt`. */
export const STALL_CHECK_INTERVAL_MS = 5_000;

/** User-visible notice appended when a turn is auto-interrupted due to stall. */
export const STALL_INTERRUPTED_MESSAGE =
  `[Auto-interrupted: No response for ${STREAM_STALL_MS / 1000}s. You can send your message again.]`;
