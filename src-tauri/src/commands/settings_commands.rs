use crate::error::AppError;
use crate::settings::{persist, Settings};

#[tauri::command]
pub fn load_settings() -> Result<Settings, AppError> {
    let paths = persist::SettingsPaths::default_paths();
    Ok(persist::load(&paths))
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), AppError> {
    let paths = persist::SettingsPaths::default_paths();
    persist::save(&settings, &paths)
}
