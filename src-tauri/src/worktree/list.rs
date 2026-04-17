use std::path::{Path, PathBuf};

use super::{BranchInfo, BranchKind, WorktreeInfo};
use crate::error::AppError;

pub fn find_git_repo_root(path: &Path) -> Result<Option<PathBuf>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    let out = super::git::run_git(path, &["rev-parse", "--show-toplevel"])?;
    if !out.status.success() {
        return Ok(None);
    }
    let root = super::git::stdout_utf8(&out);
    if root.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(root)))
    }
}

/// Returns the branch name (or short SHA for detached HEAD) of the git
/// repository containing `cwd`. Returns `None` when `cwd` is not inside a
/// git repository or when HEAD cannot be resolved.
pub fn get_current_branch(cwd: &Path) -> Result<Option<String>, AppError> {
    if !cwd.exists() {
        return Ok(None);
    }
    let sym = super::git::run_git(cwd, &["symbolic-ref", "--short", "HEAD"])?;
    if sym.status.success() {
        let name = super::git::stdout_utf8(&sym);
        if !name.is_empty() {
            return Ok(Some(name));
        }
    }
    let sha = super::git::run_git(cwd, &["rev-parse", "--short", "HEAD"])?;
    if sha.status.success() {
        let value = super::git::stdout_utf8(&sha);
        if !value.is_empty() {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

pub fn list_worktrees(repo_root: &Path) -> Result<Vec<WorktreeInfo>, AppError> {
    let out = super::git::run_git(repo_root, &["worktree", "list", "--porcelain"])?;
    super::git::check_success(&out, "worktree-list")?;
    Ok(parse_worktree_porcelain(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_worktree_porcelain(input: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    for line in input.lines() {
        if line.is_empty() {
            if let Some(info) = current.take() {
                out.push(info);
            }
            continue;
        }
        let (key, rest) = match line.split_once(' ') {
            Some((k, r)) => (k, r),
            None => (line, ""),
        };
        match key {
            "worktree" => {
                if let Some(info) = current.take() {
                    out.push(info);
                }
                current = Some(WorktreeInfo {
                    path: rest.to_string(),
                    branch: None,
                    head_sha: String::new(),
                    locked: false,
                    prunable: false,
                    detached: false,
                });
            }
            "HEAD" => {
                if let Some(info) = current.as_mut() {
                    info.head_sha = rest.to_string();
                }
            }
            "branch" => {
                if let Some(info) = current.as_mut() {
                    let name = rest.strip_prefix("refs/heads/").unwrap_or(rest);
                    info.branch = Some(name.to_string());
                }
            }
            "detached" => {
                if let Some(info) = current.as_mut() {
                    info.detached = true;
                }
            }
            "locked" => {
                if let Some(info) = current.as_mut() {
                    info.locked = true;
                }
            }
            "prunable" => {
                if let Some(info) = current.as_mut() {
                    info.prunable = true;
                }
            }
            _ => {}
        }
    }
    if let Some(info) = current.take() {
        out.push(info);
    }
    out
}

pub fn list_branches(repo_root: &Path) -> Result<Vec<BranchInfo>, AppError> {
    let out = super::git::run_git(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    super::git::check_success(&out, "for-each-ref")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut branches = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 2 { continue; }
        let refname = parts[0];
        let sha = parts[1];
        let upstream = parts.get(2).and_then(|s| if s.is_empty() { None } else { Some((*s).to_string()) });

        let (kind, name) = if let Some(rest) = refname.strip_prefix("refs/heads/") {
            (BranchKind::Local, rest.to_string())
        } else if let Some(rest) = refname.strip_prefix("refs/remotes/") {
            if rest.ends_with("/HEAD") { continue; }
            (BranchKind::Remote, rest.to_string())
        } else {
            continue;
        };

        branches.push(BranchInfo { name, kind, head_sha: sha.to_string(), upstream });
    }
    Ok(branches)
}

pub fn get_disk_usage(path: &Path) -> Result<u64, AppError> {
    if !path.exists() {
        return Ok(0);
    }
    walk_bytes(path).map_err(|e| AppError::FileSystemError(format!("disk usage: {e}")))
}

fn walk_bytes(path: &Path) -> std::io::Result<u64> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(meta.len());
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        total = total.saturating_add(walk_bytes(&entry.path())?);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::test_support::{init_repo, run};
    use std::process::Command;
    use tempfile::TempDir;

    #[test]
    fn find_repo_root_returns_none_for_non_repo() {
        let tmp = TempDir::new().unwrap();
        let root = find_git_repo_root(tmp.path()).unwrap();
        assert!(root.is_none());
    }

    #[test]
    fn find_repo_root_returns_path_for_repo() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let root = find_git_repo_root(tmp.path()).unwrap().unwrap();
        assert!(root.canonicalize().unwrap() == tmp.path().canonicalize().unwrap());
    }

    #[test]
    fn list_worktrees_returns_main_after_init() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let list = list_worktrees(tmp.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].branch.as_deref() == Some("main"));
        assert!(!list[0].head_sha.is_empty());
    }

    #[test]
    fn get_current_branch_returns_main_after_init() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let branch = get_current_branch(tmp.path()).unwrap();
        assert_eq!(branch.as_deref(), Some("main"));
    }

    #[test]
    fn get_current_branch_returns_none_for_non_repo() {
        let tmp = TempDir::new().unwrap();
        assert!(get_current_branch(tmp.path()).unwrap().is_none());
    }

    #[test]
    fn get_current_branch_returns_name_on_orphan_branch() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        run(tmp.path(), &["checkout", "--orphan", "empty"]);
        let branch = get_current_branch(tmp.path()).unwrap();
        assert_eq!(branch.as_deref(), Some("empty"));
    }

    #[test]
    fn get_current_branch_returns_sha_for_detached_head() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let head = Command::new("git")
            .current_dir(tmp.path())
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let full_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
        run(tmp.path(), &["checkout", "--detach", &full_sha]);
        let branch = get_current_branch(tmp.path()).unwrap().unwrap();
        assert!(!branch.is_empty());
        assert!(full_sha.starts_with(&branch));
    }

    #[test]
    fn list_branches_returns_main_local() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let branches = list_branches(tmp.path()).unwrap();
        assert!(branches.iter().any(|b| b.name == "main" && b.kind == BranchKind::Local));
    }

    #[test]
    fn parse_porcelain_handles_multiple_worktrees() {
        let input = "worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\nlocked\nprunable\n\n";
        let parsed = parse_worktree_porcelain(input);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert!(parsed[1].detached);
        assert!(parsed[1].locked);
        assert!(parsed[1].prunable);
    }

    #[test]
    fn get_disk_usage_sums_files() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        std::fs::write(tmp.path().join("b.txt"), b"hi").unwrap();
        assert_eq!(get_disk_usage(tmp.path()).unwrap(), 7);
    }

    #[test]
    fn get_disk_usage_returns_zero_for_missing() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("nope");
        assert_eq!(get_disk_usage(&missing).unwrap(), 0);
    }

    #[test]
    fn find_repo_root_returns_none_when_path_missing() {
        let p = PathBuf::from("/tmp/chorus-nonexistent-xyz-9999");
        assert!(find_git_repo_root(&p).unwrap().is_none());
    }

    // AC-R8: submodule / bare repo handling is documented in the spec as
    // "create_worktree rejects or warns"; here we at least ensure
    // list_worktrees does not panic on a bare repo.
    #[test]
    fn list_worktrees_handles_bare_repo() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("CHORUS_TEST_ISOLATE_GIT", "1");
        run(tmp.path(), &["init", "--bare"]);
        // bare repos without commits return empty porcelain output
        let list = list_worktrees(tmp.path()).unwrap_or_default();
        // The only assertion is that the call didn't panic.
        let _ = list;
    }
}
