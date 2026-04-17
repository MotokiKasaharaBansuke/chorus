import { describe, it, expect } from "vitest";
import {
  navigateHistory,
  appendToHistory,
  MAX_INPUT_HISTORY,
  MAX_HISTORY_ITEM_LENGTH,
  type HistoryNavInput,
} from "./input-history";

const HISTORY = ["most recent", "second", "oldest"] as const;

function make(overrides: Partial<HistoryNavInput>): HistoryNavInput {
  return {
    key: "ArrowUp",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    historyIdx: -1,
    history: HISTORY,
    draft: "",
    ...overrides,
  };
}

describe("navigateHistory — cursor position guard", () => {
  it("↑ is skipped when caret sits below the first line", () => {
    // "line1\nline2" with caret after the newline → history must not trigger.
    const result = navigateHistory(make({ value: "line1\nline2", selectionStart: 7, selectionEnd: 7 }));
    expect(result.handled).toBe(false);
  });

  it("↑ triggers when caret is on the first line mid-word", () => {
    const result = navigateHistory(make({ value: "abc", selectionStart: 2, selectionEnd: 2 }));
    expect(result.handled).toBe(true);
    if (result.handled) expect(result.newValue).toBe("most recent");
  });

  it("↓ is skipped when caret sits above the last line", () => {
    // In history (idx=0), user moved caret up into the middle of a multi-line entry.
    const result = navigateHistory(make({
      key: "ArrowDown",
      value: "multi\nline",
      selectionStart: 2,
      selectionEnd: 2,
      historyIdx: 0,
    }));
    expect(result.handled).toBe(false);
  });

  it("↓ triggers when caret sits on the last line", () => {
    const result = navigateHistory(make({
      key: "ArrowDown",
      value: "multi\nline",
      selectionStart: 10,
      selectionEnd: 10,
      historyIdx: 0,
      draft: "typing",
    }));
    expect(result.handled).toBe(true);
    if (result.handled) expect(result.newValue).toBe("typing");
  });

  it("shift+arrow always defers to the textarea (selection extension)", () => {
    const up = navigateHistory(make({ shiftKey: true }));
    const down = navigateHistory(make({ key: "ArrowDown", shiftKey: true, historyIdx: 0 }));
    expect(up.handled).toBe(false);
    expect(down.handled).toBe(false);
  });

  it("alt/ctrl/meta modifiers defer to the textarea (macOS word/line jumps etc.)", () => {
    const alt = navigateHistory(make({ altKey: true }));
    const ctrl = navigateHistory(make({ ctrlKey: true }));
    const meta = navigateHistory(make({ metaKey: true }));
    expect(alt.handled).toBe(false);
    expect(ctrl.handled).toBe(false);
    expect(meta.handled).toBe(false);
  });

  it("active text selection defers to the textarea", () => {
    const result = navigateHistory(make({ value: "abc", selectionStart: 0, selectionEnd: 3 }));
    expect(result.handled).toBe(false);
  });

  it("CRLF line endings are treated as line breaks", () => {
    // Caret after "\r\n" sits on the second visual line — ↑ must not trigger.
    const result = navigateHistory(make({ value: "line1\r\nline2", selectionStart: 8, selectionEnd: 8 }));
    expect(result.handled).toBe(false);
  });

  it("bare CR line endings are treated as line breaks", () => {
    const result = navigateHistory(make({ value: "line1\rline2", selectionStart: 7, selectionEnd: 7 }));
    expect(result.handled).toBe(false);
  });

  it("emoji (surrogate pair) mid-caret does not corrupt first-line detection", () => {
    // "💩a" = 3 UTF-16 units. Caret after the emoji (pos 2) is still on line 1.
    const result = navigateHistory(make({ value: "💩a", selectionStart: 2, selectionEnd: 2 }));
    expect(result.handled).toBe(true);
  });
});

