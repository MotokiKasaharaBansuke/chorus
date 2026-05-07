import type { ReviewCliType } from "./tab";

export type ShareCargoTarget = "auto" | "always" | "never";

export interface PostCreateHooks {
  pnpmInstall: boolean;
  copyCargoConfig: boolean;
  symlinkEnvFiles: boolean;
  envFileAllowlist: string[];
  runInBackground: boolean;
  timeoutSeconds: number;
}

export interface OnPaneClose {
  promptRemoveWorktree: boolean;
  backgroundDelete: boolean;
  autoRemoveOnClose: boolean;
}

export interface WorktreeSettings {
  autoCreate: boolean;
  basePath: string;
  branchPrefix: string;
  defaultBaseBranch: string;
  shareCargoTarget: ShareCargoTarget;
  spotlightExclude: boolean;
  watchLockfiles: boolean;
  warnThreshold: number;
  postCreateHooks: PostCreateHooks;
  onPaneClose: OnPaneClose;
}

/**
 * Default execution engine for newly-spawned claude-code / codex panes.
 *
 * - `"pty"` — historical path; safe and unchanged.
 * - `"headless"` — Phase 1+ JSONL engine. Opt-in until Phase 4 retires
 *   PTY entirely. Shell tabs and the bottom terminal are unaffected.
 */
export type EngineDefault = "pty" | "headless";

export interface Settings {
  reviewCliType: ReviewCliType;
  /**
   * Engine preference for newly-created Claude/Codex panes. Absent in
   * old persisted settings — treated as `"pty"` for backwards compat.
   */
  engineDefault?: EngineDefault;
  worktree: WorktreeSettings;
}

export const DEFAULT_POST_CREATE_HOOKS: PostCreateHooks = {
  pnpmInstall: true,
  copyCargoConfig: true,
  symlinkEnvFiles: false,
  envFileAllowlist: [".env", ".env.local", ".env.development"],
  runInBackground: true,
  timeoutSeconds: 600,
};

export const DEFAULT_ON_PANE_CLOSE: OnPaneClose = {
  promptRemoveWorktree: true,
  backgroundDelete: true,
  autoRemoveOnClose: false,
};

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  autoCreate: false,
  basePath: "~/chorus-worktrees",
  branchPrefix: "feat/",
  defaultBaseBranch: "main",
  shareCargoTarget: "auto",
  spotlightExclude: true,
  watchLockfiles: true,
  warnThreshold: 10,
  postCreateHooks: DEFAULT_POST_CREATE_HOOKS,
  onPaneClose: DEFAULT_ON_PANE_CLOSE,
};

export const DEFAULT_SETTINGS: Settings = {
  reviewCliType: "codex",
  engineDefault: "pty",
  worktree: DEFAULT_WORKTREE_SETTINGS,
};
