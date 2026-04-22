import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// --- Global stubs (before mocks) ---

class WindowStub {
  private emitter = new EventEmitter();
  addEventListener(type: string, fn: (...args: unknown[]) => void) {
    this.emitter.on(type, fn);
  }
  removeEventListener(type: string, fn: (...args: unknown[]) => void) {
    this.emitter.off(type, fn);
  }
  dispatchEvent(event: { type: string }) {
    this.emitter.emit(event.type, event);
    return true;
  }
  removeAllListeners() {
    this.emitter.removeAllListeners();
  }
}

let windowStub: WindowStub;

vi.stubGlobal("CustomEvent", class CustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
});

vi.stubGlobal("FileReader", class MockFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  readAsDataURL() {
    this.result = "data:image/png;base64,dGVzdA==";
    queueMicrotask(() => this.onload?.());
  }
});

/** Mock Image element: reports 800×600 by default (under MAX_IMAGE_DIMENSION). */
let mockImageWidth = 800;
let mockImageHeight = 600;

/** Mock createImageBitmap: resolves with width/height from mockImageWidth/Height. */
vi.stubGlobal("createImageBitmap", (_source: unknown) =>
  Promise.resolve({
    width: mockImageWidth,
    height: mockImageHeight,
    close: vi.fn(),
  }),
);

/** Stub canvas for the resize path */
const mockCanvasCtx = {
  drawImage: vi.fn(),
};
vi.stubGlobal("document", {
  ...globalThis.document,
  createElement: (tag: string) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => mockCanvasCtx,
        toDataURL: () => "data:image/png;base64,cmVzaXplZA==",
      };
    }
    // file input for openFilePicker
    return { type: "", accept: "", multiple: false, click: vi.fn(), onchange: null };
  },
});

// Stub solid-js reactivity
const cleanupFns: Array<() => void> = [];
vi.mock("solid-js", () => ({
  createSignal: <T>(init: T) => {
    let value = init;
    return [
      () => value,
      (v: T | ((prev: T) => T)) => {
        value = typeof v === "function" ? (v as (prev: T) => T)(value) : v;
      },
    ];
  },
  createEffect: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => cleanupFns.push(fn),
}));

// Stub Tauri commands
const mockSaveTempImage = vi.fn();
const mockImportImageFile = vi.fn();
const mockDeleteTempImage = vi.fn();

vi.mock("../lib/commands", () => ({
  saveTempImage: (...args: unknown[]) => mockSaveTempImage(...args),
  importImageFile: (...args: unknown[]) => mockImportImageFile(...args),
  deleteTempImage: (...args: unknown[]) => mockDeleteTempImage(...args),
}));

import { useImageAttachment, DROP_DEDUP_WINDOW_MS, scaleToFit, MAX_IMAGE_DIMENSION } from "./use-image-attachment";

