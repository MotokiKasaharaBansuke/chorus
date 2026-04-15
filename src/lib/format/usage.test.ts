import { describe, it, expect } from "vitest";
import { formatCost, formatTokens, formatResetsIn, formatUtilization, utilizationColor } from "./usage";

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

describe("formatResetsIn", () => {
  const base = 1_700_000_000_000;

  it("returns '—' for NaN", () => {
    expect(formatResetsIn(NaN, base)).toBe("—");
  });

  it("returns '—' for Infinity", () => {
    expect(formatResetsIn(Infinity, base)).toBe("—");
  });

  it("returns 'now' when resetsAt is in the past", () => {
    expect(formatResetsIn(base - 1000, base)).toBe("now");
  });

  it("returns minutes for < 60 min", () => {
    expect(formatResetsIn(base + 30 * 60_000, base)).toBe("30m");
  });

  it("rounds up to nearest minute", () => {
    expect(formatResetsIn(base + 90_000, base)).toBe("2m");
  });

  it("returns hours for >= 60 min", () => {
    expect(formatResetsIn(base + 3 * 3600_000, base)).toBe("3h");
  });

  it("returns days for >= 24 hours", () => {
    expect(formatResetsIn(base + 4 * 86400_000, base)).toBe("4d");
  });
});

describe("formatUtilization", () => {
  it("formats 0.97 as 97%", () => {
    expect(formatUtilization(0.97)).toBe("97%");
  });

  it("formats 0 as 0%", () => {
    expect(formatUtilization(0)).toBe("0%");
  });

  it("formats 1 as 100%", () => {
    expect(formatUtilization(1)).toBe("100%");
  });

  it("returns 0% for NaN", () => {
    expect(formatUtilization(NaN)).toBe("0%");
  });

  it("returns 0% for negative", () => {
    expect(formatUtilization(-0.5)).toBe("0%");
  });

  it("clamps to 100% when utilization exceeds 1", () => {
    expect(formatUtilization(1.5)).toBe("100%");
  });
});

describe("utilizationColor", () => {
  it("returns orange for >= 0.9", () => {
    expect(utilizationColor(0.9)).toBe("#d4863a");
    expect(utilizationColor(1.0)).toBe("#d4863a");
    expect(utilizationColor(1.5)).toBe("#d4863a");
  });

  it("returns yellow for >= 0.7 and < 0.9", () => {
    expect(utilizationColor(0.7)).toBe("#d4c43a");
    expect(utilizationColor(0.89)).toBe("#d4c43a");
  });

  it("returns green for < 0.7", () => {
    expect(utilizationColor(0)).toBe("#4abf4a");
    expect(utilizationColor(0.5)).toBe("#4abf4a");
    expect(utilizationColor(0.69)).toBe("#4abf4a");
  });

  it("returns green for NaN (treated as low utilization)", () => {
    expect(utilizationColor(NaN)).toBe("#4abf4a");
  });

  it("returns green for negative values", () => {
    expect(utilizationColor(-0.1)).toBe("#4abf4a");
  });
});
