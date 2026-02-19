/// Opens the built-in WebKit Inspector for the current webview.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}
