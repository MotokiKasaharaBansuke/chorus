import { createSignal, For, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isValidTempImagePath } from "../../lib/validate-path";
import { ImagePreviewModal } from "./image-preview-modal";
import type { ChatMessage } from "../../types";
import styles from "./chat-panel.module.css";

interface StickyPromptHeaderProps {
  message: ChatMessage;
}

export function StickyPromptHeader(props: StickyPromptHeaderProps) {
  const [previewSrc, setPreviewSrc] = createSignal<string | null>(null);

  const textBlocks = () =>
    props.message.blocks.filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text");

  const imageBlocks = () =>
    props.message.blocks.filter((b): b is Extract<typeof b, { kind: "image" }> => b.kind === "image");

  return (
    <>
      <div class={styles.stickyHeader}>
        <div class={styles.stickyHeaderContent}>
          <For each={textBlocks()}>
            {(block) => (
              <span class={styles.stickyHeaderText}>{block.text}</span>
            )}
          </For>
          <Show when={imageBlocks().length > 0}>
            <div class={styles.stickyHeaderImages}>
              <For each={imageBlocks()}>
                {(block) => {
                  if (!isValidTempImagePath(block.path)) return null;
                  const src = convertFileSrc(block.path);
                  return (
                    <div
                      class={styles.stickyHeaderThumb}
                      onClick={() => setPreviewSrc(src)}
                    >
                      <img src={src} alt={block.name} class={styles.stickyHeaderThumbImg} />
                      <span class={styles.stickyHeaderThumbLabel}>{block.name}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <Show when={previewSrc()}>
        {(src) => (
          <ImagePreviewModal src={src()} onClose={() => setPreviewSrc(null)} />
        )}
      </Show>
    </>
  );
}
