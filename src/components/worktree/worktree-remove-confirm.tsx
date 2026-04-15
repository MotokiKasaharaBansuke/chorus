import { Show } from "solid-js";
import type { TabWorktree } from "../../types";
import styles from "./worktree-remove-confirm.module.css";

export interface WorktreeRemoveConfirmProps {
  worktree: TabWorktree | null;
  isDirty: boolean;
  onKeep: () => void;
  onRemove: () => void;
}

export function WorktreeRemoveConfirm(props: WorktreeRemoveConfirmProps) {
  return (
    <Show when={props.worktree}>
      {(wt) => (
        <div class={styles.overlay} onClick={props.onKeep}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 class={styles.title}>Remove worktree?</h3>
            <p class={styles.sub}>
              This pane was opened with an auto-created worktree. Remove it too?
            </p>
            <div class={styles.meta}>
              {wt().path}
              <br />
              <span style={{ color: "#888" }}>branch: {wt().branch}</span>
            </div>
            <Show when={props.isDirty}>
              <div class={styles.warning}>
                ⚠️ This worktree has uncommitted changes. Removing it will
                discard them. Use <code>git stash</code> or commit first if
                you want to keep them.
              </div>
            </Show>
            <div class={styles.actions}>
              <button class={styles.keepBtn} onClick={props.onKeep}>Keep worktree</button>
              <button class={styles.removeBtn} onClick={props.onRemove}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
