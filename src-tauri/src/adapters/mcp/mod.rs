use crate::adapters::llm::{
    FunctionDefinition as LlmFunctionDefinition, ToolDefinition as LlmToolDefinition,
};
use crate::core::ports::tools::{ToolExecutionContext, ToolPort};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Read,
    Write,
}

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub permission: Permission,
}

pub struct ToolContext<'a> {
    pub vault_path: &'a Path,
    pub db_path: &'a Path,
    pub embedding_key: &'a str,
    pub embedding_model_id: &'a str,
    pub tavily_api_key: &'a str,
    pub search_provider: &'a str,
    pub searxng_base_url: &'a str,
    pub brave_api_key: &'a str,
}

pub type McpContext<'a> = ToolContext<'a>;

type ToolFuture<'a> = Pin<Box<dyn Future<Output = Value> + Send + 'a>>;

pub trait ToolExecutor: Send + Sync {
    fn definition(&self) -> &ToolDefinition;
    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn ToolExecutor>>,
    order: Vec<String>,
}

impl ToolRegistry {
    pub fn new(has_web_search: bool) -> Self {
        let mut registry = Self {
            tools: HashMap::new(),
            order: Vec::new(),
        };
        registry.register(KbSearchTool::new());
        registry.register(KbReadTool::new());
        registry.register(KbCreateTool::new());
        registry.register(KbUpdateTool::new());
        registry.register(KbListTool::new());
        registry.register(KbHistoryTool::new());
        registry.register(KbDiffTool::new());
        registry.register(WebSearchTool::new(has_web_search));
        registry
    }

    pub fn tool_definitions_for_llm(&self) -> Vec<LlmToolDefinition> {
        self.order
            .iter()
            .filter_map(|name| self.tools.get(name))
            .map(|tool| {
                let definition = tool.definition();
                LlmToolDefinition {
                    r#type: "function".to_string(),
                    function: LlmFunctionDefinition {
                        name: definition.name.clone(),
                        description: definition.description.clone(),
                        parameters: definition.input_schema.clone(),
                    },
                }
            })
            .collect()
    }

    pub fn prompt_tool_lines(&self) -> Vec<String> {
        self.order
            .iter()
            .filter_map(|name| self.tools.get(name))
            .map(|tool| {
                let definition = tool.definition();
                format!("- {}: {}", definition.name, definition.description)
            })
            .collect()
    }

    pub async fn execute(&self, name: &str, args: Value, ctx: &ToolContext<'_>) -> Value {
        let Some(tool) = self.tools.get(name) else {
            let started = Instant::now();
            return error_envelope(
                name,
                "mcp.unknown_tool",
                None,
                json!({}),
                "unknown_tool",
                format!("Unknown MCP tool: {name}"),
                false,
                started,
                uuid::Uuid::new_v4().to_string(),
            );
        };

        let result = tool.execute(args, ctx).await;
        enforce_registry_write_verification(tool.definition(), result)
    }

    fn register<T>(&mut self, executor: T)
    where
        T: ToolExecutor + 'static,
    {
        let name = executor.definition().name.clone();
        self.order.push(name.clone());
        self.tools.insert(name, Box::new(executor));
    }
}

impl ToolPort for ToolRegistry {
    fn tool_definitions_for_llm(&self) -> Vec<LlmToolDefinition> {
        self.tool_definitions_for_llm()
    }

    fn prompt_tool_lines(&self) -> Vec<String> {
        self.prompt_tool_lines()
    }

    fn execute<'a>(
        &'a self,
        name: &'a str,
        args: Value,
        ctx: &'a ToolExecutionContext<'a>,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let port_ctx = ToolContext {
                vault_path: ctx.vault_path,
                db_path: ctx.db_path,
                embedding_key: ctx.embedding_key,
                embedding_model_id: ctx.embedding_model_id,
                tavily_api_key: ctx.tavily_api_key,
                search_provider: ctx.search_provider,
                searxng_base_url: ctx.searxng_base_url,
                brave_api_key: ctx.brave_api_key,
            };
            ToolRegistry::execute(self, name, args, &port_ctx).await
        })
    }
}

fn enforce_registry_write_verification(definition: &ToolDefinition, result: Value) -> Value {
    if definition.permission != Permission::Write {
        return result;
    }

    // If the result already indicates failure, pass through without additional verification
    if result.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return result;
    }

    let readback_ok = result
        .get("proof")
        .and_then(|v| v.get("readback_ok"))
        .and_then(|v| v.as_bool());

    // Require explicit readback_ok == true for write operations
    if readback_ok == Some(true) {
        return result;
    }

    let mut payload = match result {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    let path = payload
        .get("target")
        .and_then(|v| v.get("resolved_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    payload.insert("ok".to_string(), json!(false));
    payload.insert(
        "error".to_string(),
        json!({
            "code": "verify_mismatch",
            "message": format!("Post-write verification mismatch for {path}"),
            "retriable": false
        }),
    );

    Value::Object(payload)
}

struct KbSearchTool {
    definition: ToolDefinition,
}

impl KbSearchTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_search".to_string(),
                description: "Use this when you need semantic retrieval from the vault and do not know the exact note path. Do not use when you already have a concrete path (use kb_read). Errors: invalid_arguments (missing query), search_failed (retrieval/index issue, retriable). Edge cases: if results are empty or weak, retry with a narrower query or use kb_list to discover file names."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" },
                        "limit": { "type": "integer", "description": "Max results (default 10)" }
                    },
                    "required": ["query"]
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for KbSearchTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_search(ctx, &args, &trace_id, started).await
        })
    }
}

