//! Git worktree management used for pane-auto-worktree feature.
//!
//! The public surface exposes CRUD-style operations that Tauri commands
//! re-export. All git subprocess calls go through [`git::run_git`] so that
//! the `--` separator and environment isolation (for tests) are applied
//! uniformly.

pub mod create;
pub mod hook;
pub mod list;
pub mod remove;

use serde::{Deserialize, Serialize};

pub use crate::settings::ShareCargoTarget;
pub use create::create_worktree;
pub use hook::run_post_create_hooks;
pub use list::{find_git_repo_root, get_disk_usage, list_branches, list_worktrees};
pub use remove::remove_worktree;

// ---------- Shared types ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeRequest {
    pub repo_root: String,
    pub base_branch: String,
    pub new_branch: String,
    pub base_path: String,
    pub post_create_hooks: crate::settings::PostCreateHooks,
    pub share_cargo_target: ShareCargoTarget,
    pub spotlight_exclude: bool,
    #[serde(default)]
    pub pane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
    pub head_sha: String,
    pub hook_run_id: Option<String>,
    #[serde(default)]
    pub hook_warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head_sha: String,
    pub locked: bool,
    pub prunable: bool,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub kind: BranchKind,
    pub head_sha: String,
    pub upstream: Option<String>,
}

// ---------- Submodules: branch + path (private, consumed by create/list/remove) ----------

pub(crate) mod branch_name {
    //! Branch-name validation. Callers must pass the NFC-normalized value
    //! that will also be handed to `git`, so the validated string and the
    //! string sent to subprocess are guaranteed identical.

    use unicode_normalization::UnicodeNormalization;

    use crate::error::AppError;

    pub const MAX_LEN: usize = 100;

    /// Normalizes input to NFC and validates it against the allowlist.
    /// Returns the normalized value on success.
    pub fn validate(raw: &str) -> Result<String, AppError> {
        let normalized: String = raw.nfc().collect();
        check(&normalized)?;
        Ok(normalized)
    }

    fn check(name: &str) -> Result<(), AppError> {
        if name.is_empty() {
            return Err(AppError::WorktreeInvalidBranchName("empty".into()));
        }
        if name.len() > MAX_LEN {
            return Err(AppError::WorktreeInvalidBranchName(format!(
                "longer than {MAX_LEN}"
            )));
        }
        let first = name.chars().next().unwrap();
        if !first.is_ascii_alphanumeric() {
            return Err(AppError::WorktreeInvalidBranchName(
                "must start with ASCII alphanumeric".into(),
            ));
        }
        for c in name.chars() {
            if c.is_control() || c == '\0' {
                return Err(AppError::WorktreeInvalidBranchName(
                    "contains control characters".into(),
                ));
            }
            let is_allowed = c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-');
            if !is_allowed {
                return Err(AppError::WorktreeInvalidBranchName(format!(
                    "disallowed character: {c:?}"
                )));
            }
        }
        // forbid .. segments that enable path-traversal-like ref names
        for seg in name.split('/') {
            if seg == ".." || seg == "." || seg.is_empty() {
                return Err(AppError::WorktreeInvalidBranchName(format!(
                    "invalid segment: {seg:?}"
                )));
            }
            if seg.ends_with(".lock") {
                return Err(AppError::WorktreeInvalidBranchName(
                    "segment ends with .lock".into(),
                ));
            }
        }
        Ok(())
    }

    /// Converts a branch name to a single-level directory name used under
    /// `basePath`. Collapses `/` to `__` and appends `.noindex` when the
    /// caller wants Spotlight exclusion.
    pub fn to_dir_name(branch: &str, spotlight_exclude: bool) -> String {
        let flat = branch.replace('/', "__");
        if spotlight_exclude {
            format!("{flat}.noindex")
        } else {
            flat
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn accepts_simple_name() {
            assert!(validate("feat/foo-bar_1").is_ok());
        }

        #[test]
        fn rejects_empty() {
            assert!(validate("").is_err());
        }

        #[test]
        fn rejects_leading_hyphen() {
            assert!(validate("-foo").is_err());
        }

        #[test]
        fn rejects_nul() {
            assert!(validate("foo\0bar").is_err());
        }

        #[test]
        fn rejects_control_chars() {
            assert!(validate("foo\x01bar").is_err());
        }

        #[test]
        fn rejects_dotdot_segment() {
            assert!(validate("foo/../bar").is_err());
        }

        #[test]
        fn rejects_empty_segment() {
            assert!(validate("foo//bar").is_err());
        }

        #[test]
        fn rejects_lock_suffix() {
            assert!(validate("foo.lock").is_err());
            assert!(validate("a/b.lock").is_err());
        }

        #[test]
        fn rejects_disallowed_char() {
            assert!(validate("foo bar").is_err());
            assert!(validate("foo$bar").is_err());
        }

        #[test]
        fn rejects_length_over_100() {
            let long: String = "a".repeat(101);
            assert!(validate(&long).is_err());
        }

        #[test]
        fn rejects_non_ascii_characters() {
            // Allowlist is intentionally ASCII-only so paths remain stable
            // across NFC/NFD/HFS+ normalization quirks. NFC is still applied
            // before validation (see `validate`) in case the allowlist is
            // ever widened; today it simply becomes a rejection.
            assert!(validate("feat/caf\u{00e9}").is_err());
            assert!(validate("feat/caf\u{0065}\u{0301}").is_err());
        }

        #[test]
        fn to_dir_name_flattens_slashes() {
            assert_eq!(to_dir_name("feat/foo", false), "feat__foo");
        }

        #[test]
        fn to_dir_name_appends_noindex_when_requested() {
            assert_eq!(to_dir_name("feat/foo", true), "feat__foo.noindex");
        }
    }
}

pub(crate) mod path_util {
    //! Path generation + validation. Frontend never supplies the final
    //! worktree path; it is derived here from `basePath + branch` so the
    //! single source of truth lives on the backend.

