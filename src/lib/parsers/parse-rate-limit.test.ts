import { describe, it, expect, vi } from "vitest";
import { parseRateLimitEvent } from "./parse-rate-limit";

describe("parseRateLimitEvent", () => {
  it("parses flat event with utilization + resets_at", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      utilization: 0.97,
      resets_at: "2026-04-15T21:00:00.000Z",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "five_hour",
      label: "Session (5hr)",
      utilization: 0.97,
    });
    expect(entries[0].resetsAt).toBeGreaterThan(0);
  });

  it("parses nested rate_limit object", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit: {
        type: "seven_day",
        utilization: 0.6,
        resets_at: 1713200000,
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "seven_day",
      label: "Weekly (7 day)",
      utilization: 0.6,
    });
  });

  it("parses rate_limits array", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limits: [
        { type: "five_hour", utilization: 0.97, resets_at: 1713200000 },
        { type: "seven_day", utilization: 0.6, resets_at: 1713500000 },
      ],
    });
    expect(entries).toHaveLength(2);
  });

  it("parses claims array", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      claims: [
        { type: "five_hour", utilization: 0.97, resets_at: "2026-04-15T21:00:00Z" },
      ],
    });
    expect(entries).toHaveLength(1);
  });

  it("handles percent_used (0-100 scale)", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      percent_used: 97,
      resets_at: 1713200000,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].utilization).toBeCloseTo(0.97);
  });

  it("converts epoch seconds to ms", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      utilization: 0.5,
      resets_at: 1713200000,
    });
    expect(entries[0].resetsAt).toBe(1713200000000);
  });

  it("preserves epoch ms as-is", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      utilization: 0.5,
      resets_at: 1713200000000,
    });
    expect(entries[0].resetsAt).toBe(1713200000000);
  });

  it("uses custom label when provided", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      label: "Custom Label",
      utilization: 0.5,
      resets_at: 1713200000,
    });
    expect(entries[0].label).toBe("Custom Label");
  });

  it("generates label from unknown type", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "weekly_sonnet",
      utilization: 0.65,
      resets_at: 1713200000,
    });
    expect(entries[0].label).toBe("Weekly Sonnet");
  });

  it("warns on unknown format", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = parseRateLimitEvent({ type: "rate_limit_event" });
    expect(entries).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("skips entries missing utilization", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      resets_at: 1713200000,
    });
    expect(entries).toHaveLength(0);
  });

  it("skips entries missing resets_at", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      utilization: 0.5,
    });
    expect(entries).toHaveLength(0);
  });

  it("treats percent_used = 0 as zero utilization (not skipped)", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      percent_used: 0,
      resets_at: 1713200000,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].utilization).toBe(0);
  });

  it("skips entries when percent_used is null (not treated as 0)", () => {
    const entries = parseRateLimitEvent({
      type: "rate_limit_event",
      rate_limit_type: "five_hour",
      percent_used: null,
      resets_at: 1713200000,
    });
    expect(entries).toHaveLength(0);
  });
});
