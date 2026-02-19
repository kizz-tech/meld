use crate::adapters::llm::{self, ChatMessage, StreamEvent, ToolDefinition};
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Clone)]
pub struct ChatRequest<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub messages: &'a [ChatMessage],
    pub tools: Option<&'a [ToolDefinition]>,
    pub tx: mpsc::UnboundedSender<StreamEvent>,
}

#[derive(Debug, Clone)]
pub struct EmbeddingRequest<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub texts: &'a [String],
}

pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    fn supports_tools(&self) -> bool {
        true
    }
    fn supports_streaming(&self) -> bool {
        true
    }
    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>>;
}

pub trait EmbeddingProvider: Send + Sync {
    fn id(&self) -> &str;
    fn dimensions(&self) -> usize;
    fn embed<'a>(
        &'a self,
        request: EmbeddingRequest<'a>,
    ) -> BoxFuture<'a, Result<Vec<Vec<f32>>, DynError>>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogEntry {
    pub id: String,
    pub display_name: String,
    pub supports_llm: bool,
    pub supports_embeddings: bool,
    pub auth_modes: Vec<String>,
}

pub struct ProviderRegistry {
    llm: HashMap<String, Box<dyn LlmProvider>>,
    embedding: HashMap<String, Box<dyn EmbeddingProvider>>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        let mut registry = Self {
            llm: HashMap::new(),
            embedding: HashMap::new(),
        };

        registry.register_llm(Box::new(OpenAiLlmProvider));
        registry.register_llm(Box::new(OpenRouterLlmProvider));
        registry.register_llm(Box::new(AnthropicLlmProvider));
        registry.register_llm(Box::new(GoogleLlmProvider));
        registry.register_llm(Box::new(OllamaLlmProvider));
        registry.register_llm(Box::new(LmStudioLlmProvider));

        registry.register_embedding(Box::new(OpenAiEmbeddingProvider));
        registry.register_embedding(Box::new(GoogleEmbeddingProvider));

        registry
    }
}

impl ProviderRegistry {
    pub fn register_llm(&mut self, provider: Box<dyn LlmProvider>) {
        self.llm.insert(provider.id().to_string(), provider);
    }

    pub fn register_embedding(&mut self, provider: Box<dyn EmbeddingProvider>) {
        self.embedding.insert(provider.id().to_string(), provider);
    }

    pub fn resolve_llm<'a>(
        &'a self,
        model_id: &'a str,
    ) -> Result<(&'a dyn LlmProvider, &'a str), String> {
        let (provider_id, model) = split_model_id(model_id)?;
        let provider = self
            .llm
            .get(provider_id)
            .ok_or_else(|| format!("Unsupported LLM provider: {provider_id}"))?;
        Ok((provider.as_ref(), model))
    }

    pub fn resolve_embedding<'a>(
        &'a self,
        model_id: &'a str,
    ) -> Result<(&'a dyn EmbeddingProvider, &'a str), String> {
        let (provider_id, model) = split_model_id(model_id)?;
        let provider = self
            .embedding
            .get(provider_id)
            .ok_or_else(|| format!("Unsupported embedding provider: {provider_id}"))?;
        Ok((provider.as_ref(), model))
    }

    pub fn catalog(&self) -> Vec<ProviderCatalogEntry> {
        let mut by_provider: HashMap<String, ProviderCatalogEntry> = HashMap::new();

        for provider in self.llm.values() {
            let id = provider.id().to_string();
            by_provider
                .entry(id.clone())
                .or_insert_with(|| ProviderCatalogEntry {
                    id: id.clone(),
                    display_name: provider_display_name(&id),
                    supports_llm: false,
                    supports_embeddings: false,
                    auth_modes: provider_auth_modes(&id),
                })
                .supports_llm = true;
        }

        for provider in self.embedding.values() {
            let id = provider.id().to_string();
            by_provider
                .entry(id.clone())
                .or_insert_with(|| ProviderCatalogEntry {
                    id: id.clone(),
                    display_name: provider_display_name(&id),
                    supports_llm: false,
                    supports_embeddings: false,
                    auth_modes: provider_auth_modes(&id),
                })
                .supports_embeddings = true;
        }

        let mut entries = by_provider.into_values().collect::<Vec<_>>();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }

    #[allow(dead_code)]
    pub fn llm_provider_ids(&self) -> Vec<String> {
        let mut ids = self.llm.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids
    }

    #[allow(dead_code)]
    pub fn embedding_provider_ids(&self) -> Vec<String> {
        let mut ids = self.embedding.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids
    }
}

