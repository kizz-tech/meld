use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{mpsc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::adapters::config::Settings;
use crate::adapters::providers::split_model_id;

use super::shared::{resolve_provider_credential, IndexProgress};

#[derive(Debug)]
struct VaultWatcherHandle {
    vault_path: String,
    stop_tx: mpsc::Sender<()>,
    join_handle: JoinHandle<()>,
}

static VAULT_WATCHER: LazyLock<Mutex<Option<VaultWatcherHandle>>> =
    LazyLock::new(|| Mutex::new(None));
const EMBEDDING_MAX_ATTEMPTS: usize = 3;

fn default_embedding_model_id_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "google" => Some("google:gemini-embedding-001"),
        "openai" => Some("openai:text-embedding-3-small"),
        _ => None,
    }
}

fn resolve_embedding_model_id_for_reindex(
    current_provider: &str,
    current_model_id: &str,
    candidate_provider: &str,
) -> Option<String> {
    if candidate_provider.eq_ignore_ascii_case(current_provider) {
        if let Ok((provider, model)) = split_model_id(current_model_id) {
            let normalized_model = model.trim();
            if provider.eq_ignore_ascii_case(candidate_provider) && !normalized_model.is_empty() {
                return Some(format!(
                    "{}:{}",
                    candidate_provider.to_ascii_lowercase(),
                    normalized_model
                ));
            }
        }
    }

    default_embedding_model_id_for_provider(candidate_provider).map(str::to_string)
}

async fn embed_chunk_with_retry(
    api_key: &str,
    embedding_model_id: &str,
    content: &str,
) -> Result<Vec<f32>, String> {
    let mut attempt = 1usize;
    loop {
        match crate::adapters::embeddings::get_embedding(api_key, embedding_model_id, content).await
        {
            Ok(embedding) => return Ok(embedding),
            Err(error) => {
                if attempt >= EMBEDDING_MAX_ATTEMPTS {
                    return Err(error.to_string());
                }
                let backoff_ms = 200_u64.saturating_mul(1_u64 << (attempt - 1));
                log::warn!(
                    "Embedding request failed (attempt {attempt}/{EMBEDDING_MAX_ATTEMPTS}), retrying in {backoff_ms}ms: {}",
                    error
                );
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                attempt += 1;
            }
        }
    }
}

fn is_markdown_watch_path(vault_root: &Path, path: &Path) -> bool {
    let relative = match path.strip_prefix(vault_root) {
        Ok(value) => value,
        Err(_) => return false,
    };

    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        return false;
    }

    if normalized == ".meld"
        || normalized.starts_with(".meld/")
        || normalized == ".git"
        || normalized.starts_with(".git/")
        || normalized.contains("/.git/")
    {
        return false;
    }

    Path::new(&normalized)
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

pub(crate) fn stop_vault_watcher() {
    let existing = {
        let mut guard = VAULT_WATCHER.lock().expect("vault watcher lock poisoned");
        guard.take()
    };

    if let Some(watcher) = existing {
        let _ = watcher.stop_tx.send(());
        let _ = watcher.join_handle.join();
    }
}

