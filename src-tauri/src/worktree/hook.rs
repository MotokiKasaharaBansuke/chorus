//! Post-create hook execution.
//!
//! MVP scope: synchronous filesystem operations only (copyCargoConfig,
//! symlinkEnvFiles). Command execution with PTY-IPC streaming and timeout
//! enforcement is implemented in T3-A; this module already honours the
//! allowlist and file-size / symlink safety checks required by the spec.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::AppError;
use crate::settings::PostCreateHooks;

const CARGO_CONFIG_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutcome {
    pub cargo_config_copied: bool,
    pub env_files_linked: Vec<String>,
    /// `true` when a `pnpm install` was spawned in the background.
    /// The output is not streamed in MVP scope; users observe completion via
    /// `node_modules/` appearing in the sidebar file tree.
    pub pnpm_install_started: bool,
    /// Lower-case code strings for hooks that were requested but failed to
    /// start / complete. Callers show them as warnings but do not block the
    /// pane creation.
    pub warnings: Vec<String>,
}

pub fn run_post_create_hooks(
    hooks: &PostCreateHooks,
    repo_root: &Path,
    worktree_path: &Path,
) -> Result<HookOutcome, AppError> {
    let mut outcome = HookOutcome::default();

    if hooks.copy_cargo_config {
        match copy_cargo_config(repo_root, worktree_path) {
            Ok(true) => outcome.cargo_config_copied = true,
            Ok(false) => {} // source not present or skipped
            Err(e) => outcome.warnings.push(format!("copyCargoConfig: {e}")),
        }
    }

    if hooks.symlink_env_files {
        for name in &hooks.env_file_allowlist {
            match symlink_env_file(repo_root, worktree_path, name) {
                Ok(true) => outcome.env_files_linked.push(name.clone()),
                Ok(false) => {}
                Err(e) => outcome.warnings.push(format!("symlink {name}: {e}")),
            }
        }
    }

    if hooks.pnpm_install && worktree_path.join("package.json").exists() {
        match spawn_pnpm_install(worktree_path) {
            Ok(()) => outcome.pnpm_install_started = true,
            Err(e) => outcome.warnings.push(format!("pnpmInstall: {e}")),
        }
    }

    Ok(outcome)
}

