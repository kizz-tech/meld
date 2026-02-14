use crate::adapters::config::Settings;
use crate::adapters::providers::ProviderCatalogEntry;

use super::shared::{ensure_valid_provider_id, normalize_provider};

#[tauri::command]
pub async fn get_config() -> Result<Settings, String> {
    Ok(Settings::load_global())
}

#[tauri::command]
pub async fn get_provider_catalog() -> Result<Vec<ProviderCatalogEntry>, String> {
    let registry = crate::adapters::providers::ProviderRegistry::default();
    Ok(registry.catalog())
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;

    let mut settings = Settings::load_global();
    settings.set_api_key(&provider, key.trim());
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_oauth_client(provider: String, client_id: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;

    let mut settings = Settings::load_global();
    settings.set_oauth_client(&provider, &client_id)?;
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_auth_mode(provider: String, mode: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;

    let mut settings = Settings::load_global();
    settings
        .set_auth_mode(&provider, &mode)
        .map_err(|e| e.to_string())?;
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_oauth(
    provider: String,
) -> Result<crate::adapters::oauth::OauthStartResponse, String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;
    crate::adapters::oauth::start_oauth(&provider).await
}

#[tauri::command]
pub async fn finish_oauth(
    provider: String,
    flow_id: String,
    timeout_ms: Option<u64>,
) -> Result<crate::adapters::oauth::OauthFinishResponse, String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;
    crate::adapters::oauth::finish_oauth(&provider, &flow_id, timeout_ms).await
}

#[tauri::command]
pub async fn disconnect_oauth(provider: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;
    crate::adapters::oauth::disconnect_oauth(&provider)
}

#[tauri::command]
pub async fn set_model(provider: String, model: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;

    if model.trim().is_empty() {
        return Err("model is required".to_string());
    }

    let mut settings = Settings::load_global();
    settings.set_model(&provider, &model);
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_embedding_model(provider: String, model: String) -> Result<(), String> {
    let provider = normalize_provider(&provider);
    ensure_valid_provider_id(&provider)?;

    if model.trim().is_empty() {
        return Err("model is required".to_string());
    }

    let supports_embeddings = crate::adapters::providers::ProviderRegistry::default()
        .catalog()
        .iter()
        .any(|entry| entry.id == provider && entry.supports_embeddings);
    if !supports_embeddings {
        return Err(format!(
            "Provider '{}' does not support embeddings",
            provider
        ));
    }

    let mut settings = Settings::load_global();
    settings
        .set_embedding_model(&provider, &model)
        .map_err(|e| e.to_string())?;

    let auth_mode = settings.auth_mode_for_provider(&provider);
    let has_api_key = settings
        .api_key_for_provider(&provider)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_oauth = settings.oauth_token_for_provider(&provider).is_some();
    if auth_mode == "oauth" {
        if !has_oauth {
            return Err(format!(
                "No OAuth token configured for embedding provider '{}'",
                provider
            ));
        }
    } else if !has_api_key {
        return Err(format!(
            "No API key configured for embedding provider '{}'",
            provider
        ));
    }

    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_fallback_model(model_id: Option<String>) -> Result<(), String> {
    let mut settings = Settings::load_global();
    settings
        .set_fallback_chat_model(model_id.as_deref())
        .map_err(|e| e.to_string())?;
    settings.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_user_language(language: String) -> Result<(), String> {
    let mut settings = Settings::load_global();
    settings.set_user_language(&language);
    settings.save().map_err(|e| e.to_string())
}
