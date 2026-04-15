use std::path::PathBuf;

pub fn config_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir())
        .expect("cannot determine home directory: $HOME is unset and dirs::home_dir() failed");
    home.join(".config").join("chorus")
}

pub fn session_file() -> PathBuf {
    config_dir().join("session.json")
}

pub fn settings_file() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn settings_lock_file() -> PathBuf {
    config_dir().join("settings.json.lock")
}

pub fn settings_tmp_file() -> PathBuf {
    config_dir().join("settings.json.tmp")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_paths_share_config_dir() {
        let dir = config_dir();
        assert!(session_file().starts_with(&dir));
        assert!(settings_file().starts_with(&dir));
        assert!(settings_lock_file().starts_with(&dir));
        assert!(settings_tmp_file().starts_with(&dir));
    }

    #[test]
    fn settings_file_name_is_stable() {
        assert_eq!(settings_file().file_name().unwrap(), "settings.json");
        assert_eq!(settings_lock_file().file_name().unwrap(), "settings.json.lock");
        assert_eq!(settings_tmp_file().file_name().unwrap(), "settings.json.tmp");
    }
}
