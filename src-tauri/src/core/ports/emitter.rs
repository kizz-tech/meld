use serde_json::Value;

pub trait EmitterPort: Send + Sync {
    fn emit(&self, channel: &str, payload: &Value);
}
