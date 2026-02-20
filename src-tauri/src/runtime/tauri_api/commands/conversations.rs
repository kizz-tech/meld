use tauri::AppHandle;

use crate::adapters::config::Settings;
use crate::adapters::providers::split_model_id;

use super::assistant::spawn_assistant_task;
use super::shared::{
    current_db_path, parse_conversation_id, parse_message_id, resolve_provider_credential,
    title_from_first_user_message, SendMessageResponse,
};

fn resolve_provider_and_model_for_conversation(
    settings: &Settings,
    db: &crate::adapters::vectordb::VectorDb,
    conversation_id: i64,
) -> Result<(String, String), String> {
    let folder_model_id = db
        .resolve_conversation_chat_model_id(conversation_id)
        .map_err(|e| e.to_string())?;

    if let Some(model_id) = folder_model_id {
        match split_model_id(&model_id) {
            Ok((provider, model)) => return Ok((provider.to_string(), model.to_string())),
            Err(error) => {
                log::warn!(
                    "Invalid folder default_model_id '{}' for conversation {}. Falling back to settings model: {}",
                    model_id,
                    conversation_id,
                    error
                );
            }
        }
    }

    Ok((settings.chat_provider(), settings.chat_model()))
}

fn parse_folder_id(folder_id: &str) -> Result<i64, String> {
    folder_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid folder_id: {folder_id}"))
}

#[tauri::command]
pub async fn create_conversation(title: Option<String>) -> Result<String, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;

    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "New conversation".to_string());

    let conversation_id = db.create_conversation(&title).map_err(|e| e.to_string())?;
    Ok(conversation_id.to_string())
}

