mod budget;
mod compaction;
mod events;
pub mod instructions;
mod ledger;
pub mod run;
pub mod state;
mod verification;

use std::sync::Arc;

use crate::core::ports::{emitter::EmitterPort, llm::LlmPort, store::StorePort, tools::ToolPort};

pub use budget::RunBudget;
pub use run::{RunRequest, RunResult};
pub use state::{is_indexing_active, set_indexing_active};

pub struct Agent {
    pub(crate) tools: Arc<dyn ToolPort>,
    pub(crate) llm: Arc<dyn LlmPort>,
    pub(crate) store: Arc<dyn StorePort>,
    pub(crate) emitter: Arc<dyn EmitterPort>,
}

impl Agent {
    pub fn new(
        tools: Arc<dyn ToolPort>,
        llm: Arc<dyn LlmPort>,
        store: Arc<dyn StorePort>,
        emitter: Arc<dyn EmitterPort>,
    ) -> Self {
        Self {
            tools,
            llm,
            store,
            emitter,
        }
    }
}
