import type { CliConfig } from "../../types";
import type { WorktreeSettings } from "../../types/settings";
import type { CreatedWorktree } from "../../types/worktree";
import { generateAutoBranchName } from "./generate-branch-name";

export interface SpawnPaneDeps {
  findGitRepoRoot: (path: string) => Promise<string | null>;
  createWorktree: (args: {
    repoRoot: string;
    baseBranch: string;
    newBranch: string;
    worktree: WorktreeSettings;
  }) => Promise<CreatedWorktree>;
  spawnPty: (config: CliConfig) => Promise<string>;
  /** Injected clock for deterministic branch-name generation in tests. */
  now?: () => Date;
}

export interface SpawnPaneOutcome {
  paneId: string;
  worktree: CreatedWorktree | null;
  finalConfig: CliConfig;
}

/**
 * Pure-ish orchestration: decides whether to create a worktree and which
 * directory the PTY should start in. All side effects are injected via
 * `deps` so the function is fully unit-testable.
 *
 * When `autoCreate` is on and the working directory is a git repo, the
 * branch name is auto-generated from `branchPrefix` + a timestamp suffix,
 * and the base branch comes from `defaultBaseBranch`. No UI prompt.
 */
export async function spawnPaneWithWorktree(
  config: CliConfig,
  settings: WorktreeSettings,
  deps: SpawnPaneDeps,
): Promise<SpawnPaneOutcome> {
  if (!settings.autoCreate) {
    const paneId = await deps.spawnPty(config);
    return { paneId, worktree: null, finalConfig: config };
  }

  const repoRoot = await deps.findGitRepoRoot(config.workingDir);
  if (!repoRoot) {
    const paneId = await deps.spawnPty(config);
    return { paneId, worktree: null, finalConfig: config };
  }

  const now = deps.now?.() ?? new Date();
  const newBranch = generateAutoBranchName(settings.branchPrefix, now);
  if (!newBranch) {
    // Surface through the same error-dialog path that the backend would use
    // for a server-side rejection, so the user sees *why* auto-create was
    // skipped instead of silently getting a pane without a worktree.
    throw {
      WorktreeInvalidBranchName: `Branch prefix "${settings.branchPrefix}" is not a valid git branch name.`,
    };
  }

  const created = await deps.createWorktree({
    repoRoot,
    baseBranch: settings.defaultBaseBranch,
    newBranch,
    worktree: settings,
  });

  const finalConfig: CliConfig = { ...config, workingDir: created.path };
  const paneId = await deps.spawnPty(finalConfig);
  return { paneId, worktree: created, finalConfig };
}
