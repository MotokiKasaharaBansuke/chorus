import { createSignal, createEffect, onCleanup } from "solid-js";
import { saveTempImage, importImageFile, deleteTempImage } from "../lib/commands";
import type { AttachedImage } from "../types";

const WEB_SAFE_EXTS = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
export const DROP_DEDUP_WINDOW_MS = 500;

/** Claude API processes images at max 1568px internally; 2048 leaves margin for detail. */
export const MAX_IMAGE_DIMENSION = 2048;

interface UseImageAttachmentOptions {
  tabId: string;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(
      typeof reader.result === "string" ? (reader.result.split(",")[1] ?? "") : "",
    );
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function scaleToFit(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function drawToCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: string,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL(mimeType).split(",")[1] ?? "";
}

/**
 * Resize the image if it exceeds MAX_IMAGE_DIMENSION, and convert
 * non-web-safe formats to PNG.  Small web-safe images skip the canvas
 * entirely for a faster path.
 *
 * Uses `createImageBitmap` instead of `new Image()` + blob URL to avoid
 * being blocked by CSP `img-src` restrictions (blob: is not in our CSP).
 */
async function compressImage(
  file: File,
  ext: string,
  isWebSafe: boolean,
): Promise<{ base64: string; saveExt: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    const needsResize =
      bitmap.width > MAX_IMAGE_DIMENSION ||
      bitmap.height > MAX_IMAGE_DIMENSION;

    // Web-safe and small enough: fast path — no canvas overhead
    if (isWebSafe && !needsResize) {
      return {
        base64: await readFileAsBase64(file),
        saveExt: ext === "jpg" ? "jpeg" : ext,
      };
    }

    // Canvas path: resize and/or convert
    const { width, height } = needsResize
      ? scaleToFit(bitmap.width, bitmap.height, MAX_IMAGE_DIMENSION)
      : { width: bitmap.width, height: bitmap.height };

    const saveExt = isWebSafe ? (ext === "jpg" ? "jpeg" : ext) : "png";
    const mimeType = `image/${saveExt}`;
    const base64 = drawToCanvas(bitmap, width, height, mimeType);
    return { base64, saveExt };
  } finally {
    bitmap.close();
  }
}

export function useImageAttachment(options: UseImageAttachmentOptions) {
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([]);
  const [isDragOver, setIsDragOver] = createSignal(false);
  let lastDropHandledAt = 0;

  async function handleImageFile(file: File) {
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    const isWebSafe = WEB_SAFE_EXTS.has(ext);

    try {
      const { base64, saveExt } = await compressImage(file, ext, isWebSafe);
      const path = await saveTempImage(base64, saveExt);
      const name = file.name || `screenshot.${saveExt}`;
      const mediaType = `image/${saveExt}`;
      setAttachedImages(prev => [...prev, { name, path, mediaType }]);
    } catch (error: unknown) {
      console.warn("[chorus] image attachment failed:", error);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(i => i.type.startsWith("image/"));
    const preferred = imageItems.find(i => i.type === "image/png") ?? imageItems[0];
    if (!preferred) return;
    e.preventDefault();
    if (Date.now() - lastDropHandledAt < DROP_DEDUP_WINDOW_MS) return;
    const file = preferred.getAsFile();
    if (file) handleImageFile(file);
  }

  function removeImage(idx: number) {
    const img = attachedImages()[idx];
    if (img) deleteTempImage(img.path).catch(() => {});
    setAttachedImages(prev => prev.filter((_, i) => i !== idx));
  }

  /** Clear all attached images without deleting temp files.
   *  Used after submit — the Rust reader thread handles temp file cleanup
   *  after the CLI process exits. For user-initiated removal, use removeImage. */
  function clearAll() {
    setAttachedImages([]);
  }

  function openFilePicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      if (input.files) Array.from(input.files).forEach(handleImageFile);
    };
    input.click();
  }

  // Image drop events dispatched from App.tsx
  createEffect(() => {
    async function handleImageDrop(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { tabId, paths } = e.detail ?? {};
      if (tabId !== options.tabId || !Array.isArray(paths)) return;
      lastDropHandledAt = Date.now();
      for (const p of paths) {
        if (typeof p !== "string") continue;
        try {
          const imported = await importImageFile(p);
          setAttachedImages(prev =>
            prev.some(img => img.path === imported.path)
              ? prev
              : [...prev, { name: p.split("/").pop() ?? "image", path: imported.path, mediaType: imported.mediaType }],
          );
        } catch (error: unknown) {
          console.warn("[chorus] image drop import failed:", error);
        }
      }
    }
    window.addEventListener("mlm-image-drop", handleImageDrop);
    onCleanup(() => window.removeEventListener("mlm-image-drop", handleImageDrop));
  });

  createEffect(() => {
    function handleDragState(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { tabId, over } = e.detail ?? {};
      setIsDragOver(tabId === options.tabId && over === true);
    }
    window.addEventListener("mlm-drag-state", handleDragState);
    onCleanup(() => window.removeEventListener("mlm-drag-state", handleDragState));
  });

  return {
    attachedImages,
    isDragOver,
    handlePaste,
    handleImageFile,
    removeImage,
    clearAll,
    openFilePicker,
  };
}
