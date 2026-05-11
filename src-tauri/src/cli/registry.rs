use serde::Deserialize;
use std::path::PathBuf;

use crate::error::AppError;

/// Fallback codex model used when the user has not picked one. Chosen
/// because it is available on the broadest plan tier (including the
/// ChatGPT subscription plan) — codex's own default is plan-gated and
/// errors mid-turn for many users without a clear UI signal.
const DEFAULT_CODEX_MODEL: &str = "gpt-5.2";

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

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CliMode {
    #[default]
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
            tracing::info!(binary = name, path = %p.display(), "cli binary resolved");
            return Some(p);
        }
    }

    // Try PATH
    if let Ok(p) = which::which(name) {
        tracing::info!(binary = name, path = %p.display(), "cli binary resolved via PATH");
        return Some(p);
    }
    None
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

            // Load user-scope (~/.claude.json), project-scope, and
            // local-scope settings so that MCP servers registered by the
            // user are available inside Chorus sessions — matching the
            // behaviour of the Cursor Claude Code extension.
            args.push("--setting-sources=user,project,local".into());

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

            // Codex's built-in default (`gpt-5.1-codex-max`) is gated
            // behind an API plan that ChatGPT-account users do not
            // have, so an unspecified model crashes the CLI with
            // `exit 1` mid-turn. Pin a sensible fallback that works
            // on the broadest plan tier; users can still override
            // via `cliConfig.model` per pane.
            args.push("--model".into());
            args.push(model.clone().unwrap_or_else(|| DEFAULT_CODEX_MODEL.into()));

            Ok((binary.to_string_lossy().to_string(), args))
        }
        CliType::Shell => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            Ok((shell, vec!["-l".into()]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `resolve_command` が ClaudeCode に対して `--setting-sources` を返すことを検証
    #[test]
    fn claude_code_includes_setting_sources() {
        // claude バイナリが存在しない環境では CliNotFound になるためスキップ
        let Ok((_bin, args)) = resolve_command(
            &CliType::ClaudeCode,
            &CliMode::Default,
            &None,
        ) else {
            eprintln!("skipping: claude binary not found");
            return;
        };

        assert!(
            args.iter().any(|a| a == "--setting-sources=user,project,local"),
            "expected --setting-sources=user,project,local in args: {args:?}",
        );
    }

    /// DangerouslySkipPermissions モードでも `--setting-sources` が含まれる
    #[test]
    fn claude_code_dangerous_mode_includes_setting_sources() {
        let Ok((_bin, args)) = resolve_command(
            &CliType::ClaudeCode,
            &CliMode::DangerouslySkipPermissions,
            &None,
        ) else {
            return;
        };

        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"--setting-sources=user,project,local".to_string()));
    }

    /// model 指定時も `--setting-sources` が含まれる
    #[test]
    fn claude_code_with_model_includes_setting_sources() {
        let Ok((_bin, args)) = resolve_command(
            &CliType::ClaudeCode,
            &CliMode::Default,
            &Some("claude-sonnet-4-5-20250514".into()),
        ) else {
            return;
        };

        assert!(args.contains(&"--setting-sources=user,project,local".to_string()));
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"claude-sonnet-4-5-20250514".to_string()));
    }

    /// Codex には `--setting-sources` が含まれない
    #[test]
    fn codex_does_not_include_setting_sources() {
        let Ok((_bin, args)) = resolve_command(
            &CliType::Codex,
            &CliMode::Default,
            &None,
        ) else {
            return;
        };

        assert!(
            !args.iter().any(|a| a.contains("setting-sources")),
            "codex should not have --setting-sources: {args:?}",
        );
    }
}
