use crate::adapters::vectordb::{ChunkResult, VectorDb};
use std::path::Path;
use tokio::sync::mpsc;

pub mod eval;
mod rerank;

pub struct RagContext {
    pub chunks: Vec<ChunkResult>,
    pub context_text: String,
    pub hyde_used: bool,
    pub rerank_applied: bool,
    pub rerank_reason: String,
    pub candidate_count: usize,
}

fn should_use_hyde(query: &str) -> bool {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return false;
    }

    let word_count = trimmed.split_whitespace().count();
    if word_count <= 8 {
        return true;
    }

    let lowered = trimmed.to_ascii_lowercase();
    [
        "how ", "why ", "what ", "strategy", "approach", "improve", "optimize", "idea", "plan",
    ]
    .iter()
    .any(|marker| lowered.contains(marker))
}

fn blend_embeddings(primary: &[f32], secondary: &[f32]) -> Vec<f32> {
    if primary.len() != secondary.len() {
        return primary.to_vec();
    }

    primary
        .iter()
        .zip(secondary.iter())
        .map(|(a, b)| ((*a as f64 * 0.65) + (*b as f64 * 0.35)) as f32)
        .collect()
}

async fn generate_hyde_document(query: &str) -> Option<String> {
    let mut settings = crate::adapters::config::Settings::load_global();
    let provider = settings.chat_provider();
    let api_key = crate::adapters::oauth::resolve_provider_credential(&mut settings, &provider)
        .await
        .ok()?;
    let model_id = settings.chat_model_id();

    let messages = vec![
        crate::adapters::llm::ChatMessage {
            role: "system".to_string(),
            content: "Write a concise hypothetical markdown note that would answer the user's question. Return only the note text in plain markdown.".to_string(),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        },
        crate::adapters::llm::ChatMessage {
            role: "user".to_string(),
            content: query.to_string(),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            thought_signatures: None,
        },
    ];

    let (tx, mut rx) = mpsc::unbounded_channel();
    let provider_clone = provider.clone();
    let model_clone = model_id.clone();
    let api_key_clone = api_key.clone();
    let messages_clone = messages.clone();

    let llm_handle = tokio::spawn(async move {
        crate::adapters::llm::chat_stream(
            &api_key_clone,
            &provider_clone,
            &model_clone,
            &messages_clone,
            None,
            tx,
            None,
        )
        .await
    });

    let mut output = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            crate::adapters::llm::StreamEvent::Text(text) => output.push_str(&text),
            crate::adapters::llm::StreamEvent::Done => break,
            crate::adapters::llm::StreamEvent::Error(_) => return None,
            crate::adapters::llm::StreamEvent::ToolCall(_)
            | crate::adapters::llm::StreamEvent::Usage(_)
            | crate::adapters::llm::StreamEvent::ThoughtSignature(_)
            | crate::adapters::llm::StreamEvent::ThinkingSummary(_)
            | crate::adapters::llm::StreamEvent::Recovery(_) => {}
        }
    }

    match llm_handle.await {
        Ok(Ok(())) => {
            let trimmed = output.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

pub async fn query(
    db_path: &Path,
    api_key: &str,
    embedding_model_id: &str,
    query: &str,
    limit: usize,
    chunk_count: usize,
) -> Result<RagContext, Box<dyn std::error::Error + Send + Sync>> {
    let settings = crate::adapters::config::Settings::load_global();
    let rerank_enabled = settings.retrieval_rerank_enabled();
    let rerank_top_k = settings.retrieval_rerank_top_k().min(limit.max(1));
    let retrieval_limit = if rerank_enabled {
        (limit.max(rerank_top_k) * 3).min(50)
    } else {
        limit.max(1)
    };

    let query_embedding =
        crate::adapters::embeddings::get_embedding(api_key, embedding_model_id, query).await?;

    let mut hyde_used = false;
    let mut retrieval_embedding = query_embedding.clone();
    let skip_hyde = chunk_count < 100;
    if !skip_hyde && should_use_hyde(query) {
        let hyde_result =
            tokio::time::timeout(std::time::Duration::from_secs(8), generate_hyde_document(query))
                .await;
        if let Ok(Some(hyde_document)) = hyde_result {
            if let Ok(hyde_embedding) = crate::adapters::embeddings::get_embedding(
                api_key,
                embedding_model_id,
                &hyde_document,
            )
            .await
            {
                retrieval_embedding = blend_embeddings(&query_embedding, &hyde_embedding);
                hyde_used = true;
            }
        }
    }

    // Open DB in a blocking task to avoid Send issues with rusqlite
    let db_path = db_path.to_path_buf();
    let query_text = query.to_string();
    let chunks = tokio::task::spawn_blocking(move || {
        let db = VectorDb::open(&db_path)
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })?;
        db.search_hybrid(&retrieval_embedding, &query_text, retrieval_limit)
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })
    })
    .await??;

    let rerank_outcome = if rerank_enabled {
        rerank::rerank(query, chunks, rerank_top_k)
    } else {
        rerank::RerankOutcome {
            candidate_count: chunks.len(),
            chunks,
            applied: false,
            reason: "disabled_in_settings".to_string(),
        }
    };

    let mut chunks = rerank_outcome.chunks;
    chunks.truncate(limit.max(1));

    let context_text = chunks
        .iter()
        .map(|chunk| {
            let source = if let Some(heading) = &chunk.heading_path {
                format!("{}#{}", chunk.file_path, heading)
            } else {
                chunk.file_path.clone()
            };
            format!("[Source: {}]\n{}\n", source, chunk.content)
        })
        .collect::<Vec<_>>()
        .join("\n---\n\n");

    Ok(RagContext {
        chunks,
        context_text,
        hyde_used,
        rerank_applied: rerank_outcome.applied,
        rerank_reason: rerank_outcome.reason,
        candidate_count: rerank_outcome.candidate_count,
    })
}
