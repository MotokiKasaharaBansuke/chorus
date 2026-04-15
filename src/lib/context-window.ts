export const CONTEXT_WINDOW_SIZE = 200_000;
export const AUTO_COMPACT_THRESHOLD = 0.9;
export const AUTO_COMPACT_RESET_THRESHOLD = 0.5;
export const CONTEXT_WARN_THRESHOLD = 0.8;

export function contextColor(pct: number): string {
  if (pct >= AUTO_COMPACT_THRESHOLD) return "#c74e39";
  if (pct >= CONTEXT_WARN_THRESHOLD) return "#e8587a";
  if (pct >= AUTO_COMPACT_RESET_THRESHOLD) return "#e1c08d";
  return "#3fb950";
}

/** Returns true when auto-compact should fire.
 *  Pure — no side effects; caller is responsible for debouncing via triggered flag. */
export function shouldAutoCompact(pct: number, isStreaming: boolean, triggered: boolean): boolean {
  return pct >= AUTO_COMPACT_THRESHOLD && !isStreaming && !triggered;
}
