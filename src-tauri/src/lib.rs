pub mod core;
pub mod adapters;
pub mod runtime;

pub fn run() {
    env_logger::init();
    runtime::tauri_api::run();
}
