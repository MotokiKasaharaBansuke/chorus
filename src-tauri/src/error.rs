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
    SettingsLoadFailed(String),
    SettingsSaveFailed(String),
    GitRepoNotFound(String),
    GitNotFound,
    GitCommandFailed { code: String, message: String },
    WorktreeBranchExists(String),
    WorktreePathExists(String),
    WorktreeCreateFailed { code: String, message: String },
    WorktreeRemoveFailed { code: String, message: String },
    WorktreeHookFailed { code: String, message: String },
    WorktreeInvalidBranchName(String),
    WorktreePathTraversal(String),
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
            Self::SettingsLoadFailed(msg) => write!(f, "Settings load failed: {msg}"),
            Self::SettingsSaveFailed(msg) => write!(f, "Settings save failed: {msg}"),
            Self::GitRepoNotFound(msg) => write!(f, "Git repository not found: {msg}"),
            Self::GitNotFound => write!(f, "git executable not found on PATH"),
            Self::GitCommandFailed { code, message } => write!(f, "Git command failed [{code}]: {message}"),
            Self::WorktreeBranchExists(msg) => write!(f, "Worktree branch already exists: {msg}"),
            Self::WorktreePathExists(msg) => write!(f, "Worktree path already exists: {msg}"),
            Self::WorktreeCreateFailed { code, message } => write!(f, "Worktree create failed [{code}]: {message}"),
            Self::WorktreeRemoveFailed { code, message } => write!(f, "Worktree remove failed [{code}]: {message}"),
            Self::WorktreeHookFailed { code, message } => write!(f, "Worktree hook failed [{code}]: {message}"),
            Self::WorktreeInvalidBranchName(msg) => write!(f, "Invalid branch name: {msg}"),
            Self::WorktreePathTraversal(msg) => write!(f, "Path traversal detected: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}