describe("navigateHistory — draft preservation", () => {
  it("captures the draft on the first ↑ entry", () => {
    const result = navigateHistory(make({ value: "in progress", selectionStart: 11, selectionEnd: 11 }));
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newDraft).toBe("in progress");
      expect(result.newHistoryIdx).toBe(0);
      expect(result.newValue).toBe("most recent");
    }
  });

  it("keeps the original draft through successive ↑ presses", () => {
    // Second ↑: already in history (idx=0), draft already captured.
    const result = navigateHistory(make({
      value: "most recent",
      selectionStart: 11,
      selectionEnd: 11,
      historyIdx: 0,
      draft: "in progress",
    }));
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newDraft).toBe("in progress");
      expect(result.newHistoryIdx).toBe(1);
      expect(result.newValue).toBe("second");
    }
  });

  it("restores the draft when ↓ steps back past index 0", () => {
    const result = navigateHistory(make({
      key: "ArrowDown",
      value: "most recent",
      selectionStart: 11,
      selectionEnd: 11,
      historyIdx: 0,
      draft: "in progress",
    }));
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newValue).toBe("in progress");
      expect(result.newHistoryIdx).toBe(-1);
      expect(result.newDraft).toBe("in progress");
    }
  });

  it("accidental ↑ then ↓ round-trips the original draft intact", () => {
    const up = navigateHistory(make({ value: "hello", selectionStart: 5, selectionEnd: 5 }));
    expect(up.handled).toBe(true);
    if (!up.handled) return;

    const down = navigateHistory(make({
      key: "ArrowDown",
      value: up.newValue,
      selectionStart: up.newValue.length,
      selectionEnd: up.newValue.length,
      historyIdx: up.newHistoryIdx,
      draft: up.newDraft,
    }));
    expect(down.handled).toBe(true);
    if (down.handled) expect(down.newValue).toBe("hello");
  });
});

describe("navigateHistory — boundaries", () => {
  it("↑ on an empty history is skipped", () => {
    const result = navigateHistory(make({ history: [] }));
    expect(result.handled).toBe(false);
  });

  it("↑ at the oldest entry is swallowed without advancing", () => {
    const result = navigateHistory(make({
      value: "oldest",
      selectionStart: 6,
      selectionEnd: 6,
      historyIdx: HISTORY.length - 1,
      draft: "draft",
    }));
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newHistoryIdx).toBe(HISTORY.length - 1);
      expect(result.newValue).toBe("oldest");
      expect(result.newDraft).toBe("draft");
    }
  });

  it("↓ outside of history mode is skipped", () => {
    const result = navigateHistory(make({
      key: "ArrowDown",
      value: "typing",
      selectionStart: 6,
      selectionEnd: 6,
      historyIdx: -1,
    }));
    expect(result.handled).toBe(false);
  });
});

describe("appendToHistory", () => {
  it("prepends a new entry", () => {
    const result = appendToHistory(["old"], "new");
    expect(result).toEqual(["new", "old"]);
  });

  it("is a no-op for an empty entry", () => {
    const history = ["a"];
    expect(appendToHistory(history, "")).toBe(history);
  });

  it("dedupes an entry identical to the most-recent one", () => {
    const history = ["same", "other"];
    expect(appendToHistory(history, "same")).toBe(history);
  });

  it("does not dedupe when the duplicate is further back", () => {
    const result = appendToHistory(["other", "same"], "same");
    expect(result).toEqual(["same", "other", "same"]);
  });

  it("skips entries longer than MAX_HISTORY_ITEM_LENGTH (self-defence)", () => {
    const history = ["a"];
    const oversized = "x".repeat(MAX_HISTORY_ITEM_LENGTH + 1);
    expect(appendToHistory(history, oversized)).toBe(history);
  });

  it("caps total count at MAX_INPUT_HISTORY", () => {
    const saturated = Array.from({ length: MAX_INPUT_HISTORY }, (_, i) => `entry-${i}`);
    const result = appendToHistory(saturated, "newest");
    expect(result.length).toBe(MAX_INPUT_HISTORY);
    expect(result[0]).toBe("newest");
    // Oldest entry (entry-${MAX-1}) was dropped.
    expect(result[result.length - 1]).toBe(`entry-${MAX_INPUT_HISTORY - 2}`);
  });
});
