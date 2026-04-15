import { describe, it, expect } from "vitest";
import { generateAutoBranchName } from "./generate-branch-name";

const FIXED = new Date(2026, 3, 15, 14, 30, 52, 125); // local 2026-04-15 14:30:52.125

describe("generateAutoBranchName", () => {
  it("appends timestamped pane suffix under a trailing-slash prefix", () => {
    expect(generateAutoBranchName("feat/", FIXED)).toBe("feat/pane-20260415-143052-125");
  });

  it("inserts a slash when the prefix has none", () => {
    expect(generateAutoBranchName("feat", FIXED)).toBe("feat/pane-20260415-143052-125");
  });

  it("omits the prefix entirely when blank", () => {
    expect(generateAutoBranchName("", FIXED)).toBe("pane-20260415-143052-125");
    expect(generateAutoBranchName("   ", FIXED)).toBe("pane-20260415-143052-125");
  });

  it("zero-pads single-digit date/time/millisecond components", () => {
    const early = new Date(2026, 0, 2, 3, 4, 5, 7);
    expect(generateAutoBranchName("feat/", early)).toBe("feat/pane-20260102-030405-007");
  });

  it("produces different names for calls within the same second", () => {
    const a = new Date(2026, 3, 15, 14, 30, 52, 100);
    const b = new Date(2026, 3, 15, 14, 30, 52, 101);
    expect(generateAutoBranchName("feat/", a)).not.toBe(generateAutoBranchName("feat/", b));
  });

  it("returns null when the combined name violates branch rules", () => {
    expect(generateAutoBranchName("-bad", FIXED)).toBeNull(); // starts with '-'
    expect(generateAutoBranchName("has space", FIXED)).toBeNull();
    expect(generateAutoBranchName("emoji🙂", FIXED)).toBeNull();
  });
});
