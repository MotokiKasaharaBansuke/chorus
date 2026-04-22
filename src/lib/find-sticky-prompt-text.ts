import type { ChatMessage } from "../types";

/** Distance from the bottom of the scroll container (px) below which the
 *  sticky overlay is hidden — the user is "close enough" to the latest reply. */
export const BOTTOM_PROXIMITY_PX = 80;

interface VirtualItem {
  readonly index: number;
  readonly start: number;
}

interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Find the text of the last user message whose top edge has scrolled above
 * the viewport.  Returns `null` when the user is near the bottom of the
 * scroll container (within {@link BOTTOM_PROXIMITY_PX}), when there are no
 * messages, or when the last scrolled-past user message contains no text.
 */
export function findStickyPromptText(
  messages: readonly ChatMessage[],
  virtualItems: readonly VirtualItem[],
  scroll: ScrollMetrics,
  estimatedHeight: number,
): string | null {
  const distToBottom = Math.max(
    0,
    scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
  );
  if (distToBottom < BOTTOM_PROXIMITY_PX) return null;

  const itemMap = new Map(virtualItems.map(v => [v.index, v.start]));
  let text: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    const start = itemMap.get(i) ?? i * estimatedHeight;
    if (start < scroll.scrollTop) {
      const joined = messages[i].blocks
        .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
        .map(b => b.text)
        .join("\n");
      if (joined) text = joined;
    }
  }

  return text;
}
