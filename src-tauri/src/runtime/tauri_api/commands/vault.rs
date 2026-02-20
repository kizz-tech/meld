use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::AppHandle;
use walkdir::WalkDir;

use crate::adapters::config::Settings;
use crate::adapters::vault::VaultInfo;

use super::shared::{VaultEntry, VaultFileEntry};
use super::watcher::{ensure_vault_watcher, run_reindex_internal, stop_vault_watcher};

fn normalize_relative_entry_path(path: &str) -> Result<String, String> {
    let normalized_slashes = path.trim().replace('\\', "/");
    if normalized_slashes.is_empty() {
        return Err("Path is empty".to_string());
    }

    let mut parts: Vec<String> = Vec::new();
    for raw_part in normalized_slashes.split('/') {
        let part = raw_part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("Parent directory segments (..) are not allowed".to_string());
        }
        parts.push(part.to_string());
    }

    if parts.is_empty() {
        return Err("Path is empty".to_string());
    }

    Ok(parts.join("/"))
}

fn resolve_vault_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is empty".to_string());
    }

    let requested_path = PathBuf::from(trimmed);
    let absolute_path = if requested_path.is_absolute() {
        requested_path
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to resolve current directory: {e}"))?
            .join(requested_path)
    };

    if !absolute_path.exists() {
        std::fs::create_dir_all(&absolute_path)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    } else if !absolute_path.is_dir() {
        return Err("Path exists but is not a directory".to_string());
    }

    absolute_path
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize vault path: {e}"))
}

