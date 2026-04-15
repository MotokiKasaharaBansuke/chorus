import { createSignal, createEffect, Show, For } from "solid-js";
import type { WorktreeSettings } from "../../types/settings";
import type { WorktreeInfo } from "../../types/worktree";
import styles from "./worktree-settings-modal.module.css";

export interface WorktreeSettingsModalProps {
  isOpen: boolean;
  settings: WorktreeSettings;
  /** The repo root the currently active pane is rooted in, if any. */
  repoRoot: string | null;
  onChange: (patch: Partial<WorktreeSettings>) => void;
  loadWorktrees: (repoRoot: string) => Promise<WorktreeInfo[]>;
  removeWorktree: (path: string, force: boolean) => Promise<void>;
  onClose: () => void;
}

const RECOMMENDED_PRESET: Partial<WorktreeSettings> = {
  spotlightExclude: true,
  watchLockfiles: true,
  shareCargoTarget: "always",
  postCreateHooks: {
    pnpmInstall: true,
    copyCargoConfig: true,
    symlinkEnvFiles: false,
    envFileAllowlist: [".env", ".env.local", ".env.development"],
    runInBackground: true,
    timeoutSeconds: 600,
  },
};

export function WorktreeSettingsModal(props: WorktreeSettingsModalProps) {
  const [worktrees, setWorktrees] = createSignal<WorktreeInfo[]>([]);
  const [listError, setListError] = createSignal<string | null>(null);

  async function refreshList() {
    if (!props.repoRoot) {
      setWorktrees([]);
      return;
    }
    try {
      setListError(null);
      setWorktrees(await props.loadWorktrees(props.repoRoot));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }

  createEffect(() => {
    if (props.isOpen) refreshList();
  });

  async function handleRemove(path: string) {
    if (!confirm(`Remove worktree at ${path}?\n(git worktree remove --force)`)) return;
    try {
      await props.removeWorktree(path, true);
      await refreshList();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Show when={props.isOpen}>
      <div class={styles.overlay} onClick={props.onClose}>
        <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
          <h3 class={styles.title}>Worktree</h3>
          <p class={styles.sub}>
            Chorus can create a git worktree when you open a new pane, keeping branches isolated.
          </p>

          <div class={styles.preset}>
            <div class={styles.presetText}>
              Lightweight preset: enable Spotlight exclusion, lockfile watcher, and shared Cargo target.
            </div>
            <button
              class={styles.presetBtn}
              onClick={() => props.onChange(RECOMMENDED_PRESET)}
              type="button"
            >
              Apply
            </button>
          </div>

          <div class={styles.sectionTitle}>General</div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>
              Auto-create worktree on new pane
              <div class={styles.rowHint}>
                Creates a worktree silently on <kbd>⌘T</kbd>, branching off <code>{props.settings.defaultBaseBranch}</code> with a timestamped name.
              </div>
            </div>
            <button
              type="button"
              aria-label="Toggle auto-create"
              class={`${styles.toggle} ${props.settings.autoCreate ? styles.toggleOn : ""}`}
              onClick={() => props.onChange({ autoCreate: !props.settings.autoCreate })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>
              Auto-remove worktree on pane close
              <div class={styles.rowHint}>
                Removes the worktree without asking when the pane closes. Dirty trees still prompt for safety.
              </div>
            </div>
            <button
              type="button"
              aria-label="Toggle auto-remove on close"
              class={`${styles.toggle} ${props.settings.onPaneClose.autoRemoveOnClose ? styles.toggleOn : ""}`}
              onClick={() =>
                props.onChange({
                  onPaneClose: {
                    ...props.settings.onPaneClose,
                    autoRemoveOnClose: !props.settings.onPaneClose.autoRemoveOnClose,
                  },
                })
              }
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Base path
              <div class={styles.rowHint}>Where worktrees are created. Supports <code>~/</code>.</div>
            </div>
            <input
              class={styles.input}
              type="text"
              value={props.settings.basePath}
              onChange={(e) => props.onChange({ basePath: e.currentTarget.value })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Branch prefix
              <div class={styles.rowHint}>Prepended to the branch name input.</div>
            </div>
            <input
              class={styles.input}
              type="text"
              value={props.settings.branchPrefix}
              onChange={(e) => props.onChange({ branchPrefix: e.currentTarget.value })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Default base branch</div>
            <input
              class={styles.input}
              type="text"
              value={props.settings.defaultBaseBranch}
              onChange={(e) => props.onChange({ defaultBaseBranch: e.currentTarget.value })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Spotlight exclude (append <code>.noindex</code>)</div>
            <button
              type="button"
              class={`${styles.toggle} ${props.settings.spotlightExclude ? styles.toggleOn : ""}`}
              onClick={() => props.onChange({ spotlightExclude: !props.settings.spotlightExclude })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Watch lockfiles for "outdated"</div>
            <button
              type="button"
              class={`${styles.toggle} ${props.settings.watchLockfiles ? styles.toggleOn : ""}`}
              onClick={() => props.onChange({ watchLockfiles: !props.settings.watchLockfiles })}
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Warn when worktree count exceeds</div>
            <input
              class={`${styles.input} ${styles.numberInput}`}
              type="number"
              min="1"
              max="100"
              value={props.settings.warnThreshold}
              onChange={(e) =>
                props.onChange({ warnThreshold: Math.max(1, Number(e.currentTarget.value) | 0) })
              }
            />
          </div>

          <div class={styles.sectionTitle}>Post-create hooks</div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Copy <code>.cargo/config.toml</code></div>
            <button
              type="button"
              class={`${styles.toggle} ${props.settings.postCreateHooks.copyCargoConfig ? styles.toggleOn : ""}`}
              onClick={() =>
                props.onChange({
                  postCreateHooks: {
                    ...props.settings.postCreateHooks,
                    copyCargoConfig: !props.settings.postCreateHooks.copyCargoConfig,
                  },
                })
              }
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>Run <code>pnpm install</code></div>
            <button
              type="button"
              class={`${styles.toggle} ${props.settings.postCreateHooks.pnpmInstall ? styles.toggleOn : ""}`}
              onClick={() =>
                props.onChange({
                  postCreateHooks: {
                    ...props.settings.postCreateHooks,
                    pnpmInstall: !props.settings.postCreateHooks.pnpmInstall,
                  },
                })
              }
            />
          </div>

          <div class={styles.row}>
            <div class={styles.rowLabel}>
              Symlink env files
              <div class={styles.rowHint}>Allowlisted filenames only. Off by default.</div>
            </div>
            <button
              type="button"
              class={`${styles.toggle} ${props.settings.postCreateHooks.symlinkEnvFiles ? styles.toggleOn : ""}`}
              onClick={() =>
                props.onChange({
                  postCreateHooks: {
                    ...props.settings.postCreateHooks,
                    symlinkEnvFiles: !props.settings.postCreateHooks.symlinkEnvFiles,
                  },
                })
              }
            />
          </div>

          <div class={styles.sectionTitle}>Active worktrees</div>

          <Show
            when={props.repoRoot}
            fallback={<div class={styles.emptyState}>Open a pane in a git repository to see its worktrees.</div>}
          >
            <Show when={listError()}>
              <div class={styles.emptyState}>{listError()}</div>
            </Show>
            <Show
              when={worktrees().length > 0}
              fallback={<div class={styles.emptyState}>No worktrees yet.</div>}
            >
              <div class={styles.worktreeList}>
                <For each={worktrees()}>
                  {(wt) => (
                    <div class={styles.worktreeRow}>
                      <div class={styles.worktreeInfo}>
                        <div class={styles.worktreePath}>{wt.path}</div>
                        <div class={styles.worktreeMeta}>
                          <Show when={wt.locked}><span class={`${styles.badge} ${styles.badgeLocked}`}>locked</span></Show>
                          <Show when={wt.prunable}><span class={`${styles.badge} ${styles.badgePrunable}`}>prunable</span></Show>
                          <Show when={wt.detached}><span class={`${styles.badge} ${styles.badgeDetached}`}>detached</span></Show>
                          <span>{wt.branch ?? "(no branch)"} · {wt.headSha.slice(0, 7)}</span>
                        </div>
                      </div>
                      <button class={styles.removeBtn} onClick={() => handleRemove(wt.path)}>Remove</button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <div class={styles.footer}>
            <button class={styles.closeBtn} onClick={props.onClose}>Done</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
