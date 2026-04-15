import type { PostCreateHooks, ShareCargoTarget } from "./settings";

export type BranchKind = "local" | "remote";

export interface BranchInfo {
  name: string;
  kind: BranchKind;
  headSha: string;
  upstream: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  headSha: string;
  locked: boolean;
  prunable: boolean;
  detached: boolean;
}

export interface CreateWorktreeRequest {
  repoRoot: string;
  baseBranch: string;
  newBranch: string;
  basePath: string;
  postCreateHooks: PostCreateHooks;
  shareCargoTarget: ShareCargoTarget;
  spotlightExclude: boolean;
  paneId?: string | null;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  headSha: string;
  hookRunId: string | null;
  hookWarnings: string[];
}
