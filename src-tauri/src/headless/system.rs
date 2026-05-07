//! OS-level concerns for the headless pipeline: fd budget and per-session
//! advisory locks.
//!
//! `current_fd_count` and `SessionLockError::AlreadyLocked` are public for
//! the diagnostics surface and the resume-flow respectively (both Phase 1c).

#![allow(dead_code)]
//!
//! macOS' default soft `RLIMIT_NOFILE` is 256, which 20 concurrent CLI
//! sessions blow through (each carries stdin/stdout/stderr plus epoll
//! plumbing — easily 5–6 fds, and worktree watchers add another 5 each).
//! `raise_fd_limit_to_target` raises the soft limit at startup; the lock module
//! prevents two Chorus instances from racing on the same `tab_id`.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::PathBuf;

use fs2::FileExt;

use crate::config_path::{headless_locks_dir, headless_session_lock};
use crate::headless::validation::is_valid_session_id;

/// Soft-limit target. 4096 covers ~50 concurrent sessions plus headroom
/// for fs watchers, log files, and Tauri internals.
pub const TARGET_NOFILE: u64 = 4096;

/// Raise the soft `RLIMIT_NOFILE` to `TARGET_NOFILE` if currently lower.
/// Idempotent — a no-op when the soft limit already exceeds the target.
/// Capped at the hard limit so the call cannot fail with `EPERM` in the
/// common case where the user has not granted unlimited fds.
pub fn raise_fd_limit_to_target() -> io::Result<()> {
    // SAFETY: `getrlimit`/`setrlimit` operate on a process-wide table and
    // require no synchronization beyond what the kernel provides.
    unsafe {
        let mut current: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) != 0 {
            return Err(io::Error::last_os_error());
        }
        // `libc::rlim_t` is `u64` on macOS and Linux today; comparison and
        // arithmetic work directly without an intermediate cast.
        if current.rlim_cur >= TARGET_NOFILE {
            return Ok(());
        }
        let new = libc::rlimit {
            rlim_cur: TARGET_NOFILE.min(current.rlim_max),
            rlim_max: current.rlim_max,
        };
        if libc::setrlimit(libc::RLIMIT_NOFILE, &new) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Best-effort fd count for diagnostics. Returns `None` on platforms where
/// `/dev/fd` is unavailable. Use sparingly — counts are sampled, not pinned.
pub fn current_fd_count() -> Option<usize> {
    std::fs::read_dir("/dev/fd").ok().map(|d| d.count())
}

/// Errors when acquiring a session lock.
#[derive(Debug)]
pub enum SessionLockError {
    /// Tab ID failed shape validation.
    InvalidTabId,
    /// Another process holds the lock.
    AlreadyLocked,
    /// IO error opening or locking the file.
    Io(io::Error),
}

impl std::fmt::Display for SessionLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTabId => write!(f, "invalid tab id"),
            Self::AlreadyLocked => write!(f, "session lock held by another process"),
            Self::Io(e) => write!(f, "session lock io error: {e}"),
        }
    }
}

impl std::error::Error for SessionLockError {}

impl From<io::Error> for SessionLockError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Advisory exclusive lock keyed by `tab_id`. Released on drop.
///
/// Lock files live in `~/.config/chorus/headless-locks/`; the file content
/// is empty — only the kernel-held flock matters. Files are intentionally
/// left on disk after release so future processes can detect stale locks
/// via mtime if a Chorus instance crashed without dropping cleanly.
pub struct SessionLock {
    file: File,
    path: PathBuf,
}

impl SessionLock {
    /// Try to acquire the lock for `tab_id`. Returns `Ok(Some(lock))` on
    /// success and `Ok(None)` when another process holds it.
    pub fn try_acquire(tab_id: &str) -> Result<Option<Self>, SessionLockError> {
        if !is_valid_session_id(tab_id) {
            return Err(SessionLockError::InvalidTabId);
        }
        let dir = headless_locks_dir();
        std::fs::create_dir_all(&dir)?;
        let path = headless_session_lock(tab_id);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { file, path })),
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock) => Ok(None),
            Err(e) => Err(SessionLockError::Io(e)),
        }
    }

    /// Path of the on-disk lock file. Useful for tests and diagnostics.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

