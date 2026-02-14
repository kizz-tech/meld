use crate::adapters::config::Settings;
use crate::adapters::git::HistoryEntry;

#[tauri::command]
pub async fn get_history() -> Result<Vec<HistoryEntry>, String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.as_ref().ok_or("No vault configured")?;

    match crate::adapters::git::get_history(std::path::Path::new(vault_path)) {
        Ok(entries) => Ok(entries),
        Err(_) => Ok(Vec::new()), // No git repo yet — return empty history
    }
}

#[tauri::command]
pub async fn revert_commit(commit_id: String) -> Result<(), String> {
    let settings = Settings::load_global();
    let vault_path = settings.vault_path.as_ref().ok_or("No vault configured")?;

    crate::adapters::git::revert_commit(std::path::Path::new(vault_path), &commit_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_file_external(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}
