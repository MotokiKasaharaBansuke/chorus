import { describe, it, expect } from "vitest";
import { formatCost, formatTokens } from "./usage";

describe("formatCost", () => {
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("formats small amounts with 4 decimals", () => {
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("formats amounts >= $0.01 with 2 decimals", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(123.456)).toBe("$123.46");
  });

  it("returns $0.00 for NaN", () => {
    expect(formatCost(NaN)).toBe("$0.00");
  });

  it("returns $0.00 for Infinity", () => {
    expect(formatCost(Infinity)).toBe("$0.00");
    expect(formatCost(-Infinity)).toBe("$0.00");
  });

  it("returns $0.00 for negative values", () => {
    expect(formatCost(-0.5)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("formats zero", () => {
    expect(formatTokens(0)).toBe("0");
  });

  it("formats small counts as-is", () => {
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(999999)).toBe("1000.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("returns 0 for NaN", () => {
    expect(formatTokens(NaN)).toBe("0");
  });

  it("returns 0 for negative values", () => {
    expect(formatTokens(-100)).toBe("0");
  });

  it("returns 0 for Infinity", () => {
    expect(formatTokens(Infinity)).toBe("0");
  });
});
