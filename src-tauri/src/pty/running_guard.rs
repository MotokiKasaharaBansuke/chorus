use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;

/// RAII guard that clears `running_since` on drop — even if the reader thread panics.
///
/// Created in `StreamSession::send_message` and moved into the reader thread.
/// When the thread exits (normally or via panic), `Drop` sets the value to `None`,
/// guaranteeing the session never gets permanently stuck in "busy" state.
pub(crate) struct MessageRunGuard {
    running_since: Arc<Mutex<Option<Instant>>>,
}

impl MessageRunGuard {
    pub fn new(running_since: Arc<Mutex<Option<Instant>>>) -> Self {
        Self { running_since }
    }
}

impl Drop for MessageRunGuard {
    fn drop(&mut self) {
        *self.running_since.lock() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_clears_running_since_on_drop() {
        let running = Arc::new(Mutex::new(Some(Instant::now())));
        {
            let _guard = MessageRunGuard::new(Arc::clone(&running));
            assert!(running.lock().is_some());
        }
        assert!(running.lock().is_none());
    }

    #[test]
    fn guard_clears_on_panic() {
        let running = Arc::new(Mutex::new(Some(Instant::now())));
        let running_clone = Arc::clone(&running);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = MessageRunGuard::new(running_clone);
            panic!("simulated reader thread panic");
        }));

        assert!(result.is_err());
        assert!(running.lock().is_none(), "running_since must be cleared even after panic");
    }
}
