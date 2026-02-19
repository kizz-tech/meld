use std::path::Path;

use futures::future::BoxFuture;
use serde_json::Value;

pub use crate::adapters::llm::ToolDefinition;

pub struct ToolExecutionContext<'a> {
    pub vault_path: &'a Path,
    pub db_path: &'a Path,
    pub embedding_key: &'a str,
    pub embedding_model_id: &'a str,
    pub tavily_api_key: &'a str,
    pub search_provider: &'a str,
    pub searxng_base_url: &'a str,
    pub brave_api_key: &'a str,
}

pub trait ToolPort: Send + Sync {
    fn tool_definitions_for_llm(&self) -> Vec<ToolDefinition>;
    fn prompt_tool_lines(&self) -> Vec<String>;
    fn execute<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        ctx: &'a ToolExecutionContext<'a>,
    ) -> BoxFuture<'a, Value>;
}
