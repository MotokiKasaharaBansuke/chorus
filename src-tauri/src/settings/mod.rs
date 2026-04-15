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

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub id: String,
    pub name: String,
    /// Path to a custom CLAUDE_CONFIG_DIR for this account (e.g. ~/.claude-work).
    /// Tilde is expanded at spawn time.
    pub claude_config_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub review_cli_type: ReviewCliType,
    pub worktree: WorktreeSettings,
    pub accounts: Vec<AccountProfile>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            review_cli_type: ReviewCliType::default(),
            worktree: WorktreeSettings::default(),
            accounts: Vec::new(),
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
    fn missing_fields_fall_back_to_defaults() {
        let json = r#"{"reviewCliType":"claudeCode"}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.review_cli_type, ReviewCliType::ClaudeCode);
        assert_eq!(s.worktree, WorktreeSettings::default());
    }

    #[test]
    fn empty_object_yields_all_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn default_accounts_is_empty() {
        let s = Settings::default();
        assert!(s.accounts.is_empty());
    }

    #[test]
    fn accounts_field_serializes_to_camel_case_array() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"accounts\""));
    }

    #[test]
    fn account_profile_roundtrips_with_config_dir() {
        let json = r#"{
            "reviewCliType":"codex",
            "worktree":{},
            "accounts":[
                {"id":"acc-1","name":"Work","claudeConfigDir":"~/.claude-work"}
            ]
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.accounts.len(), 1);
        let p = &s.accounts[0];
        assert_eq!(p.id, "acc-1");
        assert_eq!(p.name, "Work");
        assert_eq!(p.claude_config_dir.as_deref(), Some("~/.claude-work"));
    }

    #[test]
    fn account_profile_roundtrips_without_config_dir() {
        let json = r#"{"reviewCliType":"codex","worktree":{},"accounts":[{"id":"acc-2","name":"Personal"}]}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.accounts.len(), 1);
        assert!(s.accounts[0].claude_config_dir.is_none());
    }

    #[test]
    fn missing_accounts_field_falls_back_to_empty_vec() {
        // Old settings.json without the accounts field should still deserialize successfully
        let json = r#"{"reviewCliType":"codex","worktree":{}}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.accounts.is_empty());
    }
}
