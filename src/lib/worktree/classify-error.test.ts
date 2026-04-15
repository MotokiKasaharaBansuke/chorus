import { describe, it, expect } from "vitest";
import { classifyWorktreeError } from "./classify-error";

describe("classifyWorktreeError", () => {
  it("identifies tuple variants (single-string payload)", () => {
    expect(classifyWorktreeError({ WorktreeBranchExists: "feat/foo" })).toEqual({
      kind: "WorktreeBranchExists",
      detail: "feat/foo",
    });
    expect(classifyWorktreeError({ WorktreePathExists: "/tmp/wt/x" })).toEqual({
      kind: "WorktreePathExists",
      detail: "/tmp/wt/x",
    });
  });

  it("identifies struct variants (code + message)", () => {
    expect(
      classifyWorktreeError({
        WorktreeHookFailed: { code: "Timeout", message: "hook exceeded 600s" },
      }),
    ).toEqual({ kind: "WorktreeHookFailed", detail: "hook exceeded 600s" });
  });

  it("identifies unit variants serialized as strings", () => {
    expect(classifyWorktreeError("GitNotFound")).toEqual({
      kind: "Unknown",
      detail: "GitNotFound",
    });
    // AppError::GitNotFound serializes as the bare variant name.
    // String inputs are classified Unknown; UI falls back to raw message.
  });

  it("handles Error instances", () => {
    expect(classifyWorktreeError(new Error("boom"))).toEqual({
      kind: "Unknown",
      detail: "boom",
    });
  });

  it("returns Unknown for empty or unexpected shapes", () => {
    expect(classifyWorktreeError({}).kind).toBe("Unknown");
    expect(classifyWorktreeError(null).kind).toBe("Unknown");
    expect(classifyWorktreeError(42).kind).toBe("Unknown");
  });

  it("preserves unrecognized keys in detail", () => {
    const info = classifyWorktreeError({ SomethingNew: "info" });
    expect(info.kind).toBe("Unknown");
    expect(info.detail).toContain("SomethingNew");
  });
});