fn provider_display_name(provider_id: &str) -> String {
    match provider_id {
        "openai" => "OpenAI".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "google" => "Google Gemini".to_string(),
        "ollama" => "Ollama".to_string(),
        "lm_studio" => "LM Studio".to_string(),
        "tavily" => "Tavily".to_string(),
        _ => provider_id.to_string(),
    }
}

fn provider_auth_modes(provider_id: &str) -> Vec<String> {
    match provider_id {
        "google" => vec!["api_key".to_string(), "oauth".to_string()],
        "openrouter" => vec!["api_key".to_string()],
        "anthropic" | "tavily" => vec!["api_key".to_string()],
        _ => vec!["api_key".to_string()],
    }
}

pub fn split_model_id(model_id: &str) -> Result<(&str, &str), String> {
    let trimmed = model_id.trim();
    let (provider, model) = trimmed
        .split_once(':')
        .ok_or_else(|| format!("Invalid model id '{trimmed}'. Expected provider:model"))?;

    let provider = provider.trim();
    let model = model.trim();

    if provider.is_empty() || model.is_empty() {
        return Err(format!(
            "Invalid model id '{trimmed}'. Provider and model must be non-empty"
        ));
    }

    Ok((provider, model))
}

#[derive(Debug, Clone, Serialize)]
struct OpenAIEmbeddingRequest {
    input: Vec<String>,
    model: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIEmbeddingResponse {
    data: Vec<OpenAIEmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct OpenAIEmbeddingData {
    embedding: Vec<f32>,
}

#[derive(Debug, Serialize)]
struct GoogleEmbeddingRequest {
    content: GoogleEmbeddingContent,
}

#[derive(Debug, Serialize)]
struct GoogleEmbeddingContent {
    parts: Vec<GoogleEmbeddingPart>,
}

#[derive(Debug, Serialize)]
struct GoogleEmbeddingPart {
    text: String,
}

#[derive(Debug, Deserialize)]
struct GoogleEmbeddingResponse {
    embedding: GoogleEmbeddingValues,
}

#[derive(Debug, Deserialize)]
struct GoogleEmbeddingValues {
    values: Vec<f32>,
}

struct OpenAiLlmProvider;
struct OpenRouterLlmProvider;
struct AnthropicLlmProvider;
struct GoogleLlmProvider;
struct OllamaLlmProvider;
struct LmStudioLlmProvider;
struct OpenAiEmbeddingProvider;
struct GoogleEmbeddingProvider;

impl LlmProvider for OpenAiLlmProvider {
    fn id(&self) -> &str {
        "openai"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::openai::chat_stream(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
            )
            .await
        })
    }
}

impl LlmProvider for AnthropicLlmProvider {
    fn id(&self) -> &str {
        "anthropic"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::anthropic::chat_stream(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
            )
            .await
        })
    }
}

impl LlmProvider for OpenRouterLlmProvider {
    fn id(&self) -> &str {
        "openrouter"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::openai::chat_stream_with_endpoint(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
                "https://openrouter.ai/api/v1/chat/completions",
                "OpenRouter",
            )
            .await
        })
    }
}

impl LlmProvider for GoogleLlmProvider {
    fn id(&self) -> &str {
        "google"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::google::chat_stream(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
            )
            .await
        })
    }
}

impl LlmProvider for OllamaLlmProvider {
    fn id(&self) -> &str {
        "ollama"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::openai::chat_stream_with_endpoint(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
                "http://localhost:11434/v1/chat/completions",
                "Ollama",
            )
            .await
        })
    }
}

impl LlmProvider for LmStudioLlmProvider {
    fn id(&self) -> &str {
        "lm_studio"
    }

    fn chat<'a>(&'a self, request: ChatRequest<'a>) -> BoxFuture<'a, Result<(), DynError>> {
        Box::pin(async move {
            llm::providers::openai::chat_stream_with_endpoint(
                request.api_key,
                request.model,
                request.messages,
                request.tools,
                request.tx,
                "http://localhost:1234/v1/chat/completions",
                "LM Studio",
            )
            .await
        })
    }
}

impl EmbeddingProvider for OpenAiEmbeddingProvider {
    fn id(&self) -> &str {
        "openai"
    }

