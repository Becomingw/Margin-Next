//! Application assembly: plugins, managed state, setup, and event wiring.

#[cfg(test)]
mod bindings_test;
// `pub(crate)`: the mirror-shape anti-drift tests live in the owning modules
// of the private payload structs and reference the mirrors from here. Test
// builds only — the module does not exist otherwise.
#[cfg(test)]
pub(crate) mod events_contract;
mod handlers;
pub(crate) mod logging;
pub mod menu;
pub mod vault_session;

#[cfg(not(target_os = "ios"))]
pub mod finder_service;
pub use crate::features::open_request;
#[cfg(not(target_os = "ios"))]
pub mod terminal;
#[cfg(not(target_os = "ios"))]
pub mod window;

use crate::features::agent::plugins::{AgentPlugins, McpPlugin, McpPluginTransport};
use crate::features::agent::{AgentRegistry, AgentRunController};
use crate::features::markdown::wiki::WikiIndexState;
use crate::features::system::settings::{AppSettings, AppSettingsStore};
use crate::features::vault::rename::ExternalRenameRepairStore;
#[cfg(not(target_os = "ios"))]
use crate::features::vault::watcher::FsWatchController;
#[cfg(not(target_os = "ios"))]
use crate::integration::connector::ConnectorController;
#[cfg(not(target_os = "ios"))]
use crate::integration::mcp::tunnel::McpTunnelController;
#[cfg(not(target_os = "ios"))]
use crate::integration::mcp::McpController;
#[cfg(not(target_os = "ios"))]
use crate::integration::remote::RemoteRegistry;
#[cfg(not(target_os = "ios"))]
use std::sync::Arc;
#[cfg(not(target_os = "ios"))]
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Both ring and aws-lc-rs backends exist in the dependency tree; rustls
    // panics at connect time unless a process-wide default is installed.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = tauri::Builder::default();

    // Single-instance must be the first plugin so second-instance argv (deep
    // links on Windows/Linux) is forwarded before other plugins run.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            crate::app::open_request::handle_argv_urls(app, &argv);
            // `get_window`: a window hosting Browse child webviews is no
            // longer a WebviewWindow.
            if let Some(win) = app.get_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder = builder
        .register_asynchronous_uri_scheme_protocol("edda-arxiv", |_ctx, request, responder| {
            crate::features::paper::discovery::proxy::arxiv::handle(request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("edda-model", |_ctx, request, responder| {
            crate::features::paper::analyze::layout::model_assets::handle_model_uri(
                request, responder,
            );
        })
        .register_asynchronous_uri_scheme_protocol("edda-web", |_ctx, request, responder| {
            crate::features::web::proxy::handle(request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("edda-preview", |_ctx, request, responder| {
            crate::features::vault::preview::handle(request, responder);
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(logging::build_log_plugin().build());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_shell::init());
    }

    // Former-name config/data dirs must be in place before settings load.
    edda_core::app_rename::migrate_app_dirs();
    let settings_store = AppSettingsStore::load();
    let layout_backend = settings_store.layout_backend();
    let import_concurrency = settings_store.batch_import_concurrency();
    builder = builder
        .manage(settings_store)
        .manage(AgentRegistry::load())
        .manage(AgentPlugins::default())
        .manage(AgentRunController::new())
        .manage(std::sync::Arc::new(
            crate::features::agent::session::pool::AgentWarmPool::new(),
        ))
        .manage(crate::features::agent::AgentWarmGate::new())
        .manage(crate::features::agent::PermissionGate::new())
        .manage(crate::features::agent::ElicitationGate::new())
        .manage(crate::features::agent::AskUserGate::new())
        .manage(crate::integration::bridge::BridgeController::new())
        .manage(crate::integration::bridge::BridgeClientController::new())
        .manage(
            crate::features::jobs::JobCenter::with_layout_backend(&layout_backend)
                .with_import_concurrency(import_concurrency),
        )
        .manage(crate::features::paper::catalog::CapsCache::new())
        .manage(crate::features::review::ReviewEditCache::default())
        .manage(WikiIndexState::new())
        .manage(crate::features::vault::doctor::DoctorDirtyPathsState::default())
        .manage(ExternalRenameRepairStore::new())
        .manage(crate::integration::sync::SyncService::default())
        .manage(crate::app::open_request::PendingVaultOpen::new());

    #[cfg(not(target_os = "ios"))]
    {
        // Remote vault sessions are consumed by features (agent / import /
        // trash) through inversion traits defined in the features themselves;
        // register the registry both concretely (integration commands) and as
        // each trait object (feature commands).
        let remote_registry = Arc::new(RemoteRegistry::new());
        builder = builder
            .manage(FsWatchController::new())
            .manage(Arc::new(ConnectorController::new()))
            .manage(Arc::new(McpController::new()))
            .manage(
                Arc::new(crate::integration::mcp::workspace::WorkspaceMcpProvider)
                    as Arc<dyn crate::features::agent::workspace_tools::WorkspaceToolsProvider>,
            )
            .manage(Arc::new(McpTunnelController::new()))
            .manage(remote_registry.clone())
            .manage(remote_registry.clone() as Arc<dyn crate::features::agent::RemoteAgentHosts>)
            .manage(
                remote_registry.clone() as Arc<dyn crate::features::paper::import::RemoteImportOps>
            )
            .manage(
                remote_registry
                    as Arc<dyn crate::features::vault::trash::remote_ops::RemoteTrashOps>,
            );
    }

    builder = handlers::attach_handlers(builder);

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // The HTML boot shell is ready now; reveal it while React hydrates.
                // On Linux/GTK, calling show() on an already-visible window can
                // corrupt the native titlebar hit-test (buttons become dead until
                // a resize/double-click). Only show if currently hidden.
                let win = webview.window();
                if !win.is_visible().unwrap_or(false) {
                    let _ = win.show();
                }
            }
        });
    }

    builder = builder.setup(|app| {
        // JobCenter runner registry: business domains own their executors and
        // register them here at assembly time (P2 runner-registry refactor).
        // JobCenter itself lives in features/jobs, alongside the domains it
        // schedules.
        {
            let center = app.state::<crate::features::jobs::JobCenter>();
            crate::features::paper::analyze::refs::register_job_runners(&center);
            crate::features::paper::import::job_runners::register_job_runners(&center);
            crate::features::paper::analyze::layout::model_assets::register_job_runners(&center);
            let handle = app.handle().clone();
            center.set_layout_backend_source(move || {
                handle.state::<AppSettingsStore>().layout_backend()
            });
            // Deep edda-core pollers (pdf parse, asset downloads, citing
            // scans) check cancellation through the JobCenter task-id registry.
            crate::core::cancel::install_cancel_probe(crate::features::jobs::is_task_cancelled);
        }
        let settings_store = app.state::<AppSettingsStore>();
        let agents = app.state::<AgentRegistry>();
        let mut settings = settings_store
            .get()
            .map(|result| result.settings)
            .unwrap_or_default();
        // Migrate the old Agent-only proxy once into the shared network setting.
        if !settings.network_proxy_enabled {
            if let Ok((enabled, url)) = agents.proxy_settings() {
                if enabled {
                    settings.network_proxy_enabled = true;
                    settings.network_proxy_url = url;
                    let _ = settings_store.set(settings.clone());
                }
            }
        }
        // Settings-change reactions: domains subscribe at assembly time, so
        // the settings feature stays schema-agnostic with no edges into
        // agent/connector/import/jobs (P2-18 settings-layer refactor; mirrors
        // the JobCenter runner-registry pattern). Registered after the
        // one-shot proxy migration above so that migration `set` does not
        // fire reactions this boot sequence applies manually below.
        {
            let handle = app.handle().clone();
            settings_store.subscribe(move |s| {
                let _ = handle
                    .state::<AgentRegistry>()
                    .set_proxy(s.network_proxy_enabled, s.network_proxy_url.clone());
            });
            app.state::<AgentPlugins>().set(agent_plugins(&settings));
            let handle = app.handle().clone();
            settings_store.subscribe(move |s| {
                handle.state::<AgentPlugins>().set(agent_plugins(s));
            });
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                let handle = app.handle().clone();
                settings_store.subscribe(move |_s| {
                    crate::features::paper::import::refresh_parser_config(
                        &handle.state::<AppSettingsStore>(),
                    );
                });
            }
            #[cfg(not(target_os = "ios"))]
            {
                let handle = app.handle().clone();
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                settings_store.subscribe(move |_s| {
                    let handle = handle.clone();
                    let gate = gate.clone();
                    tauri::async_runtime::spawn(async move {
                        let _guard = gate.lock().await;
                        let Ok(latest) = handle.state::<AppSettingsStore>().get() else {
                            return;
                        };
                        let ctrl = Arc::clone(handle.state::<Arc<ConnectorController>>().inner());
                        if ctrl.status().port != latest.settings.connector_port {
                            ctrl.set_port(latest.settings.connector_port).await;
                        }
                        if ctrl.status().enabled != latest.settings.connector_enabled {
                            ctrl.set_enabled(latest.settings.connector_enabled).await;
                        }
                    });
                });
            }
            #[cfg(not(target_os = "ios"))]
            {
                let handle = app.handle().clone();
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                settings_store.subscribe(move |s| {
                    let ctrl = Arc::clone(handle.state::<Arc<McpController>>().inner());
                    let translator = s.translator_base_url.clone();
                    let note_mode = s.paper_note_mode.clone();
                    ctrl.set_translator_url(Some(translator));
                    ctrl.set_paper_note_mode(note_mode);
                    let handle = handle.clone();
                    let gate = gate.clone();
                    tauri::async_runtime::spawn(async move {
                        let _guard = gate.lock().await;
                        let Ok(latest) = handle.state::<AppSettingsStore>().get() else {
                            return;
                        };
                        // Read the latest desired state inside the serialized reaction;
                        // rapid saves must not apply an older port after a newer one.
                        if ctrl.port() != latest.settings.mcp_port {
                            ctrl.set_port(latest.settings.mcp_port).await;
                        }
                        if ctrl.status().enabled != latest.settings.mcp_enabled {
                            ctrl.set_enabled(latest.settings.mcp_enabled).await;
                        }
                        if !latest.settings.mcp_enabled {
                            handle.state::<Arc<McpTunnelController>>().stop();
                        }
                    });
                });
            }
            #[cfg(not(target_os = "ios"))]
            {
                let handle = app.handle().clone();
                settings_store.subscribe(move |s| {
                    let tunnel = Arc::clone(handle.state::<Arc<McpTunnelController>>().inner());
                    let mcp_url = format!("http://127.0.0.1:{}/mcp", s.mcp_port);
                    tauri::async_runtime::spawn(async move {
                        let _ = tunnel.mcp_url_changed(mcp_url).await;
                    });
                });
            }
            {
                let handle = app.handle().clone();
                settings_store.subscribe(move |s| {
                    let center = handle
                        .state::<crate::features::jobs::JobCenter>()
                        .inner()
                        .clone();
                    let backend = s.layout.backend.clone();
                    let import_cap = s.batch_import_concurrency.max(1) as usize;
                    let app = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        center.apply_layout_backend(&backend).await;
                        center.apply_import_concurrency(import_cap).await;
                        center.drain_and_spawn(&app).await;
                    });
                });
            }
        }
        crate::core::http::configure_proxy(
            settings.network_proxy_enabled,
            &settings.network_proxy_url,
        )?;
        crate::core::http::configure_github_mirror(
            settings.github_mirror_enabled,
            &settings.github_mirror_base_url,
        )?;
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        crate::features::paper::import::refresh_parser_config(&settings_store);
        let _ = agents.set_proxy(
            settings.network_proxy_enabled,
            settings.network_proxy_url.clone(),
        );
        // Prefetch PP-DocLayoutV3 into XDG as a JobCenter `modelDownload` job;
        // the tasks-panel projection shows progress, concurrent triggers dedupe.
        crate::features::paper::analyze::layout::model_assets::spawn_background_download(
            app.handle().clone(),
        );
        // Native menu is macOS-only; the renderer re-syncs the locale on mount.
        #[cfg(target_os = "macos")]
        {
            let menu = menu::build_menu(app.handle(), "en")?;
            app.set_menu(menu)?;
        }
        // Ensure registry is loaded early.
        let _ = app.state::<AgentRegistry>();
        let _ = app.state::<WikiIndexState>();
        let _ = app.state::<crate::features::vault::doctor::DoctorDirtyPathsState>();
        let _ = app.state::<ExternalRenameRepairStore>();
        #[cfg(not(target_os = "ios"))]
        {
            let connector = app.state::<Arc<ConnectorController>>();
            connector.set_app_handle(app.handle().clone());
            let remote = app.state::<Arc<RemoteRegistry>>();
            connector.set_remote_registry(Arc::clone(&remote));
        }
        #[cfg(not(target_os = "ios"))]
        {
            let mcp = app.state::<Arc<McpController>>();
            mcp.set_app_handle(app.handle().clone());
            mcp.set_translator_url(Some(settings.translator_base_url.clone()));
            mcp.set_paper_note_mode(settings.paper_note_mode.clone());
        }
        #[cfg(not(target_os = "ios"))]
        {
            let tunnel = app.state::<Arc<McpTunnelController>>();
            tunnel.set_app_handle(app.handle().clone());
        }
        log::info!(
            target: "edda::op",
            "op start app_ready debug={}",
            cfg!(debug_assertions)
        );

        // Desktop deep links: cold start + runtime open URLs.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            // Linux / Windows dev: associate schemes with the current executable.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!(target: "edda::op", "deep_link register_all failed: {e}");
                }
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let list: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
                crate::app::open_request::handle_deep_link_urls(app.handle(), &list);
            }
            // Dev / direct spawn: CLI may pass edda://… as argv when the
            // OS scheme is not registered (common with `tauri dev`).
            let argv: Vec<String> = std::env::args().collect();
            crate::app::open_request::handle_argv_urls(app.handle(), &argv);
            // Consume a request file left by `edda open` before we listened.
            if let Some(path) = crate::app::open_request::take_cli_open_request_file() {
                let _ = crate::app::open_request::handle_open_path(app.handle(), &path);
            }
            crate::app::open_request::spawn_cli_open_request_watcher(app.handle().clone());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let list: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                crate::app::open_request::handle_deep_link_urls(&handle, &list);
            });
        }

        // Finder "Open with Edda" Quick Action: default-installed and kept
        // current on macOS (opt-out remembered via a config marker).
        #[cfg(target_os = "macos")]
        {
            tauri::async_runtime::spawn_blocking(|| {
                crate::app::finder_service::ensure_installed();
            });
        }

        // Auto sync: resume background schedulers for configured vaults.
        app.state::<crate::integration::sync::SyncService>()
            .start_all(app.handle());

        Ok(())
    });

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        builder = builder.on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "close_tab_or_window" {
                // Cmd+W is app-global on macOS. When Settings is focused, close
                // that native window instead of forwarding the command to the
                // main renderer, where it would close the active document tab.
                if let Some(settings) =
                    app.get_webview_window(crate::app::window::commands::SETTINGS_WINDOW_LABEL)
                {
                    if settings.is_focused().unwrap_or(false) {
                        let _ = settings.close();
                        return;
                    }
                }
            }
            if id == "new_window" {
                // `window_new` is async so webview creation never runs inside this
                // main-thread menu callback (see its doc comment).
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::app::window::commands::window_new(app).await {
                        log::error!(target: "edda::op", "op end window_new ok=false error={e}");
                    }
                });
                return;
            }
            // Remaining menu ids are renderer actions: broadcast one
            // `menu:invoked` event with the action id (naming per
            // docs/development/lifecycle-events.md).
            let _ = app.emit(
                crate::app::menu::MENU_INVOKED_EVENT,
                serde_json::json!({ "action": id }),
            );
        });
    }

    #[cfg(not(target_os = "ios"))]
    {
        builder = builder.on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                log::info!(target: "edda::window", "window lifecycle window={} event={event:?}", window.label());
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<FsWatchController>().stop(window.label());
                crate::app::window::close_orphaned_auxiliary_windows(
                    window.app_handle(),
                    window.label(),
                );
                if window.label() == crate::app::window::commands::SETTINGS_WINDOW_LABEL {
                    crate::app::window::commands::emit_window_closed(
                        window.app_handle(),
                        "settings",
                        None,
                    );
                }
                if let Some(view) =
                    crate::app::window::commands::feature_view_from_label(window.label())
                {
                    crate::app::window::commands::emit_window_closed(
                        window.app_handle(),
                        "feature",
                        Some(view),
                    );
                }
            }
        });
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            let _ = &app;
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                #[cfg(not(target_os = "ios"))]
                app.state::<Arc<ConnectorController>>().stop();
                // The MCP HTTP listener and the ChatGPT tunnel child are both
                // desktop-only; stop them here so port 8765/8080 are released
                // when the app quits. This matches Connector/Bridge behavior.
                #[cfg(not(target_os = "ios"))]
                {
                    app.state::<Arc<McpController>>().stop_server();
                    app.state::<Arc<McpTunnelController>>().stop();
                }
                // Close the mobile relay rather than letting the socket die with
                // the process, so paired clients see a clean shutdown. `stop`
                // takes the runtime, so the second call in this arm is a no-op.
                let _ = app
                    .state::<crate::integration::bridge::BridgeController>()
                    .stop();
            }
            // Best-effort final push (bounded); only on Exit so it runs once.
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<crate::integration::sync::SyncService>()
                    .flush_on_exit();
            }
        });
}

/// Enabled MCP plugins from settings, in the agent feature's own shape.
fn agent_plugins(settings: &AppSettings) -> Vec<McpPlugin> {
    settings
        .agent_mcp_servers
        .iter()
        .filter(|server| server.enabled)
        .map(|server| McpPlugin {
            name: server.name.clone(),
            transport: if server.url.is_empty() {
                McpPluginTransport::Stdio {
                    command: server.command.clone(),
                    args: server.args.clone(),
                    env: server.env.clone().into_iter().collect(),
                }
            } else {
                McpPluginTransport::Http {
                    url: server.url.clone(),
                    headers: server.headers.clone().into_iter().collect(),
                }
            },
        })
        .collect()
}