/// Inspect the lock file for `tab_id` without trying to acquire it.
///
/// Returns `Ok(Some(age))` when a lock file exists and we can read its
/// mtime; the caller can then decide if the lock is stale (e.g. the
/// previous Chorus instance crashed without releasing it). `Ok(None)`
/// means no lock file is present, so a fresh acquire will succeed.
///
/// Released locks leave the file behind by design — the kernel-held
/// flock has cleared but the path stays so callers like this one have
/// an mtime to inspect.
pub fn lock_age(tab_id: &str) -> Result<Option<std::time::Duration>, SessionLockError> {
    if !is_valid_session_id(tab_id) {
        return Err(SessionLockError::InvalidTabId);
    }
    let path = headless_session_lock(tab_id);
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let mtime = meta.modified()?;
            // NTP-driven clock rewinds make `duration_since` return Err
            // when the system clock is now older than `mtime`. We reject
            // collapsing that into "no lock file" — the lock genuinely
            // exists. Fall through to `Duration::ZERO` so the caller's
            // staleness check sees a "very recent" lock and stays on the
            // safe side (treat as live, not stale).
            let age = std::time::SystemTime::now()
                .duration_since(mtime)
                .unwrap_or(std::time::Duration::ZERO);
            Ok(Some(age))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SessionLockError::Io(e)),
    }
}

/// Forcibly remove the lock file for `tab_id` so a subsequent
/// `try_acquire` succeeds. Caller must have first confirmed staleness via
/// `lock_age` and obtained user consent — this function performs no
/// safety checks of its own.
pub fn force_release_lock(tab_id: &str) -> Result<(), SessionLockError> {
    if !is_valid_session_id(tab_id) {
        return Err(SessionLockError::InvalidTabId);
    }
    let path = headless_session_lock(tab_id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(SessionLockError::Io(e)),
    }
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        // Release the kernel lock; ignore errors (the file is unlinked on
        // drop only if the user explicitly cleans up — we keep the file so
        // a future stale-lock detector has an mtime to inspect).
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn raise_fd_limit_is_idempotent() {
        raise_fd_limit_to_target().expect("first call");
        raise_fd_limit_to_target().expect("second call");
    }

    #[test]
    #[serial]
    fn current_fd_count_returns_some_on_unix() {
        // Both macOS and Linux expose /dev/fd; guarantee the helper is
        // operational on this platform.
        assert!(current_fd_count().is_some());
    }

    #[test]
    fn try_acquire_rejects_invalid_tab_id() {
        assert!(matches!(
            SessionLock::try_acquire("--evil"),
            Err(SessionLockError::InvalidTabId),
        ));
        assert!(matches!(
            SessionLock::try_acquire(""),
            Err(SessionLockError::InvalidTabId),
        ));
    }

    /// Two acquires on the same `tab_id` from the same process: the second
    /// returns `Ok(None)` because the kernel lock is held by the first.
    #[test]
    #[serial]
    fn second_acquire_yields_none_until_first_drops() {
        let tab = "lock-test-second-acquire";
        let _first = SessionLock::try_acquire(tab)
            .expect("first acquire result")
            .expect("first acquire holds the lock");
        let second = SessionLock::try_acquire(tab).expect("second acquire result");
        assert!(second.is_none(), "expected lock contention");
        // After dropping `_first`, a fresh acquire should succeed.
        drop(_first);
        let third = SessionLock::try_acquire(tab)
            .expect("third acquire result")
            .expect("third acquire after drop");
        drop(third);
    }

    #[test]
    #[serial]
    fn lock_age_returns_none_when_no_file_exists() {
        let tab = "lock-age-fresh";
        let _ = force_release_lock(tab);
        assert!(lock_age(tab).unwrap().is_none());
    }

    #[test]
    #[serial]
    fn lock_age_returns_some_after_acquire() {
        let tab = "lock-age-after-acquire";
        let _ = force_release_lock(tab);
        let lock = SessionLock::try_acquire(tab).unwrap().expect("acquire");
        let age = lock_age(tab).unwrap();
        assert!(age.is_some(), "lock_age should return Some after acquire");
        drop(lock);
        let _ = force_release_lock(tab);
    }

    #[test]
    #[serial]
    fn force_release_after_acquire_lets_next_acquire_succeed() {
        let tab = "lock-force-release";
        let _ = force_release_lock(tab);
        let lock = SessionLock::try_acquire(tab).unwrap().expect("acquire 1");
        // Second acquire fails because flock is held.
        assert!(SessionLock::try_acquire(tab).unwrap().is_none());
        // Drop the live lock so flock is released; force_release also
        // unlinks the file.
        drop(lock);
        force_release_lock(tab).expect("force_release");
        let lock2 = SessionLock::try_acquire(tab).unwrap().expect("acquire 2");
        drop(lock2);
        let _ = force_release_lock(tab);
    }

    #[test]
    fn lock_age_rejects_invalid_tab_id() {
        assert!(matches!(lock_age("--evil"), Err(SessionLockError::InvalidTabId)));
        assert!(matches!(force_release_lock("--evil"), Err(SessionLockError::InvalidTabId)));
    }

    #[test]
    #[serial]
    fn distinct_tab_ids_do_not_contend() {
        let a = SessionLock::try_acquire("lock-test-distinct-a")
            .unwrap()
            .expect("acquire a");
        let b = SessionLock::try_acquire("lock-test-distinct-b")
            .unwrap()
            .expect("acquire b");
        assert_ne!(a.path(), b.path());
    }
}
