use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::worktree::{
    self, BranchInfo, CreateWorktreeRequest, CreatedWorktree, WorktreeInfo,
};

#[tauri::command]
pub fn find_git_repo_root(path: String) -> Result<Option<String>, AppError> {
    let p = PathBuf::from(path);
    let root = worktree::find_git_repo_root(&p)?;
    Ok(root.map(|r| r.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn list_branches(repo_root: String) -> Result<Vec<BranchInfo>, AppError> {
    worktree::list_branches(Path::new(&repo_root))
}

#[tauri::command]
pub fn list_worktrees(repo_root: String) -> Result<Vec<WorktreeInfo>, AppError> {
    worktree::list_worktrees(Path::new(&repo_root))
}

#[tauri::command]
pub fn create_worktree(
    req: CreateWorktreeRequest,
) -> Result<CreatedWorktree, AppError> {
    let repo = PathBuf::from(&req.repo_root);
    let mut created = worktree::create_worktree(req.clone())?;

    match worktree::run_post_create_hooks(
        &req.post_create_hooks,
        &repo,
        Path::new(&created.path),
    ) {
        Ok(outcome) => {
            created.hook_warnings = outcome.warnings;
        }
        Err(e) => {
            created.hook_warnings = vec![format!("hook runner: {e}")];
        }
    }

    Ok(created)
}

#[tauri::command]
pub fn remove_worktree(path: String, force: bool) -> Result<(), AppError> {
    worktree::remove_worktree(Path::new(&path), force)
}

#[tauri::command]
pub async fn get_disk_usage(path: String) -> Result<u64, AppError> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || worktree::get_disk_usage(&p))
        .await
        .map_err(|e| AppError::FileSystemError(format!("disk_usage task: {e}")))?
}
