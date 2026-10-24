//! Review-only assembly: transactional Margin document services, without Edda's
//! workbench startup, background jobs, settings migration or update channel.

mod ai;
mod commands;
#[cfg(windows)]
mod frame;
use commands::*;
use std::{collections::HashSet, path::PathBuf, sync::Mutex};
use tauri::Manager;
use tauri_plugin_fs::FsExt;

#[tauri::command]
async fn margin_frame_theme(
    window: tauri::WebviewWindow,
    background: [u8; 3],
    foreground: [u8; 3],
    dark: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        window
            .set_theme(Some(if dark {
                tauri::Theme::Dark
            } else {
                tauri::Theme::Light
            }))
            .map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        window
            .run_on_main_thread(move || {
                frame::theme(
                    windows::Win32::Foundation::HWND(hwnd as *mut _),
                    background,
                    foreground,
                    dark,
                )
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (window, background, foreground, dark);
    Ok(())
}

#[derive(Default)]
pub(super) struct MarginRoots(Mutex<HashSet<PathBuf>>);

#[tauri::command]
async fn margin_open_workspace(
    app: tauri::AppHandle,
    roots: tauri::State<'_, MarginRoots>,
    ai: tauri::State<'_, ai::Controller>,
    path: String,
) -> Result<String, String> {
    let root = margin_core::fs::resolve_vault(&path)
        .and_then(|p| std::fs::canonicalize(p).map_err(margin_core::error::AppError::from))
        .map_err(|e| e.to_string())?;
    ai.stop().await?;
    app.fs_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;
    roots
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(root.clone());
    // Opening a folder does not create a Vault/catalog or migrate its data.
    Ok(root.to_string_lossy().replace('\\', "/"))
}

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MarginRoots::default())
        .manage(ai::Controller::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    window.set_icon(icon.clone())?;
                }
                #[cfg(windows)]
                frame::install(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            margin_open_workspace,
            margin_frame_theme,
            crate::fonts::commands::export_system_cjk_font,
            margin_create,
            margin_import,
            margin_parse_pdf,
            margin_list,
            margin_open,
            margin_stamp,
            margin_command,
            margin_updates,
            margin_revision,
            margin_suggestions,
            margin_diff,
            margin_export,
            margin_proposal_detail,
            margin_ai_start,
            margin_ai_stop,
            margin_ai_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Margin");
}
