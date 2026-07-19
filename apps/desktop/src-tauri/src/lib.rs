//! SkillKeeper desktop (Tauri) entry point and command registration.

mod app;
mod commands;
pub mod pty;
mod state;

use tauri::{Emitter, Manager};

use std::sync::Arc;

use crate::pty::TerminalEvent;
use crate::state::AppContext;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = AppContext::new().expect("failed to build the SkillKeeper app context");

    // Override the process UI language before AppKit initializes so the standard
    // menu items macOS injects itself (the Window tiling group) localize to the
    // configured language, not the system one. Mirrors `menu::current_lang`, but
    // reads `context` directly since it is not managed as state yet.
    {
        let loaded = skillkeeper_config::load_config(&context.fs, &context.paths.config_yaml);
        let lang = serde_json::to_value(loaded.config.general.language)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "en".to_string());
        app::menu::set_process_language(&lang);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Shared as `Arc` so heavy commands can move a cheap handle into a
        // `spawn_blocking` closure (see `commands::blocking`).
        .manage(Arc::new(context))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                commands::window::wire_window_chrome(&window);
                let theme = commands::config::load(&app.state::<Arc<AppContext>>())
                    .config
                    .general
                    .theme;
                app::theme::apply(&window, theme);
                app::theme::wire_system_theme_follow(&window);
            }
            // Publish an ssh-agent to the process env before any git command may
            // run, so git subprocesses inherit SSH_AUTH_SOCK.
            app::ssh_agent::ensure_ssh_agent();
            // macOS-only application menu (no-op elsewhere).
            app::menu::install(app.handle())?;
            // macOS: make Cmd+Q / Dock-Quit / the Quit menu item exit fast
            // instead of dragging through AppKit's ~15s terminate: teardown.
            #[cfg(target_os = "macos")]
            app::install_fast_terminate();
            app::watcher::start(app.handle().clone());
            // Pump the terminal reader thread's output to the frontend. The
            // manager can only hand out its event receiver once; `setup` is the
            // first place the `AppHandle` needed to emit is available.
            if let Some(events) = app.state::<Arc<AppContext>>().terminal.take_events() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    while let Ok(event) = events.recv() {
                        match event {
                            TerminalEvent::Data(chunk) => {
                                let _ = handle.emit("terminal:data", chunk);
                            }
                            TerminalEvent::Exit => {
                                let _ = handle.emit("terminal:exit", ());
                            }
                            TerminalEvent::RequestOpen => {
                                let _ = handle.emit("terminal:requestOpen", ());
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::window::get_app_version,
            commands::window::platform,
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_close,
            commands::window::window_is_maximized,
            commands::config::config_get,
            commands::config::config_set,
            commands::state_read::repositories_list,
            commands::state_read::projects_list,
            commands::state_read::skills_list,
            commands::repositories::repositories_add,
            commands::repositories::repositories_clone,
            commands::repositories::repositories_update,
            commands::repositories::repositories_remove,
            commands::repositories::repositories_sync,
            commands::repositories::repositories_has_update,
            commands::repositories::repositories_describe,
            commands::repositories::repositories_list_branches,
            commands::skills::skills_available,
            commands::skills::skills_reconcile,
            commands::skills::skills_apply,
            commands::mcp::mcp_list_available,
            commands::mcp::mcp_apply,
            commands::mcp::mcp_installs,
            commands::mcp::mcp_reconcile,
            commands::mcp::mcp_update,
            commands::mcp::mcp_update_preflight,
            commands::editors::editors_list,
            commands::editors::open_config_in_editor,
            commands::editors::open_project,
            commands::editors::open_external,
            commands::projects::projects_add,
            commands::projects::projects_update,
            commands::projects::projects_remove,
            commands::projects::projects_exists,
            commands::projects::projects_describe,
            commands::projects::projects_detect_agents,
            commands::dialog::dialog_select_folder,
            commands::terminal::terminal_start,
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_clear_buffer,
            commands::terminal::terminal_run_ssh_add,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match &event {
            // Once the app has finished launching, (re)apply the dock icon for
            // the active theme. The icon set during `setup` is applied before
            // launch completes and is clobbered by the system loading the bundle
            // icon, so a dark-mode launch would otherwise show the light icon.
            tauri::RunEvent::Ready => {
                if let Some(window) = app.get_webview_window("main") {
                    let theme = commands::config::load(&app.state::<Arc<AppContext>>())
                        .config
                        .general
                        .theme;
                    app::theme::refresh_dock_icon(&window, theme);
                }
            }
            // Quit the whole app when the main window closes (macOS would
            // otherwise keep it running window-less) or on any exit request
            // (Cmd+Q / the Quit menu item routed to `terminate:`).
            tauri::RunEvent::ExitRequested { .. } => app::quit(app),
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } if label == "main" => app::quit(app),
            _ => {}
        });
}