describe("useImageAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Run cleanups from previous test to remove event listeners
    for (const fn of cleanupFns) fn();
    cleanupFns.length = 0;
    // Fresh window per test to avoid listener leaks
    windowStub = new WindowStub();
    vi.stubGlobal("window", windowStub);
    mockDeleteTempImage.mockResolvedValue(undefined);
    // Reset image dimensions (prevents leaking between tests)
    mockImageWidth = 800;
    mockImageHeight = 600;
  });

  function createHook(tabId = "tab-1") {
    return useImageAttachment({ tabId });
  }

  describe("handlePaste", () => {
    function makePasteEvent(types: string[]) {
      const items = types.map(type => ({
        type,
        getAsFile: () => new File(["data"], `img.${type.split("/")[1]}`, { type }),
      }));
      return {
        clipboardData: { items },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;
    }

    it("calls preventDefault for image paste", () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/test.png");
      const e = makePasteEvent(["image/png"]);

      hook.handlePaste(e);

      expect(e.preventDefault).toHaveBeenCalled();
    });

    it("prefers image/png over other types", () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/test.png");
      const e = makePasteEvent(["image/tiff", "image/png"]);

      hook.handlePaste(e);

      expect(e.preventDefault).toHaveBeenCalled();
    });

    it("ignores paste without image items", () => {
      const hook = createHook();
      const e = {
        clipboardData: { items: [{ type: "text/plain", getAsFile: () => null }] },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      hook.handlePaste(e);

      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("ignores paste with null clipboardData", () => {
      const hook = createHook();
      const e = { clipboardData: null, preventDefault: vi.fn() } as unknown as ClipboardEvent;

      hook.handlePaste(e);

      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("ignores paste when getAsFile returns null", () => {
      const hook = createHook();
      const e = {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => null }],
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent;

      hook.handlePaste(e);

      // preventDefault is called (image type matched), but no file to process
      expect(e.preventDefault).toHaveBeenCalled();
      expect(mockSaveTempImage).not.toHaveBeenCalled();
    });
  });

  describe("removeImage", () => {
    it("deletes temp file and removes from list", async () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/img1.png");

      await hook.handleImageFile(new File(["data"], "test.png", { type: "image/png" }));
      expect(hook.attachedImages().length).toBe(1);

      hook.removeImage(0);

      expect(mockDeleteTempImage).toHaveBeenCalledWith("/tmp/chorus-images/img1.png");
      expect(hook.attachedImages().length).toBe(0);
    });

    it("handles out-of-bounds index gracefully", () => {
      const hook = createHook();
      hook.removeImage(99);
      expect(mockDeleteTempImage).not.toHaveBeenCalled();
    });
  });

  describe("clearAll", () => {
    it("clears images without deleting temp files (Rust handles post-submit cleanup)", async () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/img.png");
      await hook.handleImageFile(new File(["data"], "test.png", { type: "image/png" }));
      expect(hook.attachedImages().length).toBe(1);

      hook.clearAll();

      expect(hook.attachedImages().length).toBe(0);
      expect(mockDeleteTempImage).not.toHaveBeenCalled();
    });
  });

  describe("handleImageFile", () => {
    it("adds web-safe image to attachments", async () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/photo.png");

      await hook.handleImageFile(new File(["data"], "photo.png", { type: "image/png" }));

      expect(mockSaveTempImage).toHaveBeenCalledWith("dGVzdA==", "png");
      const saved = hook.attachedImages()[0];
      expect(saved.name).toBe("photo.png");
      expect(saved.path).toBe("/tmp/chorus-images/photo.png");
      expect(saved.mediaType).toBe("image/png");
    });

    it("normalizes jpg extension to jpeg", async () => {
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/photo.jpeg");

      await hook.handleImageFile(new File(["data"], "photo.jpg", { type: "image/jpg" }));

      expect(mockSaveTempImage).toHaveBeenCalledWith(expect.any(String), "jpeg");
    });

    it("logs warning on failure instead of throwing", async () => {
      const hook = createHook();
      mockSaveTempImage.mockRejectedValue(new Error("IPC error"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await hook.handleImageFile(new File(["data"], "test.png", { type: "image/png" }));

      expect(warnSpy).toHaveBeenCalledWith(
        "[chorus] image attachment failed:",
        expect.any(Error),
      );
      expect(hook.attachedImages().length).toBe(0);
      warnSpy.mockRestore();
    });
  });

  describe("drop event filtering", () => {
    it("ignores drop events for other tabs", () => {
      createHook("tab-1");

      windowStub.dispatchEvent(new CustomEvent("mlm-image-drop", {
        detail: { tabId: "tab-2", paths: ["/path/img.png"] },
      }) as unknown as { type: string });

      expect(mockImportImageFile).not.toHaveBeenCalled();
    });

    it("processes drop events for matching tab", async () => {
      const hook = createHook("tab-1");
      mockImportImageFile.mockResolvedValue({
        path: "/tmp/chorus-images/imported.png",
        mediaType: "image/png",
      });

      windowStub.dispatchEvent(new CustomEvent("mlm-image-drop", {
        detail: { tabId: "tab-1", paths: ["/path/img.png"] },
      }) as unknown as { type: string });

      await vi.waitFor(() => {
        expect(mockImportImageFile).toHaveBeenCalledWith("/path/img.png");
      });
      expect(hook.attachedImages().length).toBe(1);
    });

    it("deduplicates images by path in drop handler", async () => {
      const hook = createHook("tab-1");
      mockImportImageFile.mockResolvedValue({
        path: "/tmp/chorus-images/same.png",
        mediaType: "image/png",
      });

      // Drop same file twice
      windowStub.dispatchEvent(new CustomEvent("mlm-image-drop", {
        detail: { tabId: "tab-1", paths: ["/path/img.png"] },
      }) as unknown as { type: string });

      await vi.waitFor(() => expect(mockImportImageFile).toHaveBeenCalledTimes(1));

      windowStub.dispatchEvent(new CustomEvent("mlm-image-drop", {
        detail: { tabId: "tab-1", paths: ["/path/img.png"] },
      }) as unknown as { type: string });

      await vi.waitFor(() => expect(mockImportImageFile).toHaveBeenCalledTimes(2));

      // Same path → deduplicated to 1
      expect(hook.attachedImages().length).toBe(1);
    });

    it("logs warning on import failure", async () => {
      createHook("tab-1");
      mockImportImageFile.mockRejectedValue(new Error("bad format"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      windowStub.dispatchEvent(new CustomEvent("mlm-image-drop", {
        detail: { tabId: "tab-1", paths: ["/path/bad.tiff"] },
      }) as unknown as { type: string });

      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          "[chorus] image drop import failed:",
          expect.any(Error),
        );
      });
      warnSpy.mockRestore();
    });
  });

  describe("drag state", () => {
    it("sets isDragOver for matching tab", () => {
      const hook = createHook("tab-1");

      windowStub.dispatchEvent(new CustomEvent("mlm-drag-state", {
        detail: { tabId: "tab-1", over: true },
      }) as unknown as { type: string });
      expect(hook.isDragOver()).toBe(true);

      windowStub.dispatchEvent(new CustomEvent("mlm-drag-state", {
        detail: { tabId: "tab-1", over: false },
      }) as unknown as { type: string });
      expect(hook.isDragOver()).toBe(false);
    });

    it("ignores drag state for other tabs", () => {
      const hook = createHook("tab-1");

      windowStub.dispatchEvent(new CustomEvent("mlm-drag-state", {
        detail: { tabId: "tab-2", over: true },
      }) as unknown as { type: string });
      expect(hook.isDragOver()).toBe(false);
    });
  });

  describe("DROP_DEDUP_WINDOW_MS", () => {
    it("is exported and equals 500", () => {
      expect(DROP_DEDUP_WINDOW_MS).toBe(500);
    });
  });

  describe("handleImageFile — resize path", () => {
    it("resizes oversized images via canvas", async () => {
      mockImageWidth = 4000;
      mockImageHeight = 3000;
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/resized.png");

      await hook.handleImageFile(new File(["data"], "big.png", { type: "image/png" }));

      // The canvas path produces "cmVzaXplZA==" from our mock
      expect(mockSaveTempImage).toHaveBeenCalledWith("cmVzaXplZA==", "png");
      expect(mockCanvasCtx.drawImage).toHaveBeenCalled();
    });

    it("skips canvas for small web-safe images (fast path)", async () => {
      mockImageWidth = 800;
      mockImageHeight = 600;
      mockCanvasCtx.drawImage.mockClear();
      const hook = createHook();
      mockSaveTempImage.mockResolvedValue("/tmp/chorus-images/small.png");

      await hook.handleImageFile(new File(["data"], "small.png", { type: "image/png" }));

      // FileReader path produces "dGVzdA==" from our mock
      expect(mockSaveTempImage).toHaveBeenCalledWith("dGVzdA==", "png");
      expect(mockCanvasCtx.drawImage).not.toHaveBeenCalled();
    });
  });
});

