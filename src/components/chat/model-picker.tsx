import { For, Show, createSignal, onMount, onCleanup } from "solid-js";
import type { CliType } from "../../types";
import styles from "./chat-panel.module.css";

interface ModelOption {
  id: string;
  label: string;
  desc: string;
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: "", label: "Default (recommended)", desc: "Opus 4.6 with 1M context [NEW] · Most capable for complex work" },
  { id: "claude-sonnet-4-6", label: "Sonnet", desc: "Sonnet 4.6 · Best for everyday tasks" },
  { id: "claude-sonnet-4-6-1m", label: "Sonnet (1M context)", desc: "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku", desc: "Haiku 4.5 · Fastest for quick answers" },
];

const CODEX_MODELS: ModelOption[] = [
  { id: "", label: "Default (recommended)", desc: "o4-mini · Optimized for coding tasks" },
  { id: "o3", label: "o3", desc: "Most capable reasoning model" },
  { id: "gpt-4.1", label: "GPT-4.1", desc: "Latest GPT-4.1 model" },
  { id: "o4-mini", label: "o4-mini", desc: "Fast and efficient for coding" },
  { id: "codex-mini-latest", label: "Codex Mini", desc: "Lightweight coding model" },
];

interface ModelPickerProps {
  cliType: CliType;
  currentModel?: string;
  containerEl?: HTMLDivElement;
  onSelect: (model: string) => void;
  onClose: () => void;
}

export function ModelPicker(props: ModelPickerProps) {
  const models = () => props.cliType === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
  const currentId = () => props.currentModel ?? "";
  const initialIdx = () => Math.max(0, models().findIndex(m => m.id === currentId()));
  const [focusedIdx, setFocusedIdx] = createSignal(initialIdx());

  const handleKeyDown = (e: KeyboardEvent) => {
    const list = models();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx(i => (i + 1) % list.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(i => (i - 1 + list.length) % list.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const model = list[focusedIdx()];
      if (model) { props.onSelect(model.id); props.onClose(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => window.addEventListener("keydown", handleKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown, true));

  return (
    <div class={styles.pickerOverlay} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class={styles.pickerModal}>
        <div class={styles.pickerTitle}>Select a model</div>
        <For each={models()}>
          {(model, idx) => {
            const isSelected = () => currentId() === model.id;
            const isFocused = () => focusedIdx() === idx();
            return (
              <div
                class={`${styles.pickerItem} ${isSelected() ? styles.pickerItemSelected : ""} ${isFocused() ? styles.pickerItemFocused : ""}`}
                onClick={() => { props.onSelect(model.id); props.onClose(); }}
                onMouseEnter={() => setFocusedIdx(idx())}
              >
                <div>
                  <div class={styles.pickerItemLabel}>{model.label}</div>
                  <div class={styles.pickerItemDesc}>{model.desc}</div>
                </div>
                <Show when={isSelected()}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