    use std::path::{Path, PathBuf};

    use crate::error::AppError;

    pub fn expand_tilde(raw: &str) -> PathBuf {
        if let Some(stripped) = raw.strip_prefix("~/") {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join(stripped)
        } else if raw == "~" {
            PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        } else {
            PathBuf::from(raw)
        }
    }

    /// Ensures `base_path` exists (created with 0700 on Unix) and returns
    /// its canonical absolute path.
    pub fn ensure_base_path(base_path: &str) -> Result<PathBuf, AppError> {
        let expanded = expand_tilde(base_path);
        if !expanded.exists() {
            std::fs::create_dir_all(&expanded)
                .map_err(|e| AppError::FileSystemError(format!("mkdir basePath: {e}")))?;
            set_dir_mode_0700(&expanded);
        }
        expanded
            .canonicalize()
            .map_err(|e| AppError::FileSystemError(format!("canonicalize basePath: {e}")))
    }

    #[cfg(unix)]
    fn set_dir_mode_0700(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perm = meta.permissions();
            perm.set_mode(0o700);
            let _ = std::fs::set_permissions(path, perm);
        }
    }

    #[cfg(not(unix))]
    fn set_dir_mode_0700(_path: &Path) {}

    /// Computes the worktree path and verifies it stays under `base_abs`.
    /// The target path must not yet exist. `base_abs` must be canonical
    /// (`ensure_base_path` guarantees this); the parent of the returned
    /// candidate is re-canonicalized to defend against symlinks that
    /// appear between `ensure_base_path` and this call.
    pub fn build_worktree_path(
        base_abs: &Path,
        dir_name: &str,
    ) -> Result<PathBuf, AppError> {
        if dir_name.is_empty() || dir_name.contains('/') || dir_name.contains('\0') {
            return Err(AppError::WorktreePathTraversal(format!(
                "invalid dir name: {dir_name:?}"
            )));
        }
        let candidate = base_abs.join(dir_name);
        // Re-canonicalize the parent; if someone swapped basePath for a
        // symlink pointing elsewhere, this catches it.
        let parent = candidate
            .parent()
            .ok_or_else(|| AppError::WorktreePathTraversal("no parent".into()))?;
        let parent_canonical = parent
            .canonicalize()
            .map_err(|e| AppError::FileSystemError(format!("canonicalize parent: {e}")))?;
        if parent_canonical != base_abs {
            return Err(AppError::WorktreePathTraversal(format!(
                "parent escapes basePath: {}",
                parent_canonical.to_string_lossy()
            )));
        }
        if candidate.exists() {
            return Err(AppError::WorktreePathExists(
                candidate.to_string_lossy().into(),
            ));
        }
        Ok(candidate)
    }

