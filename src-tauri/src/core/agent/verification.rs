use serde_json::{json, Value};

use super::events::now_iso;

pub(super) fn args_preview(args: &Value) -> Option<Value> {
    let object = args.as_object()?;
    let mut preview = serde_json::Map::new();

    for key in ["query", "path", "folder"] {
        if let Some(value) = object.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                preview.insert(key.to_string(), json!(trimmed));
            }
        }
    }

    if preview.is_empty() {
        None
    } else {
        Some(Value::Object(preview))
    }
}

pub(super) fn extract_result_preview(result: &Value) -> String {
    if let Some(summary) = result
        .get("result")
        .and_then(|v| v.get("summary"))
        .and_then(|v| v.as_str())
    {
        return summary.to_string();
    }
    if let Some(message) = result
        .get("error")
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
    {
        return message.to_string();
    }
    "Tool executed".to_string()
}

pub(super) fn extract_file_changes(result: &Value) -> Option<Value> {
    let target = result.get("target")?.as_object()?;
    let path = target.get("resolved_path")?.as_str()?;
    let write_action = result
        .get("result")
        .and_then(|v| v.get("write_action"))
        .and_then(|v| v.as_str())?;
    let noop = result
        .get("result")
        .and_then(|v| v.get("noop"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if noop {
        return Some(json!([]));
    }

    Some(json!([{
        "path": path,
        "action": write_action,
        "hash_before": result.get("proof").and_then(|v| v.get("hash_before")).cloned().unwrap_or(Value::Null),
        "hash_after": result.get("proof").and_then(|v| v.get("hash_after")).cloned().unwrap_or(Value::Null),
        "bytes": result.get("proof").and_then(|v| v.get("bytes")).cloned().unwrap_or(Value::Null),
        "readback_ok": result.get("proof").and_then(|v| v.get("readback_ok")).cloned().unwrap_or(Value::Null),
        "diff_stats": result.get("proof").and_then(|v| v.get("diff_stats")).cloned().unwrap_or(Value::Null),
    }]))
}

pub(super) fn build_verify_summary(result: &Value) -> String {
    let ok = result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let action = result
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let path = result
        .get("target")
        .and_then(|v| v.get("resolved_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("n/a");

    let proof = result.get("proof").and_then(|v| v.as_object());
    if let Some(proof) = proof {
        let readback_ok = proof
            .get("readback_ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let bytes = proof.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
        let hash_after = proof
            .get("hash_after")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        return format!(
            "verify {action}: ok={ok}, readback_ok={readback_ok}, bytes={bytes}, hash_after={hash_after}, path={path}"
        );
    }

    if ok {
        format!("verify {action}: ok=true, path={path}")
    } else {
        let err = result
            .get("error")
            .and_then(|v| v.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        format!("verify {action}: ok=false, error={err}")
    }
}

pub(super) fn build_verification_event(
    run_id: &str,
    iteration: usize,
    tool: &str,
    result: &Value,
) -> serde_json::Value {
    let target = result.get("target").cloned().unwrap_or(json!({}));
    let proof = result.get("proof").cloned().unwrap_or(json!({}));

    json!({
        "run_id": run_id,
        "iteration": iteration,
        "tool": tool,
        "ok": result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        "action": result.get("action").and_then(|v| v.as_str()).unwrap_or("unknown"),
        "target": target,
        "proof": proof,
        "error": result.get("error").cloned(),
        "ts": now_iso(),
    })
}
