//! Image attachment intake for the headless engine.
//!
//! Mirrors the validation contract used by `pty/session.rs` so a future
//! refactor can collapse the two into a single shared module without
//! changing observable behaviour. The duplication is intentional for
//! Phase 1h: keeping the engines decoupled lets each evolve safely.
//!
//! ## Trust model
//!
//! The frontend hands us a temp file path plus the declared media type.
//! Both are attacker-controlled — a compromised renderer could try to
//! exfiltrate `/etc/passwd` by passing it as an "image" — so we
//! enforce, in order:
//!
//! 1. Path is rooted at `/tmp/chorus-images/` and contains no `..`.
//! 2. The file is opened with `O_NOFOLLOW`, which closes the symlink
//!    TOCTOU window at the kernel boundary **for the final path
//!    component only**. A pre-existing symlink on `/tmp/chorus-images`
//!    itself would still be traversable; the same gap exists on the
//!    PTY side (`pty/session.rs`) and Phase 1i is the planned home
//!    for an `openat`-based hardening pass that pins the dir fd at
//!    startup.
//! 3. The opened fd refers to a regular file (not pipe / device).
//! 4. The size sits inside `MAX_IMAGE_BYTES`.
//! 5. The declared `media_type` is one of the four claude API accepts.
//!
//! Failures map to `AppError::ImageSaveFailed` so they surface to the
//! UI through the same channel as PTY-side image errors.

use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path};

use serde::Deserialize;

use crate::error::AppError;

/// Wire-shape of an image attachment from the frontend. Same field
/// names as `pty/session.rs::ImageAttachment` so the two backends can
/// share a single TypeScript type at the IPC boundary.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    /// Absolute path to a temp image file written by the frontend's
    /// `saveTempImage` command. Must live under `/tmp/chorus-images/`.
    pub path: String,
    /// Declared media type (`image/png` etc.). Validated against
    /// `ALLOWED_MEDIA_TYPES`.
    pub media_type: String,
}

/// Decoded image ready to embed in a stream-json `image` content
/// block. `data` is the raw base64 string (no `data:` URL prefix).
#[derive(Debug)]
pub struct InlineImage {
    pub media_type: String,
    pub data: String,
}

/// Hard cap matching the PTY side. 20 MiB is more than enough for a
/// 4k screenshot at PNG quality and prevents a single attachment from
/// pinning hundreds of MB of memory while base64 expands by 33%.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// Same set the Anthropic API documents — anything else fails fast at
/// the wire format check before reaching the model.
pub const ALLOWED_MEDIA_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
];

/// Validate the path-level constraints without touching the filesystem.
fn assert_temp_image_path(path: &str) -> Result<(), AppError> {
    let p = Path::new(path);
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::ImageSaveFailed("Path traversal not allowed".into()));
    }
    if !path.starts_with("/tmp/chorus-images/") {
        return Err(AppError::ImageSaveFailed(
            "Image path outside temp directory".into(),
        ));
    }
    Ok(())
}

fn assert_media_type(media_type: &str) -> Result<(), AppError> {
    if !ALLOWED_MEDIA_TYPES.contains(&media_type) {
        return Err(AppError::ImageSaveFailed(format!(
            "Unsupported media type: {media_type}",
        )));
    }
    Ok(())
}

/// Validate one attachment and return the decoded `InlineImage` ready
/// for embedding in stream-json. Reads the whole file into memory —
/// callers should free each `InlineImage` as soon as the stream-json
/// line containing it has been written so peak memory stays bounded
/// by the largest single image, not the sum.
pub fn load_attachment(att: &ImageAttachment) -> Result<InlineImage, AppError> {
    use base64::Engine as _;

    assert_media_type(&att.media_type)?;
    assert_temp_image_path(&att.path)?;

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        // `O_NOFOLLOW` closes the symlink TOCTOU window: the kernel
        // refuses to follow a symlink at the final component, so a
        // race that swaps the file for a link to `/etc/passwd` after
        // we validate the string but before we open it is a no-op.
        .custom_flags(libc::O_NOFOLLOW)
        .open(&att.path)
        .map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) {
                AppError::ImageSaveFailed("Symlinks not allowed".into())
            } else {
                AppError::ImageSaveFailed(format!("Cannot open image {}: {e}", att.path))
            }
        })?;

    let meta = file
        .metadata()
        .map_err(|e| AppError::ImageSaveFailed(format!("Cannot stat image {}: {e}", att.path)))?;
    if !meta.is_file() {
        return Err(AppError::ImageSaveFailed("Not a regular file".into()));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(AppError::ImageSaveFailed(format!(
            "Image too large: {} bytes (max {MAX_IMAGE_BYTES})",
            meta.len(),
        )));
    }

    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|e| AppError::ImageSaveFailed(format!("Failed to read image {}: {e}", att.path)))?;

    Ok(InlineImage {
        media_type: att.media_type.clone(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(path: &str, media_type: &str) -> ImageAttachment {
        ImageAttachment {
            path: path.to_string(),
            media_type: media_type.to_string(),
        }
    }

    #[test]
    fn rejects_paths_outside_temp_dir() {
        let err = load_attachment(&att("/etc/passwd", "image/png")).unwrap_err();
        assert!(format!("{err:?}").contains("outside"));
    }

    #[test]
    fn rejects_path_traversal_components() {
        let err = load_attachment(&att(
            "/tmp/chorus-images/../etc/passwd",
            "image/png",
        ))
        .unwrap_err();
        assert!(format!("{err:?}").contains("traversal"));
    }

    #[test]
    fn rejects_unknown_media_type() {
        let err = load_attachment(&att(
            "/tmp/chorus-images/x.svg",
            "image/svg+xml",
        ))
        .unwrap_err();
        assert!(format!("{err:?}").contains("Unsupported"));
    }

    #[test]
    fn loads_small_png_round_trip() {
        let dir = std::path::Path::new("/tmp/chorus-images");
        std::fs::create_dir_all(dir).expect("create temp dir");
        let path = format!("/tmp/chorus-images/headless-img-test-{}.png", std::process::id());
        // 1 KiB of arbitrary bytes; we are exercising IO + base64,
        // not PNG decoding (claude does that).
        let payload: Vec<u8> = (0..1024).map(|i| (i & 0xff) as u8).collect();
        std::fs::write(&path, &payload).expect("write fixture");
        let inline = load_attachment(&att(&path, "image/png")).expect("load");
        assert_eq!(inline.media_type, "image/png");
        // base64 of 1 KiB should be 1368 chars (`ceil(1024 / 3) * 4`).
        assert_eq!(inline.data.len(), 1368);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_oversized_image() {
        let dir = std::path::Path::new("/tmp/chorus-images");
        std::fs::create_dir_all(dir).expect("create temp dir");
        let path = format!(
            "/tmp/chorus-images/headless-oversize-test-{}.png",
            std::process::id(),
        );
        // Sparse-write a file just over the cap so the test does not
        // need to allocate a 20 MiB buffer.
        let f = std::fs::File::create(&path).expect("create fixture");
        f.set_len(MAX_IMAGE_BYTES + 1).expect("set_len");
        drop(f);
        let err = load_attachment(&att(&path, "image/png")).unwrap_err();
        assert!(format!("{err:?}").contains("too large"));
        std::fs::remove_file(&path).ok();
    }
}
