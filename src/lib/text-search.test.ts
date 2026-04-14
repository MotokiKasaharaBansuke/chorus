import { describe, expect, it } from "vitest";
import { findAllMatches } from "./text-search";

describe("findAllMatches", () => {
  it("returns no matches for empty query", () => {
    expect(findAllMatches("hello", "")).toEqual({ matches: [], truncated: false });
  });

  it("finds single match", () => {
    expect(findAllMatches("hello world", "world")).toEqual({
      matches: [{ start: 6, end: 11 }],
      truncated: false,
    });
  });

  it("finds multiple non-overlapping matches", () => {
    expect(findAllMatches("abcabcabc", "abc")).toEqual({
      matches: [
        { start: 0, end: 3 },
        { start: 3, end: 6 },
        { start: 6, end: 9 },
      ],
      truncated: false,
    });
  });

  it("is case-insensitive", () => {
    expect(findAllMatches("Hello HELLO hello", "hello").matches).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("returns no matches when nothing found", () => {
    expect(findAllMatches("hello", "xyz")).toEqual({ matches: [], truncated: false });
  });

  it("handles empty text", () => {
    expect(findAllMatches("", "query")).toEqual({ matches: [], truncated: false });
  });

  it("does not loop on overlapping single-char matches", () => {
    expect(findAllMatches("aaa", "a").matches).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  it("truncates at limit and flags result", () => {
    const result = findAllMatches("aaaaa", "a", 3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation when exactly at limit", () => {
    const result = findAllMatches("aaa", "a", 3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });
});
