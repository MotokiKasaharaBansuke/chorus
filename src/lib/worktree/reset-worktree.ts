import type { CliConfig } from "../../types";
import type { TabWorktree } from "../../types";
import type { CreateWorktreeRequest, CreatedWorktree } from "../../types/worktree";
import type { WorktreeSettings } from "../../types/settings";
import { generateAutoBranchName } from "./generate-branch-name";

export interface ResetWorktreeDeps {
  killPty: (ptyId: string) => Promise<void>;
  removeWorktree: (path: string, force: boolean) => Promise<void>;
  createWorktree: (args: CreateWorktreeRequest) => Promise<CreatedWorktree>;
  spawnPty: (config: CliConfig) => Promise<string>;
  isTabAlive: (tabId: string) => boolean;
}

export interface ResetWorktreeResult {
  newPtyId: string;
  created: CreatedWorktree;
}

export async function resetWorktree(
  tabId: string,
  ptyId: string,
  cliConfig: CliConfig,
  worktree: TabWorktree,
  settings: WorktreeSettings,
  deps: ResetWorktreeDeps,
): Promise<ResetWorktreeResult> {
  await deps.killPty(ptyId).catch(() => {});
  await deps.removeWorktree(worktree.path, true);

  const newBranch = generateAutoBranchName(settings.branchPrefix, new Date());
  if (!newBranch) {
    throw new Error(`Branch prefix "${settings.branchPrefix}" is not a valid git branch name.`);
  }

  const created = await deps.createWorktree({
    repoRoot: worktree.repoRoot,
    baseBranch: settings.defaultBaseBranch,
    newBranch,
    basePath: settings.basePath,
    postCreateHooks: settings.postCreateHooks,
    shareCargoTarget: settings.shareCargoTarget,
    spotlightExclude: settings.spotlightExclude,
  });

  async function abortIfTabClosed(ptyIdToKill?: string): Promise<void> {
    if (deps.isTabAlive(tabId)) return;
    if (ptyIdToKill) await deps.killPty(ptyIdToKill).catch(() => {});
    await deps.removeWorktree(created.path, true).catch(() => {});
    throw new Error("Tab was closed during worktree reset.");
  }

  await abortIfTabClosed();

  const newConfig = { ...cliConfig, workingDir: created.path };
  const newPtyId = await deps.spawnPty(newConfig);

  await abortIfTabClosed(newPtyId);

  return { newPtyId, created };
}
