import { describe, it, expect } from "vitest";
import { isValidTempImagePath } from "./validate-path";

describe("isValidTempImagePath", () => {
  it("accepts a valid temp image path", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/abc123.png")).toBe(true);
  });

  it("accepts paths with subdirectories", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/sub/file.jpg")).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/../etc/passwd")).toBe(false);
  });

  it("rejects paths outside temp directory", () => {
    expect(isValidTempImagePath("/home/user/photo.png")).toBe(false);
  });

  it("rejects paths with newline injection", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/file\n.png")).toBe(false);
  });

  it("rejects paths with carriage return injection", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/file\r.png")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidTempImagePath("")).toBe(false);
  });

  it("rejects null byte injection", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/file\0.png")).toBe(false);
  });

  it("rejects tab character injection", () => {
    expect(isValidTempImagePath("/tmp/chorus-images/\tfile.png")).toBe(false);
  });
});
