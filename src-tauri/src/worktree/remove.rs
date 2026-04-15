use std::path::Path;

use super::git;
use crate::error::AppError;

pub fn remove_worktree(path: &Path, force: bool) -> Result<(), AppError> {
    // `git worktree remove` requires the command be run inside the original
    // repository. Resolve its main repo via git -C <path> rev-parse --git-common-dir.
    let common_dir = resolve_common_dir(path)?;

    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force { args.push("--force"); }
    let path_str = path.to_string_lossy();
    args.push("--");
    args.push(&path_str);

    let out = git::run_git(&common_dir, &args)?;
    if !out.status.success() {
        return Err(AppError::WorktreeRemoveFailed {
            code: "git-remove".into(),
            message: String::from_utf8_lossy(&out.stderr).trim().into(),
        });
    }
    Ok(())
}

fn resolve_common_dir(path: &Path) -> Result<std::path::PathBuf, AppError> {
    let out = git::run_git(path, &["rev-parse", "--git-common-dir"])?;
    git::check_success(&out, "rev-parse-common-dir")?;
    let raw = git::stdout_utf8(&out);
    let as_path = std::path::PathBuf::from(&raw);
    // --git-common-dir returns either absolute or relative-to-path. Resolve.
    let resolved = if as_path.is_absolute() {
        as_path
    } else {
        path.join(&raw)
    };
    // Strip trailing "/.git" so we operate from the worktree/repo root
    let repo_root = resolved
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(resolved);
    Ok(repo_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{PostCreateHooks, ShareCargoTarget};
    use crate::worktree::create::create_worktree;
    use crate::worktree::list::list_worktrees;
    use crate::worktree::test_support::init_repo;
    use crate::worktree::CreateWorktreeRequest;
    use tempfile::TempDir;

    #[test]
    fn remove_worktree_drops_entry() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        let created = create_worktree(CreateWorktreeRequest {
            repo_root: repo.path().to_string_lossy().into(),
            base_branch: "main".into(),
            new_branch: "feat/removable".into(),
            base_path: base.path().to_string_lossy().into(),
            post_create_hooks: PostCreateHooks::default(),
            share_cargo_target: ShareCargoTarget::Auto,
            spotlight_exclude: false,
            pane_id: None,
        })
        .unwrap();

        remove_worktree(Path::new(&created.path), false).unwrap();

        let list = list_worktrees(repo.path()).unwrap();
        assert!(list.iter().all(|w| w.path != created.path));
        assert!(!Path::new(&created.path).exists());
    }

    #[test]
    fn remove_worktree_missing_path_errors() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let err = remove_worktree(&tmp.path().join("does-not-exist"), false).unwrap_err();
        matches!(err, AppError::WorktreeRemoveFailed { .. });
    }
}
