import { createEffect, onCleanup } from "solid-js";
import styles from "./chat-panel.module.css";

interface ImagePreviewModalProps {
  src: string;
  onClose: () => void;
}

export function ImagePreviewModal(props: ImagePreviewModalProps) {
  createEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", handleEscape);
    onCleanup(() => document.removeEventListener("keydown", handleEscape));
  });

  return (
    <div
      class={styles.imagePreviewOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={() => props.onClose()}
    >
      <div class={styles.imagePreviewContent} onClick={(e) => e.stopPropagation()}>
        <img
          src={props.src}
          class={styles.imagePreviewImg}
          alt="Preview"
          onError={() => props.onClose()}
        />
        <button
          class={styles.imagePreviewClose}
          aria-label="Close preview"
          onClick={() => props.onClose()}
        >{"\u00d7"}</button>
      </div>
    </div>
  );
}
