use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::AppHandle;

use crate::cli::registry::CliType;
use crate::error::AppError;
use super::session::{PtySession, StreamSession};

const MAX_TABS: usize = 20;

enum Session {
    Pty(PtySession),
    Stream(Arc<StreamSession>),
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn_pty(
        &self,
        id: &str,
        command: &str,
        args: &[String],
        working_dir: &str,
        cols: u16,
        rows: u16,
        app: AppHandle,
    ) -> Result<(), AppError> {
        if self.sessions.lock().len() >= MAX_TABS {
            return Err(AppError::PtySpawnFailed(format!("Maximum tabs ({MAX_TABS}) reached")));
        }
        let session = PtySession::spawn(id, command, args, working_dir, cols, rows, app)?;
        self.sessions.lock().insert(id.to_string(), Session::Pty(session));
        Ok(())
    }

    pub fn create_stream(
        &self,
        id: &str,
        cli_type: CliType,
        command: String,
        base_args: Vec<String>,
        working_dir: String,
        extra_env: HashMap<String, String>,
    ) -> Result<(), AppError> {
        if self.sessions.lock().len() >= MAX_TABS {
            return Err(AppError::PtySpawnFailed(format!("Maximum tabs ({MAX_TABS}) reached")));
        }
        let session = StreamSession::new(cli_type, command, base_args, working_dir, extra_env);
        self.sessions.lock().insert(id.to_string(), Session::Stream(Arc::new(session)));
        tracing::info!(session_id = id, "Stream session created");
        Ok(())
    }

    /// Send a message to a stream session.
    /// The Arc clone allows releasing the sessions lock before spawning the CLI process,
    /// so other sessions are not blocked during process startup.
    pub fn send_stream_message(
        &self,
        id: &str,
        message: &str,
        images: Option<&[super::session::ImageAttachment]>,
        app: AppHandle,
    ) -> Result<(), AppError> {
        let session = {
            let sessions = self.sessions.lock();
            match sessions.get(id) {
                Some(Session::Stream(s)) => Arc::clone(s),
                Some(Session::Pty(_)) => return Err(AppError::PtyWriteFailed("Not a stream session".into())),
                None => return Err(AppError::PtyNotFound(id.to_string())),
            }
        }; // Lock released here — before cmd.spawn()
        session.send_message(id, message, images, app)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock();
        match sessions.get_mut(id) {
            Some(Session::Pty(s)) => s.write(data),
            Some(Session::Stream(_)) => Err(AppError::PtyWriteFailed("Use send_stream_message for stream sessions".into())),
            None => Err(AppError::PtyNotFound(id.to_string())),
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let sessions = self.sessions.lock();
        match sessions.get(id) {
            Some(Session::Pty(s)) => s.resize(cols, rows),
            Some(Session::Stream(_)) => Ok(()),
            None => Err(AppError::PtyNotFound(id.to_string())),
        }
    }

    pub fn kill(&self, id: &str) -> Result<(), AppError> {
        if let Some(mut session) = self.sessions.lock().remove(id) {
            kill_session(&mut session);
            tracing::info!(session_id = id, "Session killed");
            Ok(())
        } else {
            Err(AppError::PtyNotFound(id.to_string()))
        }
    }

    pub fn list_session_ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }

    /// Returns (id, cli_type_str) pairs for sessions not in `keep`.
    pub fn list_zombie_infos(&self, keep: &[String]) -> Vec<(String, String)> {
        let sessions = self.sessions.lock();
        let keep_set: std::collections::HashSet<&str> =
            keep.iter().map(|s| s.as_str()).collect();
        sessions
            .iter()
            .filter(|(id, _)| !keep_set.contains(id.as_str()))
            .map(|(id, session)| {
                let cli_type = match session {
                    Session::Stream(s) => match s.cli_type {
                        CliType::ClaudeCode => "claude-code",
                        CliType::Codex => "codex",
                        CliType::Shell => "shell",
                    },
                    Session::Pty(_) => "shell",
                };
                (id.clone(), cli_type.to_string())
            })
            .collect()
    }

    /// Kills a single session by ID. Returns true if found and killed.
    pub fn kill_one(&self, id: &str) -> bool {
        if let Some(mut session) = self.sessions.lock().remove(id) {
            kill_session(&mut session);
            tracing::info!(session_id = id, "Session killed individually");
            true
        } else {
            false
        }
    }

    pub fn kill_except(&self, keep: &[String]) -> u32 {
        let mut sessions = self.sessions.lock();
        let keep_set: std::collections::HashSet<&str> =
            keep.iter().map(|s| s.as_str()).collect();
        let zombie_ids: Vec<String> = sessions
            .keys()
            .filter(|id| !keep_set.contains(id.as_str()))
            .cloned()
            .collect();
        let count = zombie_ids.len() as u32;
        for id in &zombie_ids {
            if let Some(mut session) = sessions.remove(id) {
                kill_session(&mut session);
                tracing::info!(session_id = %id, "Zombie session killed");
            }
        }
        count
    }

    pub fn kill_all(&self) {
        for (id, mut session) in self.sessions.lock().drain() {
            kill_session(&mut session);
            tracing::info!(session_id = id, "Session killed (shutdown)");
        }
    }
}

fn kill_session(session: &mut Session) {
    match session {
        Session::Pty(s) => s.kill(),
        Session::Stream(s) => s.kill(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::registry::CliType;

    fn make_manager_with_streams(ids: &[&str]) -> PtyManager {
        let mgr = PtyManager::new();
        for id in ids {
            mgr.create_stream(
                id,
                CliType::ClaudeCode,
                "claude".into(),
                vec![],
                "/tmp".into(),
                HashMap::new(),
            )
            .expect("create_stream should succeed");
        }
        mgr
    }

    #[test]
    fn list_zombie_infos_returns_non_kept_sessions() {
        let mgr = make_manager_with_streams(&["a", "b", "c"]);
        let zombies = mgr.list_zombie_infos(&["a".to_string()]);
        let mut ids: Vec<_> = zombies.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["b", "c"]);
    }

    #[test]
    fn list_zombie_infos_empty_when_all_kept() {
        let mgr = make_manager_with_streams(&["a", "b"]);
        let zombies = mgr.list_zombie_infos(&["a".to_string(), "b".to_string()]);
        assert!(zombies.is_empty());
    }

    #[test]
    fn list_zombie_infos_all_zombies_when_keep_empty() {
        let mgr = make_manager_with_streams(&["a", "b"]);
        let zombies = mgr.list_zombie_infos(&[]);
        assert_eq!(zombies.len(), 2);
    }

    #[test]
    fn list_zombie_infos_reports_claude_code_cli_type() {
        let mgr = make_manager_with_streams(&["x"]);
        let zombies = mgr.list_zombie_infos(&[]);
        assert_eq!(zombies.len(), 1);
        assert_eq!(zombies[0].1, "claude-code");
    }

    #[test]
    fn kill_one_returns_true_and_removes_session() {
        let mgr = make_manager_with_streams(&["a", "b"]);
        assert!(mgr.kill_one("a"));
        assert_eq!(mgr.list_session_ids().len(), 1);
        assert!(!mgr.list_session_ids().contains(&"a".to_string()));
    }

    #[test]
    fn kill_one_returns_false_for_missing_id() {
        let mgr = make_manager_with_streams(&["a"]);
        assert!(!mgr.kill_one("nonexistent"));
        assert_eq!(mgr.list_session_ids().len(), 1);
    }
}
