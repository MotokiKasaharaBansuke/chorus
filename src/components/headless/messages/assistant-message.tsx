import { For, Show, createMemo } from "solid-js";

import { applyInline as applyInlineRaw } from "../../../lib/format/inline";
import { formatInline } from "../../../lib/format/markdown";
import type { HeadlessMessage } from "../../../types/headless";

import { ToolCall } from "./tool-call";
import styles from "./messages.module.css";

interface AssistantMessageProps {
  message: Extract<HeadlessMessage, { role: "assistant" }>;
}

/**
 * Bind `applyInline` to this module's CSS classes. `formatInline` always
 * runs `escapeHtml` first, so assistant text containing literal
 * `<script>` is rendered as harmless text — the `innerHTML` below is
 * only ever fed escaped + structurally-safe HTML.
 */
function applyInline(text: string): string {
  return applyInlineRaw(text, {
    mdLink: styles.mdLink,
    inlineCode: styles.inlineCode,
  });
}

/**
 * Single assistant turn. Body is Markdown-rendered, then any tool calls
 * issued during this turn are listed beneath. Streaming flag drives the
 * blinking cursor at the tail.
 *
 * The HTML string is `createMemo`-derived from `text` so a stream that
 * delivers tokens at 100 Hz only re-renders Markdown when the text
 * actually changes, not on every reactive read.
 */
export function AssistantMessage(props: AssistantMessageProps) {
  const html = createMemo(() => formatInline(props.message.text, applyInline, styles));
  return (
    <div class={`${styles.message} ${styles.assistantMessage}`}>
      <div class={styles.assistantText}>
        <span innerHTML={html()} />
        <Show when={props.message.streaming}>
          <span class={styles.streamingCursor} />
        </Show>
      </div>
      <For each={props.message.toolCalls}>
        {(call) => <ToolCall call={call} />}
      </For>
    </div>
  );
}
