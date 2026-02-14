use serde_json::{json, Value};

use crate::core::ports::emitter::EmitterPort;

use super::state::AgentState;

pub(super) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(super) fn emit_run_state(
    emitter: &dyn EmitterPort,
    run_id: &str,
    state: AgentState,
    iteration: usize,
    reason: Option<&str>,
) -> Value {
    let state_str = state.as_str();
    let mut payload = serde_json::Map::new();
    payload.insert("run_id".to_string(), json!(run_id));
    payload.insert("state".to_string(), json!(state_str));
    payload.insert("iteration".to_string(), json!(iteration));
    payload.insert("ts".to_string(), json!(now_iso()));
    if let Some(reason) = reason {
        payload.insert("reason".to_string(), json!(reason));
    }

    let value = Value::Object(payload);
    emitter.emit("agent:run_state", &value);
    emitter.emit(
        "agent:status",
        &json!({
            "status": state_str,
            "iteration": iteration,
            "reason": reason,
            "run_id": run_id,
        }),
    );
    emitter.emit("agent:lifecycle", &value);
    value
}

#[allow(clippy::too_many_arguments)]
pub(super) fn emit_timeline_step(
    emitter: &dyn EmitterPort,
    run_id: &str,
    iteration: usize,
    phase: &str,
    tool: Option<&str>,
    args_preview: Option<Value>,
    result_preview: Option<String>,
    file_changes: Option<Value>,
) {
    let mut payload = serde_json::Map::new();
    payload.insert("id".to_string(), json!(uuid::Uuid::new_v4().to_string()));
    payload.insert("run_id".to_string(), json!(run_id));
    payload.insert("iteration".to_string(), json!(iteration));
    payload.insert("phase".to_string(), json!(phase));
    payload.insert("ts".to_string(), json!(now_iso()));

    if let Some(tool_name) = tool {
        payload.insert("tool".to_string(), json!(tool_name));
    }
    if let Some(args) = args_preview {
        payload.insert("args_preview".to_string(), args);
    }
    if let Some(preview) = result_preview {
        payload.insert("result_preview".to_string(), json!(preview));
    }
    if let Some(changes) = file_changes {
        payload.insert("file_changes".to_string(), changes);
    }

    emitter.emit("agent:timeline_step", &Value::Object(payload));
}

pub(super) fn emit_timeline_done(
    emitter: &dyn EmitterPort,
    run_id: &str,
    iteration: usize,
    steps: usize,
) {
    emitter.emit(
        "agent:timeline_done",
        &json!({
            "run_id": run_id,
            "iteration": iteration,
            "steps": steps,
            "ts": now_iso(),
        }),
    );
}
