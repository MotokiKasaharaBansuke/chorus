// chorus image commands require Unix filesystem semantics (O_EXCL, chmod).
#[cfg(not(unix))]
compile_error!("image_commands requires a Unix target (macOS / Linux)");

use base64::Engine;
use std::fs;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use crate::error::AppError;

/// Fixed temp directory under /tmp so it matches the Tauri asset protocol scope.
/// std::env::temp_dir() on macOS returns /var/folders/... which is outside that scope.
const TEMP_IMAGES_DIR: &str = "/tmp/chorus-images";

const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// 20 MiB — generous enough for high-res screenshots, tight enough to prevent DoS.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Upper bound on base64-encoded length for a MAX_IMAGE_BYTES payload.
/// base64 encodes 3 bytes → 4 chars, plus up to 4 bytes of padding.
const MAX_ENCODED_LEN: usize = MAX_IMAGE_BYTES * 4 / 3 + 4;

// ── private helpers ─────────────────────────────────────────────────────────

fn into_save_error(e: impl std::fmt::Display) -> AppError {
    AppError::ImageSaveFailed(e.to_string())
}

fn into_op_error(e: impl std::fmt::Display) -> AppError {
    AppError::ImageOperationFailed(e.to_string())
}

fn get_temp_dir() -> Result<PathBuf, AppError> {
    let dir = PathBuf::from(TEMP_IMAGES_DIR);
    // Always create + chmod, not just when missing. This avoids TOCTOU and
    // ensures permissions are correct even if the dir was created by another process.
    fs::create_dir_all(&dir).map_err(into_save_error)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(into_save_error)?;
    Ok(dir)
}

/// Converts `NotFound` I/O errors into `Ok(())` so callers get idempotent deletes.
fn ignore_not_found(err: std::io::Error) -> Result<(), AppError> {
    if err.kind() == ErrorKind::NotFound {
        Ok(())
    } else {
        Err(into_op_error(err))
    }
}

/// Validates that `filename` is `{uuid}.{ext}` — strictly allowlist-based.
/// Uses the `uuid` crate to enforce the 8-4-4-4-12 hyphen structure.
/// The explicit length check is required because `uuid::Uuid::parse_str` also
/// accepts the 32-char unhyphenated form; we only allow the hyphenated form.
fn is_valid_image_filename(filename: &str) -> bool {
    let Some(dot_pos) = filename.rfind('.') else {
        return false;
    };
    let stem = &filename[..dot_pos];
    let ext = &filename[dot_pos + 1..];
    // Hyphenated UUID is exactly 36 chars: 8-4-4-4-12 + 4 hyphens.
    stem.len() == 36
        && uuid::Uuid::parse_str(stem).is_ok()
        && ALLOWED_EXTENSIONS.contains(&ext)
}

// ── shared helper ────────────────────────────────────────────────────────────

/// Write raw bytes to a new temp file with hardened permissions.
/// O_CREAT | O_EXCL | mode 0600: atomic exclusive creation.
fn write_temp_file(bytes: &[u8], ext: &str) -> Result<String, AppError> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::ImageSaveFailed(format!(
            "Image too large: {} bytes (max {})",
            bytes.len(), MAX_IMAGE_BYTES
        )));
    }

    let dir = get_temp_dir()?;
    let filename = format!("{}.{ext}", uuid::Uuid::new_v4());
    let file_path = dir.join(&filename);

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file_path)
        .map_err(into_save_error)?;

    file.write_all(bytes).map_err(|e| {
        let _ = fs::remove_file(&file_path);
        into_save_error(e)
    })?;

    file_path
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let _ = fs::remove_file(&file_path);
            AppError::ImageSaveFailed("Non-UTF8 path".into())
        })
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_temp_image(data: String, extension: Option<String>) -> Result<String, AppError> {
    let ext = extension.as_deref().unwrap_or("png").to_lowercase();
    let ext = ext.as_str();
    if !ALLOWED_EXTENSIONS.contains(&ext) {
        return Err(AppError::ImageSaveFailed(format!("Unsupported extension: {ext}")));
    }
    if data.len() > MAX_ENCODED_LEN {
        return Err(AppError::ImageSaveFailed(format!(
            "Image data too large (max {} bytes decoded)", MAX_IMAGE_BYTES
        )));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| AppError::ImageSaveFailed(format!("Invalid base64: {e}")))?;

    write_temp_file(&bytes, ext)
}

/// Import an image from a native file path: read it, save to temp dir, and return
/// the temp path + base64 data + media type for the frontend AttachedImage.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub path: String,
    pub base64_data: String,
    pub media_type: String,
}

#[tauri::command]
pub fn import_image_file(file_path: String) -> Result<ImportedImage, AppError> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Read;

    let src = std::path::Path::new(&file_path);

    // Reject paths with ".." components to prevent path traversal.
    if src.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::ImageSaveFailed("Path traversal not allowed".into()));
    }

    let ext = src.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    // Normalise "jpg" → "jpeg" so media_type matches the IANA standard ("image/jpeg").
    let ext = if ext == "jpg" { "jpeg".to_string() } else { ext };
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::ImageSaveFailed(format!("Unsupported extension: {ext}")));
    }

    // Open with O_NOFOLLOW to atomically reject symlinks (no TOCTOU window).
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(src)
        .map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) {
                AppError::ImageSaveFailed("Symlinks not allowed".into())
            } else {
                into_save_error(e)
            }
        })?;

    let meta = file.metadata().map_err(into_save_error)?;
    if !meta.is_file() {
        return Err(AppError::ImageSaveFailed(format!("Not a regular file: {file_path}")));
    }
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(AppError::ImageSaveFailed(format!(
            "Image too large: {} bytes (max {})", meta.len(), MAX_IMAGE_BYTES
        )));
    }

    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes).map_err(into_save_error)?;

    let temp_path = write_temp_file(&bytes, &ext)?;
    let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let media_type = format!("image/{ext}");

    Ok(ImportedImage {
        path: temp_path,
        base64_data,
        media_type,
    })
}

