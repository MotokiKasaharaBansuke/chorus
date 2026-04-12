import { describe, it, expect } from "vitest";
import { classifyStreamError } from "./classify-error";

describe("classifyStreamError", () => {
  it("returns 'not_found' for PtyNotFound error", () => {
    expect(classifyStreamError({ PtyNotFound: "some-id" })).toBe("not_found");
  });

  it("returns 'busy' for StreamSessionBusy error", () => {
    expect(classifyStreamError({ StreamSessionBusy: "Already processing a message" })).toBe("busy");
  });

  it("returns 'other' for PtyWriteFailed error", () => {
    expect(classifyStreamError({ PtyWriteFailed: "some write error" })).toBe("other");
  });

  it("returns 'other' for PtySpawnFailed error", () => {
    expect(classifyStreamError({ PtySpawnFailed: "spawn failed" })).toBe("other");
  });

  it("returns 'other' for string error", () => {
    expect(classifyStreamError("unexpected error")).toBe("other");
  });

  it("returns 'other' for null", () => {
    expect(classifyStreamError(null)).toBe("other");
  });

  it("returns 'other' for undefined", () => {
    expect(classifyStreamError(undefined)).toBe("other");
  });

  it("returns 'other' for number", () => {
    expect(classifyStreamError(42)).toBe("other");
  });

  it("returns 'other' for empty object", () => {
    expect(classifyStreamError({})).toBe("other");
  });

  it("returns 'not_found' even when object has extra properties", () => {
    expect(classifyStreamError({ PtyNotFound: "id", extra: true })).toBe("not_found");
  });
});
