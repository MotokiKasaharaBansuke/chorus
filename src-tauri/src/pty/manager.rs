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
    ) -> Result<(), AppError> {
        if self.sessions.lock().len() >= MAX_TABS {
            return Err(AppError::PtySpawnFailed(format!("Maximum tabs ({MAX_TABS}) reached")));
        }
        let session = StreamSession::new(cli_type, command, base_args, working_dir);
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
            match &mut session {
                Session::Pty(s) => s.kill(),
                Session::Stream(s) => s.kill(),
            }
            tracing::info!(session_id = id, "Session killed");
            Ok(())
        } else {
            Err(AppError::PtyNotFound(id.to_string()))
        }
    }

    pub fn kill_all(&self) {
        for (id, mut session) in self.sessions.lock().drain() {
            match &mut session {
                Session::Pty(s) => s.kill(),
                Session::Stream(s) => s.kill(),
            }
            tracing::info!(session_id = id, "Session killed (shutdown)");
        }
    }
}
