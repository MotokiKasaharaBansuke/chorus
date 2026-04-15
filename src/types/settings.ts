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

export interface Settings {
  reviewCliType: ReviewCliType;
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
  worktree: DEFAULT_WORKTREE_SETTINGS,
};