fn to_relative_under(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Path is outside vault".to_string())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn is_hidden_or_ignored(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

fn file_modified_at_millis(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn build_archive_target_path(archive_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let normalized = relative_path.replace('\\', "/");
    if normalized.is_empty() {
        return Err("Path is empty".to_string());
    }

    let base_target = archive_root.join(&normalized);
    if !base_target.exists() {
        return Ok(base_target);
    }

    let source = Path::new(&normalized);
    let file_stem = source.file_stem().and_then(|value| value.to_str());
    let extension = source.extension().and_then(|value| value.to_str());
    let base_name = source.file_name().and_then(|value| value.to_str());
    let parent = source.parent().unwrap_or_else(|| Path::new(""));
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();

    for suffix in 1..=999 {
        let candidate_name = if let Some(stem) = file_stem {
            if let Some(ext) = extension {
                format!("{stem}__archived_{timestamp}_{suffix}.{ext}")
            } else {
                format!("{stem}__archived_{timestamp}_{suffix}")
            }
        } else if let Some(name) = base_name {
            format!("{name}__archived_{timestamp}_{suffix}")
        } else {
            format!("archived_{timestamp}_{suffix}")
        };

        let candidate_relative = parent.join(candidate_name);
        let candidate = archive_root.join(candidate_relative);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Failed to generate archive target path".to_string())
}

#[tauri::command]
pub async fn select_vault(app: AppHandle, path: String) -> Result<VaultInfo, String> {
    let vault_path = resolve_vault_path(&path)?;
    let selected_path = vault_path.to_string_lossy().to_string();

    let info = crate::adapters::vault::scan_vault(&vault_path).map_err(|e| e.to_string())?;

    Settings::update_global(|settings| {
        settings.push_recent_vault(&selected_path);
        settings.vault_path = Some(selected_path.clone());
        Ok(())
    })?;
    ensure_vault_watcher(&app);

    Ok(info)
}

#[tauri::command]
pub async fn get_vault_info(app: AppHandle) -> Result<Option<VaultInfo>, String> {
    let settings = Settings::load_global();
    match &settings.vault_path {
        Some(path) => {
            let vault_path = std::path::Path::new(path);
            if vault_path.exists() && vault_path.is_dir() {
                ensure_vault_watcher(&app);
                let info =
                    crate::adapters::vault::scan_vault(vault_path).map_err(|e| e.to_string())?;
                Ok(Some(info))
            } else {
                stop_vault_watcher();
                let stale_path = path.clone();
                if let Err(error) = Settings::update_global(|settings| {
                    if settings.vault_path.as_deref() == Some(stale_path.as_str()) {
                        settings.vault_path = None;
                    }
                    Ok(())
                }) {
                    log::warn!("Failed to clear stale vault path from config: {}", error);
                }
                Ok(None)
            }
        }
        None => {
            stop_vault_watcher();
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn reindex(app: AppHandle) -> Result<(), String> {
    run_reindex_internal(&app).await
}

#[tauri::command]
pub async fn list_vault_files() -> Result<Vec<VaultFileEntry>, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    let mut entries: Vec<VaultFileEntry> = crate::adapters::vault::list_md_files(vault_root)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|path| {
            let relative = path.strip_prefix(vault_root).ok()?;
            Some(VaultFileEntry {
                path: path.to_string_lossy().to_string(),
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                updated_at: file_modified_at_millis(&path),
            })
        })
        .collect();

    entries.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });

    Ok(entries)
}

#[tauri::command]
pub async fn preview_file(path: String) -> Result<String, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);
    let requested_path = Path::new(&path);
    let full_path = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        vault_root.join(requested_path)
    };

    crate::adapters::vault::ensure_within_vault(vault_root, &full_path)
        .map_err(|e| e.to_string())?;
    let canonical_path = full_path.canonicalize().map_err(|e| e.to_string())?;
    let is_markdown = canonical_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_markdown {
        return Err("Only markdown files can be previewed".to_string());
    }

    std::fs::read_to_string(canonical_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_vault_entries() -> Result<Vec<VaultEntry>, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    let mut entries: Vec<VaultEntry> = Vec::new();

    for entry in WalkDir::new(vault_root)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| !is_hidden_or_ignored(&entry.file_name().to_string_lossy()))
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        if entry_path == vault_root {
            continue;
        }

        if entry.file_type().is_dir() {
            entries.push(VaultEntry {
                kind: "folder".to_string(),
                path: entry_path.to_string_lossy().to_string(),
                relative_path: to_relative_under(vault_root, entry_path)?,
                updated_at: file_modified_at_millis(entry_path),
            });
            continue;
        }

        if entry.file_type().is_file() {
            let is_markdown = entry_path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            if !is_markdown {
                continue;
            }

            entries.push(VaultEntry {
                kind: "file".to_string(),
                path: entry_path.to_string_lossy().to_string(),
                relative_path: to_relative_under(vault_root, entry_path)?,
                updated_at: file_modified_at_millis(entry_path),
            });
        }
    }

    entries.sort_by(|left, right| {
        let left_updated = left.updated_at.unwrap_or_default();
        let right_updated = right.updated_at.unwrap_or_default();
        right_updated
            .cmp(&left_updated)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| {
                left.relative_path
                    .to_lowercase()
                    .cmp(&right.relative_path.to_lowercase())
            })
    });

    Ok(entries)
}

#[tauri::command]
pub async fn resolve_or_create_note(path: String) -> Result<String, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    crate::adapters::vault::ensure_vault_initialized(vault_root).map_err(|e| e.to_string())?;

    let normalized = crate::adapters::vault::normalize_note_path(&path)?;
    let full_path = vault_root.join(&normalized);

    if full_path.exists() {
        if full_path.is_file() {
            return Ok(normalized);
        }
        return Err("Path exists but is not a file".to_string());
    }

    crate::adapters::vault::write_note(vault_root, &normalized, "").map_err(|e| e.to_string())?;
    Ok(normalized)
}

