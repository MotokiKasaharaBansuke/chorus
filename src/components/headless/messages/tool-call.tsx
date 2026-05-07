import { Match, Show, Switch } from "solid-js";

import type { HeadlessToolCall } from "../../../types/headless";

import { EditTool } from "./tools/edit-tool";
import { GenericTool } from "./tools/generic-tool";
import styles from "./messages.module.css";

interface ToolCallProps {
  call: HeadlessToolCall;
}

/**
 * One assistant tool invocation, with header (name + status) and a
 * tool-specific body. Routing to the specialised renderers happens by
 * tool `name` — anything we don't recognise falls back to `GenericTool`,
 * which JSON-pretty-prints the input.
 */
export function ToolCall(props: ToolCallProps) {
  const status = () => {
    const r = props.call.result;
    if (!r) return "running";
    return r.isError ? "error" : "done";
  };

  return (
    <div class={styles.toolCall}>
      <div class={styles.toolCallHeader}>
        <span class={styles.toolCallName}>{props.call.name}</span>
        <span
          class={
            status() === "error"
              ? `${styles.toolCallStatus} ${styles.toolCallStatusError}`
              : styles.toolCallStatus
          }
        >
          {status()}
        </span>
      </div>
      <Switch fallback={<GenericTool call={props.call} />}>
        <Match when={props.call.name === "Edit"}>
          <EditTool call={props.call} />
        </Match>
      </Switch>
      <Show when={props.call.result}>
        {(result) => (
          <div class={styles.toolCallBody}>
            <div class={styles.toolCallSection}>
              <div class={styles.toolCallSectionLabel}>
                {result().isError ? "error" : "result"}
              </div>
              <pre>{result().output}</pre>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
