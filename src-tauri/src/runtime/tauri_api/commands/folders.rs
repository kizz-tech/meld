use crate::adapters::config::Settings;

use super::shared::{current_db_path, parse_conversation_id};

fn parse_folder_id(folder_id: &str) -> Result<i64, String> {
    folder_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid folder_id: {}", folder_id))
}

#[tauri::command]
pub async fn create_chat_folder(
    name: Option<String>,
    parent_id: Option<String>,
) -> Result<String, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;

    let name = name
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "New folder".to_string());
    let parsed_parent = parent_id.as_deref().map(parse_folder_id).transpose()?;

    let folder_id = db
        .create_folder(&name, parsed_parent)
        .map_err(|e| e.to_string())?;
    Ok(folder_id.to_string())
}

#[tauri::command]
pub async fn get_chat_folder(
    folder_id: String,
) -> Result<crate::adapters::vectordb::FolderSummary, String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.get_folder(parsed_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_chat_folders() -> Result<Vec<crate::adapters::vectordb::FolderSummary>, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.list_folders().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_chat_folder(folder_id: String, name: String) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.rename_folder(parsed_id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_chat_folder(
    folder_id: String,
    icon: Option<String>,
    custom_instruction: Option<String>,
    default_model_id: Option<String>,
) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.update_folder(
        parsed_id,
        icon.as_deref(),
        custom_instruction.as_deref(),
        default_model_id.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn archive_chat_folder(folder_id: String) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_folder_archived(parsed_id, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unarchive_chat_folder(folder_id: String) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_folder_archived(parsed_id, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_chat_folder(folder_id: String) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_folder_pinned(parsed_id, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_chat_folder(folder_id: String) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_folder_pinned(parsed_id, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn move_chat_folder(
    folder_id: String,
    new_parent_id: Option<String>,
) -> Result<(), String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let parsed_parent = new_parent_id.as_deref().map(parse_folder_id).transpose()?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.move_folder(parsed_id, parsed_parent)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_folder(
    conversation_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let parsed_conversation = parse_conversation_id(&conversation_id)?;
    let parsed_folder = folder_id.as_deref().map(parse_folder_id).transpose()?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_conversation_folder(parsed_conversation, parsed_folder)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_folder_instruction_chain(folder_id: String) -> Result<Vec<String>, String> {
    let parsed_id = parse_folder_id(&folder_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.get_folder_instruction_chain(parsed_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn migrate_chat_folders_from_local(
    json: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    let id_map = db
        .import_folders_from_local(&json)
        .map_err(|e| e.to_string())?;
    Ok(id_map
        .into_iter()
        .map(|(k, v)| (k, v.to_string()))
        .collect())
}
