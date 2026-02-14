use std::sync::atomic::{AtomicBool, Ordering};

static INDEXING_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_indexing_active(active: bool) {
    INDEXING_ACTIVE.store(active, Ordering::SeqCst);
}

pub fn is_indexing_active() -> bool {
    INDEXING_ACTIVE.load(Ordering::SeqCst)
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub enum AgentState {
    Accepted,
    Planning,
    Thinking,
    ToolCalling,
    Verifying,
    Responding,
    Completed,
    Failed,
    Timeout,
    Cancelled,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Accepted => "accepted",
            AgentState::Planning => "planning",
            AgentState::Thinking => "thinking",
            AgentState::ToolCalling => "tool_calling",
            AgentState::Verifying => "verifying",
            AgentState::Responding => "responding",
            AgentState::Completed => "completed",
            AgentState::Failed => "failed",
            AgentState::Timeout => "timeout",
            AgentState::Cancelled => "cancelled",
        }
    }
}
