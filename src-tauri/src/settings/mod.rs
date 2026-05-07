pub mod persist;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewCliType {
    ClaudeCode,
    Codex,
}

impl Default for ReviewCliType {
    fn default() -> Self { Self::Codex }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareCargoTarget {
    Auto,
    Always,
    Never,
}

impl Default for ShareCargoTarget {
    fn default() -> Self { Self::Auto }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PostCreateHooks {
    pub pnpm_install: bool,
    pub copy_cargo_config: bool,
    pub symlink_env_files: bool,
    pub env_file_allowlist: Vec<String>,
    pub run_in_background: bool,
    pub timeout_seconds: u64,
}

impl Default for PostCreateHooks {
    fn default() -> Self {
        Self {
            pnpm_install: true,
            copy_cargo_config: true,
            symlink_env_files: false,
            env_file_allowlist: vec![".env".into(), ".env.local".into(), ".env.development".into()],
            run_in_background: true,
            timeout_seconds: 600,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnPaneClose {
    pub prompt_remove_worktree: bool,
    pub background_delete: bool,
    pub auto_remove_on_close: bool,
}

impl Default for OnPaneClose {
    fn default() -> Self {
        Self { prompt_remove_worktree: true, background_delete: true, auto_remove_on_close: false }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreeSettings {
    pub auto_create: bool,
    pub base_path: String,
    pub branch_prefix: String,
    pub default_base_branch: String,
    pub share_cargo_target: ShareCargoTarget,
    pub spotlight_exclude: bool,
    pub watch_lockfiles: bool,
    pub warn_threshold: u32,
    pub post_create_hooks: PostCreateHooks,
    pub on_pane_close: OnPaneClose,
}

impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            auto_create: false,
            base_path: "~/chorus-worktrees".into(),
            branch_prefix: "feat/".into(),
            default_base_branch: "main".into(),
            share_cargo_target: ShareCargoTarget::Auto,
            spotlight_exclude: true,
            watch_lockfiles: true,
            warn_threshold: 10,
            post_create_hooks: PostCreateHooks::default(),
            on_pane_close: OnPaneClose::default(),
        }
    }
}

/// Default execution engine for Claude/Codex panes. Pre-Phase-3 sessions
/// have no field, which deserializes to `Pty` for backwards compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineDefault {
    #[default]
    Pty,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub review_cli_type: ReviewCliType,
    pub engine_default: EngineDefault,
    pub worktree: WorktreeSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            review_cli_type: ReviewCliType::default(),
            engine_default: EngineDefault::default(),
            worktree: WorktreeSettings::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values_match_spec() {
        let s = Settings::default();
        assert_eq!(s.review_cli_type, ReviewCliType::Codex);
        assert!(!s.worktree.auto_create);
        assert_eq!(s.worktree.base_path, "~/chorus-worktrees");
        assert_eq!(s.worktree.branch_prefix, "feat/");
        assert_eq!(s.worktree.default_base_branch, "main");
        assert_eq!(s.worktree.share_cargo_target, ShareCargoTarget::Auto);
        assert!(s.worktree.post_create_hooks.pnpm_install);
        assert_eq!(s.worktree.post_create_hooks.timeout_seconds, 600);
        assert!(s.worktree.on_pane_close.prompt_remove_worktree);
    }

    #[test]
    fn serialize_uses_camel_case() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"reviewCliType\""));
        assert!(json.contains("\"autoCreate\""));
        assert!(json.contains("\"basePath\""));
        assert!(json.contains("\"pnpmInstall\""));
        assert!(json.contains("\"timeoutSeconds\""));
    }

    #[test]
    fn review_cli_type_camel_case_in_json() {
        let json = serde_json::to_string(&ReviewCliType::ClaudeCode).unwrap();
        assert_eq!(json, "\"claudeCode\"");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let json = r#"{"reviewCliType":"codex","unknownField":"x","worktree":{"autoCreate":true,"unknownNested":42}}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.worktree.auto_create);
        assert_eq!(s.review_cli_type, ReviewCliType::Codex);
    }

    #[test]
    fn engine_default_round_trips_kebab_case() {
        let s = Settings { engine_default: EngineDefault::Headless, ..Default::default() };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"engineDefault\":\"headless\""), "{json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.engine_default, EngineDefault::Headless);
    }

    #[test]
    fn missing_engine_default_falls_back_to_pty() {
        // Pre-Phase-3 settings.json — no `engineDefault` key.
        let json = r#"{"reviewCliType":"codex"}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.engine_default, EngineDefault::Pty);
    }

    #[test]
    fn engine_default_explicit_pty_round_trips() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"engineDefault\":\"pty\""), "{json}");
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let json = r#"{"reviewCliType":"claudeCode"}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.review_cli_type, ReviewCliType::ClaudeCode);
        assert_eq!(s.engine_default, EngineDefault::Pty);
        assert_eq!(s.worktree, WorktreeSettings::default());
    }

    #[test]
    fn empty_object_yields_all_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
    }

}
