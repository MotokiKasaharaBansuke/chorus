import { invoke } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  CreateWorktreeRequest,
  CreatedWorktree,
  WorktreeInfo,
} from "../../types/worktree";

export function findGitRepoRoot(path: string): Promise<string | null> {
  return invoke<string | null>("find_git_repo_root", { path });
}

export function listBranches(repoRoot: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("list_branches", { repoRoot });
}

export function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("list_worktrees", { repoRoot });
}

export function createWorktree(req: CreateWorktreeRequest): Promise<CreatedWorktree> {
  return invoke<CreatedWorktree>("create_worktree", { req });
}

export function removeWorktree(path: string, force: boolean): Promise<void> {
  return invoke("remove_worktree", { path, force });
}

export function getDiskUsage(path: string): Promise<number> {
  return invoke<number>("get_disk_usage", { path });
}
