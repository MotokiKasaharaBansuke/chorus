import { Show } from "solid-js";
import type { WorktreeErrorInfo } from "../../lib/worktree/classify-error";
import styles from "./worktree-error-dialog.module.css";

export interface WorktreeErrorDialogProps {
  error: WorktreeErrorInfo | null;
  onRetry: () => void;
  onClose: () => void;
}

function headlineFor(kind: WorktreeErrorInfo["kind"]): string {
  switch (kind) {
    case "WorktreeBranchExists": return "That branch already exists.";
    case "WorktreePathExists": return "A directory already exists at the target path.";
    case "WorktreeInvalidBranchName": return "The branch name is not allowed.";
    case "WorktreePathTraversal": return "The computed path escapes the configured base path.";
    case "WorktreeHookFailed": return "A post-create hook failed (the pane still opened).";
    case "WorktreeCreateFailed": return "Creating the worktree failed.";
    case "WorktreeRemoveFailed": return "Removing the worktree failed.";
    case "GitNotFound": return "Chorus could not find the git executable on PATH.";
    case "GitCommandFailed": return "A git command failed.";
    case "GitRepoNotFound": return "That directory is not inside a git repository.";
    case "SettingsLoadFailed": return "Failed to load settings.";
    case "SettingsSaveFailed": return "Failed to save settings.";
    default: return "Something went wrong.";
  }
}

function canRetry(kind: WorktreeErrorInfo["kind"]): boolean {
  return (
    kind === "WorktreeBranchExists" ||
    kind === "WorktreePathExists" ||
    kind === "WorktreeInvalidBranchName"
  );
}

export function WorktreeErrorDialog(props: WorktreeErrorDialogProps) {
  return (
    <Show when={props.error}>
      {(err) => (
        <div class={styles.overlay} onClick={props.onClose}>
          <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 class={styles.title}>Worktree</h3>
            <p class={styles.headline}>{headlineFor(err().kind)}</p>
            <pre class={styles.detail}>{err().detail}</pre>
            <Show when={canRetry(err().kind)}>
              <p class={styles.hint}>Pick a different branch name and try again.</p>
            </Show>
            <div class={styles.actions}>
              <button class={styles.closeBtn} onClick={props.onClose}>Close</button>
              <Show when={canRetry(err().kind)}>
                <button class={styles.retryBtn} onClick={props.onRetry}>Try again</button>
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
