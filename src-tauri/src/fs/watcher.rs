use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, FileIdMap};
use notify_debouncer_full::notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

const DEBOUNCE_MS: u64 = 150;
const MAX_PATHS_PER_EVENT: usize = 200;

/// Directories that produce high-volume noise and are always ignored,
/// independent of the project's `.gitignore` (covers repos that forgot
/// to list them and non-git directories).
const ALWAYS_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".cache",
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsChangePayload {
    pub root: String,
    pub paths: Vec<String>,
}

pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

struct WatcherHandle {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, root: &str, app: AppHandle) -> Result<(), AppError> {
        let root_path = Path::new(root)
            .canonicalize()
            .map_err(|e| AppError::FileSystemError(format!("Cannot resolve path: {e}")))?;
        if !root_path.is_dir() {
            return Err(AppError::FileSystemError(format!(
                "Not a directory: {}",
                root_path.display()
            )));
        }

        let gitignore = build_gitignore(&root_path);
        let root_for_event = root_path.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            None,
            move |result: DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(errors) => {
                        tracing::warn!(?errors, "fs watcher error");
                        return;
                    }
                };

                let mut paths: Vec<String> = events
                    .iter()
                    .flat_map(|e| e.event.paths.iter())
                    .filter(|p| !is_ignored(p, &root_for_event, gitignore.as_ref()))
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();

                // sort + dedup collapses rapid duplicate notifications emitted by
                // editor atomic-save (e.g. swap file rename then unlink on the same path)
                paths.sort();
                paths.dedup();

                if paths.is_empty() {
                    return;
                }
                if paths.len() > MAX_PATHS_PER_EVENT {
                    tracing::warn!(
                        count = paths.len(),
                        kept = MAX_PATHS_PER_EVENT,
                        "fs watcher: truncated large change batch"
                    );
                    paths.truncate(MAX_PATHS_PER_EVENT);
                }

                let payload = FsChangePayload {
                    root: root_for_event.to_string_lossy().to_string(),
                    paths,
                };
                let _ = app.emit("fs-change", payload);
            },
        )
        .map_err(|e| AppError::FileSystemError(format!("watcher init failed: {e}")))?;

        debouncer
            .watcher()
            .watch(&root_path, RecursiveMode::Recursive)
            .map_err(|e| AppError::FileSystemError(format!("watch failed: {e}")))?;

        // Atomic swap: only replace the live watcher once the new one is
        // fully constructed + watching. If any step above fails, the old
        // watcher keeps running.
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::FileSystemError("watcher state poisoned".into()))?;
        *guard = Some(WatcherHandle { _debouncer: debouncer });
        tracing::info!(root = %root_path.display(), "fs watcher started");
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

fn build_gitignore(root: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    let _ = builder.add(root.join(".gitignore"));
    builder.build().ok()
}

fn is_ignored(path: &Path, root: &Path, gi: Option<&Gitignore>) -> bool {
    if !path.starts_with(root) {
        return true;
    }
    // Always skip high-noise dirs regardless of .gitignore state. Checked via
    // path components so deep paths like `foo/node_modules/bar` are caught.
    if path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| ALWAYS_IGNORED_DIRS.contains(&s))
    }) {
        return true;
    }
    if let Some(g) = gi {
        // `is_dir = false` because in delete events the path no longer exists
        // on disk, so `path.is_dir()` would silently return false and any
        // directory-only patterns in .gitignore (`build/`) wouldn't match.
        // Treating every path as a file still matches both `name` and `name/`
        // rules for files, which covers the common case.
        if g.matched_path_or_any_parents(path, false).is_ignore() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_root() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    #[test]
    fn always_ignored_dirs_rejected() {
        let dir = setup_root();
        let root = dir.path();
        for name in ALWAYS_IGNORED_DIRS {
            let path = root.join(name).join("inner.txt");
            assert!(
                is_ignored(&path, root, None),
                "expected {name} to be ignored"
            );
        }
    }

    #[test]
    fn nested_always_ignored_dirs_rejected() {
        let dir = setup_root();
        let root = dir.path();
        let path = root.join("packages/ui/node_modules/react/index.js");
        assert!(is_ignored(&path, root, None));
    }

    #[test]
    fn paths_outside_root_rejected() {
        let dir = setup_root();
        let root = dir.path();
        assert!(is_ignored(Path::new("/etc/passwd"), root, None));
    }

    #[test]
    fn paths_inside_root_allowed_without_gitignore() {
        let dir = setup_root();
        let root = dir.path();
        let path = root.join("src/main.rs");
        assert!(!is_ignored(&path, root, None));
    }

    #[test]
    fn gitignore_patterns_respected_for_missing_paths() {
        let dir = setup_root();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "build/\n*.log\n").unwrap();
        let gi = build_gitignore(root).expect("gitignore");

        // Deleted file under `build/` — path no longer exists on disk, but we
        // must still classify it as ignored (regression: old code used
        // `path.is_dir()` which returned false for deleted paths).
        let deleted = root.join("build/artifact.bin");
        assert!(is_ignored(&deleted, root, Some(&gi)));

        let log = root.join("debug.log");
        assert!(is_ignored(&log, root, Some(&gi)));

        let kept = root.join("src/main.rs");
        assert!(!is_ignored(&kept, root, Some(&gi)));
    }
}
