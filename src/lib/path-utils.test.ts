import { describe, expect, it } from "vitest";
import { parentDir } from "./path-utils";

describe("parentDir", () => {
  it("returns parent of nested absolute path", () => {
    expect(parentDir("/a/b/c")).toBe("/a/b");
  });

  it("returns '/' for direct child of root", () => {
    expect(parentDir("/foo")).toBe("/");
  });

  it("returns '/' for root itself", () => {
    expect(parentDir("/")).toBe("/");
  });

  it("ignores trailing slashes", () => {
    expect(parentDir("/a/b/")).toBe("/a");
    expect(parentDir("/a/b///")).toBe("/a");
  });

  it("returns '' for single relative segment", () => {
    expect(parentDir("foo")).toBe("");
  });

  it("returns '' for empty string", () => {
    expect(parentDir("")).toBe("");
  });

  it("handles relative nested path", () => {
    expect(parentDir("a/b/c")).toBe("a/b");
  });
});