    fn dimensions(&self) -> usize {
        1536
    }

    fn embed<'a>(
        &'a self,
        request: EmbeddingRequest<'a>,
    ) -> BoxFuture<'a, Result<Vec<Vec<f32>>, DynError>> {
        Box::pin(async move {
            let client = reqwest::Client::new();
            let response = client
                .post("https://api.openai.com/v1/embeddings")
                .header("Authorization", format!("Bearer {}", request.api_key))
                .json(&OpenAIEmbeddingRequest {
                    input: request.texts.to_vec(),
                    model: request.model.to_string(),
                })
                .send()
                .await?;

            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                return Err(format!("OpenAI embedding API error ({status}): {body}").into());
            }

            let response = response.json::<OpenAIEmbeddingResponse>().await?;
            let embeddings = response
                .data
                .into_iter()
                .map(|item| item.embedding)
                .collect::<Vec<_>>();
            Ok(embeddings)
        })
    }
}

impl EmbeddingProvider for GoogleEmbeddingProvider {
    fn id(&self) -> &str {
        "google"
    }

    fn dimensions(&self) -> usize {
        768
    }

    fn embed<'a>(
        &'a self,
        request: EmbeddingRequest<'a>,
    ) -> BoxFuture<'a, Result<Vec<Vec<f32>>, DynError>> {
        Box::pin(async move {
            let client = reqwest::Client::new();
            let mut embeddings = Vec::with_capacity(request.texts.len());

            for text in request.texts {
                let base_url = format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:embedContent",
                    request.model
                );

                let request_body = GoogleEmbeddingRequest {
                    content: GoogleEmbeddingContent {
                        parts: vec![GoogleEmbeddingPart {
                            text: text.to_string(),
                        }],
                    },
                };

                let response = if request.api_key.trim().starts_with("AIza") {
                    let url_with_key = format!("{base_url}?key={}", request.api_key.trim());
                    client
                        .post(&url_with_key)
                        .json(&request_body)
                        .send()
                        .await?
                } else {
                    client
                        .post(&base_url)
                        .bearer_auth(request.api_key.trim())
                        .json(&request_body)
                        .send()
                        .await?
                };

                if !response.status().is_success() {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    return Err(format!("Google embedding API error ({status}): {body}").into());
                }

                let response = response.json::<GoogleEmbeddingResponse>().await?;
                embeddings.push(response.embedding.values);
            }

            Ok(embeddings)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ProviderRegistry;

    #[test]
    fn resolve_llm_openai_model_id() {
        let registry = ProviderRegistry::default();
        let (provider, model) = registry.resolve_llm("openai:gpt-4.1").expect("resolve llm");
        assert_eq!(provider.id(), "openai");
        assert_eq!(model, "gpt-4.1");
    }

    #[test]
    fn resolve_embedding_google_model_id() {
        let registry = ProviderRegistry::default();
        let (provider, model) = registry
            .resolve_embedding("google:gemini-embedding-001")
            .expect("resolve embedding");
        assert_eq!(provider.id(), "google");
        assert_eq!(provider.dimensions(), 768);
        assert_eq!(model, "gemini-embedding-001");
    }

    #[test]
    fn catalog_includes_supported_capabilities() {
        let registry = ProviderRegistry::default();
        let entries = registry.catalog();
        let openai = entries
            .iter()
            .find(|entry| entry.id == "openai")
            .expect("openai entry");
        assert!(openai.supports_llm);
        assert!(openai.supports_embeddings);
        assert_eq!(openai.auth_modes, vec!["api_key".to_string()]);

        let anthropic = entries
            .iter()
            .find(|entry| entry.id == "anthropic")
            .expect("anthropic entry");
        assert!(anthropic.supports_llm);
        assert!(!anthropic.supports_embeddings);

        let openrouter = entries
            .iter()
            .find(|entry| entry.id == "openrouter")
            .expect("openrouter entry");
        assert!(openrouter.supports_llm);
        assert!(!openrouter.supports_embeddings);
        assert_eq!(openrouter.auth_modes, vec!["api_key".to_string()]);

        let google = entries
            .iter()
            .find(|entry| entry.id == "google")
            .expect("google entry");
        assert_eq!(
            google.auth_modes,
            vec!["api_key".to_string(), "oauth".to_string()]
        );
    }
}
