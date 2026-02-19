pub mod adapters;
pub mod core;
pub mod runtime;

pub fn run() {
    env_logger::init();
    runtime::tauri_api::run();
}
