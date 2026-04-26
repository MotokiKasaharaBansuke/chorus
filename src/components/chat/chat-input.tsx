import { createSignal, For, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { SlashMenu, getFiltered } from "./slash-menu";
import { ImagePreviewModal } from "./image-preview-modal";
import { navigateHistory, type HistoryNavHandled } from "./input-history";
import { useTabStore } from "../../stores/tab-store";
import type { CliType, CliMode, AttachedImage } from "../../types";
import styles from "./chat-panel.module.css";

const CLAUDE_MODES: CliMode[] = ["default", "plan", "dangerously-skip-permissions"];
const CODEX_MODES: CliMode[] = ["default", "dangerously-skip-permissions"];
const MODE_LABELS: Record<CliMode, string> = {
  default: "Default",
  plan: "Plan",
  "dangerously-skip-permissions": "Bypass",
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
  onRequestReview?: () => void;
  isReviewInProgress?: boolean;
  inputHistory: readonly string[];
  onAppendHistory: (text: string) => void;
  contextIndicator?: {
    pct: number;
    color: string;
    tokens: number;
    windowSize: number;
    onCompact: () => void;
  };
}

const DONUT_RADIUS = 6;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

interface ContextDonutProps {
  pct: number;
  color: string;
  tokens: number;
  windowSize: number;
  isStreaming: boolean;
  onCompact: () => void;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function ContextDonut(props: ContextDonutProps) {
  const [tooltipStyle, setTooltipStyle] = createSignal<Record<string, string> | null>(null);
  const usedPct = () => Math.max(0, Math.min(100, Math.round(props.pct * 100)));
  const strokeDashoffset = () => DONUT_CIRCUMFERENCE * (1 - Math.min(props.pct, 1));
  let wrapRef: HTMLDivElement | undefined;

  return (
    <div
      ref={wrapRef}
      class={styles.contextDonutWrap}
      onMouseEnter={() => {
        if (!wrapRef) return;
        const r = wrapRef.getBoundingClientRect();
        setTooltipStyle({
          position: "fixed",
          left: `${Math.round(r.left + r.width / 2)}px`,
          top: `${Math.round(r.top - 8)}px`,
          transform: "translate(-50%, -100%)",
        });
      }}
      onMouseLeave={() => setTooltipStyle(null)}
      onClick={() => { if (!props.isStreaming) props.onCompact(); }}
      style={{ cursor: props.isStreaming ? "default" : "pointer" }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle
          cx="8" cy="8" r={DONUT_RADIUS}
          fill="none" stroke="#333" stroke-width="2.5"
        />
        <circle
          cx="8" cy="8" r={DONUT_RADIUS}
          fill="none" stroke={props.color} stroke-width="2.5"
          stroke-dasharray={DONUT_CIRCUMFERENCE}
          stroke-dashoffset={strokeDashoffset()}
          stroke-linecap="round"
          transform="rotate(-90 8 8)"
          style={{ transition: "stroke-dashoffset 0.4s ease, stroke 0.4s ease" }}
        />
      </svg>
      <Show when={tooltipStyle()}>
        {(st) => (
          <div class={styles.contextTooltip} style={st()}>
            <span>{formatTokens(props.tokens)} / {formatTokens(props.windowSize)} tokens ({usedPct()}%)</span>
            <span class={styles.contextTooltipAction}>Click to compact now.</span>
          </div>
        )}
      </Show>
    </div>
  );
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
  // Intentionally non-reactive: only consumed inside the keydown handler.
  // A signal would force a re-render on every ↑/↓ press without changing
  // any rendered output.
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

  function resetHistoryCursor() {
    historyIdx = -1;
    draftBeforeHistory = "";
  }

  function handleSubmit() {
    if (props.isStreaming) return;
    const text = inputText().trim();
    if (!text) return;
    props.onAppendHistory(text);
    resetHistoryCursor();
    props.onSubmit(text);
    setInputText("");
    if (textareaRef) { textareaRef.style.height = "auto"; }
  }

  function selectSlashCommand(id: string) {
    setShowSlash(false);
    setSlashIdx(0);
    setInputText("");
    resetHistoryCursor();
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

  function applyHistoryResult(result: HistoryNavHandled) {
    historyIdx = result.newHistoryIdx;
    draftBeforeHistory = result.newDraft;
    setInputText(result.newValue);
    if (!textareaRef) return;
    autoResize(textareaRef);
    // Drop the caret to the end so a follow-up ↑/↓ at that position keeps
    // stepping through history (first/last-line guard stays satisfied for
    // single-line entries; multi-line entries let the textarea handle
    // intra-text navigation first).
    const pos = result.newValue.length;
    textareaRef.setSelectionRange(pos, pos);
  }

  /** Returns true if the key was handled by input history navigation. */
  function handleHistoryKey(e: KeyboardEvent): boolean {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
    if (!textareaRef) return false;
    const result = navigateHistory({
      key: e.key,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      value: textareaRef.value,
      selectionStart: textareaRef.selectionStart,
      selectionEnd: textareaRef.selectionEnd,
      historyIdx,
      history: props.inputHistory,
      draft: draftBeforeHistory,
    });
    if (!result.handled) return false;
    e.preventDefault();
    applyHistoryResult(result);
    return true;
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
          <ImagePreviewModal src={convertFileSrc(path())} onClose={() => setPreviewImage(null)} />
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
          <Show when={props.onRequestReview}>
            <button
              class={styles.reviewBtn}
              onClick={() => props.onRequestReview?.()}
              disabled={props.isStreaming || props.isReviewInProgress}
              title="Send changed files for review"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                <path d="M1 3h14v1H1zM1 7h10v1H1zM1 11h12v1H1z" fill="currentColor"/>
                <path d="M12 6l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </Show>
          <span class={styles.inputHint} onClick={() => {
            setShowSlash(!showSlash());
            setSlashFilter("");
            if (!inputText().startsWith("/")) setInputText("/");
          }}>/</span>
          <Show when={props.contextIndicator}>
            {(indicator) => (
              <ContextDonut
                pct={indicator().pct}
                color={indicator().color}
                tokens={indicator().tokens}
                windowSize={indicator().windowSize}
                isStreaming={props.isStreaming}
                onCompact={indicator().onCompact}
              />
            )}
          </Show>
        </div>
        <div class={styles.inputRight}>
          <span class={styles.inputProject}>
            ◇ {props.workingDir.split("/").pop() || "project"}
          </span>
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
          <button
            class={styles.sendBtn}
            classList={{
              [styles.sendBtnDanger]: props.mode === "dangerously-skip-permissions",
              [styles.sendBtnPlan]: props.mode === "plan",
            }}
            onClick={props.isStreaming ? props.onInterrupt : handleSubmit}
            disabled={props.isStreaming ? false : !inputText().trim()}
          >
            {props.isStreaming ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect width="10" height="10" rx="2" fill="currentColor"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 14l11-6L3 2v5l6 1-6 1v5z" fill="currentColor"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