struct KbReadTool {
    definition: ToolDefinition,
}

impl KbReadTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_read".to_string(),
                description: "Use this when you know the exact note path from kb_list, kb_search, or a [[wikilink]]. Do not use for broad discovery across many notes (use kb_search/kb_list). Errors: invalid_arguments (missing path), not_found (path absent), verify_failed (readback failed, retriable). Edge cases: input path is normalized inside the vault root."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative path to .md" }
                    },
                    "required": ["path"]
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for KbReadTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_read(ctx, &args, &trace_id, started)
        })
    }
}

struct KbCreateTool {
    definition: ToolDefinition,
}

impl KbCreateTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_create".to_string(),
                description: "Use this to create a new note at a path that must not exist yet. Do not use for editing an existing note (use kb_update). Before creating, quickly check for similar notes via kb_search or kb_list when overlap is likely. Errors: invalid_arguments, file_exists (non-retriable; kb_read then kb_update), write_failed/verify_failed (retriable), verify_mismatch (non-retriable). Edge cases: path normalization preserves explicit roots like zettel/ and para/. Required arguments: path and content."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Requested relative path for a new note" },
                        "content": { "type": "string", "description": "Full markdown content" }
                    },
                    "required": ["path", "content"]
                }),
                permission: Permission::Write,
            },
        }
    }
}

impl ToolExecutor for KbCreateTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_create(ctx, &args, &trace_id, started)
        })
    }
}

struct KbUpdateTool {
    definition: ToolDefinition,
}

impl KbUpdateTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_update".to_string(),
                description: "Use this to replace full content of an existing note when the path should already exist. Do not use for first-time writes (use kb_create). After updating, sanity-check that the edited note still matches nearby linked context. Errors: not_found (switch to kb_create), invalid_arguments, write_failed/verify_failed (retriable), verify_mismatch (non-retriable; kb_read and retry once). Edge case: returns noop=true and write_action=noop when content is unchanged. Required arguments: path and content."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative path to existing note" },
                        "content": { "type": "string", "description": "Full markdown content" }
                    },
                    "required": ["path", "content"]
                }),
                permission: Permission::Write,
            },
        }
    }
}

impl ToolExecutor for KbUpdateTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_update(ctx, &args, &trace_id, started)
        })
    }
}

struct KbListTool {
    definition: ToolDefinition,
}

impl KbListTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_list".to_string(),
                description: "Use this to inspect vault structure, discover candidate paths, or recover when semantic retrieval is weak. Do not use for semantic Q&A over note content (use kb_search). Errors: list_failed (retriable). Edge cases: folder is optional; root listing is returned when omitted."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "folder": { "type": "string", "description": "Optional subfolder path" }
                    }
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for KbListTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_list(ctx, &args, &trace_id, started)
        })
    }
}

struct KbHistoryTool {
    definition: ToolDefinition,
}

impl KbHistoryTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_history".to_string(),
                description: "Use this to inspect the change history of the vault or a specific note. Returns a list of commits with metadata (id, message, timestamp, files_changed). Errors: history_failed (retriable). Edge cases: if no git history exists, returns empty array."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Optional file path to filter history for a specific note" },
                        "limit": { "type": "integer", "description": "Max commits to return (default 20)" }
                    }
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for KbHistoryTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_history(ctx, &args, &trace_id, started)
        })
    }
}

struct KbDiffTool {
    definition: ToolDefinition,
}

impl KbDiffTool {
    fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "kb_diff".to_string(),
                description: "Use this to see the unified diff (patch) of a specific commit. Returns commit metadata plus a patch string. Use kb_history first to discover commit IDs. Errors: invalid_arguments (missing commit_id), diff_failed (retriable)."
                    .to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "commit_id": { "type": "string", "description": "Git commit SHA to inspect" }
                    },
                    "required": ["commit_id"]
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for KbDiffTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_kb_diff(ctx, &args, &trace_id, started)
        })
    }
}

struct WebSearchTool {
    definition: ToolDefinition,
}

impl WebSearchTool {
    fn new(has_web_search: bool) -> Self {
        let description = if has_web_search {
            "Use only for fresh external facts when vault evidence is insufficient or stale. Do not use when the vault already contains enough evidence. Errors: invalid_arguments, request_failed/parse_failed (retriable). Edge cases: external results can be noisy; prefer short quotes plus URLs."
        } else {
            "Use only for fresh external facts when vault evidence is insufficient or stale. Unavailable until a web search provider is configured in Settings (not_configured). Do not use when vault context is enough. Edge cases: if unavailable, continue with vault-only reasoning."
        };

        Self {
            definition: ToolDefinition {
                name: "web_search".to_string(),
                description: description.to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query" }
                    },
                    "required": ["query"]
                }),
                permission: Permission::Read,
            },
        }
    }
}

impl ToolExecutor for WebSearchTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    fn execute<'a>(&'a self, args: Value, ctx: &'a ToolContext<'a>) -> ToolFuture<'a> {
        Box::pin(async move {
            let started = Instant::now();
            let trace_id = uuid::Uuid::new_v4().to_string();
            execute_web_search(ctx, &args, &trace_id, started).await
        })
    }
}

