import { describe, it, expect } from "vitest";
import { analyzeSessionHealth } from "./zombie-sessions";

describe("analyzeSessionHealth", () => {
  it("returns 0 zombies when backend and frontend match", () => {
    const result = analyzeSessionHealth(["a", "b"], ["a", "b"], null);
    expect(result.zombieCount).toBe(0);
  });

  it("returns 0 zombies when backend is empty", () => {
    const result = analyzeSessionHealth([], ["a"], null);
    expect(result.zombieCount).toBe(0);
  });

  it("counts sessions only in backend as zombies", () => {
    const result = analyzeSessionHealth(["a", "b", "c"], ["a"], null);
    expect(result.zombieCount).toBe(2);
  });

  it("ignores frontend-only IDs", () => {
    const result = analyzeSessionHealth(["a"], ["a", "b", "c"], null);
    expect(result.zombieCount).toBe(0);
  });

  it("returns all as zombies when frontend is empty", () => {
    const result = analyzeSessionHealth(["a", "b"], [], null);
    expect(result.zombieCount).toBe(2);
  });

  it("handles both empty", () => {
    const result = analyzeSessionHealth([], [], null);
    expect(result.zombieCount).toBe(0);
  });

  it("handles duplicate backend IDs", () => {
    const result = analyzeSessionHealth(["a", "a"], ["a"], null);
    expect(result.zombieCount).toBe(0);
  });

  it("reports active tab as not stale when it exists in backend", () => {
    const result = analyzeSessionHealth(["a", "b"], ["a", "b"], "b");
    expect(result.isActiveStale).toBe(false);
  });

  it("reports active tab as stale when missing from backend", () => {
    const result = analyzeSessionHealth(["a", "b"], ["a", "b"], "x");
    expect(result.isActiveStale).toBe(true);
  });

  it("reports not stale when activePtyId is null", () => {
    const result = analyzeSessionHealth(["a"], [], null);
    expect(result.isActiveStale).toBe(false);
  });

  it("reports stale when backend is empty", () => {
    const result = analyzeSessionHealth([], [], "a");
    expect(result.isActiveStale).toBe(true);
  });
});
