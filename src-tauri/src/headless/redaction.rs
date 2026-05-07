//! Secret redaction for log output.
//!
//! Applied at the `tracing` boundary only — never to user-facing event
//! payloads. The user wants to see their own tool output verbatim; logs are
//! the place where credentials accidentally end up in shared bug reports.
//!
//! Patterns are deliberately narrow: known-shape provider tokens with low
//! false-positive rates. A wide regex like `\b[A-Za-z0-9]{32,}\b` would scrub
//! UUIDs, hashes, and identifiers — making logs less useful without making
//! anything safer.

use std::sync::OnceLock;

use regex::Regex;

const REDACTED: &str = "[REDACTED]";

struct Patterns {
    aws_access_key: Regex,
    github_classic_token: Regex,
    github_fine_grained_pat: Regex,
    anthropic_key: Regex,
    openai_key: Regex,
    pem_private_key: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        // AWS access key IDs are documented as 20-char prefix `AKIA`/`ASIA`.
        aws_access_key: Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").unwrap(),
        // Classic GitHub PATs / OAuth / installation tokens.
        github_classic_token: Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b").unwrap(),
        // Fine-grained PATs: `github_pat_<22 alnum/_>_<59 alnum>`.
        github_fine_grained_pat: Regex::new(
            r"\bgithub_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9]{59,}\b",
        )
        .unwrap(),
        // Anthropic API keys.
        anthropic_key: Regex::new(r"sk-ant-[A-Za-z0-9_\-]{20,}").unwrap(),
        // OpenAI keys (legacy `sk-…` and project-scoped `sk-proj-…`).
        openai_key: Regex::new(r"sk-(?:proj-)?[A-Za-z0-9_\-]{20,}").unwrap(),
        // PEM-encoded private keys — match the BEGIN line and everything to END.
        // `(?s)` enables `.` across newlines.
        pem_private_key: Regex::new(
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        )
        .unwrap(),
    })
}

/// Replace known secret shapes in `s` with `[REDACTED]`.
///
/// Order matters:
/// * PEM keys span multiple lines and must run first.
/// * `anthropic_key` (`sk-ant-…`) before `openai_key` (`sk-…`); otherwise
///   the OpenAI pattern would match the prefix of an Anthropic key.
pub fn redact(s: &str) -> String {
    let p = patterns();
    let mut out = p.pem_private_key.replace_all(s, REDACTED).into_owned();
    out = p.anthropic_key.replace_all(&out, REDACTED).into_owned();
    out = p.openai_key.replace_all(&out, REDACTED).into_owned();
    out = p
        .github_fine_grained_pat
        .replace_all(&out, REDACTED)
        .into_owned();
    out = p
        .github_classic_token
        .replace_all(&out, REDACTED)
        .into_owned();
    out = p.aws_access_key.replace_all(&out, REDACTED).into_owned();
    out
}

