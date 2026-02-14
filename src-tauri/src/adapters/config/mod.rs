use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

fn default_retrieval_rerank_enabled() -> bool {
    true
}

fn default_retrieval_rerank_top_k() -> u32 {
    8
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OauthClientConfig {
    pub client_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct OauthTokenConfig {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub vault_path: Option<String>,
    pub user_language: Option<String>,
    pub chat_provider: Option<String>,
    pub chat_model: Option<String>,
    pub chat_model_id: Option<String>,
    pub fallback_chat_model_id: Option<String>,
    pub embedding_provider: Option<String>,
    pub embedding_model_id: Option<String>,
    #[serde(default)]
    pub api_keys: HashMap<String, String>,
    #[serde(default)]
    pub auth_modes: HashMap<String, String>,
    #[serde(default)]
    pub oauth_clients: HashMap<String, OauthClientConfig>,
    #[serde(default)]
    pub oauth_tokens: HashMap<String, OauthTokenConfig>,
    #[serde(default = "default_retrieval_rerank_enabled")]
    pub retrieval_rerank_enabled: bool,
    #[serde(default = "default_retrieval_rerank_top_k")]
    pub retrieval_rerank_top_k: u32,
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub tavily_api_key: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            vault_path: None,
            user_language: None,
            chat_provider: Some("openai".to_string()),
            chat_model: Some("gpt-5.2".to_string()),
            chat_model_id: Some("openai:gpt-5.2".to_string()),
            fallback_chat_model_id: None,
            embedding_provider: Some("openai".to_string()),
            embedding_model_id: Some("openai:text-embedding-3-small".to_string()),
            api_keys: HashMap::new(),
            auth_modes: HashMap::new(),
            oauth_clients: HashMap::new(),
            oauth_tokens: HashMap::new(),
            retrieval_rerank_enabled: default_retrieval_rerank_enabled(),
            retrieval_rerank_top_k: default_retrieval_rerank_top_k(),
            openai_api_key: None,
            anthropic_api_key: None,
            google_api_key: None,
            tavily_api_key: None,
        }
    }
}

impl Settings {
    fn split_model_id(model_id: &str) -> Option<(&str, &str)> {
        let (provider, model) = model_id.trim().split_once(':')?;
        let provider = provider.trim();
        let model = model.trim();
        if provider.is_empty() || model.is_empty() {
            return None;
        }
        Some((provider, model))
    }

    fn normalize_model_id(provider: &str, model: &str) -> Option<String> {
        if let Some((p, m)) = Self::split_model_id(model) {
            return Some(format!("{p}:{m}"));
        }

        let provider = provider.trim();
        let model = model.trim();
        if provider.is_empty() || model.is_empty() {
            return None;
        }

        Some(format!("{provider}:{model}"))
    }

    fn default_embedding_model_id(provider: &str) -> String {
        match provider {
            "google" => "google:gemini-embedding-001".to_string(),
            _ => "openai:text-embedding-3-small".to_string(),
        }
    }

