use serde::Serialize;
use std::path::Path;
use ignore::WalkBuilder;

use crate::error::AppError;

const MAX_DEPTH: usize = 20;
const MAX_FILE_SIZE: u64 = 1_048_576; // 1MB

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub children: Option<Vec<FileNode>>,
}

pub fn list_directory(path: &str, depth: usize) -> Result<Vec<FileNode>, AppError> {
    let root = Path::new(path);
    if !root.exists() {
        return Err(AppError::FileSystemError(format!("Path not found: {path}")));
    }
    if !root.is_dir() {
        return Err(AppError::FileSystemError(format!("Not a directory: {path}")));
    }

    let effective_depth = depth.min(MAX_DEPTH);
    let mut nodes: Vec<FileNode> = Vec::new();

    let walker = WalkBuilder::new(root)
        .max_depth(Some(effective_depth + 1))
        .follow_links(false)
        .git_ignore(true)
        .git_global(true)
        .hidden(false)
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let entry_path = entry.path();
        if entry_path == root {
            continue;
        }

        // Only include direct children at depth 1
        if depth == 1 {
            if let Some(parent) = entry_path.parent() {
                if parent != root {
                    continue;
                }
            }
        }

        let metadata = match entry_path.symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        nodes.push(FileNode {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_directory: metadata.is_dir(),
            is_symlink: metadata.is_symlink(),
            children: if metadata.is_dir() { Some(Vec::new()) } else { None },
        });
    }

    // Sort: directories first, then alphabetically
    nodes.sort_by(|a, b| {
        b.is_directory.cmp(&a.is_directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(nodes)
}

pub fn read_file_content(path: &str) -> Result<String, AppError> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(AppError::FileSystemError(format!("File not found: {path}")));
    }

    let metadata = file_path
        .metadata()
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    if metadata.len() > MAX_FILE_SIZE {
        return Err(AppError::FileSystemError(
            "File too large (max 1MB)".into(),
        ));
    }

    // Check for binary content
    let content = std::fs::read(file_path)
        .map_err(|e| AppError::FileSystemError(e.to_string()))?;

    // Simple binary detection: check first 8KB for null bytes
    let check_len = content.len().min(8192);
    if content[..check_len].contains(&0) {
        return Err(AppError::FileSystemError("Binary file".into()));
    }

    String::from_utf8(content)
        .map_err(|_| AppError::FileSystemError("Not a valid UTF-8 file".into()))
}