#[tauri::command]
pub fn delete_temp_image(filename: String) -> Result<(), AppError> {
    // Allowlist validation: only accept UUID-format filenames with known extensions.
    if !is_valid_image_filename(&filename) {
        return Err(AppError::ImageOperationFailed("Invalid filename".into()));
    }
    let file_path = get_temp_dir()?.join(&filename);
    // Treat NotFound as success — idempotent delete.
    fs::remove_file(&file_path).or_else(ignore_not_found)
}

#[tauri::command]
pub fn cleanup_temp_images() -> Result<(), AppError> {
    let dir = PathBuf::from(TEMP_IMAGES_DIR);
    // Delete files individually rather than the whole directory so that concurrent
    // sessions sharing the same directory are not affected.
    // cleanup does NOT call get_temp_dir() intentionally — we don't want to create
    // the directory if it doesn't exist, unlike save/delete which need it.
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(into_op_error(e)),
    };
    for entry in entries {
        // Skip unreadable entries (e.g. concurrent permission change) rather than
        // aborting — partial cleanup is better than no cleanup.
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let filename = name.to_string_lossy();
        // Only delete files that match our naming convention. Skip unknown files
        // (e.g. from other processes) to avoid accidental data loss.
        // Only delete regular files — skip symlinks and directories.
        let is_regular_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if is_regular_file && is_valid_image_filename(&filename) {
            // Swallow deletion errors: partial cleanup is better than aborting the remainder.
            let _ = fs::remove_file(entry.path()).or_else(ignore_not_found);
        }
    }
    Ok(())
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_valid_image_filename ──────────────────────────────────────────────

    #[test]
    fn filename_accepts_valid_uuid_png() {
        assert!(is_valid_image_filename(
            "550e8400-e29b-41d4-a716-446655440000.png"
        ));
    }

    #[test]
    fn filename_accepts_valid_uuid_jpeg() {
        assert!(is_valid_image_filename(
            "550e8400-e29b-41d4-a716-446655440000.jpeg"
        ));
    }

    #[test]
    fn filename_rejects_uuid_without_hyphens() {
        // 32 hex chars without hyphens — not a valid UUID format.
        assert!(!is_valid_image_filename(
            "550e8400e29b41d4a716446655440000.png"
        ));
    }

    #[test]
    fn filename_rejects_path_traversal() {
        assert!(!is_valid_image_filename("../etc/passwd"));
    }

    #[test]
    fn filename_rejects_slash() {
        assert!(!is_valid_image_filename("subdir/file.png"));
    }

    #[test]
    fn filename_rejects_null_byte() {
        assert!(!is_valid_image_filename("file\0.png"));
    }

    #[test]
    fn filename_rejects_disallowed_extension() {
        assert!(!is_valid_image_filename(
            "550e8400-e29b-41d4-a716-446655440000.exe"
        ));
    }

    #[test]
    fn filename_rejects_empty() {
        assert!(!is_valid_image_filename(""));
    }

    #[test]
    fn filename_rejects_no_extension() {
        assert!(!is_valid_image_filename(
            "550e8400-e29b-41d4-a716-446655440000"
        ));
    }

    // ── delete_temp_image ────────────────────────────────────────────────────

    #[test]
    fn delete_rejects_invalid_filename() {
        let result = delete_temp_image("not-a-uuid.png".into());
        assert!(result.is_err());
    }

    #[test]
    fn delete_succeeds_for_nonexistent_valid_filename() {
        // NotFound is treated as Ok — idempotent delete.
        let result = delete_temp_image("550e8400-e29b-41d4-a716-446655440000.png".into());
        assert!(result.is_ok());
    }

    // ── save_temp_image ──────────────────────────────────────────────────────

    #[test]
    fn save_rejects_disallowed_extension() {
        let result = save_temp_image("aGVsbG8=".into(), Some("exe".into()));
        assert!(result.is_err());
    }

    #[test]
    fn save_accepts_uppercase_extension() {
        // "PNG" should be normalised to "png" and accepted (not rejected with "Unsupported extension").
        let result = save_temp_image("aGVsbG8=".into(), Some("PNG".into()));
        match result {
            Err(AppError::ImageSaveFailed(msg)) => {
                assert!(!msg.contains("Unsupported extension"), "unexpected error: {msg}")
            }
            Ok(_) | Err(_) => {} // success or other non-extension error is acceptable
        }
    }

    #[test]
    fn save_rejects_invalid_base64() {
        let result = save_temp_image("!!!not-base64!!!".into(), None);
        assert!(result.is_err());
    }

    #[test]
    fn save_rejects_oversized_encoded_data() {
        let oversized = "A".repeat(MAX_ENCODED_LEN + 10);
        let result = save_temp_image(oversized, None);
        assert!(result.is_err());
    }

    #[test]
    fn save_rejects_oversized_image() {
        let big = vec![0u8; MAX_IMAGE_BYTES + 1];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&big);
        let result = save_temp_image(encoded, None);
        assert!(result.is_err());
    }
}
