import { createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writePty, saveTempImage, deleteTempImage } from "../../lib/commands";
import type { CliType } from "../../types";
import styles from "./rich-input.module.css";

const MAX_IMAGES = 5;
// Must match MAX_IMAGE_BYTES in src-tauri/src/commands/image_commands.rs.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Maps allowed image MIME types to file extensions. Acts as an allowlist. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/x-png": "png",
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface RichInputProps {
  ptyId: string;
  cliType: CliType;
}

export function RichInput(props: RichInputProps) {
  const [text, setText] = createSignal("");
  const [images, setImages] = createSignal<string[]>([]);
  const [isComposing, setIsComposing] = createSignal(false);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [previewImagePath, setPreviewImagePath] = createSignal<string | null>(null);
  const [attachError, setAttachError] = createSignal<string | null>(null);

  function discardImage(path: string) {
    deleteTempImage(path).catch((err: unknown) => {
      setAttachError(`画像の削除に失敗しました: ${toErrorMessage(err)}`);
    });
  }

  async function handleSubmit() {
    if (isSubmitting()) return;
    const content = text().trim();
    if (!content && images().length === 0) return;

    setIsSubmitting(true);
    try {
      const pendingImagePaths = images();
      // Send images first — only for CLIs that support the /image command.
      if (props.cliType === "claude-code") {
        for (const imgPath of pendingImagePaths) {
          await writePty(props.ptyId, `/image ${imgPath}\n`);
        }
      }
      if (content) {
        await writePty(props.ptyId, content + "\n");
      }
      // Only clear state and delete temp files after all writes succeed.
      setText("");
      setImages([]);
      for (const imgPath of pendingImagePaths) {
        discardImage(imgPath);
      }
    } catch (err) {
      setAttachError(`送信に失敗しました: ${toErrorMessage(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isComposing()) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("FileReader did not return a string"));
      };
      reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
      reader.readAsDataURL(file);
    });
  }

  async function attachImageFile(file: File) {
    if (props.cliType !== "claude-code") {
      setAttachError("画像添付はClaude Codeのみサポートされています");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setAttachError("画像ファイルが大きすぎます (最大 20MB)");
      return;
    }
    const ext = MIME_TO_EXT[file.type.toLowerCase()];
    if (!ext) {
      setAttachError(`サポートされていない画像形式です: ${file.type}`);
      return;
    }
    if (images().length >= MAX_IMAGES) {
      setAttachError(`一度に添付できる画像は ${MAX_IMAGES} 枚までです`);
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      // Use indexOf for the first comma — RFC 2397 data portion may contain commas.
      const commaIndex = dataUrl.indexOf(",");
      const base64Data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
      if (!base64Data) {
        setAttachError("画像データの読み取りに失敗しました (Data URL の形式が不正です)");
        return;
      }
      setAttachError(null);
      const path = await saveTempImage(base64Data, ext);
      setImages(prev => [...prev, path]);
    } catch (err) {
      setAttachError(`画像の保存に失敗しました: ${toErrorMessage(err)}`);
    }
  }

  async function attachImageFiles(files: File[]) {
    // Limit to remaining slots; final guard is in attachImageFile.
    // Sequential to avoid MAX_IMAGES race when multiple files are processed concurrently.
    const slots = MAX_IMAGES - images().length;
    for (const file of files.slice(0, slots)) {
      await attachImageFile(file);
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = Array.from(items)
      .filter(item => item.type.startsWith("image/"))
      .flatMap(item => { const f = item.getAsFile(); return f ? [f] : []; });
    if (imageFiles.length > 0) e.preventDefault();
    await attachImageFiles(imageFiles);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    const imageFiles = Array.from(e.dataTransfer?.files ?? []).filter(f =>
      f.type.startsWith("image/")
    );
    await attachImageFiles(imageFiles);
  }

  function removeImage(imgPath: string) {
    setImages(prev => prev.filter(p => p !== imgPath));
    discardImage(imgPath);
  }

  return (
    <div
      class={styles.container}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <Show when={previewImagePath()}>
        {(path) => (
          <div class={styles.modalOverlay} onClick={() => setPreviewImagePath(null)}>
            <div class={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <img src={convertFileSrc(path())} class={styles.modalImage} alt="preview" />
              <button class={styles.modalClose} onClick={() => setPreviewImagePath(null)}>×</button>
            </div>
          </div>
        )}
      </Show>
      <Show when={attachError()}>
        {(msg) => (
          <div class={styles.saveError} role="alert">
            {msg()}
            <button class={styles.saveErrorDismiss} onClick={() => setAttachError(null)}>×</button>
          </div>
        )}
      </Show>
      {images().length > 0 && (
        <div class={styles.imageBar}>
          {images().map((path) => (
            <div class={styles.imageThumb} onClick={() => setPreviewImagePath(path)}>
              <img src={convertFileSrc(path)} class={styles.imagePreview} alt="attachment" />
              <button
                class={styles.imageRemove}
                onClick={(e) => { e.stopPropagation(); removeImage(path); }}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <div class={styles.inputRow}>
        <textarea
          class={styles.textarea}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={1}
        />
        <button class={styles.sendBtn} onClick={handleSubmit} disabled={isSubmitting()}>
          ↑
        </button>
      </div>
    </div>
  );
}
