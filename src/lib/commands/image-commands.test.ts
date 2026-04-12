import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveTempImage, deleteTempImage, cleanupTempImages } from "./image-commands";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

beforeEach(() => mockInvoke.mockReset());

describe("saveTempImage", () => {

  it("throws for empty base64 data without calling invoke", async () => {
    await expect(saveTempImage("")).rejects.toThrow("Empty image data");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("throws when data: URI prefix is passed", async () => {
    await expect(saveTempImage("data:image/png;base64,abc123")).rejects.toThrow("data: URI prefix");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("calls save_temp_image with data and extension", async () => {
    mockInvoke.mockResolvedValue("/tmp/chorus-images/abc.png");
    const result = await saveTempImage("abc123", "png");
    expect(mockInvoke).toHaveBeenCalledWith("save_temp_image", { data: "abc123", extension: "png" });
    expect(result).toBe("/tmp/chorus-images/abc.png");
  });

  it("passes undefined extension when omitted", async () => {
    mockInvoke.mockResolvedValue("/tmp/chorus-images/abc.png");
    await saveTempImage("abc123");
    expect(mockInvoke).toHaveBeenCalledWith("save_temp_image", { data: "abc123", extension: undefined });
  });
});

describe("deleteTempImage", () => {
  it("throws for path with no filename component (trailing slash)", async () => {
    await expect(deleteTempImage("/")).rejects.toThrow("Invalid image path");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("throws for empty path", async () => {
    await expect(deleteTempImage("")).rejects.toThrow("Invalid image path");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("extracts filename from full path and calls delete_temp_image", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await deleteTempImage("/tmp/chorus-images/550e8400-e29b-41d4-a716-446655440000.png");
    expect(mockInvoke).toHaveBeenCalledWith("delete_temp_image", {
      filename: "550e8400-e29b-41d4-a716-446655440000.png",
    });
  });

  it("works with a plain filename (no directory part)", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await deleteTempImage("abc.png");
    expect(mockInvoke).toHaveBeenCalledWith("delete_temp_image", { filename: "abc.png" });
  });

  it("extracts filename from path with subdirectory prefix", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await deleteTempImage("subdir/550e8400-e29b-41d4-a716-446655440000.png");
    expect(mockInvoke).toHaveBeenCalledWith("delete_temp_image", {
      filename: "550e8400-e29b-41d4-a716-446655440000.png",
    });
  });
});

describe("cleanupTempImages", () => {
  it("calls cleanup_temp_images with no arguments", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await cleanupTempImages();
    expect(mockInvoke).toHaveBeenCalledWith("cleanup_temp_images");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
