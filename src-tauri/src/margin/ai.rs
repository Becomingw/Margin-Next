//! One explicit, revocable capability for one manuscript and reviewer role.
//! No Vault/MCP controller from the research workbench is started.
mod tools;
use margin_core::{error::AppError, features::margin as service};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

pub(super) struct Grant {
    root: PathBuf,
    id: String,
    reviewer: service::Reviewer,
    active: AtomicBool,
    barrier: RwLock<()>,
}
impl Grant {
    fn run<T>(
        &self,
        f: impl FnOnce(&std::path::Path, &str, &service::Reviewer) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let _lease = self
            .barrier
            .read()
            .map_err(|_| AppError::message("reviewer lock poisoned"))?;
        if !self.active.load(Ordering::Acquire) {
            return Err(AppError::domain(
                "reviewer_disconnected",
                "Reviewer access has been revoked",
            ));
        }
        f(&self.root, &self.id, &self.reviewer)
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    listening: bool,
    workspace_path: Option<String>,
    review_id: Option<String>,
    label: Option<String>,
    url: Option<String>,
    config: Option<serde_json::Value>,
}
struct Running {
    grant: Arc<Grant>,
    status: Status,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.grant.active.store(false, Ordering::Release);
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.task.abort();
    }
}

#[derive(Default)]
pub struct Controller {
    running: Mutex<Option<Running>>,
}
impl Controller {
    pub async fn status(&self) -> Status {
        let running = self.running.lock().await;
        running
            .as_ref()
            .filter(|r| r.grant.active.load(Ordering::Acquire) && !r.task.is_finished())
            .map(|r| r.status.clone())
            .unwrap_or_default()
    }
    async fn halt(running: Running) -> Result<(), String> {
        running.grant.active.store(false, Ordering::Release);
        let grant = Arc::clone(&running.grant);
        // Drain already admitted operations. Revocation cannot acknowledge while
        // a blocking SQLite mutation can still commit under the old capability.
        tokio::task::spawn_blocking(move || {
            let _guard = grant
                .barrier
                .write()
                .map_err(|_| "reviewer lock poisoned")?;
            Ok::<_, &str>(())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(str::to_owned)?;
        drop(running);
        Ok(())
    }
    pub async fn stop(&self) -> Result<Status, String> {
        let mut state = self.running.lock().await;
        if let Some(old) = state.take() {
            Self::halt(old).await?;
        }
        Ok(Status::default())
    }
    pub async fn start(&self, root: PathBuf, id: String, label: String) -> Result<Status, String> {
        let mut state = self.running.lock().await;
        if let Some(old) = state.take() {
            Self::halt(old).await?;
        }
        let r = root.clone();
        let doc = id.clone();
        let reviewer = tokio::task::spawn_blocking(move || {
            service::open(&r, &doc)?;
            service::bind_reviewer(&r, &doc, &label)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let url = format!("http://127.0.0.1:{port}/mcp");
        let bearer = format!(
            "Bearer {}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let status = Status {
            listening: true,
            workspace_path: Some(root.to_string_lossy().replace('\\', "/")),
            review_id: Some(id.clone()),
            label: Some(reviewer.label.clone()),
            url: Some(url.clone()),
            config: Some(
                serde_json::json!({"mcpServers":{"margin":{"type":"http","url":url,"headers":{"Authorization":bearer}}}}),
            ),
        };
        let grant = Arc::new(Grant {
            root,
            id,
            reviewer,
            active: AtomicBool::new(true),
            barrier: RwLock::new(()),
        });
        let mut config = StreamableHttpServerConfig::default();
        config.allowed_hosts = vec![
            "localhost".into(),
            "127.0.0.1".into(),
            format!("localhost:{port}"),
            format!("127.0.0.1:{port}"),
        ];
        let server_grant = Arc::clone(&grant);
        let transport = StreamableHttpService::new(
            move || Ok(tools::ReviewerMcp::new(Arc::clone(&server_grant))),
            LocalSessionManager::default().into(),
            config,
        );
        let app =
            axum::Router::new()
                .nest_service("/mcp", transport)
                .layer(axum::middleware::from_fn(
                    move |request: axum::extract::Request, next: axum::middleware::Next| {
                        let authorized = request
                            .headers()
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|h| h.to_str().ok())
                            == Some(bearer.as_str());
                        let browser = request.headers().contains_key(axum::http::header::ORIGIN);
                        async move {
                            if !authorized {
                                return axum::response::IntoResponse::into_response(
                                    axum::http::StatusCode::UNAUTHORIZED,
                                );
                            }
                            if browser {
                                return axum::response::IntoResponse::into_response(
                                    axum::http::StatusCode::FORBIDDEN,
                                );
                            }
                            next.run(request).await
                        }
                    },
                ));
        let (shutdown, rx) = oneshot::channel();
        let task_grant = Arc::clone(&grant);
        let task = tokio::spawn(async move {
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
            task_grant.active.store(false, Ordering::Release);
            if let Err(e) = result {
                log::warn!("Margin review MCP stopped: {e}");
            }
        });
        *state = Some(Running {
            grant,
            status: status.clone(),
            shutdown: Some(shutdown),
            task,
        });
        Ok(status)
    }
}

#[cfg(test)]
mod tests;
