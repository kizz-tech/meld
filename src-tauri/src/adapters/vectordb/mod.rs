use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::adapters::llm::TokenUsage;
use crate::adapters::providers::split_model_id;
use crate::core::agent::state::AgentState;
use crate::core::ports::store::{RunFinishRecord, RunStartRecord, StorePort};

mod math;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChunkResult {
    pub chunk_id: i64,
    pub file_path: String,
    pub chunk_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_path: Option<String>,
    pub content: String,
    pub distance: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retrieval_score: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub created_at: String,
    pub message_count: i64,
    pub archived: bool,
    pub pinned: bool,
    pub sort_order: Option<i64>,
    pub folder_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderSummary {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub custom_instruction: Option<String>,
    pub default_model_id: Option<String>,
    pub parent_id: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub sort_order: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversationMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub sources: Option<serde_json::Value>,
    pub tool_calls: Option<serde_json::Value>,
    pub timeline: Option<serde_json::Value>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunSummary {
    pub run_id: String,
    pub conversation_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub policy_version: Option<String>,
    pub policy_fingerprint: Option<String>,
    pub tool_calls: i64,
    pub write_calls: i64,
    pub verify_failures: i64,
    pub duration_ms: Option<i64>,
    pub token_usage: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunEvent {
    pub id: i64,
    pub run_id: String,
    pub iteration: i64,
    pub channel: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub ts: String,
}

#[derive(Debug, Clone)]
pub struct PreparedChunkEmbedding {
    pub chunk_index: usize,
    pub heading_path: Option<String>,
    pub content: String,
    pub char_start: usize,
    pub char_end: usize,
    pub embedding: Vec<f32>,
}

pub struct VectorDb {
    conn: Connection,
}

pub struct SqliteRunStore {
    db_path: PathBuf,
}

impl SqliteRunStore {
    pub fn new(db_path: PathBuf) -> Self {
        Self { db_path }
    }
}

fn token_usage_from_finish_record(record: &RunFinishRecord<'_>) -> Option<TokenUsage> {
    let usage = TokenUsage {
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        total_tokens: record.total_tokens,
        reasoning_tokens: record.reasoning_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
    };

    (!usage.is_empty()).then_some(usage)
}

impl StorePort for SqliteRunStore {
    fn start_run(&self, record: RunStartRecord<'_>) {
        let started_at = chrono::Utc::now().to_rfc3339();
        if let Ok(mut db) = VectorDb::open(&self.db_path) {
            let _ = db.create_run(
                record.run_id,
                &record.conversation_id.to_string(),
                &started_at,
                AgentState::Accepted.as_str(),
                Some(record.provider),
                Some(record.model),
                Some(record.policy_version),
                Some(record.policy_fingerprint),
            );
        }
    }

    fn log_event(
        &self,
        run_id: &str,
        iteration: usize,
        channel: &str,
        event_type: &str,
        payload: &JsonValue,
    ) {
        let ts = chrono::Utc::now().to_rfc3339();
        if let Ok(mut db) = VectorDb::open(&self.db_path) {
            let _ =
                db.append_run_event(run_id, iteration as i64, channel, event_type, payload, &ts);
        }
    }

    fn finish_run(&self, record: RunFinishRecord<'_>) {
        let finished_at = chrono::Utc::now().to_rfc3339();
        let token_usage_json = token_usage_from_finish_record(&record)
            .and_then(|usage| serde_json::to_string(&usage).ok());
        if let Ok(mut db) = VectorDb::open(&self.db_path) {
            let _ = db.finish_run(
                record.run_id,
                &finished_at,
                record.status.as_str(),
                record.tool_calls as i64,
                record.write_calls as i64,
                record.verify_failures as i64,
                record.duration_ms as i64,
                token_usage_json.as_deref(),
            );
        }
    }
}

impl VectorDb {
    pub fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;

        // Load sqlite-vec extension
        // For now, we use standard tables — sqlite-vec will be loaded when available
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY,
                file_path TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                heading_path TEXT,
                content TEXT NOT NULL,
                char_start INTEGER NOT NULL,
                char_end INTEGER NOT NULL,
                file_hash TEXT NOT NULL,
                embedding BLOB,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(file_path, chunk_index)
            );

            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                chunk_count INTEGER NOT NULL,
                indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                archived INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sources TEXT,
                tool_calls TEXT,
                timeline TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );

            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                provider TEXT,
                model TEXT,
                policy_version TEXT,
                policy_fingerprint TEXT,
                tool_calls INTEGER DEFAULT 0,
                write_calls INTEGER DEFAULT 0,
                verify_failures INTEGER DEFAULT 0,
                duration_ms INTEGER,
                token_usage TEXT
            );

