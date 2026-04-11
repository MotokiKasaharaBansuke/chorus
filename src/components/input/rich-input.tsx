import { createSignal, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writePty } from "../../lib/commands";
import { saveTempImage, deleteTempImage } from "../../lib/commands";
import styles from "./rich-input.module.css";

interface RichInputProps {
  ptyId: string;
  cliType: string;
}

export function RichInput(props: RichInputProps) {
  const [text, setText] = createSignal("");
  const [images, setImages] = createSignal<string[]>([]);
  const [isComposing, setIsComposing] = createSignal(false);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);

  async function handleSubmit() {
    const content = text().trim();
    if (!content && images().length === 0) return;

    // Send images first if any
    for (const imgPath of images()) {
      if (props.cliType === "claude-code") {
        await writePty(props.ptyId, `/image ${imgPath}\n`);
      }
      // Clean up temp file after sending
      try { await deleteTempImage(imgPath); } catch { /* ignore */ }
    }

    // Send text
    if (content) {
      await writePty(props.ptyId, content + "\n");
    }

    setText("");
    setImages([]);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isComposing()) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(",")[1];
          const ext = file.type.split("/")[1] ?? "png";
          try {
            const path = await saveTempImage(base64, ext);
            setImages(prev => [...prev, path]);
          } catch { /* ignore */ }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = (reader.result as string).split(",")[1];
          const ext = file.type.split("/")[1] ?? "png";
          try {
            const path = await saveTempImage(base64, ext);
            setImages(prev => [...prev, path]);
          } catch { /* ignore */ }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  function removeImage(index: number) {
    const imgPath = images()[index];
    setImages(prev => prev.filter((_, i) => i !== index));
    if (imgPath) {
      deleteTempImage(imgPath).catch(() => {});
    }
  }

  return (
    <div
      class={styles.container}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <Show when={previewPath()}>
        {(path) => (
          <div class={styles.modalOverlay} onClick={() => setPreviewPath(null)}>
            <div class={styles.modalContent} onClick={(e) => e.stopPropagation()}>
              <img src={convertFileSrc(path())} class={styles.modalImage} alt="preview" />
              <button class={styles.modalClose} onClick={() => setPreviewPath(null)}>×</button>
            </div>
          </div>
        )}
      </Show>
      {images().length > 0 && (
        <div class={styles.imageBar}>
          {images().map((path, i) => (
            <div class={styles.imageThumb} onClick={() => setPreviewPath(path)}>
              <img src={convertFileSrc(path)} class={styles.imagePreview} alt="attachment" />
              <button
                class={styles.imageRemove}
                onClick={(e) => { e.stopPropagation(); removeImage(i); }}
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
        <button class={styles.sendBtn} onClick={handleSubmit}>
          ↑
        </button>
      </div>
    </div>
  );
}