fn spawn_pnpm_install(worktree_path: &Path) -> Result<(), String> {
    let pnpm = which::which("pnpm").map_err(|_| "pnpm not found on PATH".to_string())?;
    let mut cmd = Command::new(&pnpm);
    cmd.arg("install")
        .current_dir(worktree_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid() is async-signal-safe and has no preconditions
        // beyond being called once per new session. pre_exec runs in the
        // child between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn().map_err(|e| format!("spawn pnpm: {e}"))?;
    Ok(())
}

fn copy_cargo_config(repo_root: &Path, worktree_path: &Path) -> Result<bool, String> {
    let src = repo_root.join(".cargo").join("config.toml");
    let meta = match std::fs::symlink_metadata(&src) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if meta.file_type().is_symlink() {
        return Err("source is a symlink (refusing to follow)".into());
    }
    if !meta.is_file() {
        return Err("source is not a regular file".into());
    }
    if meta.len() > CARGO_CONFIG_MAX_BYTES {
        return Err(format!(
            "source exceeds max size {CARGO_CONFIG_MAX_BYTES} bytes"
        ));
    }

    let content = std::fs::read(&src).map_err(|e| format!("read: {e}"))?;
    if std::str::from_utf8(&content).is_err() {
        return Err("source is not valid UTF-8".into());
    }

    let dst_dir = worktree_path.join(".cargo");
    std::fs::create_dir_all(&dst_dir).map_err(|e| format!("mkdir dst: {e}"))?;
    let dst = dst_dir.join("config.toml");
    if dst.exists() {
        return Ok(false); // idempotent: leave user-modified file alone
    }
    std::fs::write(&dst, content).map_err(|e| format!("write dst: {e}"))?;
    Ok(true)
}

#[cfg(unix)]
fn symlink_env_file(
    repo_root: &Path,
    worktree_path: &Path,
    name: &str,
) -> Result<bool, String> {
    // Allowlist: reject anything that leaves the repo_root directory.
    if name.contains('/') || name.contains('\\') || name.contains('\0') || name.starts_with("..") {
        return Err("name escapes repo root".into());
    }
    let src = repo_root.join(name);
    if !src.exists() {
        return Ok(false);
    }
    let dst = worktree_path.join(name);
    if dst.exists() {
        return Ok(false);
    }
    // Resolve to absolute path to avoid relative-path weirdness
    let src_abs = src
        .canonicalize()
        .map_err(|e| format!("canonicalize src: {e}"))?;
    std::os::unix::fs::symlink(&src_abs, &dst).map_err(|e| format!("symlink: {e}"))?;
    Ok(true)
}

#[cfg(not(unix))]
fn symlink_env_file(
    _repo_root: &Path,
    _worktree_path: &Path,
    _name: &str,
) -> Result<bool, String> {
    Err("symlinkEnvFiles is only supported on unix".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::PostCreateHooks;
    use tempfile::TempDir;

    fn hooks(copy: bool, link: bool, allowlist: &[&str]) -> PostCreateHooks {
        let mut h = PostCreateHooks::default();
        h.copy_cargo_config = copy;
        h.symlink_env_files = link;
        h.pnpm_install = false; // avoid spawning real pnpm in unit tests
        h.env_file_allowlist = allowlist.iter().map(|s| (*s).to_string()).collect();
        h
    }

    #[test]
    fn copies_cargo_config_when_source_exists() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".cargo")).unwrap();
        std::fs::write(repo.path().join(".cargo").join("config.toml"), "[build]\n").unwrap();

        let out = run_post_create_hooks(&hooks(true, false, &[]), repo.path(), worktree.path()).unwrap();
        assert!(out.cargo_config_copied);
        let copied = std::fs::read_to_string(worktree.path().join(".cargo").join("config.toml")).unwrap();
        assert_eq!(copied, "[build]\n");
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn skips_cargo_config_when_source_missing() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        let out = run_post_create_hooks(&hooks(true, false, &[]), repo.path(), worktree.path()).unwrap();
        assert!(!out.cargo_config_copied);
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn refuses_to_copy_when_source_is_symlink() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".cargo")).unwrap();
        let target = repo.path().join(".cargo").join("real.toml");
        std::fs::write(&target, "x").unwrap();
        std::os::unix::fs::symlink(&target, repo.path().join(".cargo").join("config.toml")).unwrap();

        let out = run_post_create_hooks(&hooks(true, false, &[]), repo.path(), worktree.path()).unwrap();
        assert!(!out.cargo_config_copied);
        assert!(out.warnings.iter().any(|w| w.contains("symlink")));
    }

    #[test]
    fn refuses_to_copy_when_source_exceeds_size_limit() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".cargo")).unwrap();
        let big = vec![b'a'; (CARGO_CONFIG_MAX_BYTES + 1) as usize];
        std::fs::write(repo.path().join(".cargo").join("config.toml"), big).unwrap();

        let out = run_post_create_hooks(&hooks(true, false, &[]), repo.path(), worktree.path()).unwrap();
        assert!(!out.cargo_config_copied);
        assert!(out.warnings.iter().any(|w| w.contains("max size")));
    }

    #[test]
    fn does_not_overwrite_existing_destination() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::create_dir_all(repo.path().join(".cargo")).unwrap();
        std::fs::write(repo.path().join(".cargo").join("config.toml"), "src").unwrap();
        std::fs::create_dir_all(worktree.path().join(".cargo")).unwrap();
        std::fs::write(worktree.path().join(".cargo").join("config.toml"), "user-edits").unwrap();

        let out = run_post_create_hooks(&hooks(true, false, &[]), repo.path(), worktree.path()).unwrap();
        assert!(!out.cargo_config_copied);
        let preserved = std::fs::read_to_string(worktree.path().join(".cargo").join("config.toml")).unwrap();
        assert_eq!(preserved, "user-edits");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_env_file_when_allowlisted_and_present() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::write(repo.path().join(".env.local"), "TOKEN=x").unwrap();

        let out = run_post_create_hooks(
            &hooks(false, true, &[".env.local"]),
            repo.path(),
            worktree.path(),
        )
        .unwrap();
        assert!(out.env_files_linked.iter().any(|n| n == ".env.local"));
        let resolved = std::fs::read_to_string(worktree.path().join(".env.local")).unwrap();
        assert_eq!(resolved, "TOKEN=x");
    }

    #[test]
    fn pnpm_install_skipped_without_package_json() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        let mut h = PostCreateHooks::default();
        h.pnpm_install = true;
        h.copy_cargo_config = false;
        h.symlink_env_files = false;
        let out = run_post_create_hooks(&h, repo.path(), worktree.path()).unwrap();
        assert!(!out.pnpm_install_started);
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn rejects_env_file_name_with_slash() {
        let repo = TempDir::new().unwrap();
        let worktree = TempDir::new().unwrap();
        std::fs::write(repo.path().join("evil"), "x").unwrap();

        let out = run_post_create_hooks(
            &hooks(false, true, &["../../etc/passwd"]),
            repo.path(),
            worktree.path(),
        )
        .unwrap();
        assert!(out.env_files_linked.is_empty());
        assert!(out.warnings.iter().any(|w| w.contains("escapes repo root")));
    }
}
