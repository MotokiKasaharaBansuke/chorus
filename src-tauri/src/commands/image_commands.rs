use base64::Engine;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use crate::error::AppError;

fn get_temp_dir() -> Result<PathBuf, AppError> {
    let dir = std::env::temp_dir().join("multi-llm-images");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
    }
    Ok(dir)
}

#[tauri::command]
pub fn save_temp_image(data: String, extension: Option<String>) -> Result<String, AppError> {
    let dir = get_temp_dir()?;
    let ext = extension.unwrap_or_else(|| "png".into());
    let filename = format!("{}.{ext}", uuid::Uuid::new_v4());
    let file_path = dir.join(&filename);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| AppError::ImageSaveFailed(format!("Invalid base64: {e}")))?;

    fs::write(&file_path, &bytes)
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;

    fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_temp_image(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    let temp_dir = get_temp_dir()?;

    // Only allow deleting from our temp directory
    if !file_path.starts_with(&temp_dir) {
        return Err(AppError::ImageSaveFailed(
            "Cannot delete files outside temp directory".into(),
        ));
    }

    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_temp_images() -> Result<(), AppError> {
    let dir = get_temp_dir()?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
    }
    Ok(())
}
