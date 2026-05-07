//! Validation primitives for headless CLI invocations.
//!
//! Argument injection is the primary threat model: any CLI flag synthesized
//! from session state, settings, or third-party JSONL must pass through this
//! module before reaching `tokio::process::Command::arg`.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

const MAX_SESSION_ID_LEN: usize = 64;
const MAX_MODEL_LEN: usize = 128;
const MAX_ENV_KEY_LEN: usize = 128;
const MAX_ENV_VALUE_LEN: usize = 4096;

/// Reasons for a validation rejection. Carries no user-controlled string so it
/// can be safely included in error responses without echoing the offending value.
#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    EmptySessionId,
    SessionIdTooLong,
    SessionIdLooksLikeFlag,
    SessionIdHasInvalidChars,

    EmptyCwd,
    CwdNotAbsolute,
    CwdHasParentTraversal,
    CwdLooksLikeFlag,

    EmptyModel,
    ModelTooLong,
    ModelLooksLikeFlag,
    ModelHasInvalidChars,

    EnvKeyEmpty,
    EnvKeyTooLong,
    EnvKeyHasInvalidChars,
    EnvKeySensitive,
    EnvValueTooLong,
    EnvValueHasNullByte,
}

/// UUID-like alphanumeric + dashes, 1..=64 chars, no leading dash.
///
/// Rejecting leading `-` defeats argument injection where a crafted session ID
/// would otherwise be interpreted as a CLI flag.
pub fn validate_session_id(id: &str) -> Result<(), ValidationError> {
    if id.is_empty() {
        return Err(ValidationError::EmptySessionId);
    }
    if id.len() > MAX_SESSION_ID_LEN {
        return Err(ValidationError::SessionIdTooLong);
    }
    if id.starts_with('-') {
        return Err(ValidationError::SessionIdLooksLikeFlag);
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(ValidationError::SessionIdHasInvalidChars);
    }
    Ok(())
}

/// Convenience wrapper used at parse boundaries where a boolean fits better.
pub fn is_valid_session_id(id: &str) -> bool {
    validate_session_id(id).is_ok()
}

/// Validate that `cwd` is an absolute path with no `..` components and no
/// flag-like prefix.
///
/// Existence is **not** checked here — the caller may want to create the
/// directory (e.g. worktree post-create). Symlink resolution is left to the
/// spawn site, which should canonicalize after lock acquisition.
pub fn validate_cwd(cwd: &str) -> Result<PathBuf, ValidationError> {
    if cwd.is_empty() {
        return Err(ValidationError::EmptyCwd);
    }
    if cwd.starts_with('-') {
        return Err(ValidationError::CwdLooksLikeFlag);
    }
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err(ValidationError::CwdNotAbsolute);
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(ValidationError::CwdHasParentTraversal);
    }
    Ok(path.to_path_buf())
}