#[allow(dead_code)]
pub fn tool_definitions(has_web_search: bool) -> Vec<LlmToolDefinition> {
    ToolRegistry::new(has_web_search).tool_definitions_for_llm()
}

#[allow(dead_code)]
pub async fn execute_tool(ctx: &ToolContext<'_>, tool_name: &str, args: &Value) -> Value {
    let registry = ToolRegistry::new(!ctx.tavily_api_key.is_empty());
    registry.execute(tool_name, args.clone(), ctx).await
}

fn infer_ecosystem(path: &str) -> &'static str {
    let normalized = path.trim_start_matches('/').to_ascii_lowercase();
    if normalized.starts_with("para/") {
        "para"
    } else if normalized.starts_with("archive/")
        || normalized.starts_with("templates/")
        || normalized.starts_with("other/")
    {
        "other"
    } else {
        "zettel"
    }
}

fn normalize_path_arg(args: &Value, key: &str) -> Result<String, String> {
    let raw = args
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Missing {key}"))?;
    crate::adapters::vault::normalize_note_path(raw)
}

fn target_payload(requested_path: &str, resolved_path: &str) -> Value {
    json!({
        "requested_path": requested_path,
        "resolved_path": resolved_path,
        "ecosystem": infer_ecosystem(resolved_path),
    })
}

fn multiset_from_lines(content: &str) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let key = line.to_string();
        let count = map.entry(key).or_insert(0usize);
        *count += 1;
    }
    map
}

fn diff_stats(before: &str, after: &str) -> Value {
    let before_count = before.lines().count();
    let after_count = after.lines().count();

    let mut before_map = multiset_from_lines(before);
    let mut after_map = multiset_from_lines(after);

    let mut added_lines = 0usize;
    let mut removed_lines = 0usize;

    let keys: Vec<String> = before_map
        .keys()
        .chain(after_map.keys())
        .cloned()
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    for key in keys {
        let before_n = before_map.remove(&key).unwrap_or(0);
        let after_n = after_map.remove(&key).unwrap_or(0);
        if after_n > before_n {
            added_lines += after_n - before_n;
        } else if before_n > after_n {
            removed_lines += before_n - after_n;
        }
    }

    json!({
        "before_lines": before_count,
        "after_lines": after_count,
        "added_lines": added_lines,
        "removed_lines": removed_lines,
        "changed": before != after,
    })
}

#[cfg(test)]
static CORRUPT_AFTER_WRITE_ONCE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn trigger_test_corruption_once() {
    CORRUPT_AFTER_WRITE_ONCE.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn maybe_corrupt_after_write(vault_path: &Path, relative_path: &str) {
    #[cfg(test)]
    if CORRUPT_AFTER_WRITE_ONCE.swap(false, std::sync::atomic::Ordering::SeqCst) {
        let _ =
            crate::adapters::vault::write_note(vault_path, relative_path, "__corrupted_by_test__");
    }

    #[cfg(not(test))]
    let _ = (vault_path, relative_path);
}

#[allow(clippy::too_many_arguments)]
fn envelope(
    tool: &str,
    action: &str,
    ok: bool,
    target: Option<Value>,
    result: Value,
    proof: Value,
    error: Option<Value>,
    started: Instant,
    trace_id: String,
) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".to_string(), json!(ok));
    payload.insert("tool".to_string(), json!(tool));
    payload.insert("action".to_string(), json!(action));
    payload.insert("result".to_string(), result);
    payload.insert("proof".to_string(), proof);
    payload.insert("trace_id".to_string(), json!(trace_id));
    payload.insert("ts".to_string(), json!(chrono::Utc::now().to_rfc3339()));
    payload.insert(
        "duration_ms".to_string(),
        json!(started.elapsed().as_millis() as u64),
    );

    if let Some(target_value) = target {
        payload.insert("target".to_string(), target_value);
    }

    if let Some(error_value) = error {
        payload.insert("error".to_string(), error_value);
    }

    Value::Object(payload)
}

#[allow(clippy::too_many_arguments)]
fn error_envelope(
    tool: &str,
    action: &str,
    target: Option<Value>,
    proof: Value,
    code: &str,
    message: impl Into<String>,
    retriable: bool,
    started: Instant,
    trace_id: String,
) -> Value {
    envelope(
        tool,
        action,
        false,
        target,
        json!({
            "summary": "Tool execution failed"
        }),
        proof,
        Some(json!({
            "code": code,
            "message": message.into(),
            "retriable": retriable,
        })),
        started,
        trace_id,
    )
}

fn build_write_result(summary: String, write_action: &str, noop: bool) -> Value {
    let mut result = Map::new();
    result.insert("summary".to_string(), json!(summary));
    result.insert("write_action".to_string(), json!(write_action));
    result.insert("noop".to_string(), json!(noop));
    Value::Object(result)
}

