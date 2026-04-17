use serde::Deserialize;
use std::path::PathBuf;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliType {
    ClaudeCode,
    Codex,
    Shell,
}

impl CliType {
    /// Whether this CLI type uses a stream session (chat UI) or a PTY session (terminal UI)
    pub fn uses_stream_session(&self) -> bool {
        matches!(self, CliType::ClaudeCode | CliType::Codex)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliMode {
    Default,
    Plan,
    DangerouslySkipPermissions,
}

pub fn find_binary(name: &str) -> Option<PathBuf> {
    // Check common paths for CLI binaries
    let paths = [
        format!("/usr/local/bin/{name}"),
        format!("/opt/homebrew/bin/{name}"),
        format!("{}/.local/bin/{name}", std::env::var("HOME").unwrap_or_default()),
        format!("{}/.npm-global/bin/{name}", std::env::var("HOME").unwrap_or_default()),
        format!("{}/.volta/bin/{name}", std::env::var("HOME").unwrap_or_default()),
    ];

    for path in &paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    // Try PATH
    which::which(name).ok()
}

pub fn resolve_command(
    cli_type: &CliType,
    mode: &CliMode,
    model: &Option<String>,
) -> Result<(String, Vec<String>), AppError> {
    match cli_type {
        CliType::ClaudeCode => {
            let binary = find_binary("claude")
                .ok_or_else(|| AppError::CliNotFound(
                    "claude not found. Install: npm install -g @anthropic-ai/claude-code".into()
                ))?;

            let mut args = Vec::new();

            match mode {
                CliMode::DangerouslySkipPermissions => {
                    args.push("--dangerously-skip-permissions".into());
                }
                CliMode::Plan => {
                    // Plan mode is set via interactive command, not a CLI flag
                }
                CliMode::Default => {}
            }

            if let Some(m) = model {
                args.push("--model".into());
                args.push(m.clone());
            }

            Ok((binary.to_string_lossy().to_string(), args))
        }
        CliType::Codex => {
            let binary = find_binary("codex")
                .ok_or_else(|| AppError::CliNotFound(
                    "codex not found. Install: npm install -g @openai/codex".into()
                ))?;

            // Headless mode: `codex exec "prompt" --json [--full-auto] [--model <m>]`
            let mut args = vec!["exec".into()];

            match mode {
                CliMode::DangerouslySkipPermissions => {
                    args.push("--full-auto".into());
                }
                CliMode::Default => {}
                CliMode::Plan => {}
            }

            if let Some(m) = model {
                args.push("--model".into());
                args.push(m.clone());
            }

            Ok((binary.to_string_lossy().to_string(), args))
        }
        CliType::Shell => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            Ok((shell, vec!["-l".into()]))
        }
    }
}
