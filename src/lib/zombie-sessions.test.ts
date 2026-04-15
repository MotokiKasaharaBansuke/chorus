import { describe, it, expect } from "vitest";
import { countZombies } from "./zombie-sessions";

describe("countZombies", () => {
  it("returns 0 when backend and frontend match", () => {
    expect(countZombies(["a", "b"], ["a", "b"])).toBe(0);
  });

  it("returns 0 when backend is empty", () => {
    expect(countZombies([], ["a"])).toBe(0);
  });

  it("counts sessions only in backend", () => {
    expect(countZombies(["a", "b", "c"], ["a"])).toBe(2);
  });

  it("ignores frontend-only IDs", () => {
    expect(countZombies(["a"], ["a", "b", "c"])).toBe(0);
  });

  it("returns all when frontend is empty", () => {
    expect(countZombies(["a", "b"], [])).toBe(2);
  });

  it("handles both empty", () => {
    expect(countZombies([], [])).toBe(0);
  });
});
