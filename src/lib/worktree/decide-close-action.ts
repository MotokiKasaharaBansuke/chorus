import type { OnPaneClose } from "../../types/settings";

export type CloseAction =
  | { kind: "silent-remove" }
  | { kind: "prompt"; isDirty: boolean }
  | { kind: "skip" };

/**
 * Decide what should happen to a pane's worktree when the pane closes.
 * Pure function — no IO, no side effects, no Solid reactivity.
 *
 * Invariants:
 *   - A dirty worktree NEVER auto-removes silently. This protects users
 *     who enabled auto-remove from losing uncommitted work.
 *   - If both `autoRemoveOnClose` and `promptRemoveWorktree` are off, the
 *     worktree is left in place even if dirty; the user has opted out of
 *     any close-time action.
 */
export function decideCloseAction(onPaneClose: OnPaneClose, isDirty: boolean): CloseAction {
  const { autoRemoveOnClose, promptRemoveWorktree } = onPaneClose;
  if (autoRemoveOnClose && !isDirty) return { kind: "silent-remove" };
  if (promptRemoveWorktree || (autoRemoveOnClose && isDirty)) {
    return { kind: "prompt", isDirty };
  }
  return { kind: "skip" };
}
