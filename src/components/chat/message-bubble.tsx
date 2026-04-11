import { For, Show, createMemo, Index } from "solid-js";
import type { ChatMessage, ChatBlock } from "../../types";
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
          return <span innerHTML={formatInline(part)} />;
        }}
      </For>
    </div>
  );
}

function flushTable(tableLines: string[]): string {
  const rows = tableLines
    .map(line => line.split("|").slice(1, -1).map(c => c.trim()))
    .filter(row => !row.every(c => /^[-: ]+$/.test(c)));
  if (rows.length === 0) return "";
  const [headers, ...data] = rows;
  const ths = (headers ?? []).map(h => `<th>${applyInline(h)}</th>`).join("");
  const trs = data.map(row =>
    `<tr>${row.map(cell => `<td>${applyInline(cell)}</td>`).join("")}</tr>`
  ).join("");
  return `<table class="${styles.mdTable}"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function formatInline(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inList = false;
  let tableLines: string[] = [];

  const flushList = () => { if (inList) { result.push("</ul>"); inList = false; } };
  const flushTableBlock = () => {
    if (tableLines.length > 0) {
      result.push(flushTable(tableLines));
      tableLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Table row
    if (line.match(/^\|/)) {
      flushList();
      tableLines.push(rawLine); // raw (unescaped) for re-parsing
      continue;
    }
    flushTableBlock();

    // Headings
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      flushList();
      result.push(`<h4 class="${styles.mdH3}">${applyInline(h3Match[1])}</h4>`);
      continue;
    }
    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      flushList();
      result.push(`<h3 class="${styles.mdH2}">${applyInline(h2Match[1])}</h3>`);
      continue;
    }
    const h1Match = line.match(/^# (.+)/);
    if (h1Match) {
      flushList();
      result.push(`<h2 class="${styles.mdH1}">${applyInline(h1Match[1])}</h2>`);
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      flushList();
      result.push(`<hr class="${styles.mdHr}"/>`);
      continue;
    }

    // Unordered list
    const liMatch = line.match(/^[-*] (.+)/);
    if (liMatch) {
      if (!inList) { result.push(`<ul class="${styles.mdList}">`); inList = true; }
      result.push(`<li>${applyInline(liMatch[1])}</li>`);
      continue;
    }

    if (inList && line.trim() === "") {
      flushList();
      result.push("<br/>");
      continue;
    }
    if (inList) flushList();

    if (line.trim() === "") {
      result.push("<br/>");
      continue;
    }

    result.push(applyInline(line));
    result.push("<br/>");
  }

  flushList();
  flushTableBlock();
  return result.join("");
}

function applyInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, `<code class="${styles.inlineCode}">$1</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a class="${styles.mdLink}" href="$2">$1</a>`);
}

function isDiff(text: string): boolean {
  const lines = text.split("\n").slice(0, 10);
  return lines.some(l => l.startsWith("+") || l.startsWith("-")) &&
    lines.some(l => l.startsWith("@@") || l.match(/^[+-]{3}/));
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
      const obj = JSON.parse(props.block.input);
      return (obj.description as string) || "";
    } catch { return ""; }
  });

  const inputDisplay = createMemo(() => {
    try {
      const obj = JSON.parse(props.block.input);
      if (obj.command) return obj.command;
      if (obj.file_path) {
        let s = obj.file_path as string;
        if (obj.offset) s += ` (lines ${obj.offset}-${(obj.offset as number) + (obj.limit ?? 100)})`;
        return s;
      }
      if (obj.pattern) return obj.pattern;
      if (obj.path) return obj.path;
      return props.block.input;
    } catch { return props.block.input; }
  });

  return (
    <div class={`${styles.timelineRow} ${dotClass()}`}>
      <div class={styles.toolContent}>
        <div class={styles.toolHeader}>
          <span class={styles.toolName}>{props.block.toolName}</span>
          <Show when={description()}>
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
          <div class={styles.toolBodyGrid}>
            <Show when={inputDisplay()}>
              <div class={styles.toolBodyRow}>
                <div class={styles.toolLabel}>IN</div>
                <pre class={styles.toolValue}>{inputDisplay()}</pre>
              </div>
            </Show>
            <Show when={props.result}>
              {(r) => (
                <div class={`${styles.toolBodyRow} ${r().isError ? styles.toolSectionError : ""}`}>
                  <div class={`${styles.toolLabel} ${r().isError ? styles.toolLabelError : ""}`}>
                    {r().isError ? "ERR" : "OUT"}
                  </div>
                  <Show when={!r().isError && isDiff(r().output)} fallback={
                    <pre class={styles.toolValue}>{r().output}</pre>
                  }>
                    <DiffOutput text={r().output} />
                  </Show>
                </div>
              )}
            </Show>
          </div>
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

  return (
    <div class={`${styles.message} ${styles[msg().role]}`}>
      <Show when={msg().role === "user"}>
        <div class={styles.userBubble}>
          <For each={msg().blocks}>
            {(block) => block.kind === "text" ? <div>{block.text}</div> : null}
          </For>
        </div>
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
              {msg().costUsd && ` · $${msg().costUsd!.toFixed(4)}`}
              {msg().durationMs && ` · ${(msg().durationMs! / 1000).toFixed(1)}s`}
            </div>
          </Show>
        </div>
      </Show>

      <Show when={msg().role === "system"}>
        <div class={styles.systemMsg}>
          <For each={msg().blocks}>
            {(block) => block.kind === "text" ? <span>{block.text}</span> : null}
          </For>
        </div>
      </Show>
    </div>
  );
}
