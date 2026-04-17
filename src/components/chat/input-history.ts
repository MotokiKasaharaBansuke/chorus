/**
 * Pure logic for the chat input's ↑/↓ history feature.
 *
 * History navigation only fires when the arrow key cannot move the caret any
 * further inside the textarea — ↑ on the first visual line, ↓ on the last
 * line (mirrors VS Code's Claude Code extension and shell history). Anywhere
 * else the helper returns `handled: false` so the textarea handles caret
 * movement natively.
 *
 * The first entry into history captures the current input as the draft; a
 * subsequent ↓ past index -1 restores that draft, so a mistaken arrow press
 * never destroys work in progress.
 */

export const MAX_INPUT_HISTORY = 200;
/**
 * Upper bound on a single history entry. Measured in UTF-16 code units
 * (`String.length`), not bytes — a 1 MB paste still gets skipped regardless
 * of encoding. Prevents one oversized entry from pinning ~200× its size in
 * memory once the buffer saturates.
 */
export const MAX_HISTORY_ITEM_LENGTH = 64 * 1024;

export interface HistoryNavInput {
  readonly key: "ArrowUp" | "ArrowDown";
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly historyIdx: number;
  readonly history: readonly string[];
  readonly draft: string;
}

export interface HistoryNavHandled {
  readonly handled: true;
  readonly newValue: string;
  readonly newHistoryIdx: number;
  readonly newDraft: string;
}

export interface HistoryNavSkipped {
  readonly handled: false;
}

export type HistoryNavResult = HistoryNavHandled | HistoryNavSkipped;

const SKIP: HistoryNavSkipped = { handled: false };
// Covers LF, CRLF, and bare CR so pasted content from any platform behaves.
const LINE_BREAK = /[\r\n]/;

function onFirstLine(value: string, selectionStart: number): boolean {
  return !LINE_BREAK.test(value.slice(0, selectionStart));
}

function onLastLine(value: string, selectionEnd: number): boolean {
  return !LINE_BREAK.test(value.slice(selectionEnd));
}

export function navigateHistory(input: HistoryNavInput): HistoryNavResult {
  // Any modifier means the user is asking for system navigation (word jump,
  // document jump, selection extension) — defer to the textarea.
  if (input.shiftKey || input.altKey || input.ctrlKey || input.metaKey) return SKIP;
  if (input.selectionStart !== input.selectionEnd) return SKIP;

  if (input.key === "ArrowUp") {
    if (input.history.length === 0) return SKIP;
    if (!onFirstLine(input.value, input.selectionStart)) return SKIP;
    if (input.historyIdx >= input.history.length - 1) {
      // Already at the oldest entry — swallow the key so the caret stays put
      // and the textarea keeps showing the same message.
      return {
        handled: true,
        newValue: input.value,
        newHistoryIdx: input.historyIdx,
        newDraft: input.draft,
      };
    }
    const nextIdx = input.historyIdx + 1;
    const nextDraft = input.historyIdx === -1 ? input.value : input.draft;
    return {
      handled: true,
      newValue: input.history[nextIdx],
      newHistoryIdx: nextIdx,
      newDraft: nextDraft,
    };
  }

  // ArrowDown
  if (input.historyIdx < 0) return SKIP;
  if (!onLastLine(input.value, input.selectionEnd)) return SKIP;
  const nextIdx = input.historyIdx - 1;
  const nextValue = nextIdx >= 0 ? input.history[nextIdx] : input.draft;
  return {
    handled: true,
    newValue: nextValue,
    newHistoryIdx: nextIdx,
    newDraft: input.draft,
  };
}

/**
 * Returns a new history array with `entry` prepended, or the original array
 * when the entry should be skipped (empty, oversized, or duplicate of the
 * most-recent entry). Caps the total count at `MAX_INPUT_HISTORY`.
 */
export function appendToHistory(
  history: readonly string[],
  entry: string,
): readonly string[] {
  if (!entry) return history;
  if (entry.length > MAX_HISTORY_ITEM_LENGTH) return history;
  if (history[0] === entry) return history;
  const next = [entry, ...history];
  return next.length > MAX_INPUT_HISTORY ? next.slice(0, MAX_INPUT_HISTORY) : next;
}
