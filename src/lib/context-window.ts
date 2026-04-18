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

/** Command string for `/compact` with context-preservation instructions.
 *
 *  Without this, Claude Code's default compact creates a generic summary that
 *  lacks task-specific details — causing "what should I continue?" responses
 *  when the user types "続けて" (continue) after compact. */
export const COMPACT_COMMAND = [
  "compact",
  "Preserve: current task and its goal,",
  "files being edited with paths,",
  "implementation progress and remaining steps,",
  "any pending decisions or blockers.",
  "Be specific enough that the conversation can resume without asking what to continue.",
].join(" ");
