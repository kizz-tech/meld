use crate::adapters::vectordb::ChunkResult;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct RerankOutcome {
    pub chunks: Vec<ChunkResult>,
    pub applied: bool,
    pub reason: String,
    pub candidate_count: usize,
}

pub fn rerank(query: &str, candidates: Vec<ChunkResult>, top_k: usize) -> RerankOutcome {
    let candidate_count = candidates.len();
    if candidate_count == 0 {
        return RerankOutcome {
            chunks: Vec::new(),
            applied: false,
            reason: "no_candidates".to_string(),
            candidate_count,
        };
    }

    let tokens = tokenize(query);
    if tokens.is_empty() {
        return RerankOutcome {
            chunks: candidates.into_iter().take(top_k.max(1)).collect(),
            applied: false,
            reason: "query_has_no_usable_tokens".to_string(),
            candidate_count,
        };
    }

    let query_lc = query.trim().to_ascii_lowercase();
    let mut scored = candidates
        .into_iter()
        .map(|mut chunk| {
            let score = rerank_score(&query_lc, &tokens, &chunk);
            chunk.retrieval_score = Some(score);
            (chunk, score)
        })
        .collect::<Vec<_>>();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let chunks = scored
        .into_iter()
        .take(top_k.max(1))
        .map(|(chunk, _)| chunk)
        .collect::<Vec<_>>();

    RerankOutcome {
        chunks,
        applied: true,
        reason: "lexical_pairwise".to_string(),
        candidate_count,
    }
}

fn rerank_score(query_lc: &str, tokens: &[String], chunk: &ChunkResult) -> f64 {
    let content_lc = chunk.content.to_ascii_lowercase();
    let heading_lc = chunk
        .heading_path
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();

    let token_hits = tokens
        .iter()
        .filter(|token| content_lc.contains(token.as_str()))
        .count() as f64;
    let heading_hits = tokens
        .iter()
        .filter(|token| !heading_lc.is_empty() && heading_lc.contains(token.as_str()))
        .count() as f64;

    let coverage = token_hits / tokens.len() as f64;
    let heading_coverage = if heading_lc.is_empty() {
        0.0
    } else {
        heading_hits / tokens.len() as f64
    };

    let phrase_boost = if query_lc.len() >= 8 && content_lc.contains(query_lc) {
        0.2
    } else {
        0.0
    };

    let base_score = chunk
        .retrieval_score
        .unwrap_or_else(|| 1.0 / (1.0 + chunk.distance.max(0.0)));

    // Blend retrieval score with pairwise lexical relevance.
    (base_score * 0.5) + (coverage * 0.35) + (heading_coverage * 0.15) + phrase_boost
}

fn tokenize(input: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    input
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| token.len() >= 3)
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::rerank;
    use crate::adapters::vectordb::ChunkResult;

    #[test]
    fn rerank_boosts_exact_phrase_match() {
        let query = "project architecture";
        let candidates = vec![
            ChunkResult {
                chunk_id: 1,
                file_path: "a.md".to_string(),
                chunk_index: 0,
                heading_path: None,
                content: "This note is generic and unrelated.".to_string(),
                distance: 0.9,
                retrieval_score: Some(0.6),
            },
            ChunkResult {
                chunk_id: 2,
                file_path: "b.md".to_string(),
                chunk_index: 0,
                heading_path: Some("Project".to_string()),
                content: "Project architecture guidelines and implementation details.".to_string(),
                distance: 0.9,
                retrieval_score: Some(0.5),
            },
        ];

        let output = rerank(query, candidates, 2);
        assert!(output.applied);
        assert_eq!(output.chunks[0].file_path, "b.md");
        assert!(output.chunks[0].retrieval_score.unwrap_or_default() > 0.0);
    }
}
