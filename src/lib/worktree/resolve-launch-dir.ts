import type { Tab } from "../../types";

export function resolveLaunchDir(
  activeTab: Tab | null | undefined,
  sidebarWorkingDir: string,
): string {
  return activeTab?.worktree?.repoRoot || sidebarWorkingDir || "~";
}
