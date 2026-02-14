use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::core::ports::emitter::EmitterPort;

pub struct TauriEmitter {
    app: AppHandle,
}

impl TauriEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EmitterPort for TauriEmitter {
    fn emit(&self, channel: &str, payload: &Value) {
        let _ = self.app.emit(channel, payload);
    }
}