    fn global_config_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".meld")
    }

    fn global_config_path() -> PathBuf {
        Self::global_config_dir().join("config.toml")
    }

    pub fn load_global() -> Self {
        let path = Self::global_config_path();
        if path.exists() {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let mut settings: Self = toml::from_str(&content).unwrap_or_default();
            settings.hydrate_legacy_api_keys();
            settings
        } else {
            Self::default()
        }
    }

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let global_dir = Self::global_config_dir();
        std::fs::create_dir_all(&global_dir)?;
        let content = toml::to_string_pretty(self)?;
        std::fs::write(Self::global_config_path(), &content)?;
        Ok(())
    }

    pub fn set_api_key(&mut self, provider: &str, key: &str) {
        let normalized_provider = provider.trim().to_ascii_lowercase();
        if normalized_provider.is_empty() {
            return;
        }
        let normalized_key = key.trim().to_string();
        if normalized_key.is_empty() {
            self.api_keys.remove(&normalized_provider);
        } else {
            self.api_keys
                .insert(normalized_provider.clone(), normalized_key.clone());
            self.auth_modes
                .insert(normalized_provider.clone(), "api_key".to_string());
        }

        let legacy_value = if normalized_key.is_empty() {
            None
        } else {
            Some(normalized_key)
        };

        match provider {
            "openai" => self.openai_api_key = legacy_value.clone(),
            "anthropic" => self.anthropic_api_key = legacy_value.clone(),
            "google" => self.google_api_key = legacy_value.clone(),
            "tavily" => self.tavily_api_key = legacy_value,
            _ => {}
        }
    }

    pub fn set_user_language(&mut self, language: &str) {
        let normalized = language.trim();
        if normalized.is_empty() {
            self.user_language = None;
            return;
        }

        // Keep user-provided language labels readable but normalized for consistency.
        self.user_language = Some(normalized.to_string());
    }

    pub fn user_language(&self) -> Option<String> {
        self.user_language
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }

    pub fn set_model(&mut self, provider: &str, model: &str) {
        let normalized_model_id = Self::normalize_model_id(provider, model);
        let (resolved_provider, resolved_model) =
            if let Some(model_id) = normalized_model_id.as_deref() {
                if let Some((provider, model)) = Self::split_model_id(model_id) {
                    (provider.to_string(), model.to_string())
                } else {
                    (provider.trim().to_string(), model.trim().to_string())
                }
            } else {
                (provider.trim().to_string(), model.trim().to_string())
            };

        if !resolved_provider.is_empty() {
            self.chat_provider = Some(resolved_provider.clone());
        }
        if !resolved_model.is_empty() {
            self.chat_model = Some(resolved_model);
        }
        if let Some(model_id) = normalized_model_id {
            self.chat_model_id = Some(model_id);
        }
    }

    pub fn set_embedding_model(&mut self, provider: &str, model: &str) -> Result<(), String> {
        let normalized_model_id = Self::normalize_model_id(provider, model)
            .ok_or_else(|| "embedding provider and model are required".to_string())?;
        let (resolved_provider, resolved_model) = Self::split_model_id(&normalized_model_id)
            .ok_or_else(|| "embedding provider and model are required".to_string())?;

        self.embedding_provider = Some(resolved_provider.to_string());
        self.embedding_model_id = Some(format!("{resolved_provider}:{resolved_model}"));
        Ok(())
    }

    pub fn set_fallback_chat_model(&mut self, model_id: Option<&str>) -> Result<(), String> {
        let normalized = model_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                Self::split_model_id(value)
                    .map(|(provider, model)| format!("{provider}:{model}"))
                    .ok_or_else(|| {
                        format!("Invalid fallback model id '{value}'. Expected provider:model")
                    })
            })
            .transpose()?;

        self.fallback_chat_model_id = normalized;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn chat_api_key(&self) -> Option<String> {
        self.api_key_for_provider(&self.chat_provider())
    }

    #[allow(dead_code)]
    pub fn embedding_api_key(&self) -> Option<String> {
        self.api_key_for_provider(&self.embedding_provider())
    }

    pub fn chat_provider(&self) -> String {
        if let Some(model_id) = &self.chat_model_id {
            if let Some((provider, _)) = Self::split_model_id(model_id) {
                return provider.to_string();
            }
        }
        self.chat_provider
            .clone()
            .unwrap_or_else(|| "openai".to_string())
    }

    pub fn chat_model(&self) -> String {
        if let Some(model_id) = &self.chat_model_id {
            if let Some((_, model)) = Self::split_model_id(model_id) {
                return model.to_string();
            }
        }
        self.chat_model
            .clone()
            .unwrap_or_else(|| "gpt-5.2".to_string())
    }

    pub fn chat_model_id(&self) -> String {
        if let Some(model_id) = self.chat_model_id.as_deref() {
            if let Some((provider, model)) = Self::split_model_id(model_id) {
                return format!("{provider}:{model}");
            }
        }
        format!("{}:{}", self.chat_provider(), self.chat_model())
    }

    pub fn embedding_provider(&self) -> String {
        if let Some(model_id) = &self.embedding_model_id {
            if let Some((provider, _)) = Self::split_model_id(model_id) {
                return provider.to_string();
            }
        }
        self.embedding_provider
            .clone()
            .unwrap_or_else(|| "openai".to_string())
    }

    pub fn embedding_model_id(&self) -> String {
        if let Some(model_id) = self.embedding_model_id.as_deref() {
            if let Some((provider, model)) = Self::split_model_id(model_id) {
                return format!("{provider}:{model}");
            }
        }
        Self::default_embedding_model_id(&self.embedding_provider())
    }

    pub fn tavily_api_key(&self) -> String {
        self.tavily_api_key.clone().unwrap_or_default()
    }

    pub fn fallback_chat_model_id(&self) -> Option<String> {
        self.fallback_chat_model_id
            .as_deref()
            .and_then(Self::split_model_id)
            .map(|(provider, model)| format!("{provider}:{model}"))
    }

    pub fn set_auth_mode(&mut self, provider: &str, mode: &str) -> Result<(), String> {
        let provider = provider.trim().to_ascii_lowercase();
        let mode = mode.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return Err("provider is required".to_string());
        }
        if mode.is_empty() {
            self.auth_modes.remove(&provider);
            return Ok(());
        }
        match mode.as_str() {
            "api_key" | "oauth" => {
                self.auth_modes.insert(provider, mode);
                Ok(())
            }
            _ => Err(format!(
                "Unsupported auth mode '{mode}'. Supported: api_key, oauth"
            )),
        }
    }

    pub fn auth_mode_for_provider(&self, provider: &str) -> String {
        let provider = provider.trim().to_ascii_lowercase();
        self.auth_modes
            .get(&provider)
            .cloned()
            .unwrap_or_else(|| "api_key".to_string())
    }

    pub fn set_oauth_client(&mut self, provider: &str, client_id: &str) -> Result<(), String> {
        let provider = provider.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return Err("provider is required".to_string());
        }

        let client_id = client_id.trim();
        if client_id.is_empty() {
            self.oauth_clients.remove(&provider);
            return Ok(());
        }

        self.oauth_clients.insert(
            provider,
            OauthClientConfig {
                client_id: client_id.to_string(),
            },
        );
        Ok(())
    }

    pub fn oauth_client_id_for_provider(&self, provider: &str) -> Option<String> {
        let provider = provider.trim().to_ascii_lowercase();
        self.oauth_clients
            .get(&provider)
            .map(|config| config.client_id.clone())
    }

    pub fn oauth_token_for_provider(&self, provider: &str) -> Option<OauthTokenConfig> {
        let provider = provider.trim().to_ascii_lowercase();
        self.oauth_tokens.get(&provider).cloned()
    }

    pub fn upsert_oauth_token(&mut self, provider: &str, token: OauthTokenConfig) {
        let provider = provider.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return;
        }

        self.oauth_tokens.insert(provider.clone(), token);
        self.auth_modes.insert(provider, "oauth".to_string());
    }

    pub fn clear_oauth_connection(&mut self, provider: &str) {
        let provider = provider.trim().to_ascii_lowercase();
        if provider.is_empty() {
            return;
        }
        self.oauth_tokens.remove(&provider);
        if self.auth_mode_for_provider(&provider) == "oauth" {
            self.auth_modes.insert(provider, "api_key".to_string());
        }
    }

    pub fn retrieval_rerank_enabled(&self) -> bool {
        self.retrieval_rerank_enabled
    }

    pub fn retrieval_rerank_top_k(&self) -> usize {
        self.retrieval_rerank_top_k.clamp(1, 50) as usize
    }

    pub fn api_key_for_provider(&self, provider: &str) -> Option<String> {
        let normalized_provider = provider.trim().to_ascii_lowercase();
        if let Some(value) = self.api_keys.get(&normalized_provider) {
            return Some(value.clone());
        }

        match normalized_provider.as_str() {
            "openai" => self.openai_api_key.clone(),
            "anthropic" => self.anthropic_api_key.clone(),
            "google" => self.google_api_key.clone(),
            "tavily" => self.tavily_api_key.clone(),
            _ => None,
        }
    }

    fn hydrate_legacy_api_keys(&mut self) {
        if let Some(value) = self
            .openai_api_key
            .as_ref()
            .filter(|v| !v.trim().is_empty())
        {
            self.api_keys
                .entry("openai".to_string())
                .or_insert_with(|| value.clone());
        }
        if let Some(value) = self
            .anthropic_api_key
            .as_ref()
            .filter(|v| !v.trim().is_empty())
        {
            self.api_keys
                .entry("anthropic".to_string())
                .or_insert_with(|| value.clone());
        }
        if let Some(value) = self
            .google_api_key
            .as_ref()
            .filter(|v| !v.trim().is_empty())
        {
            self.api_keys
                .entry("google".to_string())
                .or_insert_with(|| value.clone());
        }
        if let Some(value) = self
            .tavily_api_key
            .as_ref()
            .filter(|v| !v.trim().is_empty())
        {
            self.api_keys
                .entry("tavily".to_string())
                .or_insert_with(|| value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn set_fallback_chat_model_accepts_valid_id() {
        let mut settings = Settings::default();
        settings
            .set_fallback_chat_model(Some("openai:gpt-4.1"))
            .expect("set fallback");
        assert_eq!(
            settings.fallback_chat_model_id(),
            Some("openai:gpt-4.1".to_string())
        );
    }

    #[test]
    fn set_fallback_chat_model_clears_on_empty() {
        let mut settings = Settings::default();
        settings
            .set_fallback_chat_model(Some("openai:gpt-4.1"))
            .expect("seed fallback");
        settings
            .set_fallback_chat_model(Some("  "))
            .expect("clear fallback");
        assert_eq!(settings.fallback_chat_model_id(), None);
    }

    #[test]
    fn set_fallback_chat_model_rejects_invalid_id() {
        let mut settings = Settings::default();
        let result = settings.set_fallback_chat_model(Some("gpt-4.1"));
        assert!(result.is_err());
    }

    #[test]
    fn retrieval_rerank_top_k_is_clamped() {
        let mut settings = Settings::default();
        settings.retrieval_rerank_top_k = 0;
        assert_eq!(settings.retrieval_rerank_top_k(), 1);
        settings.retrieval_rerank_top_k = 999;
        assert_eq!(settings.retrieval_rerank_top_k(), 50);
    }

    #[test]
    fn set_model_keeps_existing_embedding_configuration() {
        let mut settings = Settings::default();
        settings
            .set_embedding_model("openai", "text-embedding-3-small")
            .expect("set embedding model");

        settings.set_model("openrouter", "openrouter/auto");

        assert_eq!(settings.embedding_provider(), "openai");
        assert_eq!(
            settings.embedding_model_id(),
            "openai:text-embedding-3-small".to_string()
        );
    }

    #[test]
    fn set_embedding_model_updates_provider_and_model_id() {
        let mut settings = Settings::default();
        settings
            .set_embedding_model("google", "gemini-embedding-001")
            .expect("set embedding model");

        assert_eq!(settings.embedding_provider(), "google");
        assert_eq!(
            settings.embedding_model_id(),
            "google:gemini-embedding-001".to_string()
        );
    }

    #[test]
    fn auth_mode_rejects_invalid_values() {
        let mut settings = Settings::default();
        let result = settings.set_auth_mode("openai", "token");
        assert!(result.is_err());
    }

    #[test]
    fn oauth_client_roundtrip() {
        let mut settings = Settings::default();
        settings
            .set_oauth_client("google", "client-123")
            .expect("set oauth client");
        assert_eq!(
            settings.oauth_client_id_for_provider("google"),
            Some("client-123".to_string())
        );
    }

    #[test]
    fn clear_oauth_connection_falls_back_to_api_key_mode() {
        let mut settings = Settings::default();
        settings
            .set_auth_mode("google", "oauth")
            .expect("set oauth mode");
        settings.upsert_oauth_token(
            "google",
            super::OauthTokenConfig {
                access_token: "token".to_string(),
                refresh_token: None,
                token_type: None,
                scope: None,
                expires_at: None,
            },
        );
        settings.clear_oauth_connection("google");
        assert!(settings.oauth_token_for_provider("google").is_none());
        assert_eq!(
            settings.auth_mode_for_provider("google"),
            "api_key".to_string()
        );
    }

    #[test]
    fn set_user_language_stores_non_empty_and_clears_empty() {
        let mut settings = Settings::default();
        settings.set_user_language("Русский");
        assert_eq!(settings.user_language(), Some("Русский".to_string()));

        settings.set_user_language("   ");
        assert_eq!(settings.user_language(), None);
    }
}
