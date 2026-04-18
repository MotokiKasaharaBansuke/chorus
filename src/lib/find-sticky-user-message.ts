import type { ChatMessage } from "../types";

/** Minimal virtualizer item shape needed for sticky header calculation. */
interface VirtualItem {
  index: number;
  start: number;
}

/**
 * Find the last user message whose position has scrolled past the top of the
 * scroll container. Returns the message, or null if none has scrolled past.
 *
 * This is a pure function with no DOM dependency — positions come from the
 * virtualizer, making it easy to test.
 */
export function findStickyUserMessage(
  messages: readonly ChatMessage[],
  virtualItems: readonly VirtualItem[],
  scrollTop: number,
  estimateSize: number,
): ChatMessage | null {
  if (messages.length === 0) return null;

  let stickyIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    const vItem = virtualItems.find(v => v.index === i);
    const itemStart = vItem ? vItem.start : i * estimateSize;
    if (itemStart < scrollTop) {
      stickyIdx = i;
    }
  }

  return stickyIdx >= 0 ? messages[stickyIdx] : null;
}
