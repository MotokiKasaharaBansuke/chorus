use std::fs;

use crate::config_path::session_file;

#[tauri::command]
pub fn save_session(data: String) -> Result<(), String> {
    let path = session_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_session() -> Result<Option<String>, String> {
    let path = session_file();
    if path.exists() {
        fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}
