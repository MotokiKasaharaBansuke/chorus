import { describe, it, expect, vi } from "vitest";
import { spawnPaneWithWorktree } from "./spawn-pane";
import { DEFAULT_WORKTREE_SETTINGS } from "../../types/settings";
import type { CliConfig } from "../../types";
import type { CreatedWorktree } from "../../types/worktree";

const baseConfig: CliConfig = {
  cliType: "claude-code",
  mode: "default",
  workingDir: "/repo",
};

const FIXED_NOW = new Date(2026, 3, 15, 14, 30, 52, 125);
const EXPECTED_BRANCH = "feat/pane-20260415-143052-125";

function created(path: string, branch: string): CreatedWorktree {
  return { path, branch, headSha: "abc", hookRunId: null, hookWarnings: [] };
}

function makeDeps(overrides: Partial<Parameters<typeof spawnPaneWithWorktree>[2]> = {}) {
  return {
    findGitRepoRoot: vi.fn(async (p: string) => p),
    createWorktree: vi.fn(async (args) => created(`/worktrees/${args.newBranch}`, args.newBranch)),
    spawnPty: vi.fn(async (_c: CliConfig) => "pty-1"),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

describe("spawnPaneWithWorktree", () => {
  it("autoCreate=false skips worktree and spawns PTY directly", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: false };

    const result = await spawnPaneWithWorktree(baseConfig, settings, deps);

    expect(result.worktree).toBeNull();
    expect(result.finalConfig.workingDir).toBe("/repo");
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.spawnPty).toHaveBeenCalledWith(baseConfig);
  });

  it("autoCreate=true but not a git repo falls back to plain spawn", async () => {
    const deps = makeDeps({ findGitRepoRoot: vi.fn(async () => null) });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    const result = await spawnPaneWithWorktree(baseConfig, settings, deps);

    expect(result.worktree).toBeNull();
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.spawnPty).toHaveBeenCalledWith(baseConfig);
  });

  it("autoCreate=true in repo: auto-generates branch name and creates worktree", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    const result = await spawnPaneWithWorktree(baseConfig, settings, deps);

    expect(deps.createWorktree).toHaveBeenCalledTimes(1);
    expect(deps.createWorktree).toHaveBeenCalledWith({
      repoRoot: "/repo",
      baseBranch: "main",
      newBranch: EXPECTED_BRANCH,
      worktree: settings,
    });
    expect(result.worktree?.path).toBe(`/worktrees/${EXPECTED_BRANCH}`);
    expect(result.finalConfig.workingDir).toBe(`/worktrees/${EXPECTED_BRANCH}`);
    expect(deps.spawnPty).toHaveBeenCalledWith({
      ...baseConfig,
      workingDir: `/worktrees/${EXPECTED_BRANCH}`,
    });
  });

  it("uses the configured defaultBaseBranch when generating the spec", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true, defaultBaseBranch: "develop" };

    await spawnPaneWithWorktree(baseConfig, settings, deps);

    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "develop", newBranch: EXPECTED_BRANCH }),
    );
  });

  it("invalid branch prefix: throws a WorktreeInvalidBranchName-shaped error without spawning", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true, branchPrefix: "has space/" };

    await expect(spawnPaneWithWorktree(baseConfig, settings, deps)).rejects.toMatchObject({
      WorktreeInvalidBranchName: expect.stringContaining("has space/"),
    });
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.spawnPty).not.toHaveBeenCalled();
  });

  it("createWorktree rejection propagates and PTY is not spawned", async () => {
    const deps = makeDeps({
      createWorktree: vi.fn(async () => {
        throw new Error("branch exists");
      }),
    });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    await expect(spawnPaneWithWorktree(baseConfig, settings, deps)).rejects.toThrow("branch exists");
    expect(deps.spawnPty).not.toHaveBeenCalled();
  });
});
