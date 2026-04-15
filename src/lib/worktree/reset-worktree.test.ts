import { describe, it, expect, vi } from "vitest";
import { resetWorktree, type ResetWorktreeDeps } from "./reset-worktree";
import { DEFAULT_WORKTREE_SETTINGS } from "../../types/settings";
import type { CliConfig, TabWorktree } from "../../types";
import type { CreatedWorktree } from "../../types/worktree";

const cliConfig: CliConfig = {
  cliType: "claude-code",
  mode: "default",
  workingDir: "/worktrees/old-branch",
};

const worktree: TabWorktree = {
  path: "/worktrees/old-branch",
  branch: "feat/old-branch",
  headSha: "abc123",
  repoRoot: "/repo",
};

function fakeCreated(path: string, branch: string): CreatedWorktree {
  return { path, branch, headSha: "def456", hookRunId: null, hookWarnings: [] };
}

function makeDeps(overrides: Partial<ResetWorktreeDeps> = {}): ResetWorktreeDeps {
  return {
    killPty: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    createWorktree: vi.fn(async (args) => fakeCreated(`/worktrees/${args.newBranch}`, args.newBranch)),
    spawnPty: vi.fn(async () => "new-pty-1"),
    isTabAlive: vi.fn(() => true),
    ...overrides,
  };
}

describe("resetWorktree", () => {
  it("kills old PTY, removes old worktree, creates new one, and spawns new PTY", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    const result = await resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps);

    expect(deps.killPty).toHaveBeenCalledWith("old-pty");
    expect(deps.removeWorktree).toHaveBeenCalledWith("/worktrees/old-branch", true);
    expect(deps.createWorktree).toHaveBeenCalledTimes(1);
    expect(deps.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo" }),
    );
    expect(deps.spawnPty).toHaveBeenCalledTimes(1);
    expect(result.newPtyId).toBe("new-pty-1");
    expect(result.created.headSha).toBe("def456");
  });

  it("propagates removeWorktree errors without creating a new worktree", async () => {
    const deps = makeDeps({
      removeWorktree: vi.fn(async () => { throw new Error("locked"); }),
    });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    await expect(resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps))
      .rejects.toThrow("locked");
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.spawnPty).not.toHaveBeenCalled();
  });

  it("throws if tab is closed after worktree creation but before PTY spawn", async () => {
    let callCount = 0;
    const deps = makeDeps({
      isTabAlive: vi.fn(() => {
        callCount++;
        return callCount <= 0;
      }),
    });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    await expect(resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps))
      .rejects.toThrow("Tab was closed");
    expect(deps.spawnPty).not.toHaveBeenCalled();
  });

  it("throws if tab is closed after PTY spawn and cleans up new resources", async () => {
    let callCount = 0;
    const deps = makeDeps({
      isTabAlive: vi.fn(() => {
        callCount++;
        return callCount <= 1;
      }),
    });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    await expect(resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps))
      .rejects.toThrow("Tab was closed");
    expect(deps.killPty).toHaveBeenCalledWith("new-pty-1");
  });

  it("throws on invalid branch prefix without creating worktree", async () => {
    const deps = makeDeps();
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true, branchPrefix: "has space/" };

    await expect(resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps))
      .rejects.toThrow("not a valid git branch name");
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it("propagates createWorktree errors after successful removal", async () => {
    const deps = makeDeps({
      createWorktree: vi.fn(async () => { throw new Error("disk full"); }),
    });
    const settings = { ...DEFAULT_WORKTREE_SETTINGS, autoCreate: true };

    await expect(resetWorktree("tab-1", "old-pty", cliConfig, worktree, settings, deps))
      .rejects.toThrow("disk full");
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.spawnPty).not.toHaveBeenCalled();
  });
});
