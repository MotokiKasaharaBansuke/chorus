import { For, Show, createMemo, createSignal, createEffect, onCleanup, Index } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ChatMessage, ChatBlock } from "../../types";
import { escapeHtml, highlightDiffLine } from "../../lib/format/html";
import { applyInline as applyInlineRaw } from "../../lib/format/inline";
import { formatInline } from "../../lib/format/markdown";
import { isValidTempImagePath } from "../../lib/validate-path";
import styles from "./chat-panel.module.css";

interface MessageBubbleProps {
  message: ChatMessage;
}

function renderMarkdown(text: string) {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/);
  return (
    <div class={styles.markdown}>
      <For each={parts}>
        {(part) => {
          if (part.startsWith("```")) {
            const inner = part.slice(3, -3);
            const lines = inner.split("\n");
            const lang = lines[0]?.trim() || undefined;
            const codeLines = lang ? lines.slice(1) : lines;
            // Strip leading/trailing empty lines
            while (codeLines.length > 0 && codeLines[0] === "") codeLines.shift();
            while (codeLines.length > 0 && codeLines[codeLines.length - 1] === "") codeLines.pop();
            const code = codeLines.join("\n");
            return (
              <div class={styles.codeBlock}>
                <Show when={lang}><div class={styles.codeLang}>{lang}</div></Show>
                <pre class={styles.codeContent}><code>{code}</code></pre>
              </div>
            );
          }
          return <span innerHTML={formatInline(part, applyInline, styles)} />;
        }}
      </For>
    </div>
  );
}


/** Bind applyInline to this module's CSS classes */
function applyInline(text: string): string {
  return applyInlineRaw(text, { mdLink: styles.mdLink, inlineCode: styles.inlineCode });
}

// --- Edit tool helpers ---

const EDIT_TOOL_NAMES = new Set(["Edit", "str_replace_editor", "EditFile", "MultiEdit"]);

interface EditInput { filePath: string; oldStr: string; newStr: string }

function toRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseEditInput(input: string): EditInput | null {
  try {
    const obj = toRecord(JSON.parse(input));
    if (!obj) return null;
    const filePath = str(obj.file_path ?? obj.path);
    const oldStr = str(obj.old_string ?? obj.oldText ?? obj.old_str);
    const newStr = str(obj.new_string ?? obj.newText ?? obj.new_str);
    if (!filePath) return null;
    return { filePath, oldStr, newStr };
  } catch { return null; }
}

function EditDiffView(props: { edit: EditInput; result?: { isError: boolean; output: string } }) {
  const oldLines = () => props.edit.oldStr ? props.edit.oldStr.split("\n") : [];
  const newLines = () => props.edit.newStr ? props.edit.newStr.split("\n") : [];
  const fileName = () => {
    const parts = props.edit.filePath.split("/");
    return parts[parts.length - 1] ?? props.edit.filePath;
  };

  const diffText = () => {
    const removed = oldLines().map(l => `- ${l}`).join("\n");
    const added = newLines().map(l => `+ ${l}`).join("\n");
    return [removed, added].filter(Boolean).join("\n");
  };

  const statusLabel = () => {
    if (props.result?.isError) return "Edit failed";
    if (props.result) return "Modified";
    return "";
  };

  return (
    <>
      <div class={styles.editDiffHeader}>
        <span class={styles.editFileName}>{fileName()}</span>
        <Show when={newLines().length > 0}>
          <span class={styles.editBadgeAdded}>+{newLines().length}</span>
        </Show>
        <Show when={oldLines().length > 0}>
          <span class={styles.editBadgeRemoved}>-{oldLines().length}</span>
        </Show>
      </div>
      <Show when={statusLabel()}>
        <div class={styles.editStatus}>{statusLabel()}</div>
      </Show>
      <pre
        class={styles.editDiffPre}
        onClick={() => openContentAsTab(`Edit ${fileName()}`, diffText())}
      >
        <Index each={oldLines()}>
          {(line) => <div class={styles.diffRemoved}><span class={styles.diffSign}>-</span><span innerHTML={highlightDiffLine(line())} /></div>}
        </Index>
        <Index each={newLines()}>
          {(line) => <div class={styles.diffAdded}><span class={styles.diffSign}>+</span><span innerHTML={highlightDiffLine(line())} /></div>}
        </Index>
      </pre>
    </>
  );
}

