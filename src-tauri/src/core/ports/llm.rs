use futures::future::BoxFuture;
use tokio::sync::mpsc;

pub type DynError = Box<dyn std::error::Error + Send + Sync>;

pub use crate::adapters::llm::{ChatMessage, RecoveryEvent, StreamEvent, ToolDefinition};

#[derive(Debug, Clone)]
pub struct LlmChatRequest<'a> {
    pub api_key: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub messages: &'a [ChatMessage],
    pub tools: Option<&'a [ToolDefinition]>,
    pub tx: mpsc::UnboundedSender<StreamEvent>,
    /// Per-turn thinking budget for reasoning models. None = provider default.
    pub thinking_budget: Option<u32>,
}

pub trait LlmPort: Send + Sync {
    fn chat_stream<'a>(
        &'a self,
        request: LlmChatRequest<'a>,
    ) -> BoxFuture<'a, Result<(), DynError>>;
}
