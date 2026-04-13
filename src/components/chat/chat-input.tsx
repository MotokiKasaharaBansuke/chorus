import { createSignal, For, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { SlashMenu, getFiltered } from "./slash-menu";
import { useTabStore } from "../../stores/tab-store";
import type { CliType, CliMode, AttachedImage } from "../../types";
import styles from "./chat-panel.module.css";

const CLAUDE_MODES: CliMode[] = ["default", "plan", "dangerously-skip-permissions"];
const MAX_INPUT_HISTORY = 200;
const CODEX_MODES: CliMode[] = ["default", "dangerously-skip-permissions"];
const MODE_LABELS: Record<CliMode, string> = {
  default: "Default",
  plan: "Plan",
  "dangerously-skip-permissions": "Bypass permissions",
};

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

  let isCompositionJustEnded = false;
  let historyIdx = -1;
  let draftBeforeHistory = "";
  let textareaRef: HTMLTextAreaElement | undefined;

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  const modes = () => props.cliType === "claude-code" ? CLAUDE_MODES : CODEX_MODES;

  function cycleMode() {
    const available = modes();
    const nextMode = available[(available.indexOf(props.mode) + 1) % available.length];
    store.updateMode(props.tabId, nextMode);
  }

  function handleSubmit() {
    if (props.isStreaming) return;
    const text = inputText().trim();
    if (!text) return;
    props.inputHistory.unshift(text);
    if (props.inputHistory.length > MAX_INPUT_HISTORY) props.inputHistory.length = MAX_INPUT_HISTORY;
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

  /** Returns true if the key was handled by the slash menu. */
  function handleSlashMenuKey(e: KeyboardEvent): boolean {
    const items = getFiltered(slashFilter(), props.cliType);
    if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx(Math.min(slashIdx() + 1, items.length - 1)); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx(Math.max(slashIdx() - 1, 0)); return true; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const item = items[slashIdx()]; if (item) selectSlashCommand(item.id); return true; }
    if (e.key === "Escape") { e.preventDefault(); setShowSlash(false); setInputText(""); return true; }
    return false;
  }

  /** Returns true if the key was handled by input history navigation. */
  function handleHistoryKey(e: KeyboardEvent): boolean {
    if (e.key === "ArrowUp" && !e.shiftKey && props.inputHistory.length > 0) {
      e.preventDefault();
      if (historyIdx === -1) draftBeforeHistory = inputText();
      if (historyIdx < props.inputHistory.length - 1) { historyIdx++; setInputText(props.inputHistory[historyIdx]); }
      return true;
    }
    if (e.key === "ArrowDown" && !e.shiftKey && historyIdx >= 0) {
      e.preventDefault();
      historyIdx--;
      setInputText(historyIdx >= 0 ? props.inputHistory[historyIdx] : draftBeforeHistory);
      return true;
    }
    return false;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isComposing() || isCompositionJustEnded) return;
    if (e.key === "Escape" && props.isStreaming) { e.preventDefault(); props.onInterrupt(); return; }
    if (showSlash() && handleSlashMenuKey(e)) return;
    if (handleHistoryKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); }
  }

  return (
    <div
      class={styles.inputWrapper}
      classList={{
        [styles.inputWrapperDanger]: props.mode === "dangerously-skip-permissions",
        [styles.inputWrapperPlan]: props.mode === "plan",
        [styles.inputWrapperStreaming]: props.isStreaming,
      }}
      style={{ position: "relative" }}
    >
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
        onCompositionEnd={() => { setIsComposing(false); isCompositionJustEnded = true; setTimeout(() => { isCompositionJustEnded = false; }, 50); }}
        placeholder="Type a message…"
        rows={1}
      />
      <div class={styles.inputFooter}>
        <div class={styles.inputLeft}>
          <span class={styles.modeChevron}>»</span>
          <span
            class={styles.modeBadge}
            classList={{
              [styles.modeDanger]: props.mode === "dangerously-skip-permissions",
              [styles.modePlan]: props.mode === "plan",
              [styles.modeDefault]: props.mode === "default",
            }}
            onClick={cycleMode}
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
            class={styles.sendBtn}
            classList={{
              [styles.sendBtnDanger]: props.mode === "dangerously-skip-permissions",
              [styles.sendBtnPlan]: props.mode === "plan",
            }}
            onClick={handleSubmit}
            disabled={!inputText().trim() || props.isStreaming}
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