/// Models accept letters, digits, `-`, `.`, `:`, `_`, `/`, up to 128 chars,
/// no leading dash.
///
/// The character set is wide enough for `claude-sonnet-4-6`, `gpt-5.0:beta`,
/// `anthropic/claude-opus-4`, but rejects shell metacharacters and whitespace.
pub fn validate_model(model: &str) -> Result<(), ValidationError> {
    if model.is_empty() {
        return Err(ValidationError::EmptyModel);
    }
    if model.len() > MAX_MODEL_LEN {
        return Err(ValidationError::ModelTooLong);
    }
    if model.starts_with('-') {
        return Err(ValidationError::ModelLooksLikeFlag);
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_' | '/');
    if !model.chars().all(allowed) {
        return Err(ValidationError::ModelHasInvalidChars);
    }
    Ok(())
}

/// Block credentials unrelated to AI assistant operation while allowing the
/// keys those CLIs legitimately need.
///
/// Strategy:
/// * Suffix blocklist for shape-bearing names (`*_PASSWORD`, `*_SECRET_KEY`,
///   `*_PRIVATE_KEY`, etc) — catches `STRIPE_SECRET_KEY`, `MY_DB_PASSWORD`,
///   and similar without an exhaustive product list.
/// * `*_TOKEN` is also blocked by default. Plenty of OAuth flows save
///   tokens to env (`OAUTH_TOKEN`, `ID_TOKEN`, `REFRESH_TOKEN`) and we do
///   not want any of those forwarded. The `TOKEN_ALLOWLIST` carves out the
///   handful that the AI CLIs need.
/// * Explicit list for fixed names that escape the suffix rules
///   (`AWS_SESSION_TOKEN` etc).
pub fn is_sensitive_env_key(key: &str) -> bool {
    /// Names ending in `_TOKEN` we deliberately let through. Keep this list
    /// short — every entry is a security exception. Prefer `*_API_KEY` style
    /// names where possible.
    const TOKEN_ALLOWLIST: &[&str] = &["GITHUB_TOKEN", "GH_TOKEN"];

    let upper = key.to_ascii_uppercase();

    if upper.ends_with("_TOKEN") && !TOKEN_ALLOWLIST.contains(&upper.as_str()) {
        return true;
    }

    upper.ends_with("_PASSWORD")
        || upper.ends_with("_PASSWD")
        || upper.ends_with("_SECRET")
        || upper.ends_with("_SECRET_KEY")
        || upper.ends_with("_PRIVATE_KEY")
        || upper.ends_with("_DSN")
        || upper.ends_with("_CONNECTION_STRING")
        || matches!(
            upper.as_str(),
            "AWS_SECRET_ACCESS_KEY"
                | "AWS_SESSION_TOKEN"
                | "DATABASE_URL"
                | "POSTGRES_URL"
                | "MYSQL_URL"
                | "REDIS_URL"
                | "MONGODB_URI"
        )
}

/// Validate one env key/value pair.
///
/// Keys must match POSIX `[A-Za-z_][A-Za-z0-9_]*`, length-bounded, and not in
/// the sensitive-key blocklist. Values are length-bounded and may not contain
/// NUL bytes (NUL terminates env on POSIX).
pub fn validate_env_entry(key: &str, value: &str) -> Result<(), ValidationError> {
    if key.is_empty() {
        return Err(ValidationError::EnvKeyEmpty);
    }
    if key.len() > MAX_ENV_KEY_LEN {
        return Err(ValidationError::EnvKeyTooLong);
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(ValidationError::EnvKeyHasInvalidChars);
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ValidationError::EnvKeyHasInvalidChars);
    }
    if is_sensitive_env_key(key) {
        return Err(ValidationError::EnvKeySensitive);
    }
    if value.len() > MAX_ENV_VALUE_LEN {
        return Err(ValidationError::EnvValueTooLong);
    }
    if value.contains('\0') {
        return Err(ValidationError::EnvValueHasNullByte);
    }
    Ok(())
}

