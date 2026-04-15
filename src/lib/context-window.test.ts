import { describe, it, expect } from "vitest";
import {
  contextColor,
  shouldAutoCompact,
  CONTEXT_WINDOW_SIZE,
  AUTO_COMPACT_THRESHOLD,
  AUTO_COMPACT_RESET_THRESHOLD,
  CONTEXT_WARN_THRESHOLD,
} from "./context-window";

describe("contextColor", () => {
  it("returns green for low usage", () => {
    expect(contextColor(0)).toBe("#3fb950");
    expect(contextColor(0.1)).toBe("#3fb950");
    expect(contextColor(AUTO_COMPACT_RESET_THRESHOLD - 0.001)).toBe("#3fb950");
  });

  it("returns yellow at the AUTO_COMPACT_RESET_THRESHOLD boundary", () => {
    expect(contextColor(AUTO_COMPACT_RESET_THRESHOLD)).toBe("#e1c08d");
    expect(contextColor(CONTEXT_WARN_THRESHOLD - 0.001)).toBe("#e1c08d");
  });

  it("returns orange at the CONTEXT_WARN_THRESHOLD boundary", () => {
    expect(contextColor(CONTEXT_WARN_THRESHOLD)).toBe("#e8587a");
    expect(contextColor(AUTO_COMPACT_THRESHOLD - 0.001)).toBe("#e8587a");
  });

  it("returns red at the AUTO_COMPACT_THRESHOLD boundary", () => {
    expect(contextColor(AUTO_COMPACT_THRESHOLD)).toBe("#c74e39");
    expect(contextColor(1.0)).toBe("#c74e39");
    expect(contextColor(1.5)).toBe("#c74e39");
  });

  it("color threshold matches AUTO_COMPACT_THRESHOLD constant", () => {
    // Just below threshold → orange, at threshold → red
    expect(contextColor(AUTO_COMPACT_THRESHOLD - 0.001)).toBe("#e8587a");
    expect(contextColor(AUTO_COMPACT_THRESHOLD)).toBe("#c74e39");
  });
});

describe("shouldAutoCompact", () => {
  it("returns true when pct >= threshold, not streaming, not triggered", () => {
    expect(shouldAutoCompact(AUTO_COMPACT_THRESHOLD, false, false)).toBe(true);
    expect(shouldAutoCompact(1.0, false, false)).toBe(true);
  });

  it("returns false when pct is below threshold", () => {
    expect(shouldAutoCompact(AUTO_COMPACT_THRESHOLD - 0.001, false, false)).toBe(false);
    expect(shouldAutoCompact(0, false, false)).toBe(false);
  });

  it("returns false when streaming", () => {
    expect(shouldAutoCompact(AUTO_COMPACT_THRESHOLD, true, false)).toBe(false);
    expect(shouldAutoCompact(1.0, true, false)).toBe(false);
  });

  it("returns false when already triggered", () => {
    expect(shouldAutoCompact(AUTO_COMPACT_THRESHOLD, false, true)).toBe(false);
    expect(shouldAutoCompact(1.0, false, true)).toBe(false);
  });

  it("returns false when both streaming and triggered", () => {
    expect(shouldAutoCompact(1.0, true, true)).toBe(false);
  });

  it("threshold aligns with contextColor: at threshold both trigger fires and color turns red", () => {
    const pct = AUTO_COMPACT_THRESHOLD;
    expect(shouldAutoCompact(pct, false, false)).toBe(true);
    expect(contextColor(pct)).toBe("#c74e39");
  });
});

describe("constants", () => {
  it("CONTEXT_WINDOW_SIZE is 200k tokens", () => {
    expect(CONTEXT_WINDOW_SIZE).toBe(200_000);
  });

  it("AUTO_COMPACT_THRESHOLD is 0.9", () => {
    expect(AUTO_COMPACT_THRESHOLD).toBe(0.9);
  });

  it("AUTO_COMPACT_RESET_THRESHOLD is 0.5", () => {
    expect(AUTO_COMPACT_RESET_THRESHOLD).toBe(0.5);
  });

  it("CONTEXT_WARN_THRESHOLD is 0.8", () => {
    expect(CONTEXT_WARN_THRESHOLD).toBe(0.8);
  });

  it("thresholds are ordered: reset < warn < compact", () => {
    expect(AUTO_COMPACT_RESET_THRESHOLD).toBeLessThan(CONTEXT_WARN_THRESHOLD);
    expect(CONTEXT_WARN_THRESHOLD).toBeLessThan(AUTO_COMPACT_THRESHOLD);
  });
});
