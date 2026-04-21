import { createSignal, createEffect, onCleanup } from "solid-js";
import { saveTempImage, importImageFile, deleteTempImage } from "../lib/commands";
import type { AttachedImage } from "../types";

const WEB_SAFE_EXTS = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
export const DROP_DEDUP_WINDOW_MS = 500;

interface UseImageAttachmentOptions {
  tabId: string;
}

export function useImageAttachment(options: UseImageAttachmentOptions) {
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([]);
  const [isDragOver, setIsDragOver] = createSignal(false);
  let lastDropHandledAt = 0;

  async function handleImageFile(file: File) {
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    const isWebSafe = WEB_SAFE_EXTS.has(ext);

    try {
      let base64: string;
      let saveExt: string;

      if (isWebSafe) {
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(
            typeof reader.result === "string" ? (reader.result.split(",")[1] ?? "") : "",
          );
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        saveExt = ext === "jpg" ? "jpeg" : ext;
      } else {
        base64 = await new Promise<string>((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) { reject(new Error("canvas 2d context unavailable")); return; }
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/png").split(",")[1] ?? "");
          };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load failed")); };
          img.src = url;
        });
        saveExt = "png";
      }

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