fn execute_kb_read(ctx: &McpContext<'_>, args: &Value, trace_id: &str, started: Instant) -> Value {
    let requested_path = match normalize_path_arg(args, "path") {
        Ok(path) => path,
        Err(error) => {
            return error_envelope(
                "kb_read",
                "kb.read",
                None,
                json!({}),
                "invalid_arguments",
                error,
                false,
                started,
                trace_id.to_string(),
            )
        }
    };
    let resolved_path = requested_path.clone();

    let content = match crate::adapters::vault::read_note(ctx.vault_path, &resolved_path) {
        Ok(content) => content,
        Err(error) => {
            return error_envelope(
                "kb_read",
                "kb.read",
                Some(target_payload(&requested_path, &resolved_path)),
                json!({}),
                "not_found",
                error.to_string(),
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    let verification =
        match crate::adapters::vault::read_note_verification(ctx.vault_path, &resolved_path) {
            Ok(verification) => verification,
            Err(error) => {
                return error_envelope(
                    "kb_read",
                    "kb.read",
                    Some(target_payload(&requested_path, &resolved_path)),
                    json!({}),
                    "verify_failed",
                    error.to_string(),
                    true,
                    started,
                    trace_id.to_string(),
                )
            }
        };

    envelope(
        "kb_read",
        "kb.read",
        true,
        Some(target_payload(&requested_path, &resolved_path)),
        json!({
            "summary": format!("Read note {resolved_path}"),
            "content": content,
        }),
        json!({
            "exists": verification.exists,
            "bytes": verification.bytes,
            "hash_after": verification.hash,
            "readback_ok": true,
        }),
        None,
        started,
        trace_id.to_string(),
    )
}

fn execute_kb_create(
    ctx: &McpContext<'_>,
    args: &Value,
    trace_id: &str,
    started: Instant,
) -> Value {
    let requested_path = match normalize_path_arg(args, "path") {
        Ok(path) => path,
        Err(error) => {
            return error_envelope(
                "kb_create",
                "kb.create",
                None,
                json!({}),
                "invalid_arguments",
                error,
                false,
                started,
                trace_id.to_string(),
            )
        }
    };
    let resolved_path = requested_path.clone();
    let target = target_payload(&requested_path, &resolved_path);

    let content = match args.get("content").and_then(|value| value.as_str()) {
        Some(content) => content,
        None => {
            return error_envelope(
                "kb_create",
                "kb.create",
                Some(target),
                json!({}),
                "invalid_arguments",
                "Missing content",
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    let before =
        match crate::adapters::vault::read_note_verification(ctx.vault_path, &resolved_path) {
            Ok(value) => value,
            Err(error) => {
                return error_envelope(
                    "kb_create",
                    "kb.create",
                    Some(target),
                    json!({}),
                    "verify_failed",
                    error.to_string(),
                    true,
                    started,
                    trace_id.to_string(),
                )
            }
        };

    if before.exists {
        return error_envelope(
            "kb_create",
            "kb.create",
            Some(target),
            json!({
                "exists": true,
                "bytes": before.bytes,
                "hash_after": before.hash,
            }),
            "file_exists",
            format!(
                "File {resolved_path} already exists ({} bytes). Use kb_read to see its content before deciding to update.",
                before.bytes
            ),
            false,
            started,
            trace_id.to_string(),
        );
    }

    if let Err(error) = crate::adapters::vault::write_note(ctx.vault_path, &resolved_path, content)
    {
        return error_envelope(
            "kb_create",
            "kb.create",
            Some(target),
            json!({
                "exists": false,
                "bytes": 0,
            }),
            "write_failed",
            error.to_string(),
            true,
            started,
            trace_id.to_string(),
        );
    }

    maybe_corrupt_after_write(ctx.vault_path, &resolved_path);

    let target_file = [ctx.vault_path.join(&resolved_path)];
    let _ = crate::adapters::git::auto_commit_files(
        ctx.vault_path,
        &target_file,
        &format!("meld: created {resolved_path}"),
    );

    let after = match crate::adapters::vault::read_note_verification(ctx.vault_path, &resolved_path)
    {
        Ok(value) => value,
        Err(error) => {
            return error_envelope(
                "kb_create",
                "kb.create",
                Some(target),
                json!({
                    "exists": false,
                    "bytes": 0,
                }),
                "verify_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let after_content =
        crate::adapters::vault::read_note(ctx.vault_path, &resolved_path).unwrap_or_default();
    let readback_ok = after.exists && after_content == content;
    let proof = json!({
        "exists": after.exists,
        "bytes": after.bytes,
        "hash_before": Value::Null,
        "hash_after": after.hash,
        "readback_ok": readback_ok,
        "diff_stats": diff_stats("", &after_content),
    });

    if !readback_ok {
        return error_envelope(
            "kb_create",
            "kb.create",
            Some(target),
            proof,
            "verify_mismatch",
            format!("Post-write verification mismatch for {resolved_path}"),
            false,
            started,
            trace_id.to_string(),
        );
    }

    envelope(
        "kb_create",
        "kb.create",
        true,
        Some(target),
        build_write_result(format!("Created note {resolved_path}"), "create", false),
        proof,
        None,
        started,
        trace_id.to_string(),
    )
}

fn execute_kb_update(
    ctx: &McpContext<'_>,
    args: &Value,
    trace_id: &str,
    started: Instant,
) -> Value {
    let requested_path = match normalize_path_arg(args, "path") {
        Ok(path) => path,
        Err(error) => {
            return error_envelope(
                "kb_update",
                "kb.update",
                None,
                json!({}),
                "invalid_arguments",
                error,
                false,
                started,
                trace_id.to_string(),
            )
        }
    };
    let resolved_path = requested_path.clone();
    let target = target_payload(&requested_path, &resolved_path);

    let content = match args.get("content").and_then(|value| value.as_str()) {
        Some(content) => content,
        None => {
            return error_envelope(
                "kb_update",
                "kb.update",
                Some(target),
                json!({}),
                "invalid_arguments",
                "Missing content",
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    let before =
        match crate::adapters::vault::read_note_verification(ctx.vault_path, &resolved_path) {
            Ok(value) => value,
            Err(error) => {
                return error_envelope(
                    "kb_update",
                    "kb.update",
                    Some(target),
                    json!({}),
                    "verify_failed",
                    error.to_string(),
                    true,
                    started,
                    trace_id.to_string(),
                )
            }
        };

    if !before.exists {
        return error_envelope(
            "kb_update",
            "kb.update",
            Some(target),
            json!({
                "exists": false,
            }),
            "not_found",
            format!("Note does not exist: {resolved_path}. Use kb_create for new notes."),
            false,
            started,
            trace_id.to_string(),
        );
    }

    let before_content =
        crate::adapters::vault::read_note(ctx.vault_path, &resolved_path).unwrap_or_default();
    let desired_hash = crate::adapters::vault::file_hash(content);
    if before.hash == desired_hash {
        return envelope(
            "kb_update",
            "kb.update",
            true,
            Some(target),
            build_write_result(
                format!("No changes needed for {resolved_path}"),
                "noop",
                true,
            ),
            json!({
                "exists": true,
                "bytes": before.bytes,
                "hash_before": before.hash,
                "hash_after": before.hash,
                "readback_ok": true,
                "diff_stats": diff_stats(&before_content, &before_content),
            }),
            None,
            started,
            trace_id.to_string(),
        );
    }

    let target_file = [ctx.vault_path.join(&resolved_path)];
    let _ = crate::adapters::git::auto_commit_files(
        ctx.vault_path,
        &target_file,
        &format!("meld: pre-edit snapshot of {resolved_path}"),
    );

    if let Err(error) = crate::adapters::vault::write_note(ctx.vault_path, &resolved_path, content)
    {
        return error_envelope(
            "kb_update",
            "kb.update",
            Some(target),
            json!({
                "exists": true,
                "bytes": before.bytes,
                "hash_before": before.hash,
            }),
            "write_failed",
            error.to_string(),
            true,
            started,
            trace_id.to_string(),
        );
    }

    maybe_corrupt_after_write(ctx.vault_path, &resolved_path);

    let _ = crate::adapters::git::auto_commit_files(
        ctx.vault_path,
        &target_file,
        &format!("meld: edited {resolved_path}"),
    );

    let after = match crate::adapters::vault::read_note_verification(ctx.vault_path, &resolved_path)
    {
        Ok(value) => value,
        Err(error) => {
            return error_envelope(
                "kb_update",
                "kb.update",
                Some(target),
                json!({
                    "exists": true,
                    "bytes": before.bytes,
                    "hash_before": before.hash,
                }),
                "verify_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let after_content =
        crate::adapters::vault::read_note(ctx.vault_path, &resolved_path).unwrap_or_default();
    let readback_ok = after.exists && after_content == content;
    let proof = json!({
        "exists": after.exists,
        "bytes": after.bytes,
        "hash_before": before.hash,
        "hash_after": after.hash,
        "readback_ok": readback_ok,
        "diff_stats": diff_stats(&before_content, &after_content),
    });

    if !readback_ok {
        return error_envelope(
            "kb_update",
            "kb.update",
            Some(target),
            proof,
            "verify_mismatch",
            format!("Post-write verification mismatch for {resolved_path}"),
            false,
            started,
            trace_id.to_string(),
        );
    }

    envelope(
        "kb_update",
        "kb.update",
        true,
        Some(target),
        build_write_result(format!("Updated note {resolved_path}"), "edit", false),
        proof,
        None,
        started,
        trace_id.to_string(),
    )
}

fn execute_kb_list(ctx: &McpContext<'_>, args: &Value, trace_id: &str, started: Instant) -> Value {
    let folder = args.get("folder").and_then(|value| value.as_str());
    let notes = match crate::adapters::vault::list_notes(ctx.vault_path, folder) {
        Ok(notes) => notes,
        Err(error) => {
            return error_envelope(
                "kb_list",
                "kb.list",
                None,
                json!({}),
                "list_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    envelope(
        "kb_list",
        "kb.list",
        true,
        None,
        json!({
            "summary": format!("Listed {} notes", notes.len()),
            "count": notes.len(),
            "folder": folder,
            "notes": notes,
        }),
        json!({}),
        None,
        started,
        trace_id.to_string(),
    )
}

fn execute_kb_history(
    ctx: &McpContext<'_>,
    args: &Value,
    trace_id: &str,
    started: Instant,
) -> Value {
    let path_filter = args.get("path").and_then(|v| v.as_str());
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .or(Some(20));

    let commits = match crate::adapters::git::get_history(ctx.vault_path, path_filter, limit) {
        Ok(entries) => entries,
        Err(error) => {
            return error_envelope(
                "kb_history",
                "kb.history",
                None,
                json!({}),
                "history_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    envelope(
        "kb_history",
        "kb.history",
        true,
        None,
        json!({
            "summary": format!("Found {} commits", commits.len()),
            "count": commits.len(),
            "commits": commits,
        }),
        json!({}),
        None,
        started,
        trace_id.to_string(),
    )
}

fn execute_kb_diff(ctx: &McpContext<'_>, args: &Value, trace_id: &str, started: Instant) -> Value {
    let commit_id = match args.get("commit_id").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => {
            return error_envelope(
                "kb_diff",
                "kb.diff",
                None,
                json!({}),
                "invalid_arguments",
                "Missing commit_id",
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    let diff = match crate::adapters::git::get_commit_diff(ctx.vault_path, commit_id) {
        Ok(diff) => diff,
        Err(error) => {
            return error_envelope(
                "kb_diff",
                "kb.diff",
                None,
                json!({}),
                "diff_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    envelope(
        "kb_diff",
        "kb.diff",
        true,
        None,
        json!({
            "summary": format!("Diff for commit {}", &diff.id[..8.min(diff.id.len())]),
            "commit_id": diff.id,
            "message": diff.message,
            "timestamp": diff.timestamp,
            "files_changed": diff.files_changed,
            "patch": diff.patch,
        }),
        json!({}),
        None,
        started,
        trace_id.to_string(),
    )
}

async fn execute_kb_search(
    ctx: &McpContext<'_>,
    args: &Value,
    trace_id: &str,
    started: Instant,
) -> Value {
    let query = match args.get("query").and_then(|value| value.as_str()) {
        Some(query) => query,
        None => {
            return error_envelope(
                "kb_search",
                "kb.search",
                None,
                json!({}),
                "invalid_arguments",
                "Missing query",
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    let limit = args
        .get("limit")
        .and_then(|value| value.as_u64())
        .unwrap_or(10) as usize;

    let db_path_owned = ctx.db_path.to_path_buf();
    let chunk_count = tokio::task::spawn_blocking(move || {
        crate::adapters::vectordb::VectorDb::open(&db_path_owned)
            .and_then(|db| db.index_stats().map(|(_, chunks)| chunks as usize))
            .unwrap_or(0)
    })
    .await
    .unwrap_or(0);

    let results = match crate::adapters::rag::query(
        ctx.db_path,
        ctx.embedding_key,
        ctx.embedding_model_id,
        query,
        limit,
        chunk_count,
    )
    .await
    {
        Ok(results) => results,
        Err(error) => {
            return error_envelope(
                "kb_search",
                "kb.search",
                None,
                json!({}),
                "search_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let sources: Vec<String> = results
        .chunks
        .iter()
        .map(|chunk| chunk.file_path.clone())
        .collect();

    envelope(
        "kb_search",
        "kb.search",
        true,
        None,
        json!({
            "summary": format!(
                "Found {} chunks for query '{}' (hyde={}, rerank={})",
                results.chunks.len(),
                query,
                results.hyde_used,
                results.rerank_applied
            ),
            "query": query,
            "count": results.chunks.len(),
            "chunks": results.chunks,
            "sources": sources,
            "retrieval": {
                "hyde_used": results.hyde_used,
                "rerank_applied": results.rerank_applied,
                "rerank_reason": results.rerank_reason,
                "candidate_count": results.candidate_count,
            },
        }),
        json!({}),
        None,
        started,
        trace_id.to_string(),
    )
}

async fn execute_web_search(
    ctx: &McpContext<'_>,
    args: &Value,
    trace_id: &str,
    started: Instant,
) -> Value {
    let query = match args.get("query").and_then(|value| value.as_str()) {
        Some(query) => query,
        None => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "invalid_arguments",
                "Missing query",
                false,
                started,
                trace_id.to_string(),
            )
        }
    };

    match ctx.search_provider {
        "searxng" => execute_web_search_searxng(ctx, query, trace_id, started).await,
        "brave" => execute_web_search_brave(ctx, query, trace_id, started).await,
        _ => execute_web_search_tavily(ctx, query, trace_id, started).await,
    }
}

async fn execute_web_search_tavily(
    ctx: &McpContext<'_>,
    query: &str,
    trace_id: &str,
    started: Instant,
) -> Value {
    if ctx.tavily_api_key.is_empty() {
        return error_envelope(
            "web_search",
            "web.search",
            None,
            json!({}),
            "not_configured",
            "Web search not configured. Add a Tavily API key in Settings.",
            false,
            started,
            trace_id.to_string(),
        );
    }

    let client = reqwest::Client::new();
    let response = match client
        .post("https://api.tavily.com/search")
        .json(&json!({
            "api_key": ctx.tavily_api_key,
            "query": query,
            "max_results": 5,
            "include_answer": true
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "request_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return error_envelope(
            "web_search",
            "web.search",
            None,
            json!({}),
            "request_failed",
            format!("Tavily API error ({status}): {body}"),
            true,
            started,
            trace_id.to_string(),
        );
    }

    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "parse_failed",
                error.to_string(),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let mut results = Vec::new();
    if let Some(answer) = data.get("answer").and_then(|value| value.as_str()) {
        results.push(json!({"type": "answer", "content": answer}));
    }
    if let Some(items) = data.get("results").and_then(|value| value.as_array()) {
        for item in items.iter().take(5) {
            results.push(json!({
                "type": "result",
                "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "url": item.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                "content": item.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }

    web_search_success_envelope(query, results, trace_id, started)
}

async fn execute_web_search_searxng(
    ctx: &McpContext<'_>,
    query: &str,
    trace_id: &str,
    started: Instant,
) -> Value {
    let base_url = ctx.searxng_base_url.trim_end_matches('/');
    let encoded_query = urlencoding::encode(query);
    let url = format!("{base_url}/search?q={encoded_query}&format=json");

    let client = reqwest::Client::builder()
        .user_agent("Meld/0.3.0")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let response: reqwest::Response = match client.get(&url).send().await
    {
        Ok(response) => response,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "request_failed",
                format!("SearXNG request failed: {error}"),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return error_envelope(
            "web_search",
            "web.search",
            None,
            json!({}),
            "request_failed",
            format!("SearXNG error ({status}): {body}"),
            true,
            started,
            trace_id.to_string(),
        );
    }

    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "parse_failed",
                format!("SearXNG parse error: {error}"),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let mut results = Vec::new();
    if let Some(items) = data.get("results").and_then(|v| v.as_array()) {
        for item in items.iter().take(5) {
            results.push(json!({
                "type": "result",
                "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "url": item.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                "content": item.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }

    web_search_success_envelope(query, results, trace_id, started)
}

async fn execute_web_search_brave(
    ctx: &McpContext<'_>,
    query: &str,
    trace_id: &str,
    started: Instant,
) -> Value {
    if ctx.brave_api_key.is_empty() {
        return error_envelope(
            "web_search",
            "web.search",
            None,
            json!({}),
            "not_configured",
            "Brave Search not configured. Add a Brave API key in Settings.",
            false,
            started,
            trace_id.to_string(),
        );
    }

    let encoded_query = urlencoding::encode(query);
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={encoded_query}&count=5"
    );

    let client = reqwest::Client::new();
    let response: reqwest::Response = match client
        .get(&url)
        .header("X-Subscription-Token", ctx.brave_api_key)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "request_failed",
                format!("Brave Search request failed: {error}"),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return error_envelope(
            "web_search",
            "web.search",
            None,
            json!({}),
            "request_failed",
            format!("Brave Search error ({status}): {body}"),
            true,
            started,
            trace_id.to_string(),
        );
    }

    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(error) => {
            return error_envelope(
                "web_search",
                "web.search",
                None,
                json!({}),
                "parse_failed",
                format!("Brave Search parse error: {error}"),
                true,
                started,
                trace_id.to_string(),
            )
        }
    };

    let mut results = Vec::new();
    if let Some(web) = data
        .get("web")
        .and_then(|v| v.get("results"))
        .and_then(|v| v.as_array())
    {
        for item in web.iter().take(5) {
            results.push(json!({
                "type": "result",
                "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "url": item.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                "content": item.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            }));
        }
    }

    web_search_success_envelope(query, results, trace_id, started)
}

fn web_search_success_envelope(
    query: &str,
    results: Vec<Value>,
    trace_id: &str,
    started: Instant,
) -> Value {
    envelope(
        "web_search",
        "web.search",
        true,
        None,
        json!({
            "summary": format!("Web search returned {} items for query '{}'", results.len(), query),
            "query": query,
            "results": results,
        }),
        json!({}),
        None,
        started,
        trace_id.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::{execute_tool, trigger_test_corruption_once, McpContext};
    use serde_json::json;

    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .expect("lock MCP test guard")
    }

    fn temp_vault() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("meld-mcp-test-{}", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn create_on_existing_file_returns_file_exists() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "maxim.md", "old content").expect("seed note");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_create",
            &json!({
                "path": "maxim.md",
                "content": "new content"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("file_exists")
        );
        assert_eq!(
            result.pointer("/proof/exists").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("maxim.md")
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn update_on_missing_file_returns_not_found() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_update",
            &json!({
                "path": "missing.md",
                "content": "x"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("not_found")
        );
        assert_eq!(
            result.pointer("/error/retriable").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("missing.md")
        );
        assert_eq!(
            result.pointer("/proof/exists").and_then(|v| v.as_bool()),
            Some(false)
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn create_new_file_succeeds() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_create",
            &json!({
                "path": "new-note.md",
                "content": "# New Note\n\nhello"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result
                .pointer("/result/write_action")
                .and_then(|v| v.as_str()),
            Some("create")
        );
        assert_eq!(
            result
                .pointer("/proof/readback_ok")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("new-note.md")
        );

        let content =
            crate::adapters::vault::read_note(&vault, "new-note.md").expect("read created note");
        assert_eq!(content, "# New Note\n\nhello");

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn update_existing_file_succeeds() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "existing.md", "old content")
            .expect("seed note");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_update",
            &json!({
                "path": "existing.md",
                "content": "updated content\nwith second line"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result
                .pointer("/result/write_action")
                .and_then(|v| v.as_str()),
            Some("edit")
        );
        assert_eq!(
            result
                .pointer("/proof/readback_ok")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/proof/diff_stats/changed")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result.pointer("/result/noop").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("existing.md")
        );
        let hash_before = result
            .pointer("/proof/hash_before")
            .and_then(|v| v.as_str())
            .expect("hash_before");
        let hash_after = result
            .pointer("/proof/hash_after")
            .and_then(|v| v.as_str())
            .expect("hash_after");
        assert_ne!(hash_before, hash_after);

        let content =
            crate::adapters::vault::read_note(&vault, "existing.md").expect("read updated note");
        assert_eq!(content, "updated content\nwith second line");

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn update_noop_on_same_content() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "same-note.md", "identical content")
            .expect("seed note");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_update",
            &json!({
                "path": "same-note.md",
                "content": "identical content"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result.pointer("/result/noop").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/result/write_action")
                .and_then(|v| v.as_str()),
            Some("noop")
        );
        assert_eq!(
            result
                .pointer("/proof/readback_ok")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/proof/diff_stats/changed")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("same-note.md")
        );
        let content =
            crate::adapters::vault::read_note(&vault, "same-note.md").expect("read noop note");
        assert_eq!(content, "identical content");

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn legacy_tool_name_is_rejected() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(&ctx, "search_notes", &json!({ "query": "rust" })).await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("unknown_tool")
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn update_reports_verify_mismatch_on_post_write_corruption() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "verification-note.md", "original")
            .expect("seed note");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        trigger_test_corruption_once();

        let result = execute_tool(
            &ctx,
            "kb_update",
            &json!({
                "path": "verification-note.md",
                "content": "expected content"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("verify_mismatch")
        );
        assert_eq!(
            result
                .pointer("/proof/readback_ok")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            result.pointer("/error/retriable").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            result.pointer("/proof/exists").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("verification-note.md")
        );
        let content = crate::adapters::vault::read_note(&vault, "verification-note.md")
            .expect("read corrupted note");
        assert_eq!(content, "__corrupted_by_test__");

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn create_with_explicit_zettel_prefix_does_not_double_prefix() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_create",
            &json!({
                "path": "zettel/maxim.md",
                "content": "hello"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("zettel/maxim.md")
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn create_with_para_prefix_is_respected() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_create",
            &json!({
                "path": "para/x.md",
                "content": "project note"
            }),
        )
        .await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result
                .pointer("/target/resolved_path")
                .and_then(|v| v.as_str()),
            Some("para/x.md")
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn kb_history_returns_commits() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "note.md", "v1").expect("write v1");
        crate::adapters::git::auto_commit(&vault, "commit v1").expect("commit v1");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(&ctx, "kb_history", &json!({})).await;

        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            result.get("tool").and_then(|v| v.as_str()),
            Some("kb_history")
        );
        let count = result
            .pointer("/result/count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        assert!(count >= 1);

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn kb_history_path_filter_works() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "a.md", "a1").expect("write a");
        crate::adapters::vault::write_note(&vault, "b.md", "b1").expect("write b");
        crate::adapters::git::auto_commit(&vault, "seed").expect("seed");

        crate::adapters::vault::write_note(&vault, "a.md", "a2").expect("write a2");
        crate::adapters::git::auto_commit_files(&vault, &[vault.join("a.md")], "edit a")
            .expect("commit a");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(&ctx, "kb_history", &json!({ "path": "a.md" })).await;
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));

        let commits = result
            .pointer("/result/commits")
            .and_then(|v| v.as_array())
            .expect("commits array");
        assert_eq!(commits.len(), 1); // edit a (seed has no parent → empty files_changed)

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn kb_diff_returns_patch() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "note.md", "line one\n").expect("write v1");
        crate::adapters::git::auto_commit(&vault, "v1").expect("commit v1");

        crate::adapters::vault::write_note(&vault, "note.md", "line one\nline two\n")
            .expect("write v2");
        crate::adapters::git::auto_commit(&vault, "v2").expect("commit v2");

        let history = crate::adapters::git::get_history(&vault, None, Some(1)).expect("history");
        let commit_id = &history.first().expect("latest").id;

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(&ctx, "kb_diff", &json!({ "commit_id": commit_id })).await;
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(result.get("tool").and_then(|v| v.as_str()), Some("kb_diff"));

        let patch = result
            .pointer("/result/patch")
            .and_then(|v| v.as_str())
            .expect("patch string");
        assert!(patch.contains("+line two"));

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn kb_diff_missing_commit_id_returns_error() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(&ctx, "kb_diff", &json!({})).await;
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("invalid_arguments")
        );

        let _ = std::fs::remove_dir_all(vault);
    }

    #[tokio::test]
    async fn kb_diff_invalid_commit_returns_error() {
        let _guard = test_guard();
        let vault = temp_vault();
        std::fs::create_dir_all(&vault).expect("create temp vault");
        let db_path = vault.join(".meld").join("index.db");

        crate::adapters::vault::write_note(&vault, "note.md", "init").expect("write");
        crate::adapters::git::auto_commit(&vault, "init").expect("commit");

        let ctx = McpContext {
            vault_path: &vault,
            db_path: &db_path,
            embedding_key: "",
            embedding_model_id: "openai:text-embedding-3-small",
            tavily_api_key: "",
            search_provider: "tavily",
            searxng_base_url: "http://localhost:8080",
            brave_api_key: "",
        };

        let result = execute_tool(
            &ctx,
            "kb_diff",
            &json!({ "commit_id": "0000000000000000000000000000000000000000" }),
        )
        .await;
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(
            result.pointer("/error/code").and_then(|v| v.as_str()),
            Some("diff_failed")
        );

        let _ = std::fs::remove_dir_all(vault);
    }
}
