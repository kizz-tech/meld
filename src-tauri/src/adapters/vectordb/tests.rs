use super::VectorDb;
use rusqlite::{params, Connection};
use std::path::PathBuf;

fn temp_db_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "meld-vectordb-migration-{}.db",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn open_migrates_legacy_conversations_schema() {
    let db_path = temp_db_path();

    // Legacy schema without title/updated_at and without messages.sources/tool_calls/timeline.
    let conn = Connection::open(&db_path).expect("open temp sqlite");
    conn.execute_batch(
        "
        CREATE TABLE conversations (
            id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ",
    )
    .expect("create legacy schema");
    drop(conn);

    let db = VectorDb::open(&db_path).expect("migrate legacy schema");

    let has_title: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name = 'title'",
            [],
            |row| row.get(0),
        )
        .expect("check title column");
    let has_updated_at: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name = 'updated_at'",
            [],
            |row| row.get(0),
        )
        .expect("check updated_at column");
    let has_timeline: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'timeline'",
            [],
            |row| row.get(0),
        )
        .expect("check timeline column");

    assert_eq!(has_title, 1);
    assert_eq!(has_updated_at, 1);
    assert_eq!(has_timeline, 1);

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn open_migrates_legacy_chunks_without_heading_path() {
    let db_path = temp_db_path();

    let conn = Connection::open(&db_path).expect("open temp sqlite");
    conn.execute_batch(
        "
        CREATE TABLE chunks (
            id INTEGER PRIMARY KEY,
            file_path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            char_start INTEGER NOT NULL,
            char_end INTEGER NOT NULL,
            file_hash TEXT NOT NULL,
            embedding BLOB,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(file_path, chunk_index)
        );
        ",
    )
    .expect("create legacy chunks");
    drop(conn);

    let db = VectorDb::open(&db_path).expect("open should migrate legacy chunks");

    let has_heading_path: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('chunks') WHERE name = 'heading_path'",
            [],
            |row| row.get(0),
        )
        .expect("check heading_path column");
    assert_eq!(has_heading_path, 1);

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn get_last_user_message_respects_assistant_anchor() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    let conversation_id = db
        .create_conversation("regenerate test")
        .expect("create conversation");
    let _user_1 = db
        .save_message(
            conversation_id,
            "user",
            "first user prompt",
            None,
            None,
            None,
        )
        .expect("save first user");
    let assistant_1 = db
        .save_message(
            conversation_id,
            "assistant",
            "first answer",
            None,
            None,
            None,
        )
        .expect("save first assistant");
    let _user_2 = db
        .save_message(
            conversation_id,
            "user",
            "second user prompt",
            None,
            None,
            None,
        )
        .expect("save second user");
    let assistant_2 = db
        .save_message(
            conversation_id,
            "assistant",
            "second answer",
            None,
            None,
            None,
        )
        .expect("save second assistant");

    let latest = db
        .get_last_user_message(conversation_id, None)
        .expect("query latest user message");
    assert_eq!(latest, Some("second user prompt".to_string()));

    let before_second_assistant = db
        .get_last_user_message(conversation_id, Some(assistant_2))
        .expect("query user message before second assistant");
    assert_eq!(
        before_second_assistant,
        Some("second user prompt".to_string())
    );

    let before_first_assistant = db
        .get_last_user_message(conversation_id, Some(assistant_1))
        .expect("query user message before first assistant");
    assert_eq!(
        before_first_assistant,
        Some("first user prompt".to_string())
    );

    let err = db
        .get_last_user_message(conversation_id, Some(assistant_1 - 1))
        .expect_err("non-assistant anchor must fail");
    assert!(err.to_string().contains("is not an assistant message"));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn truncate_messages_from_removes_anchor_and_suffix() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    let conversation_id = db
        .create_conversation("truncate test")
        .expect("create conversation");
    let _user_1 = db
        .save_message(conversation_id, "user", "u1", None, None, None)
        .expect("save u1");
    let assistant_1 = db
        .save_message(conversation_id, "assistant", "a1", None, None, None)
        .expect("save a1");
    let _user_2 = db
        .save_message(conversation_id, "user", "u2", None, None, None)
        .expect("save u2");
    let assistant_2 = db
        .save_message(conversation_id, "assistant", "a2", None, None, None)
        .expect("save a2");

    let deleted = db
        .truncate_messages_from(conversation_id, assistant_2)
        .expect("truncate from assistant");
    assert_eq!(deleted, 1);

    let messages = db
        .get_conversation_messages(conversation_id)
        .expect("load messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].content, "u1");
    assert_eq!(messages[1].content, "a1");
    assert_eq!(messages[2].content, "u2");

    let last_assistant = db
        .get_last_assistant_message_id(conversation_id)
        .expect("query last assistant id");
    assert_eq!(last_assistant, Some(assistant_1));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn edit_user_message_and_truncate_rewrites_history_branch() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    let conversation_id = db
        .create_conversation("edit test")
        .expect("create conversation");
    let user_1 = db
        .save_message(conversation_id, "user", "original", None, None, None)
        .expect("save user");
    let assistant_1 = db
        .save_message(conversation_id, "assistant", "a1", None, None, None)
        .expect("save assistant");
    let _user_2 = db
        .save_message(conversation_id, "user", "u2", None, None, None)
        .expect("save second user");

    let role_err = db
        .edit_user_message_and_truncate(assistant_1, "should fail")
        .expect_err("editing assistant message must fail");
    assert!(role_err.to_string().contains("not a user"));

    let edited_conversation_id = db
        .edit_user_message_and_truncate(user_1, "updated prompt")
        .expect("edit user message");
    assert_eq!(edited_conversation_id, conversation_id);

    let messages = db
        .get_conversation_messages(conversation_id)
        .expect("load messages");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].role, "user");
    assert_eq!(messages[0].content, "updated prompt");

    let latest_user = db
        .get_last_user_message(conversation_id, None)
        .expect("load latest user message");
    assert_eq!(latest_user, Some("updated prompt".to_string()));

    let err = db
        .edit_user_message_and_truncate(user_1 + 1000, "x")
        .expect_err("editing missing message must fail");
    assert!(err.to_string().contains("not found"));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn run_ledger_roundtrip_persists_events_and_proof() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    db.create_run(
        "run-test-1",
        "42",
        "2026-02-14T10:00:00Z",
        "accepted",
        Some("openai"),
        Some("gpt-4.1"),
        Some("policy.v1"),
        Some("abc123"),
    )
    .expect("create run");

    let event_payload = serde_json::json!({
        "tool": "kb_update",
        "proof": {
            "hash_before": "abc",
            "hash_after": "def",
            "readback_ok": true
        }
    });

    db.append_run_event(
        "run-test-1",
        1,
        "verification",
        "agent:verification",
        &event_payload,
        "2026-02-14T10:00:05Z",
    )
    .expect("append run event");

    db.finish_run(
        "run-test-1",
        "2026-02-14T10:00:10Z",
        "completed",
        3,
        1,
        0,
        10000,
        Some(
            &serde_json::to_string(&serde_json::json!({
                "input_tokens": 120,
                "output_tokens": 45,
                "total_tokens": 165,
                "reasoning_tokens": 10,
            }))
            .expect("serialize token usage"),
        ),
    )
    .expect("finish run");

    let status: String = db
        .conn
        .query_row(
            "SELECT status FROM runs WHERE run_id = ?1",
            params!["run-test-1"],
            |row| row.get(0),
        )
        .expect("query run status");
    assert_eq!(status, "completed");

    let payload_raw: String = db
        .conn
        .query_row(
            "SELECT payload FROM run_events WHERE run_id = ?1",
            params!["run-test-1"],
            |row| row.get(0),
        )
        .expect("query run event payload");
    let payload: serde_json::Value =
        serde_json::from_str(&payload_raw).expect("parse run event payload");
    assert_eq!(
        payload
            .pointer("/proof/hash_before")
            .and_then(|v| v.as_str()),
        Some("abc")
    );
    assert_eq!(
        payload
            .pointer("/proof/hash_after")
            .and_then(|v| v.as_str()),
        Some("def")
    );
    assert_eq!(
        payload
            .pointer("/proof/readback_ok")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    let token_usage_raw: Option<String> = db
        .conn
        .query_row(
            "SELECT token_usage FROM runs WHERE run_id = ?1",
            params!["run-test-1"],
            |row| row.get(0),
        )
        .expect("query run token usage");
    let token_usage: serde_json::Value = serde_json::from_str(
        token_usage_raw
            .as_deref()
            .expect("token usage should be present"),
    )
    .expect("parse token usage");
    assert_eq!(
        token_usage.get("input_tokens"),
        Some(&serde_json::json!(120))
    );
    assert_eq!(
        token_usage.get("output_tokens"),
        Some(&serde_json::json!(45))
    );
    assert_eq!(
        token_usage.get("total_tokens"),
        Some(&serde_json::json!(165))
    );

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn resolve_conversation_chat_model_id_inherits_parent_folder_model() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    let parent_folder_id = db
        .create_folder("Parent", None)
        .expect("create parent folder");
    db.update_folder(parent_folder_id, None, None, Some("openai:gpt-5"))
        .expect("set parent default model");

    let child_folder_id = db
        .create_folder("Child", Some(parent_folder_id))
        .expect("create child folder");
    db.update_folder(child_folder_id, None, None, Some("   "))
        .expect("child folder default model should be empty");

    let conversation_id = db
        .create_conversation("inherit-model")
        .expect("create conversation");
    db.set_conversation_folder(conversation_id, Some(child_folder_id))
        .expect("assign conversation to child folder");

    let resolved = db
        .resolve_conversation_chat_model_id(conversation_id)
        .expect("resolve model through folder chain");
    assert_eq!(resolved.as_deref(), Some("openai:gpt-5"));

    let _ = std::fs::remove_file(db_path);
}

