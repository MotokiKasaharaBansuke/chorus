import { StreamParser } from "./stream-parser";

/** Module-level registry that keeps StreamParser instances alive across component remounts.
 *  Keyed by tab ID so that when ChatPanel unmounts/remounts (e.g. layout split),
 *  the conversation state is preserved. */
const parsers = new Map<string, StreamParser>();

/** Get or create a StreamParser for the given tab ID.
 *  Returns the same instance on repeated calls, preserving conversation state. */
export function getOrCreateParser(tabId: string): StreamParser {
  const existing = parsers.get(tabId);
  if (existing) return existing;

  const parser = new StreamParser();
  parsers.set(tabId, parser);
  return parser;
}

/** Remove the StreamParser for a closed tab to prevent memory leaks. */
export function removeParser(tabId: string): void {
  parsers.delete(tabId);
}
