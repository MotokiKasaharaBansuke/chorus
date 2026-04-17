use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;

/// RAII guard that clears `running_since` on drop — even if the reader thread panics.
///
/// Created in `StreamSession::send_message` and moved into the reader thread.
/// When the thread exits (normally or via panic), `Drop` clears the value,
/// guaranteeing the session never gets permanently stuck in "busy" state.
///
/// Owns the `Instant` set at construction so it only clears its **own** run.
/// If `interrupt` + a fresh `send_message` race in before the old reader thread
/// notices EOF, `running_since` will already point to the new run's Instant.
/// Without the equality check the stale guard would wipe the new run's busy
/// flag, letting the next user message slip past the "already processing"
/// guard and double-spawn the CLI.
pub(crate) struct MessageRunGuard {
    running_since: Arc<Mutex<Option<Instant>>>,
    started: Instant,
}

impl MessageRunGuard {
    pub fn new(running_since: Arc<Mutex<Option<Instant>>>, started: Instant) -> Self {
        Self { running_since, started }
    }
}

impl Drop for MessageRunGuard {
    fn drop(&mut self) {
        let mut current = self.running_since.lock();
        if *current == Some(self.started) {
            *current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_clears_running_since_on_drop() {
        let started = Instant::now();
        let running = Arc::new(Mutex::new(Some(started)));
        {
            let _guard = MessageRunGuard::new(Arc::clone(&running), started);
            assert!(running.lock().is_some());
        }
        assert!(running.lock().is_none());
    }

    #[test]
    fn guard_clears_on_panic() {
        let started = Instant::now();
        let running = Arc::new(Mutex::new(Some(started)));
        let running_clone = Arc::clone(&running);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = MessageRunGuard::new(running_clone, started);
            panic!("simulated reader thread panic");
        }));

        assert!(result.is_err());
        assert!(running.lock().is_none(), "running_since must be cleared even after panic");
    }

    #[test]
    fn guard_does_not_clear_when_a_newer_run_has_taken_over() {
        // Race: old reader thread's guard drops after interrupt + a fresh
        // send_message has already replaced `running_since` with a new Instant.
        // The stale guard must not wipe the new run's busy flag.
        let old_started = Instant::now();
        let running = Arc::new(Mutex::new(Some(old_started)));
        let stale_guard = MessageRunGuard::new(Arc::clone(&running), old_started);

        // Simulate interrupt clearing + new send_message setting a new Instant.
        let new_started = Instant::now();
        *running.lock() = Some(new_started);

        drop(stale_guard);

        assert_eq!(*running.lock(), Some(new_started));
    }
}
