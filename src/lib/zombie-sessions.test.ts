import { describe, it, expect } from "vitest";
import { isSessionStale } from "./zombie-sessions";

describe("isSessionStale", () => {
  it("returns false when ptyId exists in backend", () => {
    expect(isSessionStale(["a", "b", "c"], "b")).toBe(false);
  });

  it("returns true when ptyId is not in backend", () => {
    expect(isSessionStale(["a", "b"], "x")).toBe(true);
  });

  it("returns true when backend is empty", () => {
    expect(isSessionStale([], "a")).toBe(true);
  });
});