pub(crate) fn ensure_vault_watcher(app: &AppHandle) {
    let settings = Settings::load_global();
    let Some(vault_path) = settings.vault_path.clone() else {
        stop_vault_watcher();
        return;
    };

    {
        let guard = VAULT_WATCHER.lock().expect("vault watcher lock poisoned");
        if let Some(existing) = guard.as_ref() {
            if existing.vault_path == vault_path {
                return;
            }
        }
    }

    stop_vault_watcher();

    let runtime = tokio::runtime::Handle::current();
    let app_handle = app.clone();
    let watch_path = vault_path.clone();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let join_handle = std::thread::Builder::new()
        .name("meld-vault-watcher".to_string())
        .spawn(move || {
            let (events_tx, events_rx) = mpsc::channel::<DebounceEventResult>();
            let mut debouncer = match new_debouncer(
                Duration::from_secs(2),
                Some(Duration::from_millis(500)),
                events_tx,
            ) {
                Ok(value) => value,
                Err(error) => {
                    log::error!("Failed to create vault watcher: {}", error);
                    return;
                }
            };

            if let Err(error) = debouncer.watch(Path::new(&watch_path), RecursiveMode::Recursive) {
                log::error!("Failed to watch vault '{}': {}", watch_path, error);
                return;
            }

            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                match events_rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(result) => match result {
                        Ok(events) => {
                            let has_markdown_change = events.iter().any(|event| {
                                event.paths.iter().any(|path| {
                                    is_markdown_watch_path(Path::new(&watch_path), path)
                                })
                            });

                            if !has_markdown_change {
                                continue;
                            }

                            let app_for_reindex = app_handle.clone();
                            runtime.spawn(async move {
                                if let Err(error) = run_reindex_internal(&app_for_reindex).await {
                                    log::warn!("Auto reindex failed: {}", error);
                                    let _ = app_for_reindex.emit("index:error", error);
                                }
                            });
                        }
                        Err(errors) => {
                            for error in errors {
                                log::warn!("Vault watcher event error: {}", error);
                            }
                        }
                    },
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .expect("failed to spawn vault watcher thread");

    let mut guard = VAULT_WATCHER.lock().expect("vault watcher lock poisoned");
    *guard = Some(VaultWatcherHandle {
        vault_path,
        stop_tx,
        join_handle,
    });
}

pub(crate) async fn run_reindex_internal(app: &AppHandle) -> Result<(), String> {
    if crate::core::agent::is_indexing_active() {
        return Ok(());
    }

    crate::core::agent::set_indexing_active(true);
    let result: Result<(), String> = async {
        let global_settings = Settings::load_global();
        let vault_path = global_settings
            .vault_path
            .clone()
            .ok_or("No vault configured")?;
        let vault_root = Path::new(&vault_path);
        let vault_config = crate::adapters::config::VaultConfig::load(vault_root);
        let mut settings = global_settings.merged_with_vault(&vault_config);
        crate::adapters::vault::ensure_vault_initialized(vault_root).map_err(|e| e.to_string())?;

        let files = crate::adapters::vault::list_md_files(vault_root).map_err(|e| e.to_string())?;
        let db_path = crate::adapters::vault::meld_dir(vault_root).join("index.db");
        let mut db =
            crate::adapters::vectordb::VectorDb::open(&db_path).map_err(|e| e.to_string())?;

        let mut active_paths = HashSet::with_capacity(files.len());
        for file in &files {
            let rel_path = file
                .strip_prefix(vault_root)
                .unwrap_or(file)
                .to_string_lossy()
                .replace('\\', "/");
            active_paths.insert(rel_path);
        }

        let indexed_paths = db.list_indexed_files().map_err(|e| e.to_string())?;
        for indexed_path in indexed_paths {
            if !active_paths.contains(&indexed_path) {
                db.remove_file_chunks(&indexed_path)
                    .map_err(|e| e.to_string())?;
            }
        }

        if files.is_empty() {
            return Ok(());
        }

        let current_embedding_provider = settings.embedding_provider();
        let current_embedding_model_id = settings.embedding_model_id();

        let mut provider_candidates = Vec::with_capacity(3);
        for provider in [
            current_embedding_provider.clone(),
            "google".to_string(),
            "openai".to_string(),
        ] {
            let normalized = provider.trim().to_ascii_lowercase();
            if normalized.is_empty()
                || provider_candidates
                    .iter()
                    .any(|existing: &String| existing == &normalized)
            {
                continue;
            }
            provider_candidates.push(normalized);
        }

        let mut selected_embedding: Option<(String, String, String)> = None;
        for provider in &provider_candidates {
            let Some(model_id) = resolve_embedding_model_id_for_reindex(
                &current_embedding_provider,
                &current_embedding_model_id,
                provider,
            ) else {
                continue;
            };

            match resolve_provider_credential(&mut settings, provider).await {
                Ok(api_key) => {
                    selected_embedding = Some((provider.clone(), api_key, model_id));
                    break;
                }
                Err(error) => {
                    log::debug!(
                        "Embedding provider '{}' unavailable for reindex: {}",
                        provider,
                        error
                    );
                }
            }
        }

        let (embedding_provider, api_key, embedding_model_id) = selected_embedding.ok_or_else(|| {
            format!(
                "No embedding credentials configured for reindex. Configure credentials for '{}', 'google', or 'openai'.",
                current_embedding_provider.trim().to_ascii_lowercase()
            )
        })?;
        if !embedding_provider.eq_ignore_ascii_case(&current_embedding_provider) {
            log::warn!(
                "Reindex falling back from embedding provider '{}' to '{}' due to available credentials.",
                current_embedding_provider,
                embedding_provider
            );
        }
        let total = files.len();

        for (i, file) in files.iter().enumerate() {
            let rel_path = file
                .strip_prefix(vault_root)
                .unwrap_or(file)
                .to_string_lossy()
                .replace('\\', "/");

            let _ = app.emit(
                "index:progress",
                IndexProgress {
                    current: i + 1,
                    total,
                    file: rel_path.clone(),
                },
            );

            let content = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
            let hash = crate::adapters::vault::file_hash(&content);

            if db.file_is_current(&rel_path, &hash) {
                continue;
            }

            let chunks = crate::adapters::markdown::chunk_markdown(&content, 512, 50);
            let mut prepared_chunks = Vec::with_capacity(chunks.len());

            for (idx, chunk) in chunks.iter().enumerate() {
                let embedding =
                    embed_chunk_with_retry(&api_key, &embedding_model_id, &chunk.content).await?;
                prepared_chunks.push(crate::adapters::vectordb::PreparedChunkEmbedding {
                    chunk_index: idx,
                    heading_path: chunk.heading_path.clone(),
                    content: chunk.content.clone(),
                    char_start: chunk.char_start,
                    char_end: chunk.char_end,
                    embedding,
                });
            }

            db.replace_file_chunks_atomically(&rel_path, &hash, &prepared_chunks)
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }
    .await;

    crate::core::agent::set_indexing_active(false);
    let _ = app.emit("index:done", ());
    result
}
