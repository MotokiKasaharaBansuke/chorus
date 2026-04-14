export interface TextMatch {
  start: number;
  end: number;
}

export interface TextSearchResult {
  matches: TextMatch[];
  /** True when the match count exceeded `limit` and additional hits were dropped. */
  truncated: boolean;
}

/**
 * Find every non-overlapping, case-insensitive occurrence of `query` in `text`.
 * When more than `limit` matches are found, the result is truncated and the
 * `truncated` flag is set so callers can render an accurate "N+" affordance.
 */
export function findAllMatches(
  text: string,
  query: string,
  limit: number = Number.POSITIVE_INFINITY,
): TextSearchResult {
  if (!query) return { matches: [], truncated: false };
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: TextMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, searchFrom);
    if (idx === -1) break;
    if (matches.length >= limit) {
      return { matches, truncated: true };
    }
    matches.push({ start: idx, end: idx + query.length });
    searchFrom = idx + query.length;
  }
  return { matches, truncated: false };
}
