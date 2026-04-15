use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::Deserialize;

use super::Settings;
use crate::error::AppError;

const MAX_CORRUPT_BACKUPS: usize = 5;

pub struct SettingsPaths {
    pub settings: PathBuf,
    pub lock: PathBuf,
    pub tmp: PathBuf,
    pub session: PathBuf,
}

impl SettingsPaths {
    pub fn default_paths() -> Self {
        Self {
            settings: crate::config_path::settings_file(),
            lock: crate::config_path::settings_lock_file(),
            tmp: crate::config_path::settings_tmp_file(),
            session: crate::config_path::session_file(),
        }
    }
}

pub fn load(paths: &SettingsPaths) -> Settings {
    ensure_parent_dir(&paths.settings);

    if paths.settings.exists() {
        match fs::read_to_string(&paths.settings) {
            Ok(content) => match serde_json::from_str::<Settings>(&content) {
                Ok(settings) => return settings,
                Err(e) => {
                    tracing::warn!(error = %e, "settings.json parse failed, quarantining");
                    quarantine_corrupt(&paths.settings);
                    prune_corrupt_backups(paths.settings.parent().unwrap_or(Path::new(".")));
                }
            },
            Err(e) => tracing::warn!(error = %e, "settings.json read failed"),
        }
    } else {
        if let Some(migrated) = migrate_from_session(&paths.session) {
            let _ = save(&migrated, paths);
            return migrated;
        }
    }

    Settings::default()
}

pub fn save(settings: &Settings, paths: &SettingsPaths) -> Result<(), AppError> {
    ensure_parent_dir(&paths.settings);

    let lock_file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&paths.lock)
        .map_err(|e| AppError::SettingsSaveFailed(format!("lock open: {e}")))?;
    lock_file
        .lock_exclusive()
        .map_err(|e| AppError::SettingsSaveFailed(format!("lock acquire: {e}")))?;

    let write_result = write_atomic(settings, &paths.tmp, &paths.settings);

    if write_result.is_err() && paths.tmp.exists() {
        let _ = fs::remove_file(&paths.tmp);
    }

    let _ = fs2::FileExt::unlock(&lock_file);
    write_result
}

fn write_atomic(settings: &Settings, tmp: &Path, final_path: &Path) -> Result<(), AppError> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::SettingsSaveFailed(format!("serialize: {e}")))?;

    {
        let mut f = File::create(tmp)
            .map_err(|e| AppError::SettingsSaveFailed(format!("tmp create: {e}")))?;
        f.write_all(content.as_bytes())
            .map_err(|e| AppError::SettingsSaveFailed(format!("tmp write: {e}")))?;
        f.sync_all()
            .map_err(|e| AppError::SettingsSaveFailed(format!("tmp sync: {e}")))?;
    }

    fs::rename(tmp, final_path)
        .map_err(|e| AppError::SettingsSaveFailed(format!("rename: {e}")))?;
    Ok(())
}

fn ensure_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn quarantine_corrupt(path: &Path) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = path.with_extension(format!("json.corrupt-{ts}"));
    if let Err(e) = fs::rename(path, &target) {
        tracing::warn!(error = %e, "failed to quarantine corrupt settings");
    }
}

fn prune_corrupt_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with("settings.json.corrupt-"))
                .unwrap_or(false)
        })
        .collect();

    if backups.len() <= MAX_CORRUPT_BACKUPS {
        return;
    }

    backups.sort();
    let excess = backups.len() - MAX_CORRUPT_BACKUPS;
    for old in backups.iter().take(excess) {
        let _ = fs::remove_file(old);
    }
}

#[derive(Deserialize)]
struct LegacySession {
    #[serde(rename = "reviewCliType")]
    review_cli_type: Option<super::ReviewCliType>,
}

fn migrate_from_session(session_path: &Path) -> Option<Settings> {
    if !session_path.exists() { return None; }
    let content = fs::read_to_string(session_path).ok()?;
    let legacy: LegacySession = serde_json::from_str(&content).ok()?;
    let review_cli_type = legacy.review_cli_type?;

    let mut settings = Settings::default();
    settings.review_cli_type = review_cli_type;
    tracing::info!("migrated reviewCliType from session.json to settings.json");
    Some(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn paths_in(dir: &Path) -> SettingsPaths {
        SettingsPaths {
            settings: dir.join("settings.json"),
            lock: dir.join("settings.json.lock"),
            tmp: dir.join("settings.json.tmp"),
            session: dir.join("session.json"),
        }
    }

    #[test]
    fn load_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        let settings = load(&paths);
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        let mut s = Settings::default();
        s.worktree.auto_create = true;
        s.worktree.warn_threshold = 42;

        save(&s, &paths).unwrap();
        let loaded = load(&paths);
        assert_eq!(loaded, s);
    }

    #[test]
    fn corrupt_file_quarantined_and_defaults_returned() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        fs::write(&paths.settings, "not json at all").unwrap();

        let loaded = load(&paths);
        assert_eq!(loaded, Settings::default());

        let has_quarantined = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            });
        assert!(has_quarantined);
    }

    #[test]
    fn migrates_review_cli_type_from_session() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        fs::write(
            &paths.session,
            r#"{"reviewCliType":"claudeCode","unrelated":1}"#,
        )
        .unwrap();

        let loaded = load(&paths);
        assert_eq!(loaded.review_cli_type, super::super::ReviewCliType::ClaudeCode);
        assert!(paths.settings.exists(), "settings.json should be written after migration");
    }

    #[test]
    fn migration_runs_only_when_settings_absent() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        fs::write(&paths.session, r#"{"reviewCliType":"claudeCode"}"#).unwrap();
        let _ = load(&paths);

        fs::write(&paths.session, r#"{"reviewCliType":"codex"}"#).unwrap();
        let loaded2 = load(&paths);
        assert_eq!(
            loaded2.review_cli_type,
            super::super::ReviewCliType::ClaudeCode,
            "second load should not re-migrate once settings.json exists"
        );
    }

    #[test]
    fn unknown_fields_preserved_on_roundtrip_via_defaults() {
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());
        fs::write(
            &paths.settings,
            r#"{"reviewCliType":"codex","futureField":"keepme"}"#,
        )
        .unwrap();
        let loaded = load(&paths);
        assert_eq!(loaded.review_cli_type, super::super::ReviewCliType::Codex);
    }

    #[test]
    fn corrupt_backups_are_pruned_beyond_limit() {
        let tmp = TempDir::new().unwrap();
        for i in 0..(MAX_CORRUPT_BACKUPS + 3) {
            let name = tmp.path().join(format!("settings.json.corrupt-{i}"));
            fs::write(&name, "x").unwrap();
        }
        prune_corrupt_backups(tmp.path());
        let remaining: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            })
            .collect();
        assert_eq!(remaining.len(), MAX_CORRUPT_BACKUPS);
    }

    #[test]
    fn concurrent_saves_do_not_corrupt() {
        use std::thread;
        let tmp = TempDir::new().unwrap();
        let paths = paths_in(tmp.path());

        let handles: Vec<_> = (0..5)
            .map(|i| {
                let p = SettingsPaths {
                    settings: paths.settings.clone(),
                    lock: paths.lock.clone(),
                    tmp: tmp.path().join(format!("settings.json.tmp.{i}")),
                    session: paths.session.clone(),
                };
                thread::spawn(move || {
                    let mut s = Settings::default();
                    s.worktree.warn_threshold = i;
                    save(&s, &p).unwrap();
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        let loaded = load(&paths);
        assert!((0..5).contains(&loaded.worktree.warn_threshold));
    }
}