describe("scaleToFit", () => {
  it("returns original dimensions when within max", () => {
    expect(scaleToFit(1000, 800, 2048)).toEqual({ width: 1000, height: 800 });
  });

  it("scales landscape image to fit max dimension", () => {
    const result = scaleToFit(4096, 2048, 2048);
    expect(result.width).toBe(2048);
    expect(result.height).toBe(1024);
  });

  it("scales portrait image to fit max dimension", () => {
    const result = scaleToFit(1500, 3000, 2048);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(2048);
  });

  it("scales square image", () => {
    const result = scaleToFit(4000, 4000, 2048);
    expect(result.width).toBe(2048);
    expect(result.height).toBe(2048);
  });

  it("handles exactly-at-max dimensions", () => {
    expect(scaleToFit(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it("handles one dimension at max, other under", () => {
    expect(scaleToFit(2048, 1000, 2048)).toEqual({ width: 2048, height: 1000 });
  });

  it("returns 0x0 for zero-dimension input", () => {
    expect(scaleToFit(0, 600, 2048)).toEqual({ width: 0, height: 0 });
    expect(scaleToFit(800, 0, 2048)).toEqual({ width: 0, height: 0 });
    expect(scaleToFit(0, 0, 2048)).toEqual({ width: 0, height: 0 });
  });

  it("returns 0x0 for negative dimensions", () => {
    expect(scaleToFit(-1, 600, 2048)).toEqual({ width: 0, height: 0 });
  });

  it("exports MAX_IMAGE_DIMENSION as 2048", () => {
    expect(MAX_IMAGE_DIMENSION).toBe(2048);
  });
});