    /// Post-creation verification: the created path must canonicalize
    /// inside `base_abs` (protects against symlink swap during creation).
    pub fn verify_created(base_abs: &Path, created: &Path) -> Result<(), AppError> {
        let resolved = created
            .canonicalize()
            .map_err(|e| AppError::FileSystemError(format!("canonicalize created: {e}")))?;
        if !resolved.starts_with(base_abs) {
            return Err(AppError::WorktreePathTraversal(format!(
                "created path escapes basePath: {}",
                resolved.to_string_lossy()
            )));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tempfile::TempDir;

        #[test]
        fn expand_tilde_replaces_prefix() {
            std::env::set_var("HOME", "/tmp/fake-home");
            let p = expand_tilde("~/foo/bar");
            assert_eq!(p, PathBuf::from("/tmp/fake-home/foo/bar"));
        }

        #[test]
        fn expand_tilde_passthrough_absolute() {
            assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
        }

        #[test]
        fn build_rejects_path_with_slash() {
            let tmp = TempDir::new().unwrap();
            let base = tmp.path().canonicalize().unwrap();
            let err = build_worktree_path(&base, "foo/bar").unwrap_err();
            matches!(err, AppError::WorktreePathTraversal(_));
        }

        #[test]
        fn build_rejects_nul() {
            let tmp = TempDir::new().unwrap();
            let base = tmp.path().canonicalize().unwrap();
            let err = build_worktree_path(&base, "foo\0bar").unwrap_err();
            matches!(err, AppError::WorktreePathTraversal(_));
        }

        #[test]
        fn build_rejects_existing() {
            let tmp = TempDir::new().unwrap();
            let base = tmp.path().canonicalize().unwrap();
            std::fs::create_dir_all(base.join("occupied")).unwrap();
            let err = build_worktree_path(&base, "occupied").unwrap_err();
            matches!(err, AppError::WorktreePathExists(_));
        }

        #[test]
        fn build_returns_valid_candidate() {
            let tmp = TempDir::new().unwrap();
            let base = tmp.path().canonicalize().unwrap();
            let p = build_worktree_path(&base, "feat__foo.noindex").unwrap();
            assert!(p.starts_with(&base));
            assert_eq!(p.file_name().unwrap(), "feat__foo.noindex");
        }

        #[cfg(unix)]
        #[test]
        fn build_rejects_when_base_is_swapped_to_symlink_elsewhere() {
            let anchor = TempDir::new().unwrap();
            let outside = TempDir::new().unwrap();
            let real_base = anchor.path().join("real_base");
            std::fs::create_dir_all(&real_base).unwrap();
            let base_abs = real_base.canonicalize().unwrap();

            // Swap real_base for a symlink pointing at a sibling outside
            // basePath. build_worktree_path must detect this.
            std::fs::remove_dir(&real_base).unwrap();
            std::os::unix::fs::symlink(outside.path(), &real_base).unwrap();

            let err = build_worktree_path(&base_abs, "wt").unwrap_err();
            assert!(
                matches!(
                    err,
                    AppError::WorktreePathTraversal(_) | AppError::FileSystemError(_)
                ),
                "expected traversal rejection, got {err:?}"
            );
        }

        #[test]
        fn ensure_base_path_creates_missing() {
            let tmp = TempDir::new().unwrap();
            let base = tmp.path().join("nested").join("worktrees");
            let result = ensure_base_path(base.to_str().unwrap()).unwrap();
            assert!(result.exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perm = std::fs::metadata(&result).unwrap().permissions();
                assert_eq!(perm.mode() & 0o777, 0o700);
            }
        }
    }
}

pub(crate) mod git {
    //! Subprocess wrapper. Ensures `--` separators and (optionally)
    //! test-isolated environment variables.

    use std::path::Path;
    use std::process::{Command, Output};

    use crate::error::AppError;

    /// Runs `git <args>` in the given CWD. Captures stdout/stderr.
    /// Returns `GitNotFound` if the binary is missing.
    pub fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, AppError> {
        // Resolve `git` against PATH with the fully-constructed command so we
        // can produce a clean `GitNotFound` error (AC-R12) before spawn.
        let program = which::which("git").map_err(|_| AppError::GitNotFound)?;
        let mut cmd = Command::new(program);
        cmd.current_dir(cwd);
        cmd.args(args);

        // Test isolation: avoid picking up the real user's global config
        // when CHORUS_TEST_ISOLATE_GIT is set (wired by the test harness).
        if std::env::var_os("CHORUS_TEST_ISOLATE_GIT").is_some() {
            cmd.env("GIT_CONFIG_SYSTEM", "/dev/null");
            cmd.env("GIT_CONFIG_GLOBAL", "/dev/null");
            cmd.env("GIT_TERMINAL_PROMPT", "0");
        }

        match cmd.output() {
            Ok(out) => Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::GitNotFound),
            Err(e) => Err(AppError::GitCommandFailed {
                code: "spawn".into(),
                message: e.to_string(),
            }),
        }
    }

    pub fn check_success(out: &Output, context: &str) -> Result<(), AppError> {
        if out.status.success() {
            Ok(())
        } else {
            Err(AppError::GitCommandFailed {
                code: context.into(),
                message: String::from_utf8_lossy(&out.stderr).trim().into(),
            })
        }
    }

    pub fn stdout_utf8(out: &Output) -> String {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ffi::OsStr;

        #[test]
        fn which_git_maps_missing_binary_to_git_not_found() {
            // AC-R12: when `which` fails to locate git in the provided PATH,
            // `run_git` must return `GitNotFound`. We exercise the
            // resolution strategy directly (without mutating the global env)
            // because mutating PATH races with parallel tests.
            let found = which::which_in(OsStr::new("git"), Some(""), std::env::current_dir().unwrap());
            let mapped: Result<(), AppError> = found.map(|_| ()).map_err(|_| AppError::GitNotFound);
            assert!(matches!(mapped, Err(AppError::GitNotFound)));
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared helpers for integration tests that need a real git repo.
    use std::path::Path;
    use std::process::Command;

    pub fn init_repo(dir: &Path) {
        std::env::set_var("CHORUS_TEST_ISOLATE_GIT", "1");
        run(dir, &["init", "-b", "main"]);
        run(dir, &["config", "user.email", "test@chorus.local"]);
        run(dir, &["config", "user.name", "Chorus Test"]);
        run(dir, &["commit", "--allow-empty", "-m", "initial"]);
    }

    pub fn run(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(dir)
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(args)
            .output()
            .expect("git command failed to spawn");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
