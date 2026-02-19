use notify_debouncer_full::notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};
use std::collections::HashSet;
use std::path::Path;
use std::sync::{mpsc, LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::adapters::config::Settings;

use super::shared::{resolve_provider_credential, IndexProgress};

#[derive(Debug)]
struct VaultWatcherHandle {
    vault_path: String,
    stop_tx: mpsc::Sender<()>,
    join_handle: JoinHandle<()>,
}

static VAULT_WATCHER: LazyLock<Mutex<Option<VaultWatcherHandle>>> =
    LazyLock::new(|| Mutex::new(None));

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

        let embedding_provider = settings.embedding_provider();
        let api_key = resolve_provider_credential(&mut settings, &embedding_provider).await?;
        let embedding_model_id = settings.embedding_model_id();
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

            db.remove_file_chunks(&rel_path)
                .map_err(|e| e.to_string())?;

            for (idx, chunk) in chunks.iter().enumerate() {
                let embedding = crate::adapters::embeddings::get_embedding(
                    &api_key,
                    &embedding_model_id,
                    &chunk.content,
                )
                .await
                .map_err(|e| e.to_string())?;

                db.insert_chunk(
                    &rel_path,
                    idx,
                    chunk.heading_path.as_deref(),
                    &chunk.content,
                    chunk.char_start,
                    chunk.char_end,
                    &hash,
                    &embedding,
                )
                .map_err(|e| e.to_string())?;
            }

            db.upsert_file(&rel_path, &hash, chunks.len())
                .map_err(|e| e.to_string())?;
        }

        Ok(())
    }
    .await;

    crate::core::agent::set_indexing_active(false);
    let _ = app.emit("index:done", ());
    result
}
