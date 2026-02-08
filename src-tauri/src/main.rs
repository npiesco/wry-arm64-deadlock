// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, Window};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct BrowserTab {
    id: String,
    label: String,
    title: String,
    url: String,
    is_active: bool,
}

struct AppState {
    browser_tabs: Arc<Mutex<Vec<BrowserTab>>>,
    active_tab_id: Arc<Mutex<Option<String>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            browser_tabs: Arc::new(Mutex::new(Vec::new())),
            active_tab_id: Arc::new(Mutex::new(None)),
        }
    }
}

/// Height of the toolbar + tab-bar in the main window (pixels).
const TOOLBAR_HEIGHT: f64 = 70.0;

/// Switch the active tab: hide old, show new.
fn switch_to_tab_internal(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    tab_id: &str,
) -> Result<String, String> {
    let mut tabs = state.browser_tabs.lock().unwrap();

    let tab_index = tabs
        .iter()
        .position(|t| t.id == tab_id)
        .ok_or_else(|| "Tab not found".to_string())?;

    let mut active_id = state.active_tab_id.lock().unwrap();
    if let Some(current_id) = active_id.as_ref() {
        if let Some(current_tab) = tabs.iter_mut().find(|t| &t.id == current_id) {
            current_tab.is_active = false;
            if let Some(win) = app.get_webview_window(&current_tab.label) {
                win.hide().ok();
            }
        }
    }

    tabs[tab_index].is_active = true;
    let label = tabs[tab_index].label.clone();
    drop(tabs);

    if let Some(win) = app.get_webview_window(&label) {
        win.show().map_err(|e| format!("Failed to show window: {}", e))?;
    }

    *active_id = Some(tab_id.to_string());
    drop(active_id);

    Ok(format!("Switched to tab: {}", tab_id))
}

#[tauri::command]
async fn create_new_tab(
    app: tauri::AppHandle,
    window: Window,
    state: tauri::State<'_, AppState>,
    url: Option<String>,
) -> Result<String, String> {
    let tab_id = uuid::Uuid::new_v4().to_string();
    let window_label = format!("browser_tab_{}", tab_id);

    let main_pos = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;

    let target_url = url.unwrap_or_else(|| "about:blank".to_string());
    let parsed_url = target_url
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let main_size = window
        .inner_size()
        .map_err(|e| format!("Failed to get window size: {}", e))?;
    let browser_width = main_size.width as f64;
    let browser_height = (main_size.height as f64) - TOOLBAR_HEIGHT;

    // This .build() call is where the deadlock can occur on ARM64
    let _browser_window = tauri::WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::External(parsed_url),
    )
    .title(&target_url)
    .inner_size(browser_width.max(800.0), browser_height.max(400.0))
    .position(main_pos.x as f64, (main_pos.y as f64) + TOOLBAR_HEIGHT)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("Failed to create browser window: {}", e))?;

    let new_tab = BrowserTab {
        id: tab_id.clone(),
        label: window_label.clone(),
        title: target_url.clone(),
        url: target_url.clone(),
        is_active: false,
    };

    state.browser_tabs.lock().unwrap().push(new_tab.clone());
    switch_to_tab_internal(&app, &state, &tab_id)?;

    Ok(serde_json::to_string(&new_tab).unwrap())
}

#[tauri::command]
async fn close_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tab_id: String,
) -> Result<String, String> {
    let mut tabs = state.browser_tabs.lock().unwrap();
    let tab_index = tabs
        .iter()
        .position(|t| t.id == tab_id)
        .ok_or_else(|| "Tab not found".to_string())?;

    let tab = tabs.remove(tab_index);
    let was_active = tab.is_active;
    let tabs_remaining = tabs.len();
    drop(tabs);

    if let Some(browser_win) = app.get_webview_window(&tab.label) {
        browser_win.close().ok();
    }

    if tabs_remaining == 0 {
        *state.active_tab_id.lock().unwrap() = None;
        return Ok("All tabs closed".to_string());
    }

    if was_active {
        let tabs = state.browser_tabs.lock().unwrap();
        let next_tab_id = tabs[tab_index.min(tabs_remaining - 1)].id.clone();
        drop(tabs);
        switch_to_tab_internal(&app, &state, &next_tab_id)?;
    }

    Ok("Tab closed".to_string())
}

