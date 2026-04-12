import { createSignal, For, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { deleteTempImage } from "../../lib/commands";
import { SlashMenu, getFiltered } from "./slash-menu";
import { useTabStore } from "../../stores/tab-store";
import type { CliType, CliMode } from "../../types";
import styles from "./chat-panel.module.css";

const CLAUDE_MODES: CliMode[] = ["default", "plan", "dangerously-skip-permissions"];
const CODEX_MODES: CliMode[] = ["default", "dangerously-skip-permissions"];
const MODE_LABELS: Record<CliMode, string> = {
  default: "Default",
  plan: "Plan",
  "dangerously-skip-permissions": "Bypass permissions",
};

interface AttachedImage {
  name: string;
  path: string;
}

interface ChatInputProps {
  tabId: string;
  cliType: CliType;
  mode: CliMode;
  workingDir: string;
  isStreaming: boolean;
  attachedImages: AttachedImage[];
  onRemoveImage: (idx: number) => void;
  onSubmit: (text: string) => void;
  onSlashCommand: (id: string) => void;
  onPaste: (e: ClipboardEvent) => void;
  onInterrupt: () => void;
  inputHistory: string[];
}

export function ChatInput(props: ChatInputProps) {
  const store = useTabStore();
  const [inputText, setInputText] = createSignal("");
  const [isComposing, setIsComposing] = createSignal(false);
  const [showSlash, setShowSlash] = createSignal(false);
  const [slashFilter, setSlashFilter] = createSignal("");
  const [slashIdx, setSlashIdx] = createSignal(0);
  const [previewImage, setPreviewImage] = createSignal<string | null>(null);

  let compositionJustEnded = false;
  let historyIdx = -1;
  let draftBeforeHistory = "";
  let textareaRef: HTMLTextAreaElement | undefined;

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  const modes = () => props.cliType === "claude-code" ? CLAUDE_MODES : CODEX_MODES;

  function handleSubmit() {
    const text = inputText().trim();
    if (!text) return;
    props.inputHistory.unshift(text);
    historyIdx = -1;
    draftBeforeHistory = "";
    props.onSubmit(text);
    setInputText("");
    if (textareaRef) { textareaRef.style.height = "auto"; }
  }

  function selectSlashCommand(id: string) {
    setShowSlash(false);
    setSlashIdx(0);
    setInputText("");
    props.onSlashCommand(id);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isComposing() || compositionJustEnded) return;

    if (e.key === "Escape" && props.isStreaming) {
      e.preventDefault();
      props.onInterrupt();
      return;
    }

    if (showSlash()) {
      const items = getFiltered(slashFilter(), props.cliType);
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx(Math.min(slashIdx() + 1, items.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx(Math.max(slashIdx() - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const item = items[slashIdx()]; if (item) selectSlashCommand(item.id); return; }
      if (e.key === "Escape") { e.preventDefault(); setShowSlash(false); setInputText(""); return; }
    }

    if (e.key === "ArrowUp" && !e.shiftKey) {
      if (props.inputHistory.length === 0) return;
      e.preventDefault();
      if (historyIdx === -1) draftBeforeHistory = inputText();
      if (historyIdx < props.inputHistory.length - 1) { historyIdx++; setInputText(props.inputHistory[historyIdx]); }
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey) {
      if (historyIdx < 0) return;
      e.preventDefault();
      historyIdx--;
      setInputText(historyIdx >= 0 ? props.inputHistory[historyIdx] : draftBeforeHistory);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const m = modes();
      const idx = m.indexOf(props.mode);
      const next = m[(idx + 1) % m.length];
      store.updateMode(props.tabId, next);
    }
  }

  return (
    <div class={`${styles.inputWrapper} ${
      props.mode === "dangerously-skip-permissions" ? styles.inputWrapperDanger
      : props.mode === "plan" ? styles.inputWrapperPlan
      : ""
    } ${props.isStreaming ? styles.inputWrapperStreaming : ""}`} style={{ position: "relative" }}>
      <Show when={showSlash()}>
        <SlashMenu filter={slashFilter()} selectedIdx={slashIdx()} onSelect={selectSlashCommand} cliType={props.cliType} />
      </Show>
      <Show when={previewImage()}>
        {(path) => (
          <div class={styles.imagePreviewOverlay} onClick={() => setPreviewImage(null)}>
            <div class={styles.imagePreviewContent} onClick={(e) => e.stopPropagation()}>
              <img src={convertFileSrc(path())} class={styles.imagePreviewImg} alt="preview" />
              <button class={styles.imagePreviewClose} onClick={() => setPreviewImage(null)}>×</button>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.attachedImages.length > 0}>
        <div class={styles.attachedFiles}>
          <For each={props.attachedImages}>
            {(img, idx) => (
              <div class={styles.imageThumbnail} onClick={() => setPreviewImage(img.path)} style={{ cursor: "pointer" }}>
                <img src={convertFileSrc(img.path)} alt={img.name} class={styles.thumbnailImg} />
                <button class={styles.thumbnailRemove} onClick={(e) => {
                  e.stopPropagation();
                  deleteTempImage(img.path).catch(() => {});
                  props.onRemoveImage(idx());
                }}>×</button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={textareaRef}
        class={styles.textarea}
        value={inputText()}
        onInput={(e) => {
          const val = e.currentTarget.value;
          setInputText(val);
          autoResize(e.currentTarget);
          if (val.startsWith("/")) { setShowSlash(true); setSlashFilter(val.slice(1)); setSlashIdx(0); }
          else { setShowSlash(false); }
        }}
        onKeyDown={handleKeyDown}
        onPaste={props.onPaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => { setIsComposing(false); compositionJustEnded = true; setTimeout(() => { compositionJustEnded = false; }, 50); }}
        placeholder="Type a message…"
        rows={1}
      />
      <div class={styles.inputFooter}>
        <div class={styles.inputLeft}>
          <span class={styles.modeChevron}>»</span>
          <span
            class={`${styles.modeBadge} ${
              props.mode === "dangerously-skip-permissions" ? styles.modeDanger
              : props.mode === "plan" ? styles.modePlan
              : styles.modeDefault
            }`}
            onClick={() => {
              const m = modes();
              const idx = m.indexOf(props.mode);
              const next = m[(idx + 1) % m.length];
              store.updateMode(props.tabId, next);
            }}
            title="Shift+Tab to cycle"
          >
            {MODE_LABELS[props.mode]}
          </span>
          <span class={styles.inputProject}>
            ◇ {props.workingDir.split("/").pop() || "project"}
          </span>
        </div>
        <div class={styles.inputRight}>
          <span class={styles.inputHint} onClick={() => {
            setShowSlash(!showSlash());
            setSlashFilter("");
            if (!inputText().startsWith("/")) setInputText("/");
          }}>/</span>
          <button
            class={`${styles.sendBtn} ${
              props.mode === "dangerously-skip-permissions" ? styles.sendBtnDanger
              : props.mode === "plan" ? styles.sendBtnPlan
              : ""
            }`}
            onClick={handleSubmit}
            disabled={!inputText().trim()}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 14l11-6L3 2v5l6 1-6 1v5z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
