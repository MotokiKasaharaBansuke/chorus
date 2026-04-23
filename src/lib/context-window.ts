/** Fallback context window size used until the CLI reports the actual value
 *  via `modelUsage.contextWindow` in the first `result` event. Conservative
 *  default (200k) ensures auto-compact fires early rather than late for
 *  models whose window size is unknown. */
export const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;
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

/** Ratio threshold for compaction detection. When context tokens drop to
 *  below this fraction of the previous value, it's treated as a compaction
 *  event (e.g. 0.6 = 40%+ drop triggers detection). */
export const COMPACTION_DETECT_RATIO = 0.6;

/** Max chars of user prompt to include in compact command. */
const COMPACT_PROMPT_MAX_CHARS = 200;

/** Build a `/compact` command with context-preservation instructions.
 *
 *  Without this, Claude Code's default compact creates a generic summary that
 *  lacks task-specific details — causing "what should I continue?" responses
 *  when the user types "続けて" (continue) after compact.
 *
 *  When `lastUserPrompt` is provided, it's included so the compact summary
 *  anchors on the actual task the user was working on. */
export function buildCompactCommand(lastUserPrompt?: string): string {
  const parts = [
    "compact",
    "Preserve: current task and its goal,",
    "files being edited with paths,",
    "implementation progress and remaining steps,",
    "any pending decisions or blockers.",
    "Be specific enough that the conversation can resume without asking what to continue.",
  ];
  if (lastUserPrompt) {
    const truncated = lastUserPrompt.length > COMPACT_PROMPT_MAX_CHARS
      ? lastUserPrompt.slice(0, COMPACT_PROMPT_MAX_CHARS) + "..."
      : lastUserPrompt;
    parts.push(`The user's last request was: "${truncated}"`);
  }
  return parts.join(" ");
}
