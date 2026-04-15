import { Show } from "solid-js";
import type { TabWorktree } from "../../types";
import styles from "./worktree-remove-confirm.module.css";

export interface WorktreeResetConfirmProps {
  worktree: TabWorktree | null;
  isDirty: boolean;
  onClearOnly: () => void;
  onReset: () => void;
  onCancel: () => void;
}

export function WorktreeResetConfirm(props: WorktreeResetConfirmProps) {
  return (
    <Show when={props.worktree}>
      {(wt) => (
        <div class={styles.overlay} onClick={props.onCancel}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 class={styles.title}>Start fresh with a new worktree?</h3>
            <p class={styles.sub}>
              Clear conversation and create a new worktree, or just clear the chat history.
            </p>
            <div class={styles.meta}>
              {wt().path}
              <br />
              <span style={{ color: "#888" }}>branch: {wt().branch}</span>
            </div>
            <Show when={props.isDirty}>
              <div class={styles.warning}>
                ⚠️ This worktree has uncommitted changes. Resetting will
                discard them. Use <code>git stash</code> or commit first if
                you want to keep them.
              </div>
            </Show>
            <div class={styles.actions}>
              <button class={styles.keepBtn} onClick={props.onCancel}>Cancel</button>
              <button class={styles.keepBtn} onClick={props.onClearOnly}>Clear chat only</button>
              <button class={styles.removeBtn} onClick={props.onReset}>New worktree</button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
