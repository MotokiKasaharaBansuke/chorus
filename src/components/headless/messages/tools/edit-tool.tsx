import { Show } from "solid-js";

import type { HeadlessToolCall } from "../../../../types/headless";

import styles from "../messages.module.css";

interface EditToolProps {
  call: HeadlessToolCall;
}

interface EditInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
}

/**
 * Renderer for the `Edit` tool: shows a two-block diff (old → new)
 * separated by the file path. Inputs from the wire are typed as
 * `unknown`, so each field is defensively narrowed before display —
 * never inserted via `innerHTML`, only as text nodes.
 */
export function EditTool(props: EditToolProps) {
  const input = (): EditInput => {
    const raw = props.call.input;
    return typeof raw === "object" && raw !== null ? (raw as EditInput) : {};
  };
  const filePath = (): string =>
    typeof input().file_path === "string" ? (input().file_path as string) : "(unknown path)";
  const oldString = (): string =>
    typeof input().old_string === "string" ? (input().old_string as string) : "";
  const newString = (): string =>
    typeof input().new_string === "string" ? (input().new_string as string) : "";

  return (
    <div class={`${styles.toolCallBody} ${styles.editTool}`}>
      <div class={styles.filePath}>{filePath()}</div>
      <Show when={oldString()}>
        <div class={styles.toolCallSection}>
          <div class={styles.toolCallSectionLabel}>− old</div>
          <div class={styles.diffOld}>{oldString()}</div>
        </div>
      </Show>
      <Show when={newString()}>
        <div class={styles.toolCallSection}>
          <div class={styles.toolCallSectionLabel}>+ new</div>
          <div class={styles.diffNew}>{newString()}</div>
        </div>
      </Show>
    </div>
  );
}
