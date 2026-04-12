use serde::Serialize;

#[derive(Debug, Serialize)]
pub enum AppError {
    PtySpawnFailed(String),
    PtyNotFound(String),
    PtyWriteFailed(String),
    /// The stream session is currently processing a message.
    /// Distinct from `PtyWriteFailed` so the frontend can show "please wait"
    /// instead of triggering a respawn.
    StreamSessionBusy(String),
    FileSystemError(String),
    CliNotFound(String),
    ImageSaveFailed(String),
    ImageOperationFailed(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PtySpawnFailed(msg) => write!(f, "PTY spawn failed: {msg}"),
            Self::PtyNotFound(msg) => write!(f, "PTY not found: {msg}"),
            Self::PtyWriteFailed(msg) => write!(f, "PTY write failed: {msg}"),
            Self::StreamSessionBusy(msg) => write!(f, "Session busy: {msg}"),
            Self::FileSystemError(msg) => write!(f, "File system error: {msg}"),
            Self::CliNotFound(msg) => write!(f, "CLI not found: {msg}"),
            Self::ImageSaveFailed(msg) => write!(f, "Image save failed: {msg}"),
            Self::ImageOperationFailed(msg) => write!(f, "Image operation failed: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}