/// Filter a caller-supplied env map to a safe subset for child processes.
///
/// Returns the rejected keys so the caller can surface a single warning event
/// instead of failing the whole spawn — the philosophy here is "drop and
/// continue", since AI CLIs typically tolerate a missing optional var.
pub fn sanitize_extra_env(
    env: HashMap<String, String>,
) -> (HashMap<String, String>, Vec<String>) {
    let mut accepted = HashMap::with_capacity(env.len());
    let mut rejected = Vec::new();
    for (k, v) in env {
        if validate_env_entry(&k, &v).is_ok() {
            accepted.insert(k, v);
        } else {
            rejected.push(k);
        }
    }
    (accepted, rejected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_accepts_uuid_v4() {
        assert!(is_valid_session_id("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn session_id_accepts_alnum_dashes() {
        assert!(is_valid_session_id("abc-123-XYZ"));
    }

    #[test]
    fn session_id_rejects_empty() {
        assert_eq!(validate_session_id(""), Err(ValidationError::EmptySessionId));
    }

    #[test]
    fn session_id_rejects_leading_dash() {
        assert_eq!(
            validate_session_id("-rm-rf"),
            Err(ValidationError::SessionIdLooksLikeFlag),
        );
    }

    #[test]
    fn session_id_rejects_double_dash_prefix() {
        assert_eq!(
            validate_session_id("--config=evil"),
            Err(ValidationError::SessionIdLooksLikeFlag),
        );
    }

    #[test]
    fn session_id_rejects_oversized() {
        let id = "a".repeat(65);
        assert_eq!(validate_session_id(&id), Err(ValidationError::SessionIdTooLong));
    }

    #[test]
    fn session_id_rejects_special_chars() {
        for bad in ["abc/def", "abc def", "abc.def", "abc;rm -rf /", "../parent"] {
            assert!(
                matches!(
                    validate_session_id(bad),
                    Err(ValidationError::SessionIdHasInvalidChars)
                        | Err(ValidationError::SessionIdLooksLikeFlag),
                ),
                "expected rejection for {bad:?}",
            );
        }
    }

    #[test]
    fn cwd_accepts_absolute_clean_path() {
        let cwd = validate_cwd("/Users/dev/project").unwrap();
        assert_eq!(cwd, PathBuf::from("/Users/dev/project"));
    }

    #[test]
    fn cwd_rejects_relative() {
        assert_eq!(validate_cwd("relative/path"), Err(ValidationError::CwdNotAbsolute));
    }

    #[test]
    fn cwd_rejects_parent_traversal() {
        assert_eq!(
            validate_cwd("/Users/dev/../etc"),
            Err(ValidationError::CwdHasParentTraversal),
        );
    }

    #[test]
    fn cwd_rejects_leading_dash() {
        assert_eq!(validate_cwd("-evil"), Err(ValidationError::CwdLooksLikeFlag));
    }

    #[test]
    fn cwd_rejects_empty() {
        assert_eq!(validate_cwd(""), Err(ValidationError::EmptyCwd));
    }

    #[test]
    fn model_accepts_known_aliases() {
        for ok in [
            "sonnet",
            "opus",
            "claude-sonnet-4-6",
            "claude-opus-4-7",
            "gpt-5",
            "anthropic/claude-opus-4",
            "claude-sonnet-4.6:beta",
        ] {
            assert!(validate_model(ok).is_ok(), "expected {ok:?} to pass");
        }
    }

    #[test]
    fn model_rejects_leading_dash() {
        assert_eq!(validate_model("-evil"), Err(ValidationError::ModelLooksLikeFlag));
    }

    #[test]
    fn model_rejects_shell_metas() {
        for bad in ["model;rm -rf", "model$(date)", "model|cat", "model with space"] {
            assert_eq!(
                validate_model(bad),
                Err(ValidationError::ModelHasInvalidChars),
                "expected {bad:?} to be rejected",
            );
        }
    }

    #[test]
    fn model_rejects_empty_and_oversized() {
        assert_eq!(validate_model(""), Err(ValidationError::EmptyModel));
        assert_eq!(validate_model(&"a".repeat(129)), Err(ValidationError::ModelTooLong));
    }

    #[test]
    fn sensitive_env_blocks_db_creds() {
        for k in [
            "MY_DB_PASSWORD",
            "STRIPE_SECRET_KEY",
            "DATABASE_URL",
            "AWS_SECRET_ACCESS_KEY",
            "REDIS_URL",
            "FOO_PRIVATE_KEY",
            "BAR_DSN",
        ] {
            assert!(is_sensitive_env_key(k), "{k} should be sensitive");
        }
    }

    #[test]
    fn sensitive_env_blocks_generic_tokens() {
        for k in [
            "OAUTH_TOKEN",
            "ID_TOKEN",
            "REFRESH_TOKEN",
            "ACCESS_TOKEN",
            "BEARER_TOKEN",
            "MY_PROVIDER_TOKEN",
        ] {
            assert!(is_sensitive_env_key(k), "{k} should be sensitive");
        }
    }

    #[test]
    fn sensitive_env_allows_ai_keys() {
        for k in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "PATH",
            "HOME",
        ] {
            assert!(!is_sensitive_env_key(k), "{k} should pass through");
        }
    }

    #[test]
    fn env_entry_rejects_invalid_key_chars() {
        assert_eq!(
            validate_env_entry("BAD-KEY", "v"),
            Err(ValidationError::EnvKeyHasInvalidChars),
        );
        assert_eq!(
            validate_env_entry("1LEADING_DIGIT", "v"),
            Err(ValidationError::EnvKeyHasInvalidChars),
        );
    }

    #[test]
    fn env_entry_rejects_null_byte_value() {
        assert_eq!(
            validate_env_entry("FOO", "bar\0baz"),
            Err(ValidationError::EnvValueHasNullByte),
        );
    }

    #[test]
    fn validate_env_entry_passes_allowlisted_token() {
        let pat = format!("{}{}", "ghp_", "abcdefghijklmnopqrstuvwxyz123456");
        validate_env_entry("GITHUB_TOKEN", &pat).expect("GITHUB_TOKEN must round-trip");
        validate_env_entry("GH_TOKEN", &pat).expect("GH_TOKEN must round-trip");
    }

    #[test]
    fn sanitize_extra_env_drops_only_offenders() {
        let mut input = HashMap::new();
        input.insert("ANTHROPIC_API_KEY".into(), "sk-ant-xxx".into());
        input.insert("DB_PASSWORD".into(), "leaked".into());
        input.insert("BAD-KEY".into(), "x".into());

        let (accepted, rejected) = sanitize_extra_env(input);
        assert!(accepted.contains_key("ANTHROPIC_API_KEY"));
        assert!(!accepted.contains_key("DB_PASSWORD"));
        assert!(!accepted.contains_key("BAD-KEY"));
        assert_eq!(rejected.len(), 2);
    }
}
