use base64::Engine;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use crate::error::AppError;

/// Fixed temp directory under /tmp so it matches the Tauri asset protocol scope.
/// std::env::temp_dir() on macOS returns /var/folders/... which is outside that scope.
const TEMP_IMAGES_DIR: &str = "/tmp/chorus-images";

const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// 20 MiB — generous enough for high-res screenshots, tight enough to prevent DoS.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn get_temp_dir() -> Result<PathBuf, AppError> {
    let dir = PathBuf::from(TEMP_IMAGES_DIR);
    // Always create + chmod, not just when missing. This avoids TOCTOU and
    // ensures permissions are correct even if the dir was created by another process.
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;
    Ok(dir)
}

#[tauri::command]
pub fn save_temp_image(data: String, extension: Option<String>) -> Result<String, AppError> {
    let ext = extension.as_deref().unwrap_or("png");
    if !ALLOWED_EXTENSIONS.contains(&ext) {
        return Err(AppError::ImageSaveFailed(format!("Unsupported extension: {ext}")));
    }

    let dir = get_temp_dir()?;
    let filename = format!("{}.{ext}", uuid::Uuid::new_v4());
    let file_path = dir.join(&filename);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| AppError::ImageSaveFailed(format!("Invalid base64: {e}")))?;

    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::ImageSaveFailed(format!(
            "Image too large: {} bytes (max {})",
            bytes.len(),
            MAX_IMAGE_BYTES
        )));
    }

    fs::write(&file_path, &bytes)
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;

    fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| AppError::ImageSaveFailed(e.to_string()))?;

    file_path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::ImageSaveFailed("Non-UTF8 path".into()))
}

#[tauri::command]
pub fn delete_temp_image(filename: String) -> Result<(), AppError> {
    // Accept filename only (not full path) to prevent path traversal.
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains("..")
        || filename.contains('\0')
        || filename.contains('\\')
    {
        return Err(AppError::ImageSaveFailed("Invalid filename".into()));
    }
    let file_path = get_temp_dir()?.join(&filename);
    // Attempt removal; treat NotFound as success to avoid TOCTOU.
    fs::remove_file(&file_path).or_else(|e| {
        if e.kind() == ErrorKind::NotFound {
            Ok(())
        } else {
            Err(AppError::ImageSaveFailed(e.to_string()))
        }
    })
}

#[tauri::command]
pub fn cleanup_temp_images() -> Result<(), AppError> {
    let dir = PathBuf::from(TEMP_IMAGES_DIR);
    // Attempt removal; treat NotFound as success to avoid TOCTOU.
    fs::remove_dir_all(&dir).or_else(|e| {
        if e.kind() == ErrorKind::NotFound {
            Ok(())
        } else {
            Err(AppError::ImageSaveFailed(e.to_string()))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── filename validation ──────────────────────────────────────────────────

    #[test]
    fn delete_rejects_empty_filename() {
        let result = delete_temp_image(String::new());
        assert!(result.is_err());
    }

    #[test]
    fn delete_rejects_path_traversal() {
        let result = delete_temp_image("../etc/passwd".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_rejects_slash_in_filename() {
        let result = delete_temp_image("subdir/file.png".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_rejects_null_byte() {
        let result = delete_temp_image("file\0.png".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_rejects_backslash() {
        let result = delete_temp_image("file\\.png".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_succeeds_for_nonexistent_file() {
        // Should not error on NotFound — idempotent delete.
        let result = delete_temp_image("00000000-0000-0000-0000-000000000000.png".into());
        // May succeed (NotFound treated as Ok) or fail for other reasons (e.g. dir creation).
        // On a writable system the dir will be created and NotFound returned → Ok.
        assert!(result.is_ok());
    }

    // ── extension validation ─────────────────────────────────────────────────

    #[test]
    fn save_rejects_disallowed_extension() {
        let result = save_temp_image("aGVsbG8=".into(), Some("exe".into()));
        assert!(result.is_err());
    }

    #[test]
    fn save_rejects_invalid_base64() {
        let result = save_temp_image("!!!not-base64!!!".into(), None);
        assert!(result.is_err());
    }

    // ── file size limit ──────────────────────────────────────────────────────

    #[test]
    fn save_rejects_oversized_image() {
        // Encode MAX_IMAGE_BYTES + 1 bytes of zeros as base64.
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&big);
        let result = save_temp_image(encoded, None);
        assert!(result.is_err());
    }
}