#[tauri::command]
pub async fn list_conversations(
) -> Result<Vec<crate::adapters::vectordb::ConversationSummary>, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.list_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_archived_conversations(
) -> Result<Vec<crate::adapters::vectordb::ConversationSummary>, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.list_archived_conversations().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_runs(
    conversation_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<crate::adapters::vectordb::RunSummary>, String> {
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;

    let parsed_conversation_id = conversation_id
        .as_deref()
        .map(parse_conversation_id)
        .transpose()?;
    let safe_limit = limit.unwrap_or(50).clamp(1, 200);

    db.list_runs(parsed_conversation_id, safe_limit)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_run_events(
    run_id: String,
) -> Result<Vec<crate::adapters::vectordb::RunEvent>, String> {
    let normalized = run_id.trim();
    if normalized.is_empty() {
        return Err("run_id is required".to_string());
    }

    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.get_run_events(normalized).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_conversation_messages(
    conversation_id: String,
) -> Result<Vec<crate::adapters::vectordb::ConversationMessage>, String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.get_conversation_messages(parsed_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_message(message_id: String) -> Result<(), String> {
    let parsed_id = parse_message_id(&message_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.delete_message(parsed_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_conversation(conversation_id: String, title: String) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let normalized_title = title.trim();
    if normalized_title.is_empty() {
        return Err("title cannot be empty".to_string());
    }

    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.rename_conversation(parsed_id, normalized_title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn archive_conversation(conversation_id: String) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_conversation_archived(parsed_id, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unarchive_conversation(conversation_id: String) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_conversation_archived(parsed_id, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_conversation(conversation_id: String) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_conversation_pinned(parsed_id, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_conversation(conversation_id: String) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.set_conversation_pinned(parsed_id, false)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_conversations(conversation_ids: Vec<String>) -> Result<(), String> {
    let parsed_ids = conversation_ids
        .iter()
        .map(|value| parse_conversation_id(value))
        .collect::<Result<Vec<_>, _>>()?;

    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.reorder_conversations(&parsed_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_active_run(conversation_id: String) -> Result<bool, String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    Ok(super::assistant::cancel_active_run(parsed_id))
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    message: String,
    conversation_id: Option<String>,
    folder_id: Option<String>,
) -> Result<SendMessageResponse, String> {
    let global_settings = Settings::load_global();
    let vault_path = global_settings
        .vault_path
        .clone()
        .ok_or("No vault configured")?
        .to_string();
    let vault_config =
        crate::adapters::config::VaultConfig::load(std::path::Path::new(&vault_path));
    let mut settings = global_settings.merged_with_vault(&vault_config);

    let db_path = current_db_path(&settings)?;
    let existing_conversation_id = conversation_id
        .as_deref()
        .map(parse_conversation_id)
        .transpose()?;
    let parsed_folder_id = folder_id.as_deref().map(parse_folder_id).transpose()?;

    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    let conversation_id = if let Some(parsed_id) = existing_conversation_id {
        let exists = db
            .conversation_exists(parsed_id)
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Conversation {} not found", parsed_id));
        }
        parsed_id
    } else {
        let title = title_from_first_user_message(&message);
        let created_id = db.create_conversation(&title).map_err(|e| e.to_string())?;
        if let Some(target_folder_id) = parsed_folder_id {
            db.set_conversation_folder(created_id, Some(target_folder_id))
                .map_err(|e| e.to_string())?;
        }
        created_id
    };

    let (provider, model) =
        resolve_provider_and_model_for_conversation(&settings, &db, conversation_id)?;
    drop(db);

    let api_key = resolve_provider_credential(&mut settings, &provider).await?;

    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    db.save_message(conversation_id, "user", &message, None, None, None)
        .map_err(|e| e.to_string())?;

    spawn_assistant_task(
        app,
        conversation_id,
        vault_path,
        message,
        api_key,
        provider,
        model,
        db_path,
        false,
    );

    Ok(SendMessageResponse {
        conversation_id: conversation_id.to_string(),
    })
}

#[tauri::command]
pub async fn regenerate_last_response(
    app: AppHandle,
    conversation_id: String,
    assistant_message_id: Option<String>,
) -> Result<SendMessageResponse, String> {
    let global_settings = Settings::load_global();
    let vault_path = global_settings
        .vault_path
        .clone()
        .ok_or("No vault configured")?
        .to_string();
    let vault_config =
        crate::adapters::config::VaultConfig::load(std::path::Path::new(&vault_path));
    let mut settings = global_settings.merged_with_vault(&vault_config);

    let db_path = current_db_path(&settings)?;
    let parsed_conversation_id = parse_conversation_id(&conversation_id)?;

    let (provider, model) = {
        let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
        let exists = db
            .conversation_exists(parsed_conversation_id)
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Conversation {} not found", conversation_id));
        }
        resolve_provider_and_model_for_conversation(&settings, &db, parsed_conversation_id)?
    };
    let api_key = resolve_provider_credential(&mut settings, &provider).await?;

    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    let exists = db
        .conversation_exists(parsed_conversation_id)
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err(format!("Conversation {} not found", conversation_id));
    }

    let assistant_id = match assistant_message_id {
        Some(message_id) => parse_message_id(&message_id)?,
        None => db
            .get_last_assistant_message_id(parsed_conversation_id)
            .map_err(|e| e.to_string())?
            .ok_or("No assistant message available for regeneration")?,
    };
    let user_prompt = db
        .get_last_user_message(parsed_conversation_id, Some(assistant_id))
        .map_err(|e| e.to_string())?
        .ok_or("No user message available for regeneration")?;
    db.truncate_messages_from(parsed_conversation_id, assistant_id)
        .map_err(|e| e.to_string())?;
    drop(db);

    spawn_assistant_task(
        app,
        parsed_conversation_id,
        vault_path,
        user_prompt,
        api_key,
        provider,
        model,
        db_path,
        true,
    );

    Ok(SendMessageResponse {
        conversation_id: parsed_conversation_id.to_string(),
    })
}

#[tauri::command]
pub async fn edit_user_message(
    app: AppHandle,
    message_id: String,
    content: String,
) -> Result<SendMessageResponse, String> {
    let normalized_content = content.trim().to_string();
    if normalized_content.is_empty() {
        return Err("content cannot be empty".to_string());
    }

    let global_settings = Settings::load_global();
    let vault_path = global_settings
        .vault_path
        .clone()
        .ok_or("No vault configured")?
        .to_string();
    let vault_config =
        crate::adapters::config::VaultConfig::load(std::path::Path::new(&vault_path));
    let mut settings = global_settings.merged_with_vault(&vault_config);

    let parsed_message_id = parse_message_id(&message_id)?;
    let db_path = current_db_path(&settings)?;

    let (provider, model) = {
        let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
        let conversation_id = db
            .get_message_conversation_id(parsed_message_id)
            .map_err(|e| e.to_string())?;
        resolve_provider_and_model_for_conversation(&settings, &db, conversation_id)?
    };
    let api_key = resolve_provider_credential(&mut settings, &provider).await?;

    let mut db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    let conversation_id = db
        .edit_user_message_and_truncate(parsed_message_id, &normalized_content)
        .map_err(|e| e.to_string())?;
    drop(db);

    spawn_assistant_task(
        app,
        conversation_id,
        vault_path,
        normalized_content,
        api_key,
        provider,
        model,
        db_path,
        true,
    );

    Ok(SendMessageResponse {
        conversation_id: conversation_id.to_string(),
    })
}

#[tauri::command]
pub async fn export_conversation(
    conversation_id: String,
    file_path: String,
    title: Option<String>,
) -> Result<(), String> {
    let parsed_id = parse_conversation_id(&conversation_id)?;
    let settings = Settings::load_global();
    let db_path = current_db_path(&settings)?;
    let db = crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;
    let messages = db
        .get_conversation_messages(parsed_id)
        .map_err(|e| e.to_string())?;

    let heading = title.unwrap_or_else(|| "Conversation".to_string());
    let mut md = format!("# {heading}\n\n");

    for msg in &messages {
        let role_label = match msg.role.as_str() {
            "user" => "**User**",
            "assistant" => "**Assistant**",
            other => other,
        };
        md.push_str(&format!("{role_label}\n\n{}\n\n---\n\n", msg.content));
    }

    std::fs::write(&file_path, md).map_err(|e| e.to_string())
}
