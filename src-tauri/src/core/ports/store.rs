use serde_json::Value;

use crate::core::agent::state::AgentState;

pub struct RunStartRecord<'a> {
    pub run_id: &'a str,
    pub conversation_id: i64,
    pub provider: &'a str,
    pub model: &'a str,
    pub policy_version: &'a str,
    pub policy_fingerprint: &'a str,
}

pub struct RunFinishRecord<'a> {
    pub run_id: &'a str,
    pub status: AgentState,
    pub tool_calls: u32,
    pub write_calls: u32,
    pub verify_failures: u32,
    pub duration_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

pub trait StorePort: Send + Sync {
    fn start_run(&self, record: RunStartRecord<'_>);
    fn log_event(
        &self,
        run_id: &str,
        iteration: usize,
        channel: &str,
        event_type: &str,
        payload: &Value,
    );
    fn finish_run(&self, record: RunFinishRecord<'_>);
}