/// True iff `s` contains any known secret shape. Useful for assertions in
/// tests where redaction is invariant rather than transformation.
pub fn contains_secret(s: &str) -> bool {
    let p = patterns();
    p.aws_access_key.is_match(s)
        || p.github_classic_token.is_match(s)
        || p.github_fine_grained_pat.is_match(s)
        || p.anthropic_key.is_match(s)
        || p.openai_key.is_match(s)
        || p.pem_private_key.is_match(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test fixtures are assembled at runtime so the literal source never
    // matches a credential scanner.
    fn aws_long_term() -> String {
        format!("{}IOSFODNN7EXAMPLE", "AKIA")
    }

    fn aws_temporary() -> String {
        format!("{}1234567890ABCDEF", "ASIA")
    }

    fn gh_pat() -> String {
        format!("ghp{}{}", "_", "abcdefghijklmnopqrstuvwxyz123456")
    }

    fn gh_fine_grained_pat() -> String {
        // `github_pat_<22 alnum/_>_<59 alnum>` — assemble at runtime so
        // credential scanners don't trip on the literal source.
        format!(
            "{}{}{}_{}",
            "github",
            "_pat_",
            "AAAAAAAAAA1234567890XY",
            "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVW",
        )
    }

    fn anthropic_key() -> String {
        format!("sk-{}-{}", "ant", "api03-AbCdEfGhIjKlMnOpQrSt-_0123456789")
    }

    fn openai_legacy() -> String {
        format!("sk-{}", "1234567890abcdefghijABCDEFGHIJ")
    }

    fn openai_proj() -> String {
        format!("sk-proj-{}", "abcdefghij_klmnopqrstuvwxyz")
    }

    /// Build a PEM-shaped fixture without writing the literal header in the
    /// source. Credential scanners (gitleaks, trufflehog) flag any literal
    /// `BEGIN … PRIVATE KEY` block on disk, even inside a `#[cfg(test)]`
    /// fixture, so we assemble the headers at runtime.
    fn pem_fixture(label: &str, body: &str) -> String {
        let begin = format!("-----{} {}-----", "BEGIN", label);
        let end = format!("-----{} {}-----", "END", label);
        format!("{begin}\n{body}\n{end}")
    }

    #[test]
    fn redacts_aws_access_key_id() {
        let key = aws_long_term();
        let out = redact(&format!("AWS_ACCESS_KEY_ID={key} leftover"));
        assert_eq!(out, "AWS_ACCESS_KEY_ID=[REDACTED] leftover");
    }

    #[test]
    fn redacts_temporary_aws_key() {
        let out = redact(&aws_temporary());
        assert_eq!(out, "[REDACTED]");
    }

    #[test]
    fn redacts_github_pat() {
        let out = redact(&format!("token={}", gh_pat()));
        assert_eq!(out, "token=[REDACTED]");
    }

    #[test]
    fn redacts_github_fine_grained_pat() {
        let out = redact(&format!("token={}", gh_fine_grained_pat()));
        assert_eq!(out, "token=[REDACTED]");
    }

    #[test]
    fn redacts_github_oauth_and_install() {
        for prefix in ["gho", "ghu", "ghs", "ghr"] {
            let s = format!("{prefix}{}{}", "_", "a".repeat(40));
            assert_eq!(redact(&s), "[REDACTED]");
        }
    }

    #[test]
    fn redacts_anthropic_api_key() {
        let out = redact(&format!("ANTHROPIC_API_KEY={}", anthropic_key()));
        assert_eq!(out, "ANTHROPIC_API_KEY=[REDACTED]");
    }

    #[test]
    fn redacts_openai_legacy_and_project_keys() {
        let out = redact(&format!("legacy={} proj={}", openai_legacy(), openai_proj()));
        assert_eq!(out, "legacy=[REDACTED] proj=[REDACTED]");
    }

    #[test]
    fn redacts_pem_private_key_block() {
        let pem = pem_fixture("RSA PRIVATE KEY", "MIIEpAIBAAK...");
        let out = redact(&format!("before\n{pem}\nafter"));
        assert!(out.contains("[REDACTED]"));
        assert!(!out.contains("MIIEpAIBAAK"));
        assert!(out.starts_with("before\n"));
        assert!(out.ends_with("\nafter"));
    }

    #[test]
    fn redacts_pem_with_various_key_types() {
        for label in ["RSA PRIVATE KEY", "PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"] {
            let pem = pem_fixture(label, "body");
            assert!(redact(&pem).contains("[REDACTED]"));
        }
    }

    #[test]
    fn passes_through_innocuous_text() {
        let s = "user said: my access pattern is 32 characters wide and contains hex";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn passes_through_uuids_and_short_ids() {
        let s = "session_id=550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(redact(s), s);
    }

    #[test]
    fn handles_multiple_secrets_in_one_string() {
        let s = format!("{} and {}", aws_long_term(), gh_pat());
        let out = redact(&s);
        assert_eq!(out, "[REDACTED] and [REDACTED]");
    }

    #[test]
    fn contains_secret_detects_each_kind() {
        assert!(contains_secret(&aws_long_term()));
        assert!(contains_secret(&gh_pat()));
        assert!(contains_secret(&gh_fine_grained_pat()));
        assert!(contains_secret(&anthropic_key()));
        assert!(contains_secret(&openai_proj()));
        assert!(contains_secret(&pem_fixture("PRIVATE KEY", "x")));
        assert!(!contains_secret("just a normal log line"));
    }

    #[test]
    fn anthropic_key_is_redacted_intact_not_swallowed_by_openai_rule() {
        // Order matters: the openai_key regex matches the `sk-…` prefix of an
        // Anthropic key. Running anthropic before openai must produce one
        // [REDACTED], not "sk-[REDACTED]" or similar partial mangling.
        let out = redact(&anthropic_key());
        assert_eq!(out, "[REDACTED]");
    }
}
