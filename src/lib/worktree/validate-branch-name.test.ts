import { describe, it, expect } from "vitest";
import { validateBranchName, MAX_BRANCH_NAME_LEN } from "./validate-branch-name";

describe("validateBranchName", () => {
  it("accepts simple ASCII names", () => {
    expect(validateBranchName("feat/foo-bar_1")).toEqual({
      ok: true,
      normalized: "feat/foo-bar_1",
    });
  });

  it("rejects empty string", () => {
    expect(validateBranchName("").ok).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(validateBranchName("-foo").ok).toBe(false);
  });

  it("rejects NUL byte", () => {
    expect(validateBranchName("foo\0bar").ok).toBe(false);
  });

  it("rejects control characters", () => {
    expect(validateBranchName("foo\x01bar").ok).toBe(false);
  });

  it("rejects .. segments", () => {
    expect(validateBranchName("foo/../bar").ok).toBe(false);
  });

  it("rejects empty segments", () => {
    expect(validateBranchName("foo//bar").ok).toBe(false);
  });

  it("rejects .lock suffix on any segment", () => {
    expect(validateBranchName("foo.lock").ok).toBe(false);
    expect(validateBranchName("foo/bar.lock").ok).toBe(false);
  });

  it("rejects spaces and special chars", () => {
    expect(validateBranchName("foo bar").ok).toBe(false);
    expect(validateBranchName("foo$bar").ok).toBe(false);
  });

  it(`rejects names longer than ${MAX_BRANCH_NAME_LEN}`, () => {
    const long = "a".repeat(MAX_BRANCH_NAME_LEN + 1);
    expect(validateBranchName(long).ok).toBe(false);
  });

  it("rejects non-ASCII characters (allowlist is ASCII-only)", () => {
    expect(validateBranchName("feat/café").ok).toBe(false);
    expect(validateBranchName("feat/caf\u0065\u0301").ok).toBe(false);
  });

  it("matches Rust allowlist for typical conventional names", () => {
    for (const name of ["feat/x", "fix/bug-1", "chore/renovate.deps", "release/v1.2.3"]) {
      expect(validateBranchName(name).ok).toBe(true);
    }
  });
});
