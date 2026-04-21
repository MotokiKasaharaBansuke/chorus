import type { ChatMessage } from "../types";

/** Minimal virtualizer item shape needed for sticky header calculation. */
interface VirtualItem {
  index: number;
  start: number;
}

/** How close to the bottom (in px) the user must be for the sticky header to
 *  hide. Roughly one message row height — prevents the header from flashing
 *  on after auto-scroll-to-bottom. */
export const BOTTOM_PROXIMITY_THRESHOLD_PX = 80;

/**
 * Find the last user message whose position has scrolled past the top of the
 * scroll container. Returns the message, or null if none has scrolled past.
 *
 * When the user is scrolled to the bottom (seeing the latest content), the
 * sticky header is hidden — it only appears when the user manually scrolls up
 * and the original prompt is no longer visible.
 *
 * This is a pure function with no DOM dependency — positions come from the
 * virtualizer, making it easy to test.
 */
export function findStickyUserMessage(
  messages: readonly ChatMessage[],
  virtualItems: readonly VirtualItem[],
  scrollTop: number,
  estimateSize: number,
  scrollInfo?: { clientHeight: number; scrollHeight: number },
): ChatMessage | null {
  if (messages.length === 0) return null;

  // If the user is at (or near) the bottom, don't show the sticky header.
  // This prevents the header from appearing immediately after sending a message.
  // Math.max guards against negative values from macOS elastic overscroll.
  if (scrollInfo) {
    const distanceToBottom = Math.max(
      0,
      scrollInfo.scrollHeight - scrollInfo.clientHeight - scrollTop,
    );
    if (distanceToBottom < BOTTOM_PROXIMITY_THRESHOLD_PX) return null;
  }

  const itemMap = new Map(virtualItems.map(v => [v.index, v]));

  let stickyIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    const vItem = itemMap.get(i);
    const itemStart = vItem ? vItem.start : i * estimateSize;
    if (itemStart < scrollTop) {
      stickyIdx = i;
    }
  }

  return stickyIdx >= 0 ? messages[stickyIdx] : null;
}
