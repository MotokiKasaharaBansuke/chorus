import { describe, it, expect } from "vitest";
import { resolveLaunchDir } from "./resolve-launch-dir";
import type { Tab } from "../../types";

function makeTab(worktreeRepoRoot?: string): Tab {
  const tab: Tab = {
    id: "t1",
    title: "Test",
    status: "idle",
    cliConfig: { cliType: "claude-code", mode: "default", workingDir: "/worktrees/feat__x" },
  };
  if (worktreeRepoRoot) {
    tab.worktree = { path: "/worktrees/feat__x", branch: "feat/x", headSha: "abc", repoRoot: worktreeRepoRoot };
  }
  return tab;
}

describe("resolveLaunchDir", () => {
  it("uses worktree repoRoot when active tab is a worktree", () => {
    expect(resolveLaunchDir(makeTab("/original-repo"), "/worktrees/feat__x")).toBe("/original-repo");
  });

  it("falls back to sidebarWorkingDir when tab has no worktree", () => {
    expect(resolveLaunchDir(makeTab(), "/some/dir")).toBe("/some/dir");
  });

  it("falls back to sidebarWorkingDir when no active tab", () => {
    expect(resolveLaunchDir(null, "/some/dir")).toBe("/some/dir");
  });

  it("falls back to ~ when sidebarWorkingDir is empty", () => {
    expect(resolveLaunchDir(makeTab(), "")).toBe("~");
  });

  it("falls back to ~ when both are absent", () => {
    expect(resolveLaunchDir(null, "")).toBe("~");
  });

  it("falls back to ~ when activeTab is undefined", () => {
    expect(resolveLaunchDir(undefined, "")).toBe("~");
  });
});