/** Dispatch event to open content as a read-only tab (handled by App.tsx) */
function openContentAsTab(title: string, content: string) {
  window.dispatchEvent(new CustomEvent("mlm-open-content", {
    detail: { title, content },
  }));
}


/** Text short enough to show without fade mask (~3 lines) */
function isShortText(text: string): boolean {
  return text.length < 150 && text.split("\n").length <= 3;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function isDiff(text: string): boolean {
  const lines = text.split("\n").slice(0, 15);
  // Require @@ hunk header — plain +/- lines alone (e.g. vitest output) are NOT diffs
  return lines.some(l => l.startsWith("@@")) &&
    lines.some(l => l.startsWith("+") || l.startsWith("-"));
}

function DiffOutput(props: { text: string }) {
  const lines = () => props.text.split("\n");
  return (
    <pre class={styles.diffPre}>
      <Index each={lines()}>
        {(line) => {
          const l = line();
          const cls = l.startsWith("+++") || l.startsWith("---") ? styles.diffMeta
            : l.startsWith("+") ? styles.diffAdded
            : l.startsWith("-") ? styles.diffRemoved
            : l.startsWith("@@") ? styles.diffHunk
            : styles.diffCtx;
          return <div class={cls}>{l || " "}</div>;
        }}
      </Index>
    </pre>
  );
}

function ThinkingBlock(props: { block: ChatBlock & { kind: "thinking" }; isLast: boolean }) {
  const dotClass = () => props.block.isStreaming ? styles.dotProgress : styles.dotSuccess;
  return (
    <div class={`${styles.timelineRow} ${dotClass()}`}>
      <details class={styles.thinking} open={props.block.isStreaming}>
        <summary class={styles.thinkingSummary}>
          {props.block.isStreaming ? "Thinking…" : "Thinking"}
        </summary>
        <div class={styles.thinkingContent}>{props.block.text}</div>
      </details>
    </div>
  );
}

function ToolUseBlock(props: {
  block: ChatBlock & { kind: "tool_use" };
  result?: ChatBlock & { kind: "tool_result" };
}) {
  const dotClass = () => {
    if (props.block.isStreaming) return styles.dotProgress;
    if (props.result?.isError) return styles.dotFailure;
    return styles.dotSuccess;
  };

  const description = createMemo(() => {
    try {
      const obj = toRecord(JSON.parse(props.block.input));
      return str(obj?.description);
    } catch { return ""; }
  });

  const editInput = createMemo(() =>
    EDIT_TOOL_NAMES.has(props.block.toolName) ? parseEditInput(props.block.input) : null
  );

  const isTodoWrite = () => props.block.toolName === "TodoWrite";

  const todoItems = createMemo(() => {
    if (!isTodoWrite()) return null;
    try {
      const obj = toRecord(JSON.parse(props.block.input));
      if (!obj || !Array.isArray(obj.todos)) return null;
      return obj.todos.map(item => {
        const t = toRecord(item);
        return {
          content: str(t?.content),
          status: str(t?.status) || "pending",
        };
      });
    } catch { return null; }
  });

  const inputDisplay = createMemo(() => {
    if (isTodoWrite()) return null; // Rendered separately as checklist
    try {
      const obj = toRecord(JSON.parse(props.block.input));
      if (!obj) return props.block.input;
      if (typeof obj.command === "string") return obj.command;
      if (typeof obj.file_path === "string") {
        let s = obj.file_path;
        if (typeof obj.offset === "number") s += ` (lines ${obj.offset}-${obj.offset + (typeof obj.limit === "number" ? obj.limit : 100)})`;
        return s;
      }
      if (typeof obj.pattern === "string") return obj.pattern;
      if (typeof obj.path === "string") return obj.path;
      return props.block.input;
    } catch { return props.block.input; }
  });

  return (
    <div class={`${styles.timelineRow} ${dotClass()}`}>
      <div class={styles.toolContent}>
        <div class={styles.toolHeader}>
          <span class={styles.toolName}>{props.block.toolName}</span>
          <Show when={!editInput() && description()}>
            <span class={styles.toolDesc}>{description()}</span>
          </Show>
          <Show when={props.block.isStreaming}>
            <span class={styles.toolAnnotation}>running</span>
          </Show>
          <Show when={props.result?.isError}>
            <span class={`${styles.toolAnnotation} ${styles.toolAnnotationDestructive}`}>error</span>
          </Show>
        </div>
        <div class={styles.toolBlock}>
          <Show when={todoItems()}>
            {(items) => (
              <div style={{ padding: "6px 10px" }}>
                <For each={items()}>
                  {(item) => {
                    const done = item.status === "completed";
                    const inProgress = item.status === "in_progress";
                    return (
                      <div style={{ display: "flex", "align-items": "baseline", gap: "6px", padding: "1px 0", "font-size": "11px" }}>
                        <span style={{ color: done ? "#666" : inProgress ? "#58a6ff" : "#555", "font-size": "10px", "flex-shrink": "0" }}>
                          {done ? "✓" : inProgress ? "●" : "○"}
                        </span>
                        <span style={{ color: done ? "#666" : "#aaa", "text-decoration": done ? "line-through" : "none" }}>
                          {item.content}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            )}
          </Show>
          <Show when={!isTodoWrite()}>
          <Show when={editInput()} fallback={
            <div class={styles.toolBodyGrid}>
              <Show when={inputDisplay()}>
                <div class={styles.toolBodyRow}>
                  <div class={styles.toolLabel}>IN</div>
                  <div
                    class={styles.toolValue}
                    onClick={() => openContentAsTab(`${props.block.toolName} — Input`, inputDisplay() ?? "")}
                  >{inputDisplay()}</div>
                </div>
              </Show>
              <Show when={props.result}>
                {(r) => (
                  <div class={`${styles.toolBodyRow} ${r().isError ? styles.toolSectionError : ""}`}>
                    <div class={`${styles.toolLabel} ${r().isError ? styles.toolLabelError : ""}`}>
                      {r().isError ? "ERR" : "OUT"}
                    </div>
                    <Show when={!r().isError && isDiff(r().output)} fallback={
                      <div
                        class={styles.toolValue}
                        onClick={() => openContentAsTab(`${props.block.toolName} — Output`, r().output)}
                      >{r().output}</div>
                    }>
                      <DiffOutput text={r().output} />
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          }>
            {(edit) => <EditDiffView edit={edit()} result={props.result ?? undefined} />}
          </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function TextBlock(props: { text: string; isLast: boolean; isStreaming: boolean }) {
  const dotClass = () => props.isStreaming && props.isLast ? styles.dotProgress : styles.dotSuccess;
  return (
    <div class={`${styles.timelineRow} ${dotClass()}`}>
      <div class={styles.textContent}>
        {renderMarkdown(props.text)}
        <Show when={props.isStreaming && props.isLast}>
          <span class={styles.cursor}>▊</span>
        </Show>
      </div>
    </div>
  );
}

export function MessageBubble(props: MessageBubbleProps) {
  const msg = () => props.message;
  const [previewSrc, setPreviewSrc] = createSignal<string | null>(null);

  createEffect(() => {
    if (!previewSrc()) return;
    const dismissOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewSrc(null);
    };
    document.addEventListener("keydown", dismissOnEscape);
    onCleanup(() => document.removeEventListener("keydown", dismissOnEscape));
  });

  return (
    <div class={`${styles.message} ${styles[msg().role]}`}>
      <Show when={msg().role === "user"}>
        <div class={styles.userBubble}>
          <For each={msg().blocks}>
            {(block) => {
              if (block.kind === "image") {
                if (!isValidTempImagePath(block.path)) return null;
                const [hasError, setHasError] = createSignal(false);
                const truncatedName = truncate(block.name, 64);
                const src = convertFileSrc(block.path);
                return (
                  <Show when={!hasError()} fallback={
                    <span class={styles.userImageFallback}>{truncatedName}</span>
                  }>
                    <div
                      class={`${styles.imageThumbnail} ${styles.imageThumbnailClickable}`}
                      onClick={() => setPreviewSrc(src)}
                    >
                      <img
                        src={src}
                        alt={truncatedName}
                        class={styles.thumbnailImg}
                        onError={() => setHasError(true)}
                      />
                    </div>
                  </Show>
                );
              }
              if (block.kind === "text") {
                return <div class={styles.userText}>{block.text}</div>;
              }
              return null;
            }}
          </For>
        </div>
        <Show when={previewSrc()}>
          {(src) => (
            <div
              class={styles.imagePreviewOverlay}
              role="dialog"
              aria-modal="true"
              aria-label="Image preview"
              onClick={() => setPreviewSrc(null)}
            >
              <div class={styles.imagePreviewContent} onClick={(e) => e.stopPropagation()}>
                <img
                  src={src()}
                  class={styles.imagePreviewImg}
                  alt="Preview"
                  onError={() => setPreviewSrc(null)}
                />
                <button
                  class={styles.imagePreviewClose}
                  aria-label="Close preview"
                  onClick={() => setPreviewSrc(null)}
                >×</button>
              </div>
            </div>
          )}
        </Show>
      </Show>

      <Show when={msg().role === "assistant"}>
        <div class={styles.assistantContent}>
          <For each={msg().blocks}>
            {(block, index) => {
              const isLast = () => index() === msg().blocks.length - 1;
              switch (block.kind) {
                case "text":
                  return <TextBlock text={block.text} isLast={isLast()} isStreaming={msg().isStreaming} />;
                case "thinking":
                  return <ThinkingBlock block={block} isLast={isLast()} />;
                case "tool_use": {
                  // Find matching tool_result anywhere in blocks
                  const result = msg().blocks.find(
                    b => b.kind === "tool_result" && b.toolId === block.toolId
                  ) as (ChatBlock & { kind: "tool_result" }) | undefined;
                  return <ToolUseBlock block={block} result={result} />;
                }
                case "tool_result":
                  // Skip - already rendered inline with tool_use above
                  return null;
                case "stderr":
                  return (
                    <div class={`${styles.timelineRow} ${styles.dotWarning}`}>
                      <div class={styles.stderr}>{block.text}</div>
                    </div>
                  );
                default:
                  return null;
              }
            }}
          </For>
          {/* Busy state is shown as BusySpinner above input instead */}
          <Show when={!msg().isStreaming && msg().costUsd}>
            <div class={styles.meta}>
              {msg().inputTokens && `${msg().inputTokens} in`}
              {msg().outputTokens && ` → ${msg().outputTokens} out`}
              {msg().costUsd && ` · $${(msg().costUsd ?? 0).toFixed(4)}`}
              {msg().durationMs && ` · ${((msg().durationMs ?? 0) / 1000).toFixed(1)}s`}
            </div>
          </Show>
        </div>
      </Show>

      <Show when={msg().role === "system"}>
        <For each={msg().blocks}>
          {(block) => block.kind === "stderr"
            ? <div class={styles.interrupted}>{block.text}</div>
            : block.kind === "text"
            ? <div class={styles.systemMsg}><span>{block.text}</span></div>
            : null
          }
        </For>
      </Show>
    </div>
  );
}
