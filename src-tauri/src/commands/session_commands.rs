use std::fs;
use std::path::PathBuf;

fn session_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("~"));
    PathBuf::from(home)
        .join(".config")
        .join("chorus")
        .join("session.json")
}

#[tauri::command]
pub fn save_session(data: String) -> Result<(), String> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_session() -> Result<Option<String>, String> {
    let path = session_path();
    if path.exists() {
        fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}
