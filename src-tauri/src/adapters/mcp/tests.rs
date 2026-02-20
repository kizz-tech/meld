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

    crate::adapters::vault::write_note(&vault, "existing.md", "old content").expect("seed note");

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