#[test]
fn resolve_conversation_chat_model_id_skips_invalid_models_in_folder_chain() {
    let db_path = temp_db_path();
    let mut db = VectorDb::open(&db_path).expect("open db");

    let root_folder_id = db.create_folder("Root", None).expect("create root folder");
    db.update_folder(root_folder_id, None, None, Some("openai:gpt-5"))
        .expect("set root default model");

    let parent_folder_id = db
        .create_folder("Parent", Some(root_folder_id))
        .expect("create parent folder");
    db.update_folder(parent_folder_id, None, None, Some("missing-separator"))
        .expect("set parent invalid default model");

    let child_folder_id = db
        .create_folder("Child", Some(parent_folder_id))
        .expect("create child folder");
    db.update_folder(child_folder_id, None, None, Some("openai:"))
        .expect("set child invalid default model");

    let conversation_id = db
        .create_conversation("inherit-model-invalid")
        .expect("create conversation");
    db.set_conversation_folder(conversation_id, Some(child_folder_id))
        .expect("assign conversation to child folder");

    let resolved = db
        .resolve_conversation_chat_model_id(conversation_id)
        .expect("resolve model through invalid folder defaults");
    assert_eq!(resolved.as_deref(), Some("openai:gpt-5"));

    let _ = std::fs::remove_file(db_path);
}