#[tauri::command]
pub async fn create_note(path: String) -> Result<String, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    crate::adapters::vault::ensure_vault_initialized(vault_root).map_err(|e| e.to_string())?;

    let normalized = crate::adapters::vault::normalize_note_path(&path)?;
    let full_path = vault_root.join(&normalized);
    if full_path.exists() {
        return Err("Note already exists".to_string());
    }

    crate::adapters::vault::write_note(vault_root, &normalized, "").map_err(|e| e.to_string())?;
    Ok(normalized)
}

#[tauri::command]
pub async fn create_folder(path: String) -> Result<String, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    crate::adapters::vault::ensure_vault_initialized(vault_root).map_err(|e| e.to_string())?;

    let normalized = normalize_relative_entry_path(&path)?;
    let full_path = vault_root.join(&normalized);
    if full_path.exists() {
        return Err("Folder already exists".to_string());
    }

    std::fs::create_dir_all(&full_path).map_err(|e| e.to_string())?;
    Ok(normalized)
}

#[tauri::command]
pub async fn archive_vault_entry(path: String) -> Result<(), String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    let normalized = normalize_relative_entry_path(&path)?;
    let full_path = vault_root.join(&normalized);
    if !full_path.exists() {
        return Err("Entry not found".to_string());
    }

    if normalized.eq_ignore_ascii_case(".archive")
        || normalized.to_lowercase().starts_with(".archive/")
    {
        return Err("Cannot archive .archive recursively".to_string());
    }

    let archive_root = vault_root.join(".archive");
    std::fs::create_dir_all(&archive_root).map_err(|e| e.to_string())?;
    let archive_target = build_archive_target_path(&archive_root, &normalized)?;
    if let Some(parent) = archive_target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::rename(&full_path, &archive_target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn move_vault_entry(from_path: String, to_path: String) -> Result<String, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.ok_or("No vault configured")?;
    let vault_root = Path::new(&vault_path);

    let from_relative = normalize_relative_entry_path(&from_path)?;
    let mut to_relative = normalize_relative_entry_path(&to_path)?;

    let from_full = vault_root.join(&from_relative);
    if !from_full.exists() {
        return Err("Source entry not found".to_string());
    }

    let source_is_dir = from_full.is_dir();
    let source_name = Path::new(&from_relative)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid source path")?
        .to_string();

    let tentative_to_full = vault_root.join(&to_relative);
    if tentative_to_full.exists() && tentative_to_full.is_dir() {
        to_relative = format!("{to_relative}/{source_name}");
    }

    if source_is_dir {
        if to_relative.eq_ignore_ascii_case(&from_relative)
            || to_relative
                .to_lowercase()
                .starts_with(&(from_relative.to_lowercase() + "/"))
        {
            return Err("Cannot move folder into itself".to_string());
        }
    } else if !to_relative.to_lowercase().ends_with(".md") {
        to_relative.push_str(".md");
    }

    let to_full = vault_root.join(&to_relative);
    if to_full.exists() {
        return Err("Target already exists".to_string());
    }

    let target_parent: PathBuf = to_full
        .parent()
        .map(Path::to_path_buf)
        .ok_or("Invalid target path")?;
    std::fs::create_dir_all(target_parent).map_err(|e| e.to_string())?;
    std::fs::rename(&from_full, &to_full).map_err(|e| e.to_string())?;

    Ok(to_relative.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::resolve_vault_path;

    #[test]
    fn resolve_vault_path_rejects_empty_value() {
        assert!(resolve_vault_path("   ").is_err());
    }

    #[test]
    fn resolve_vault_path_creates_and_canonicalizes_directory() {
        let root =
            std::env::temp_dir().join(format!("meld-vault-resolve-test-{}", uuid::Uuid::new_v4()));
        let nested = root.join("vault");
        let nested_text = nested.to_string_lossy().to_string();

        let resolved = resolve_vault_path(&nested_text).expect("resolve vault path");
        assert!(resolved.is_absolute());
        assert!(resolved.exists());
        assert!(resolved.is_dir());

        let _ = std::fs::remove_dir_all(root);
    }
}