#[tauri::command]
async fn close_all_tabs(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let tabs = state.browser_tabs.lock().unwrap().clone();
    for tab in tabs {
        if let Some(browser_win) = app.get_webview_window(&tab.label) {
            browser_win.close().ok();
        }
    }
    *state.browser_tabs.lock().unwrap() = Vec::new();
    *state.active_tab_id.lock().unwrap() = None;
    Ok("All tabs closed".to_string())
}

#[tauri::command]
async fn switch_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tab_id: String,
) -> Result<String, String> {
    switch_to_tab_internal(&app, &state, &tab_id)
}

#[tauri::command]
async fn get_all_tabs(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let tabs = state.browser_tabs.lock().unwrap();
    Ok(serde_json::to_string(&*tabs).unwrap())
}

/// THE DEADLOCK TRIGGER
///
/// This command closes the existing webview window and immediately
/// creates a new one with the SAME label.  On Windows ARM64
/// (Snapdragon X Elite / X Plus), the .build() call deadlocks inside
/// wry's wait_with_pump() because MsgWaitForMultipleObjectsEx does not
/// dispatch COM callbacks while the main webview's message loop is active.
#[tauri::command]
async fn navigate_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tab_id: String,
    url: String,
) -> Result<String, String> {
    let parsed_url = url
        .parse::<url::Url>()
        .map_err(|e| format!("Invalid URL: {}", e))?;

    let mut tabs = state.browser_tabs.lock().unwrap();
    let tab = tabs
        .iter_mut()
        .find(|t| t.id == tab_id)
        .ok_or_else(|| "Tab not found".to_string())?;

    tab.url = url.clone();
    tab.title = url.clone();
    let window_label = tab.label.clone();
    drop(tabs);

    // Close old window, rebuild with SAME label -> deadlocks on ARM64
    if let Some(browser_win) = app.get_webview_window(&window_label) {
        browser_win
            .close()
            .map_err(|e| format!("Failed to close window: {}", e))?;

        if let Some(main_win) = app.get_webview_window("main") {
            if let Ok(main_pos) = main_win.outer_position() {
                if let Ok(main_size) = main_win.inner_size() {
                    let browser_width = main_size.width as f64;
                    let browser_height = (main_size.height as f64) - TOOLBAR_HEIGHT;

                    let _new_browser_window = tauri::WebviewWindowBuilder::new(
                        &app,
                        &window_label,
                        WebviewUrl::External(parsed_url),
                    )
                    .title(&url)
                    .inner_size(browser_width.max(800.0), browser_height.max(400.0))
                    .position(main_pos.x as f64, (main_pos.y as f64) + TOOLBAR_HEIGHT)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .visible(true)
                    .build()
                    .map_err(|e| format!("Failed to create new window: {}", e))?;
                }
            }
        }
    }

    Ok(format!("Navigated to: {}", url))
}

fn main() {
    let app_state = AppState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .setup(|app| {
            // Keep browser-tab windows synced when the main window moves
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                let main_window_clone = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Moved(_) = event {
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            let tabs = state.browser_tabs.lock().unwrap().clone();
                            for tab in tabs {
                                if let Some(browser_win) =
                                    app_handle.get_webview_window(&tab.label)
                                {
                                    if let Ok(physical_pos) =
                                        main_window_clone.outer_position()
                                    {
                                        if let Ok(sf) =
                                            main_window_clone.scale_factor()
                                        {
                                            let lx = physical_pos.x as f64 / sf;
                                            let ly = physical_pos.y as f64 / sf;
                                            browser_win
                                                .set_position(
                                                    tauri::Position::Logical(
                                                        tauri::LogicalPosition {
                                                            x: lx,
                                                            y: ly + TOOLBAR_HEIGHT,
                                                        },
                                                    ),
                                                )
                                                .ok();
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_new_tab,
            close_tab,
            close_all_tabs,
            switch_tab,
            get_all_tabs,
            navigate_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}