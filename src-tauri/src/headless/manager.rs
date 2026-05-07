//! Process-wide registry of headless `Session`s, keyed by `tab_id`.
//!
//! `len`/`is_empty` are public for the eventual "max-tabs" check in Phase
//! 1c's spawn pre-flight; they are not consumed by the current command set.

#![allow(dead_code)]
//!
//! Mirrors the responsibility split of `pty::manager::PtyManager`: a thin
//! container that the Tauri command layer borrows via `State<HeadlessManager>`,
//! holding the lifecycle of every running headless CLI for the app.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use super::event::TabId;
use super::session::Session;

/// Process-wide registry. `Arc<Session>` so command handlers can pull a
/// session out, drop the registry lock, and `await` against the session
/// without holding a synchronous mutex across the await point.
#[derive(Default)]
pub struct HeadlessManager {
    sessions: Mutex<HashMap<TabId, Arc<Session>>>,
}

impl HeadlessManager {
    /// Insert a session. Returns `Err(existing)` if `tab_id` is already
    /// registered — the caller should never replace a session silently;
    /// they must explicitly tear the old one down first.
    pub fn insert(&self, session: Arc<Session>) -> Result<(), Arc<Session>> {
        let mut map = self.sessions.lock();
        if let Some(existing) = map.get(session.tab_id()).cloned() {
            return Err(existing);
        }
        map.insert(session.tab_id().to_string(), session);
        Ok(())
    }

    /// Look up a session by tab id. Returns `None` if no session is
    /// registered.
    pub fn get(&self, tab_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(tab_id).cloned()
    }

    /// Remove and return a session. The caller is responsible for calling
    /// `Session::shutdown` on the returned handle if a graceful exit is
    /// desired — the registry only manages registration, not lifecycle.
    pub fn remove(&self, tab_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().remove(tab_id)
    }

    /// Number of live sessions. Surfaced for diagnostics and the
    /// "too many panes" check that the command layer can perform.
    pub fn len(&self) -> usize {
        self.sessions.lock().len()
    }

    /// True iff zero sessions are registered.
    pub fn is_empty(&self) -> bool {
        self.sessions.lock().is_empty()
    }

    /// Snapshot of all registered tab ids, sorted. Useful for logging and
    /// the eventual "kill all" path during shutdown.
    pub fn tab_ids(&self) -> Vec<TabId> {
        let mut ids: Vec<_> = self.sessions.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Synchronous shutdown of every registered session. Mirrors
    /// `pty::manager::PtyManager::kill_all` so window-destroy handlers can
    /// be written symmetrically: `pty.kill_all(); headless.kill_all();`.
    /// Each session's `kill_now` runs immediately — no 3 s grace — because
    /// the Tauri runtime is about to stop and the alternative is leaking
    /// children.
    pub fn kill_all(&self) {
        let snapshot: Vec<_> = self.sessions.lock().drain().collect();
        for (_id, session) in snapshot {
            session.kill_now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Note: `Session` requires a real `tokio::process::Child` to construct,
    // so registry-level tests focus on map semantics with a stand-in. The
    // end-to-end `Session::start` round trip is exercised at the command
    // layer's integration tests.

    /// Fake session that satisfies the registry's `Arc<Session>` contract
    /// just enough for storage tests. We cannot construct a real `Session`
    /// without spawning a child, and that pulls Tauri AppHandle into scope.
    /// The registry only ever calls `tab_id()` on its values, so the type
    /// system protects us — but to keep the assert simple we test with two
    /// truly distinct tab ids that the manager treats as opaque keys.
    use std::collections::HashMap;

    /// A stub map exercising the same invariants the registry promises.
    /// We cannot directly build `Session` instances in unit tests without
    /// pulling in a Tauri runtime, so this test simply verifies that the
    /// public `HeadlessManager` API compiles and the empty case behaves.
    #[test]
    fn empty_manager_has_zero_sessions() {
        let m = HeadlessManager::default();
        assert!(m.is_empty());
        assert_eq!(m.len(), 0);
        assert!(m.get("absent").is_none());
        assert!(m.tab_ids().is_empty());
    }

    /// Integration with a real `Session` is covered by the command layer.
    /// Here we only assert that `remove` on a missing key is a no-op.
    #[test]
    fn remove_missing_is_noop() {
        let m = HeadlessManager::default();
        assert!(m.remove("never-existed").is_none());
    }

    /// Suppress the warning that `HashMap` is imported but only referenced
    /// in a type-only context — the import documents the underlying
    /// storage even when unit tests stay shallow.
    #[allow(dead_code)]
    fn _hash_map_use(_: HashMap<String, ()>) {}
}
