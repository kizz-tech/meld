use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::adapters::config::Settings;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IndexProgress {
    pub current: usize,
    pub total: usize,
    pub file: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ChatChunk {
    pub content: String,
    pub done: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCallEvent {
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub iteration: Option<usize>,
    pub tool: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolResultEvent {
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub iteration: Option<usize>,
    pub tool: String,
    pub result: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimelineStepEvent {
    #[serde(default)]
    pub run_id: Option<String>,
    pub id: String,
    pub iteration: usize,
    pub phase: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub args_preview: Option<serde_json::Value>,
    #[serde(default)]
    pub result_preview: Option<String>,
    #[serde(default)]
    pub file_changes: Option<serde_json::Value>,
    pub ts: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SendMessageResponse {
    pub conversation_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultFileEntry {
    pub path: String,
    pub relative_path: String,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VaultEntry {
    pub kind: String,
    pub path: String,
    pub relative_path: String,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

pub fn current_db_path(settings: &Settings) -> Result<PathBuf, String> {
    let vault_path = settings.vault_path.as_ref().ok_or("No vault configured")?;
    crate::adapters::vault::ensure_vault_initialized(Path::new(vault_path))
        .map_err(|e| e.to_string())?;
    Ok(crate::adapters::vault::meld_dir(Path::new(vault_path)).join("index.db"))
}

pub fn parse_conversation_id(conversation_id: &str) -> Result<i64, String> {
    conversation_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid conversation_id: {}", conversation_id))
}

pub fn parse_message_id(message_id: &str) -> Result<i64, String> {
    message_id
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("Invalid message id: {}", message_id))
}

pub fn normalize_provider(provider: &str) -> String {
    provider.trim().to_lowercase()
}

pub async fn resolve_provider_credential(
    settings: &mut Settings,
    provider: &str,
) -> Result<String, String> {
    crate::adapters::oauth::resolve_provider_credential(settings, provider).await
}

pub fn ensure_valid_provider_id(provider: &str) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider is required".to_string());
    }
    if !provider
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(format!(
            "Invalid provider '{}'. Use letters, numbers, '-', '_' or '.'.",
            provider
        ));
    }
    Ok(())
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    let chars: Vec<char> = input.chars().collect();
    if chars.len() <= max_chars {
        return input.to_string();
    }
    if max_chars <= 3 {
        return "...".to_string();
    }

    let head: String = chars.into_iter().take(max_chars - 3).collect();
    format!("{}...", head)
}

pub fn title_from_first_user_message(message: &str) -> String {
    let normalized = message
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        "New conversation".to_string()
    } else {
        truncate_chars(&normalized, 50)
    }
}
