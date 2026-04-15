use std::path::{Path, PathBuf};

use super::{branch_name, git, path_util, CreateWorktreeRequest, CreatedWorktree};
use crate::error::AppError;

pub fn create_worktree(req: CreateWorktreeRequest) -> Result<CreatedWorktree, AppError> {
    let repo_root = PathBuf::from(&req.repo_root);
    if !repo_root.exists() {
        return Err(AppError::GitRepoNotFound(req.repo_root.clone()));
    }

    let branch = branch_name::validate(&req.new_branch)?;
    reject_if_branch_exists(&repo_root, &branch)?;

    let base_abs = path_util::ensure_base_path(&req.base_path)?;
    let dir_name = branch_name::to_dir_name(&branch, req.spotlight_exclude);
    let worktree_path = path_util::build_worktree_path(&base_abs, &dir_name)?;

    let base_sha = resolve_base_sha(&repo_root, &req.base_branch)?;
    let path_str = worktree_path.to_string_lossy();

    // Create both the new branch and its worktree in one call. `-b` creates
    // the branch from the explicit SHA so the worktree is pinned to the
    // revision captured at the moment of the dirty/list check (TOCTOU
    // mitigation: see spec §3.3).
    let add_out = git::run_git(
        &repo_root,
        &["worktree", "add", "-b", &branch, "--", &path_str, &base_sha],
    )?;
    git::check_success(&add_out, "worktree-add")?;

    path_util::verify_created(&base_abs, &worktree_path)?;

    Ok(CreatedWorktree {
        path: worktree_path.to_string_lossy().into_owned(),
        branch,
        head_sha: base_sha,
        hook_run_id: None,
        hook_warnings: Vec::new(),
    })
}

fn reject_if_branch_exists(repo_root: &Path, branch: &str) -> Result<(), AppError> {
    let out = git::run_git(
        repo_root,
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )?;
    if out.status.success() {
        Err(AppError::WorktreeBranchExists(branch.to_string()))
    } else {
        Ok(())
    }
}

fn resolve_base_sha(repo_root: &Path, base: &str) -> Result<String, AppError> {
    let out = git::run_git(repo_root, &["rev-parse", "--verify", base])?;
    git::check_success(&out, "rev-parse-base")?;
    Ok(git::stdout_utf8(&out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{PostCreateHooks, ShareCargoTarget};
    use crate::worktree::test_support::init_repo;
    use tempfile::TempDir;

    fn request(repo: &Path, base_path: &Path, branch: &str) -> CreateWorktreeRequest {
        CreateWorktreeRequest {
            repo_root: repo.to_string_lossy().into(),
            base_branch: "main".into(),
            new_branch: branch.into(),
            base_path: base_path.to_string_lossy().into(),
            post_create_hooks: PostCreateHooks::default(),
            share_cargo_target: ShareCargoTarget::Auto,
            spotlight_exclude: false,
            pane_id: None,
        }
    }

    #[test]
    fn creates_worktree_and_returns_head_sha() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        let req = request(repo.path(), base.path(), "feat/new-thing");
        let created = create_worktree(req).unwrap();

        assert_eq!(created.branch, "feat/new-thing");
        assert!(!created.head_sha.is_empty());
        assert!(Path::new(&created.path).exists());
        // must be inside the basePath
        assert!(Path::new(&created.path).canonicalize().unwrap().starts_with(base.path().canonicalize().unwrap()));
    }

    #[test]
    fn rejects_existing_branch() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());
        // create a branch first
        crate::worktree::test_support::run(repo.path(), &["branch", "feat/taken"]);

        let req = request(repo.path(), base.path(), "feat/taken");
        let err = create_worktree(req).unwrap_err();
        matches!(err, AppError::WorktreeBranchExists(_));
    }

    #[test]
    fn rejects_existing_path() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        // pre-create a directory at the target path (dir_name == branch because no slashes)
        std::fs::create_dir_all(base.path().join("feat__collide")).unwrap();

        let req = request(repo.path(), base.path(), "feat/collide");
        let err = create_worktree(req).unwrap_err();
        matches!(err, AppError::WorktreePathExists(_));
    }

    #[test]
    fn rejects_non_repo_path() {
        let base = TempDir::new().unwrap();
        let req = request(Path::new("/tmp/chorus-nonexistent-xyz"), base.path(), "feat/x");
        let err = create_worktree(req).unwrap_err();
        matches!(err, AppError::GitRepoNotFound(_));
    }

    #[test]
    fn rejects_invalid_branch_name() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        let req = request(repo.path(), base.path(), "-bad");
        let err = create_worktree(req).unwrap_err();
        matches!(err, AppError::WorktreeInvalidBranchName(_));
    }

    #[test]
    fn head_sha_matches_base_branch_at_creation_time() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        // Capture main's sha at this moment
        let main_sha_out = crate::worktree::git::run_git(
            repo.path(),
            &["rev-parse", "--verify", "main"],
        )
        .unwrap();
        let expected = crate::worktree::git::stdout_utf8(&main_sha_out);

        let created = create_worktree(request(repo.path(), base.path(), "feat/sha-check")).unwrap();
        assert_eq!(created.head_sha, expected);
    }

    #[test]
    fn dirty_base_tree_does_not_block_creation() {
        // AC-R2: per spec v2, dirty base emits a warning only; worktree add
        // proceeds because the new branch points at a resolved SHA.
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        // Leave a dirty file on main
        std::fs::write(repo.path().join("dirty.txt"), "uncommitted").unwrap();

        let created = create_worktree(request(repo.path(), base.path(), "feat/despite-dirty")).unwrap();
        assert!(Path::new(&created.path).exists());
    }

    #[test]
    fn base_branch_can_be_a_detached_sha() {
        // AC-R13: when `base_branch` is a raw SHA (detached), resolve_base_sha
        // still returns the commit and creation succeeds.
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        let sha_out = crate::worktree::git::run_git(repo.path(), &["rev-parse", "main"]).unwrap();
        let sha = crate::worktree::git::stdout_utf8(&sha_out);

        let mut req = request(repo.path(), base.path(), "feat/from-detached");
        req.base_branch = sha.clone();
        let created = create_worktree(req).unwrap();
        assert_eq!(created.head_sha, sha);
    }

    #[test]
    fn spotlight_exclude_appends_noindex_suffix() {
        let repo = TempDir::new().unwrap();
        let base = TempDir::new().unwrap();
        init_repo(repo.path());

        let mut req = request(repo.path(), base.path(), "feat/noidx");
        req.spotlight_exclude = true;

        let created = create_worktree(req).unwrap();
        assert!(created.path.ends_with(".noindex"));
    }
}
