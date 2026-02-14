pub async fn get_embedding(
    api_key: &str,
    model_id: &str,
    text: &str,
) -> Result<Vec<f32>, Box<dyn std::error::Error + Send + Sync>> {
    let registry = crate::adapters::providers::ProviderRegistry::default();
    let (provider, model) = registry
        .resolve_embedding(model_id)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

    let texts = vec![text.to_string()];
    let embeddings = provider
        .embed(crate::adapters::providers::EmbeddingRequest {
            api_key,
            model,
            texts: &texts,
        })
        .await?;

    embeddings
        .into_iter()
        .next()
        .ok_or_else(|| "No embedding returned".into())
}

#[allow(dead_code)]
pub fn embedding_dimensions(model_id: &str) -> usize {
    let registry = crate::adapters::providers::ProviderRegistry::default();
    registry
        .resolve_embedding(model_id)
        .map(|(provider, _)| provider.dimensions())
        .unwrap_or(1536)
}