            CREATE TABLE IF NOT EXISTS run_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                iteration INTEGER NOT NULL,
                channel TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                ts TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES runs(run_id)
            );

            CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT 'New folder',
                icon TEXT,
                custom_instruction TEXT,
                default_model_id TEXT,
                parent_id INTEGER,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
            CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);
            CREATE INDEX IF NOT EXISTS idx_run_events_ts ON run_events(ts);
            CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
            CREATE INDEX IF NOT EXISTS idx_folders_archived ON folders(archived);
            ",
        )?;

        // FTS is optional. When sqlite is built without FTS5, fallback to vector-only retrieval.
        let _ = conn.execute_batch(
            "
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content,
                file_path UNINDEXED,
                chunk_index UNINDEXED,
                heading_path UNINDEXED
            );
            ",
        );

        // Migration-safe ALTERs for older DBs.
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE conversations ADD COLUMN title TEXT", []),
        )?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE conversations ADD COLUMN updated_at TEXT", []),
        )?;
        ignore_duplicate_column_error(conn.execute(
            "ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
            [],
        ))?;
        ignore_duplicate_column_error(conn.execute(
            "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        ))?;
        ignore_duplicate_column_error(conn.execute(
            "ALTER TABLE conversations ADD COLUMN sort_order INTEGER",
            [],
        ))?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE messages ADD COLUMN sources TEXT", []),
        )?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE messages ADD COLUMN tool_calls TEXT", []),
        )?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE messages ADD COLUMN timeline TEXT", []),
        )?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE chunks ADD COLUMN heading_path TEXT", []),
        )?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE runs ADD COLUMN policy_fingerprint TEXT", []),
        )?;
        ignore_duplicate_column_error(conn.execute(
            "ALTER TABLE conversations ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL",
            [],
        ))?;
        ignore_duplicate_column_error(
            conn.execute("ALTER TABLE folders ADD COLUMN default_model_id TEXT", []),
        )?;

        sync_chunks_fts(&conn)?;

        let has_title = table_has_column(&conn, "conversations", "title")?;
        let has_updated_at = table_has_column(&conn, "conversations", "updated_at")?;
        let has_archived = table_has_column(&conn, "conversations", "archived")?;
        let has_pinned = table_has_column(&conn, "conversations", "pinned")?;
        let has_sort_order = table_has_column(&conn, "conversations", "sort_order")?;

        if has_title && has_updated_at {
            conn.execute(
                "UPDATE conversations
                 SET title = COALESCE(NULLIF(title, ''), 'New conversation'),
                     updated_at = COALESCE(updated_at, created_at, datetime('now'))
                 WHERE title IS NULL OR title = '' OR updated_at IS NULL",
                [],
            )?;
        } else if has_title {
            conn.execute(
                "UPDATE conversations
                 SET title = COALESCE(NULLIF(title, ''), 'New conversation')
                 WHERE title IS NULL OR title = ''",
                [],
            )?;
        }
        if has_archived {
            conn.execute(
                "UPDATE conversations
                 SET archived = 0
                 WHERE archived IS NULL OR archived NOT IN (0, 1)",
                [],
            )?;
        }
        if has_pinned {
            conn.execute(
                "UPDATE conversations
                 SET pinned = 0
                 WHERE pinned IS NULL OR pinned NOT IN (0, 1)",
                [],
            )?;
        }
        if has_sort_order {
            conn.execute(
                "WITH ordered AS (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (
                            ORDER BY datetime(COALESCE(updated_at, created_at, datetime('now'))) DESC, id DESC
                        ) AS rn
                    FROM conversations
                    WHERE sort_order IS NULL
                 )
                 UPDATE conversations
                 SET sort_order = (
                    SELECT rn FROM ordered WHERE ordered.id = conversations.id
                 )
                 WHERE sort_order IS NULL",
                [],
            )?;
        }

        // Create indexes that depend on migrated columns only when the column is present.
        if has_updated_at {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)",
                [],
            )?;
        }
        if has_archived {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(archived)",
                [],
            )?;
        }
        if has_pinned {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(pinned)",
                [],
            )?;
        }
        if has_sort_order {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_sort_order ON conversations(sort_order)",
                [],
            )?;
        }
        let has_heading_path = table_has_column(&conn, "chunks", "heading_path")?;
        if has_heading_path {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_chunks_heading ON chunks(heading_path)",
                [],
            )?;
        }
        let has_folder_id = table_has_column(&conn, "conversations", "folder_id")?;
        if has_folder_id {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_conversations_folder ON conversations(folder_id)",
                [],
            )?;
        }

        Ok(Self { conn })
    }

    pub fn file_is_current(&self, file_path: &str, hash: &str) -> bool {
        self.conn
            .query_row(
                "SELECT hash FROM files WHERE path = ?1",
                params![file_path],
                |row| row.get::<_, String>(0),
            )
            .map(|h| h == hash)
            .unwrap_or(false)
    }

    pub fn remove_file_chunks(
        &mut self,
        file_path: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if table_exists(&self.conn, "chunks_fts")? {
            self.conn.execute(
                "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?1)",
                params![file_path],
            )?;
        }
        self.conn.execute(
            "DELETE FROM chunks WHERE file_path = ?1",
            params![file_path],
        )?;
        self.conn
            .execute("DELETE FROM files WHERE path = ?1", params![file_path])?;
        Ok(())
    }

    pub fn replace_file_chunks_atomically(
        &mut self,
        file_path: &str,
        hash: &str,
        chunks: &[PreparedChunkEmbedding],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let has_fts = table_exists(&self.conn, "chunks_fts")?;
        let tx = self.conn.transaction()?;

        if has_fts {
            tx.execute(
                "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?1)",
                params![file_path],
            )?;
        }
        tx.execute(
            "DELETE FROM chunks WHERE file_path = ?1",
            params![file_path],
        )?;
        tx.execute("DELETE FROM files WHERE path = ?1", params![file_path])?;

        for chunk in chunks {
            let embedding_bytes: Vec<u8> = chunk
                .embedding
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect();

            tx.execute(
                "INSERT INTO chunks (file_path, chunk_index, heading_path, content, char_start, char_end, file_hash, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    file_path,
                    chunk.chunk_index as i64,
                    chunk.heading_path.as_deref(),
                    chunk.content.as_str(),
                    chunk.char_start as i64,
                    chunk.char_end as i64,
                    hash,
                    embedding_bytes,
                ],
            )?;

            if has_fts {
                let chunk_id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO chunks_fts(rowid, content, file_path, chunk_index, heading_path)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        chunk_id,
                        chunk.content.as_str(),
                        file_path,
                        chunk.chunk_index as i64,
                        chunk.heading_path.as_deref().unwrap_or(""),
                    ],
                )?;
            }
        }

        tx.execute(
            "INSERT OR REPLACE INTO files (path, hash, chunk_count, indexed_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            params![file_path, hash, chunks.len() as i64],
        )?;

        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_chunk(
        &mut self,
        file_path: &str,
        chunk_index: usize,
        heading_path: Option<&str>,
        content: &str,
        char_start: usize,
        char_end: usize,
        file_hash: &str,
        embedding: &[f32],
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|f| f.to_le_bytes()).collect();

        self.conn.execute(
            "INSERT INTO chunks (file_path, chunk_index, heading_path, content, char_start, char_end, file_hash, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                file_path,
                chunk_index as i64,
                heading_path,
                content,
                char_start as i64,
                char_end as i64,
                file_hash,
                embedding_bytes,
            ],
        )?;

        let chunk_id = self.conn.last_insert_rowid();
        if table_exists(&self.conn, "chunks_fts")? {
            self.conn.execute(
                "INSERT INTO chunks_fts(rowid, content, file_path, chunk_index, heading_path)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    chunk_id,
                    content,
                    file_path,
                    chunk_index as i64,
                    heading_path.unwrap_or(""),
                ],
            )?;
        }

        Ok(chunk_id)
    }

    pub fn upsert_file(
        &mut self,
        file_path: &str,
        hash: &str,
        chunk_count: usize,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.conn.execute(
            "INSERT OR REPLACE INTO files (path, hash, chunk_count, indexed_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            params![file_path, hash, chunk_count as i64],
        )?;
        Ok(())
    }

    pub fn list_indexed_files(&self) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path FROM files ORDER BY path ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut files = Vec::new();
        for row in rows {
            files.push(row?);
        }
        Ok(files)
    }

    pub fn index_stats(&self) -> Result<(i64, i64), Box<dyn std::error::Error>> {
        let file_count = self
            .conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get::<_, i64>(0))?;
        let chunk_count = self
            .conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |row| {
                row.get::<_, i64>(0)
            })?;
        Ok((file_count, chunk_count))
    }

    fn search_vector_candidates(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<ChunkResult>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, file_path, chunk_index, heading_path, content, embedding
             FROM chunks
             WHERE embedding IS NOT NULL",
        )?;

        let mut results: Vec<(ChunkResult, f64)> = Vec::new();

        let rows = stmt.query_map([], |row| {
            let chunk_id: i64 = row.get(0)?;
            let file_path: String = row.get(1)?;
            let chunk_index: i64 = row.get(2)?;
            let heading_path: Option<String> = row.get(3)?;
            let content: String = row.get(4)?;
            let embedding_bytes: Vec<u8> = row.get(5)?;
            Ok((
                chunk_id,
                file_path,
                chunk_index as usize,
                heading_path,
                content,
                embedding_bytes,
            ))
        })?;

        for row in rows {
            let (chunk_id, file_path, chunk_index, heading_path, content, embedding_bytes) = row?;

            let stored_embedding: Vec<f32> = embedding_bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect();

            let similarity = math::cosine_similarity(query_embedding, &stored_embedding);

            results.push((
                ChunkResult {
                    chunk_id,
                    file_path,
                    chunk_index,
                    heading_path: normalize_heading_path(heading_path),
                    content,
                    distance: 1.0 - similarity,
                    retrieval_score: None,
                },
                similarity,
            ));
        }

        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit);

        Ok(results.into_iter().map(|(result, _)| result).collect())
    }

    fn search_keyword_candidates(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkResult>, Box<dyn std::error::Error>> {
        if !table_exists(&self.conn, "chunks_fts")? {
            return Ok(Vec::new());
        }

        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };

        let mut stmt = self.conn.prepare(
            "SELECT rowid, file_path, chunk_index, heading_path, content, bm25(chunks_fts) as rank
             FROM chunks_fts
             WHERE chunks_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![fts_query, limit as i64], |row| {
            let chunk_id: i64 = row.get(0)?;
            let file_path: String = row.get(1)?;
            let chunk_index: i64 = row.get(2)?;
            let heading_path_raw: Option<String> = row.get(3)?;
            let content: String = row.get(4)?;
            let rank: f64 = row.get(5)?;

            Ok(ChunkResult {
                chunk_id,
                file_path,
                chunk_index: chunk_index as usize,
                heading_path: normalize_heading_path(heading_path_raw),
                content,
                distance: rank.max(0.0),
                retrieval_score: None,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    pub fn search_hybrid(
        &self,
        query_embedding: &[f32],
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChunkResult>, Box<dyn std::error::Error>> {
        let candidate_limit = (limit.max(1) * 4).min(200);
        let vector = self.search_vector_candidates(query_embedding, candidate_limit)?;
        let keyword = self.search_keyword_candidates(query, candidate_limit)?;

        if keyword.is_empty() {
            return Ok(vector.into_iter().take(limit).collect());
        }
        if vector.is_empty() {
            return Ok(keyword.into_iter().take(limit).collect());
        }

        let mut merged: HashMap<(String, usize), MergedCandidate> = HashMap::new();

        for (rank, chunk) in vector.into_iter().enumerate() {
            let key = (chunk.file_path.clone(), chunk.chunk_index);
            let existing = merged
                .entry(key)
                .or_insert_with(|| MergedCandidate { chunk, score: 0.0 });
            existing.score += rrf_score(rank + 1, 60.0);
        }

        for (rank, chunk) in keyword.into_iter().enumerate() {
            let key = (chunk.file_path.clone(), chunk.chunk_index);
            let existing = merged
                .entry(key)
                .or_insert_with(|| MergedCandidate { chunk, score: 0.0 });
            existing.score += rrf_score(rank + 1, 60.0);
        }

        let mut ranked = merged.into_values().collect::<Vec<_>>();
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(limit);

        Ok(ranked
            .into_iter()
            .map(|mut item| {
                item.chunk.retrieval_score = Some(item.score);
                item.chunk
            })
            .collect())
    }

    #[allow(dead_code)]
    pub fn search(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<ChunkResult>, Box<dyn std::error::Error>> {
        self.search_vector_candidates(query_embedding, limit)
    }

    pub fn save_message(
        &mut self,
        conversation_id: i64,
        role: &str,
        content: &str,
        sources: Option<&str>,
        tool_calls: Option<&str>,
        timeline: Option<&str>,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        self.conn.execute(
            "INSERT INTO messages (conversation_id, role, content, sources, tool_calls, timeline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                conversation_id,
                role,
                content,
                sources,
                tool_calls,
                timeline
            ],
        )?;
        self.conn.execute(
            "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
            params![conversation_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn create_conversation(&mut self, title: &str) -> Result<i64, Box<dyn std::error::Error>> {
        let title = if title.trim().is_empty() {
            "New conversation"
        } else {
            title.trim()
        };
        self.conn.execute(
            "INSERT INTO conversations (title, archived, pinned, sort_order, created_at, updated_at)
             VALUES (
                ?1,
                0,
                0,
                COALESCE((SELECT MIN(sort_order) FROM conversations), 1) - 1,
                datetime('now'),
                datetime('now')
             )",
            params![title],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn conversation_exists(
        &self,
        conversation_id: i64,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let exists = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversations WHERE id = ?1)",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(exists == 1)
    }

    pub fn list_conversations(
        &self,
    ) -> Result<Vec<ConversationSummary>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT
                c.id,
                COALESCE(NULLIF(c.title, ''), 'New conversation') AS title,
                COALESCE(c.updated_at, c.created_at, datetime('now')) AS updated_at,
                c.created_at,
                COUNT(m.id) AS message_count,
                CAST(COALESCE(c.archived, 0) AS INTEGER) AS archived,
                CAST(COALESCE(c.pinned, 0) AS INTEGER) AS pinned,
                c.sort_order,
                c.folder_id
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE CAST(COALESCE(c.archived, 0) AS INTEGER) = 0
             GROUP BY c.id, c.title, c.updated_at, c.created_at, c.archived, c.pinned, c.sort_order, c.folder_id
             ORDER BY
                CAST(COALESCE(c.pinned, 0) AS INTEGER) DESC,
                CASE WHEN c.sort_order IS NULL THEN 1 ELSE 0 END ASC,
                c.sort_order ASC,
                datetime(COALESCE(c.updated_at, c.created_at, datetime('now'))) DESC,
                c.id DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ConversationSummary {
                id: row.get::<_, i64>(0)?.to_string(),
                title: row.get(1)?,
                updated_at: row.get(2)?,
                created_at: row.get(3)?,
                message_count: row.get(4)?,
                archived: row.get::<_, i64>(5)? == 1,
                pinned: row.get::<_, i64>(6)? == 1,
                sort_order: row.get(7)?,
                folder_id: row.get::<_, Option<i64>>(8)?.map(|id| id.to_string()),
            })
        })?;

        let mut conversations = Vec::new();
        for row in rows {
            conversations.push(row?);
        }
        Ok(conversations)
    }

    pub fn list_archived_conversations(
        &self,
    ) -> Result<Vec<ConversationSummary>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT
                c.id,
                COALESCE(NULLIF(c.title, ''), 'New conversation') AS title,
                COALESCE(c.updated_at, c.created_at, datetime('now')) AS updated_at,
                c.created_at,
                COUNT(m.id) AS message_count,
                CAST(COALESCE(c.archived, 0) AS INTEGER) AS archived,
                CAST(COALESCE(c.pinned, 0) AS INTEGER) AS pinned,
                c.sort_order,
                c.folder_id
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE CAST(COALESCE(c.archived, 0) AS INTEGER) = 1
             GROUP BY c.id, c.title, c.updated_at, c.created_at, c.archived, c.pinned, c.sort_order, c.folder_id
             ORDER BY datetime(COALESCE(c.updated_at, c.created_at, datetime('now'))) DESC, c.id DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(ConversationSummary {
                id: row.get::<_, i64>(0)?.to_string(),
                title: row.get(1)?,
                updated_at: row.get(2)?,
                created_at: row.get(3)?,
                message_count: row.get(4)?,
                archived: row.get::<_, i64>(5)? == 1,
                pinned: row.get::<_, i64>(6)? == 1,
                sort_order: row.get(7)?,
                folder_id: row.get::<_, Option<i64>>(8)?.map(|id| id.to_string()),
            })
        })?;

        let mut conversations = Vec::new();
        for row in rows {
            conversations.push(row?);
        }
        Ok(conversations)
    }

    pub fn get_conversation_messages(
        &self,
        conversation_id: i64,
    ) -> Result<Vec<ConversationMessage>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, role, content, sources, tool_calls, timeline, created_at
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY datetime(created_at) ASC, id ASC",
        )?;

        let rows = stmt.query_map(params![conversation_id], |row| {
            let sources_raw: Option<String> = row.get(3)?;
            let tool_calls_raw: Option<String> = row.get(4)?;
            let timeline_raw: Option<String> = row.get(5)?;

            Ok(ConversationMessage {
                id: row.get::<_, i64>(0)?.to_string(),
                role: row.get(1)?,
                content: row.get(2)?,
                sources: parse_json_field(sources_raw),
                tool_calls: parse_json_field(tool_calls_raw),
                timeline: parse_json_field(timeline_raw),
                created_at: row.get(6)?,
            })
        })?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(row?);
        }
        Ok(messages)
    }

    pub fn delete_conversation(
        &mut self,
        conversation_id: i64,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        let deleted = tx.execute(
            "DELETE FROM conversations WHERE id = ?1",
            params![conversation_id],
        )?;
        if deleted == 0 {
            return Err(format!("Conversation {} not found", conversation_id).into());
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_message(&mut self, message_id: i64) -> Result<(), Box<dyn std::error::Error>> {
        let tx = self.conn.transaction()?;

        let conversation_id: i64 = tx.query_row(
            "SELECT conversation_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get(0),
        )?;

        let deleted = tx.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
        if deleted == 0 {
            return Err(format!("Message {} not found", message_id).into());
        }

        tx.execute(
            "UPDATE conversations
             SET updated_at = datetime('now')
             WHERE id = ?1",
            params![conversation_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub fn get_message_conversation_id(
        &self,
        message_id: i64,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let conversation_id = self.conn.query_row(
            "SELECT conversation_id FROM messages WHERE id = ?1",
            params![message_id],
            |row| row.get::<_, i64>(0),
        );

        match conversation_id {
            Ok(value) => Ok(value),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Err(format!("Message {} not found", message_id).into())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn get_last_assistant_message_id(
        &self,
        conversation_id: i64,
    ) -> Result<Option<i64>, Box<dyn std::error::Error>> {
        let assistant_message = self.conn.query_row(
            "SELECT id
             FROM messages
             WHERE conversation_id = ?1
               AND role = 'assistant'
             ORDER BY id DESC
             LIMIT 1",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        );

        match assistant_message {
            Ok(message_id) => Ok(Some(message_id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn truncate_messages_from(
        &mut self,
        conversation_id: i64,
        from_message_id: i64,
    ) -> Result<usize, Box<dyn std::error::Error>> {
        let tx = self.conn.transaction()?;

        let anchor_exists: i64 = tx.query_row(
            "SELECT COUNT(*)
             FROM messages
             WHERE id = ?1
               AND conversation_id = ?2",
            params![from_message_id, conversation_id],
            |row| row.get(0),
        )?;
        if anchor_exists == 0 {
            return Err(format!(
                "Message {} not found in conversation {}",
                from_message_id, conversation_id
            )
            .into());
        }

        let deleted = tx.execute(
            "DELETE FROM messages
             WHERE conversation_id = ?1
               AND id >= ?2",
            params![conversation_id, from_message_id],
        )?;
        if deleted == 0 {
            return Err(format!(
                "No messages deleted from conversation {} at anchor {}",
                conversation_id, from_message_id
            )
            .into());
        }

        tx.execute(
            "UPDATE conversations
             SET updated_at = datetime('now')
             WHERE id = ?1",
            params![conversation_id],
        )?;

        tx.commit()?;
        Ok(deleted)
    }

    pub fn edit_user_message_and_truncate(
        &mut self,
        message_id: i64,
        content: &str,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let normalized = content.trim();
        if normalized.is_empty() {
            return Err("Message content cannot be empty".into());
        }

        let tx = self.conn.transaction()?;

        let message_context = tx.query_row(
            "SELECT conversation_id, role
             FROM messages
             WHERE id = ?1",
            params![message_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        );
        let (conversation_id, role) = match message_context {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(format!("Message {} not found", message_id).into())
            }
            Err(e) => return Err(e.into()),
        };

        if role != "user" {
            return Err(format!("Message {} is not a user message", message_id).into());
        }

        let updated = tx.execute(
            "UPDATE messages
             SET content = ?1,
                 sources = NULL,
                 tool_calls = NULL,
                 timeline = NULL
             WHERE id = ?2",
            params![normalized, message_id],
        )?;
        if updated == 0 {
            return Err(format!("Message {} not found", message_id).into());
        }

        tx.execute(
            "DELETE FROM messages
             WHERE conversation_id = ?1
               AND id > ?2",
            params![conversation_id, message_id],
        )?;

        tx.execute(
            "UPDATE conversations
             SET updated_at = datetime('now')
             WHERE id = ?1",
            params![conversation_id],
        )?;

        tx.commit()?;
        Ok(conversation_id)
    }

    pub fn rename_conversation(
        &mut self,
        conversation_id: i64,
        title: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let normalized = title.trim();
        if normalized.is_empty() {
            return Err("Conversation title cannot be empty".into());
        }

        let updated = self.conn.execute(
            "UPDATE conversations
             SET title = ?1,
                 updated_at = datetime('now')
             WHERE id = ?2",
            params![normalized, conversation_id],
        )?;
        if updated == 0 {
            return Err(format!("Conversation {} not found", conversation_id).into());
        }

        Ok(())
    }

    pub fn set_conversation_archived(
        &mut self,
        conversation_id: i64,
        archived: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let updated = if archived {
            self.conn.execute(
                "UPDATE conversations
                 SET archived = 1,
                     pinned = 0,
                     updated_at = datetime('now')
                 WHERE id = ?1",
                params![conversation_id],
            )?
        } else {
            self.conn.execute(
                "UPDATE conversations
                 SET archived = 0,
                     sort_order = COALESCE(
                        (
                          SELECT MIN(sort_order)
                          FROM conversations
                          WHERE CAST(COALESCE(archived, 0) AS INTEGER) = 0
                            AND id != ?1
                        ),
                        1
                     ) - 1,
                     updated_at = datetime('now')
                 WHERE id = ?1",
                params![conversation_id],
            )?
        };
        if updated == 0 {
            return Err(format!("Conversation {} not found", conversation_id).into());
        }
        Ok(())
    }

    pub fn set_conversation_pinned(
        &mut self,
        conversation_id: i64,
        pinned: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let updated = self.conn.execute(
            "UPDATE conversations
             SET pinned = ?1,
                 updated_at = datetime('now')
             WHERE id = ?2",
            params![if pinned { 1 } else { 0 }, conversation_id],
        )?;
        if updated == 0 {
            return Err(format!("Conversation {} not found", conversation_id).into());
        }
        Ok(())
    }

    pub fn reorder_conversations(
        &mut self,
        conversation_ids: &[i64],
    ) -> Result<(), Box<dyn std::error::Error>> {
        if conversation_ids.is_empty() {
            return Ok(());
        }

        let tx = self.conn.transaction()?;
        for (index, conversation_id) in conversation_ids.iter().enumerate() {
            tx.execute(
                "UPDATE conversations
                 SET sort_order = ?1
                 WHERE id = ?2
                   AND CAST(COALESCE(archived, 0) AS INTEGER) = 0",
                params![(index as i64) + 1, conversation_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_last_user_message(
        &self,
        conversation_id: i64,
        assistant_message_id: Option<i64>,
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        if let Some(assistant_id) = assistant_message_id {
            let role = self.conn.query_row(
                "SELECT role FROM messages WHERE id = ?1 AND conversation_id = ?2",
                params![assistant_id, conversation_id],
                |row| row.get::<_, String>(0),
            );

            match role {
                Ok(value) => {
                    if value != "assistant" {
                        return Err(format!(
                            "Message {} is not an assistant message in conversation {}",
                            assistant_id, conversation_id
                        )
                        .into());
                    }
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    return Err(format!(
                        "Assistant message {} not found in conversation {}",
                        assistant_id, conversation_id
                    )
                    .into())
                }
                Err(e) => return Err(e.into()),
            }

            let user_message = self.conn.query_row(
                "SELECT content
                 FROM messages
                 WHERE conversation_id = ?1
                   AND role = 'user'
                   AND id < ?2
                 ORDER BY id DESC
                 LIMIT 1",
                params![conversation_id, assistant_id],
                |row| row.get::<_, String>(0),
            );

            return match user_message {
                Ok(content) => Ok(Some(content)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            };
        }

        let user_message = self.conn.query_row(
            "SELECT content
             FROM messages
             WHERE conversation_id = ?1
               AND role = 'user'
             ORDER BY id DESC
             LIMIT 1",
            params![conversation_id],
            |row| row.get::<_, String>(0),
        );

        match user_message {
            Ok(content) => Ok(Some(content)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // ── Folder methods ────────────────────────────────────

    pub fn create_folder(
        &mut self,
        name: &str,
        parent_id: Option<i64>,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let name = if name.trim().is_empty() {
            "New folder"
        } else {
            name.trim()
        };
        self.conn.execute(
            "INSERT INTO folders (name, parent_id, created_at, updated_at)
             VALUES (?1, ?2, datetime('now'), datetime('now'))",
            params![name, parent_id],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_folder(&self, folder_id: i64) -> Result<FolderSummary, Box<dyn std::error::Error>> {
        let folder = self.conn.query_row(
            "SELECT id, name, icon, custom_instruction, default_model_id, parent_id, pinned, archived, sort_order, created_at, updated_at
             FROM folders WHERE id = ?1",
            params![folder_id],
            |row| {
                Ok(FolderSummary {
                    id: row.get::<_, i64>(0)?.to_string(),
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    custom_instruction: row.get(3)?,
                    default_model_id: row.get(4)?,
                    parent_id: row.get::<_, Option<i64>>(5)?.map(|id| id.to_string()),
                    pinned: row.get::<_, i64>(6)? == 1,
                    archived: row.get::<_, i64>(7)? == 1,
                    sort_order: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )?;
        Ok(folder)
    }

    pub fn list_folders(&self) -> Result<Vec<FolderSummary>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, icon, custom_instruction, default_model_id, parent_id, pinned, archived, sort_order, created_at, updated_at
             FROM folders
             WHERE archived = 0
             ORDER BY pinned DESC, sort_order ASC, datetime(updated_at) DESC, id DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(FolderSummary {
                id: row.get::<_, i64>(0)?.to_string(),
                name: row.get(1)?,
                icon: row.get(2)?,
                custom_instruction: row.get(3)?,
                default_model_id: row.get(4)?,
                parent_id: row.get::<_, Option<i64>>(5)?.map(|id| id.to_string()),
                pinned: row.get::<_, i64>(6)? == 1,
                archived: row.get::<_, i64>(7)? == 1,
                sort_order: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;

        let mut folders = Vec::new();
        for row in rows {
            folders.push(row?);
        }
        Ok(folders)
    }

    pub fn rename_folder(
        &mut self,
        folder_id: i64,
        name: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Folder name cannot be empty".into());
        }
        let updated = self.conn.execute(
            "UPDATE folders SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![name, folder_id],
        )?;
        if updated == 0 {
            return Err(format!("Folder {} not found", folder_id).into());
        }
        Ok(())
    }

    pub fn update_folder(
        &mut self,
        folder_id: i64,
        icon: Option<&str>,
        custom_instruction: Option<&str>,
        default_model_id: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let normalized_default_model_id = default_model_id.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return None;
            }

            match split_model_id(trimmed) {
                Ok(_) => Some(trimmed.to_string()),
                Err(error) => {
                    log::warn!(
                        "Dropping invalid folder default_model_id '{}' for folder {}: {}",
                        trimmed,
                        folder_id,
                        error
                    );
                    None
                }
            }
        });
        let updated = self.conn.execute(
            "UPDATE folders SET icon = ?1, custom_instruction = ?2, default_model_id = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![icon, custom_instruction, normalized_default_model_id.as_deref(), folder_id],
        )?;
        if updated == 0 {
            return Err(format!("Folder {} not found", folder_id).into());
        }
        Ok(())
    }

    pub fn set_folder_archived(
        &mut self,
        folder_id: i64,
        archived: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tx = self.conn.transaction()?;

        // Collect all descendant folder IDs (including self)
        let mut descendants = vec![folder_id];
        let mut stack = vec![folder_id];
        while let Some(current) = stack.pop() {
            let mut stmt = tx.prepare("SELECT id FROM folders WHERE parent_id = ?1")?;
            let children: Vec<i64> = stmt
                .query_map(params![current], |row| row.get::<_, i64>(0))?
                .filter_map(|r| r.ok())
                .collect();
            for child in children {
                descendants.push(child);
                stack.push(child);
            }
        }

        for id in &descendants {
            if archived {
                tx.execute(
                    "UPDATE folders SET archived = 1, pinned = 0, updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                )?;
            } else {
                tx.execute(
                    "UPDATE folders SET archived = 0, updated_at = datetime('now') WHERE id = ?1",
                    params![id],
                )?;
            }
        }

        // Unassign conversations from archived folders
        if archived {
            for id in &descendants {
                tx.execute(
                    "UPDATE conversations SET folder_id = NULL WHERE folder_id = ?1",
                    params![id],
                )?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn set_folder_pinned(
        &mut self,
        folder_id: i64,
        pinned: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let updated = self.conn.execute(
            "UPDATE folders SET pinned = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![if pinned { 1 } else { 0 }, folder_id],
        )?;
        if updated == 0 {
            return Err(format!("Folder {} not found", folder_id).into());
        }
        Ok(())
    }

    pub fn move_folder(
        &mut self,
        folder_id: i64,
        new_parent_id: Option<i64>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Cycle detection: new_parent_id must not be a descendant of folder_id
        if let Some(target_parent) = new_parent_id {
            if target_parent == folder_id {
                return Err("Cannot move folder into itself".into());
            }
            let mut current = Some(target_parent);
            while let Some(pid) = current {
                let parent: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT parent_id FROM folders WHERE id = ?1",
                        params![pid],
                        |row| row.get(0),
                    )
                    .ok();
                match parent {
                    Some(p) if p == folder_id => {
                        return Err("Cannot move folder into its own descendant".into());
                    }
                    Some(p) => current = Some(p),
                    None => break,
                }
            }
        }

        let updated = self.conn.execute(
            "UPDATE folders SET parent_id = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![new_parent_id, folder_id],
        )?;
        if updated == 0 {
            return Err(format!("Folder {} not found", folder_id).into());
        }
        Ok(())
    }

    pub fn set_conversation_folder(
        &mut self,
        conversation_id: i64,
        folder_id: Option<i64>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let updated = self.conn.execute(
            "UPDATE conversations SET folder_id = ?1, updated_at = datetime('now') WHERE id = ?2",
            params![folder_id, conversation_id],
        )?;
        if updated == 0 {
            return Err(format!("Conversation {} not found", conversation_id).into());
        }
        Ok(())
    }

    pub fn get_folder_instruction_chain(
        &self,
        folder_id: i64,
    ) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        // Traverse from folder_id to root, collecting instructions, then reverse
        let mut chain = Vec::new();
        let mut current = Some(folder_id);
        let mut visited = std::collections::HashSet::new();

        while let Some(fid) = current {
            if !visited.insert(fid) {
                break; // cycle safety
            }
            let row = self.conn.query_row(
                "SELECT custom_instruction, parent_id FROM folders WHERE id = ?1",
                params![fid],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                    ))
                },
            );
            match row {
                Ok((instruction, parent_id)) => {
                    if let Some(inst) = instruction {
                        let trimmed = inst.trim().to_string();
                        if !trimmed.is_empty() {
                            chain.push(trimmed);
                        }
                    }
                    current = parent_id;
                }
                Err(_) => break,
            }
        }

        chain.reverse(); // root → leaf order
        Ok(chain)
    }

    pub fn get_conversation_folder_id(
        &self,
        conversation_id: i64,
    ) -> Result<Option<i64>, Box<dyn std::error::Error>> {
        let folder_id = self.conn.query_row(
            "SELECT folder_id FROM conversations WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        Ok(folder_id)
    }

    pub fn resolve_conversation_chat_model_id(
        &self,
        conversation_id: i64,
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        let mut current = self.get_conversation_folder_id(conversation_id)?;
        let mut visited = std::collections::HashSet::new();

        while let Some(folder_id) = current {
            if !visited.insert(folder_id) {
                break;
            }

            let row = self.conn.query_row(
                "SELECT default_model_id, parent_id FROM folders WHERE id = ?1",
                params![folder_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                    ))
                },
            );

            match row {
                Ok((default_model_id, parent_id)) => {
                    if let Some(model_id) = default_model_id {
                        let trimmed = model_id.trim();
                        if !trimmed.is_empty() {
                            match split_model_id(trimmed) {
                                Ok(_) => return Ok(Some(trimmed.to_string())),
                                Err(error) => {
                                    log::warn!(
                                        "Ignoring invalid default_model_id '{}' for folder {} while resolving conversation {}: {}",
                                        trimmed,
                                        folder_id,
                                        conversation_id,
                                        error
                                    );
                                }
                            }
                        }
                    }
                    current = parent_id;
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => break,
                Err(error) => return Err(Box::new(error)),
            }
        }

        Ok(None)
    }

    pub fn import_folders_from_local(
        &mut self,
        json: &str,
    ) -> Result<std::collections::HashMap<String, i64>, Box<dyn std::error::Error>> {
        #[derive(serde::Deserialize)]
        struct LocalFolder {
            id: String,
            name: String,
            #[serde(rename = "parentId")]
            parent_id: Option<String>,
            pinned: Option<bool>,
            #[serde(default)]
            archived: Option<bool>,
        }

        #[derive(serde::Deserialize)]
        struct LocalLayout {
            folders: Vec<LocalFolder>,
            assignments: std::collections::HashMap<String, String>,
        }

        let layout: LocalLayout = serde_json::from_str(json)?;
        let mut id_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

        // Topological insert: process folders with no parent first, then children
        let mut remaining: Vec<&LocalFolder> = layout.folders.iter().collect();
        let mut progress = true;
        while !remaining.is_empty() && progress {
            progress = false;
            let mut next_remaining = Vec::new();
            for folder in remaining {
                if folder.archived.unwrap_or(false) {
                    progress = true;
                    continue;
                }
                let resolved_parent = match &folder.parent_id {
                    None => Some(None),
                    Some(pid) => id_map.get(pid).map(|&db_id| Some(db_id)),
                };
                if let Some(parent_id) = resolved_parent {
                    let db_id = self.create_folder(&folder.name, parent_id)?;
                    if folder.pinned.unwrap_or(false) {
                        let _ = self.set_folder_pinned(db_id, true);
                    }
                    id_map.insert(folder.id.clone(), db_id);
                    progress = true;
                } else {
                    next_remaining.push(folder);
                }
            }
            remaining = next_remaining;
        }

        // Apply conversation assignments
        for (conversation_id_str, local_folder_id) in &layout.assignments {
            if let Some(&db_folder_id) = id_map.get(local_folder_id) {
                if let Ok(conv_id) = conversation_id_str.parse::<i64>() {
                    let _ = self.set_conversation_folder(conv_id, Some(db_folder_id));
                }
            }
        }

        Ok(id_map)
    }

    // ── Run methods ────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn create_run(
        &mut self,
        run_id: &str,
        conversation_id: &str,
        started_at: &str,
        status: &str,
        provider: Option<&str>,
        model: Option<&str>,
        policy_version: Option<&str>,
        policy_fingerprint: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.conn.execute(
            "INSERT INTO runs (run_id, conversation_id, started_at, status, provider, model, policy_version, policy_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run_id,
                conversation_id,
                started_at,
                status,
                provider,
                model,
                policy_version,
                policy_fingerprint
            ],
        )?;
        Ok(())
    }

    pub fn append_run_event(
        &mut self,
        run_id: &str,
        iteration: i64,
        channel: &str,
        event_type: &str,
        payload: &JsonValue,
        ts: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let payload_json = serde_json::to_string(payload)?;
        self.conn.execute(
            "INSERT INTO run_events (run_id, iteration, channel, event_type, payload, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![run_id, iteration, channel, event_type, payload_json, ts],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn finish_run(
        &mut self,
        run_id: &str,
        finished_at: &str,
        status: &str,
        tool_calls: i64,
        write_calls: i64,
        verify_failures: i64,
        duration_ms: i64,
        token_usage: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.conn.execute(
            "UPDATE runs
             SET finished_at = ?2,
                 status = ?3,
                 tool_calls = ?4,
                 write_calls = ?5,
                 verify_failures = ?6,
                 duration_ms = ?7,
                 token_usage = ?8
             WHERE run_id = ?1",
            params![
                run_id,
                finished_at,
                status,
                tool_calls,
                write_calls,
                verify_failures,
                duration_ms,
                token_usage
            ],
        )?;
        Ok(())
    }

    pub fn list_runs(
        &self,
        conversation_id: Option<i64>,
        limit: usize,
    ) -> Result<Vec<RunSummary>, Box<dyn std::error::Error>> {
        let query_with_conversation = "
            SELECT run_id, conversation_id, started_at, finished_at, status, provider, model, policy_version, policy_fingerprint,
                   tool_calls, write_calls, verify_failures, duration_ms, token_usage
            FROM runs
            WHERE conversation_id = ?1
            ORDER BY datetime(started_at) DESC, run_id DESC
            LIMIT ?2";

        let query_without_conversation = "
            SELECT run_id, conversation_id, started_at, finished_at, status, provider, model, policy_version, policy_fingerprint,
                   tool_calls, write_calls, verify_failures, duration_ms, token_usage
            FROM runs
            ORDER BY datetime(started_at) DESC, run_id DESC
            LIMIT ?1";

        let mut rows_buffer: Vec<RunSummary> = Vec::new();

        if let Some(conversation_id) = conversation_id {
            let mut stmt = self.conn.prepare(query_with_conversation)?;
            let rows =
                stmt.query_map(params![conversation_id.to_string(), limit as i64], |row| {
                    let token_usage_raw: Option<String> = row.get(13)?;
                    Ok(RunSummary {
                        run_id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        started_at: row.get(2)?,
                        finished_at: row.get(3)?,
                        status: row.get(4)?,
                        provider: row.get(5)?,
                        model: row.get(6)?,
                        policy_version: row.get(7)?,
                        policy_fingerprint: row.get(8)?,
                        tool_calls: row.get(9)?,
                        write_calls: row.get(10)?,
                        verify_failures: row.get(11)?,
                        duration_ms: row.get(12)?,
                        token_usage: parse_json_field(token_usage_raw),
                    })
                })?;

            for row in rows {
                rows_buffer.push(row?);
            }
        } else {
            let mut stmt = self.conn.prepare(query_without_conversation)?;
            let rows = stmt.query_map(params![limit as i64], |row| {
                let token_usage_raw: Option<String> = row.get(13)?;
                Ok(RunSummary {
                    run_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    started_at: row.get(2)?,
                    finished_at: row.get(3)?,
                    status: row.get(4)?,
                    provider: row.get(5)?,
                    model: row.get(6)?,
                    policy_version: row.get(7)?,
                    policy_fingerprint: row.get(8)?,
                    tool_calls: row.get(9)?,
                    write_calls: row.get(10)?,
                    verify_failures: row.get(11)?,
                    duration_ms: row.get(12)?,
                    token_usage: parse_json_field(token_usage_raw),
                })
            })?;

            for row in rows {
                rows_buffer.push(row?);
            }
        }

        Ok(rows_buffer)
    }

    pub fn get_run_events(
        &self,
        run_id: &str,
    ) -> Result<Vec<RunEvent>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, iteration, channel, event_type, payload, ts
             FROM run_events
             WHERE run_id = ?1
             ORDER BY iteration ASC, id ASC",
        )?;

        let rows = stmt.query_map(params![run_id], |row| {
            let payload_raw: String = row.get(5)?;
            let payload = serde_json::from_str::<serde_json::Value>(&payload_raw)
                .unwrap_or(serde_json::Value::String(payload_raw));
            Ok(RunEvent {
                id: row.get(0)?,
                run_id: row.get(1)?,
                iteration: row.get(2)?,
                channel: row.get(3)?,
                event_type: row.get(4)?,
                payload,
                ts: row.get(6)?,
            })
        })?;

        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }
}

#[derive(Debug)]
struct MergedCandidate {
    chunk: ChunkResult,
    score: f64,
}

fn normalize_heading_path(value: Option<String>) -> Option<String> {
    value.and_then(|heading| {
        let trimmed = heading.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn build_fts_query(query: &str) -> Option<String> {
    let mut terms = Vec::new();
    for token in query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| token.chars().count() >= 2)
    {
        let cleaned = token.trim().to_lowercase();
        if cleaned.is_empty() || terms.iter().any(|existing| existing == &cleaned) {
            continue;
        }
        terms.push(cleaned);
        if terms.len() >= 12 {
            break;
        }
    }

    if terms.is_empty() {
        return None;
    }

    Some(
        terms
            .iter()
            .map(|term| format!("\"{}\"*", term.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

fn rrf_score(rank: usize, k: f64) -> f64 {
    1.0 / (k + rank as f64)
}

fn sync_chunks_fts(conn: &Connection) -> rusqlite::Result<()> {
    if !table_exists(conn, "chunks_fts")? {
        return Ok(());
    }

    let chunk_count: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;
    let fts_count: i64 = conn.query_row("SELECT COUNT(*) FROM chunks_fts", [], |row| row.get(0))?;

    if chunk_count == fts_count {
        return Ok(());
    }

    conn.execute("DELETE FROM chunks_fts", [])?;
    conn.execute(
        "INSERT INTO chunks_fts(rowid, content, file_path, chunk_index, heading_path)
         SELECT id, content, file_path, chunk_index, COALESCE(heading_path, '')
         FROM chunks",
        [],
    )?;
    Ok(())
}

fn parse_json_field(raw: Option<String>) -> Option<serde_json::Value> {
    raw.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            serde_json::from_str::<serde_json::Value>(trimmed)
                .ok()
                .or(Some(serde_json::Value::String(value)))
        }
    })
}

fn ignore_duplicate_column_error(result: rusqlite::Result<usize>) -> rusqlite::Result<()> {
    match result {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.to_ascii_lowercase().contains("duplicate column name") =>
        {
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let sql = format!(
        "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = ?1",
        table.replace('\'', "''")
    );
    let count: i64 = conn.query_row(&sql, params![column], |row| row.get(0))?;
    Ok(count > 0)
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1",
        params![table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

#[cfg(test)]
mod tests;
