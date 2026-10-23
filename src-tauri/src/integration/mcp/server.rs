//! Streamable HTTP MCP listener (loopback only).

use super::tools::EddaMcp;
use super::McpController;
use crate::core::error::AppError;
use crate::features::agent::session::handlers::TurnRegistry;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

pub async fn serve(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
) -> Result<(), AppError> {
    serve_inner(listener, shutdown_rx, ctrl, None, None).await
}

pub(crate) async fn serve_workspace(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
    turns: TurnRegistry,
    bearer: String,
) -> Result<(), AppError> {
    serve_inner(listener, shutdown_rx, ctrl, Some(turns), Some(bearer)).await
}

async fn serve_inner(
    listener: TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
    ctrl: Arc<McpController>,
    turns: Option<TurnRegistry>,
    bearer: Option<String>,
) -> Result<(), AppError> {
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(ctrl.status().port);
    let mut config = StreamableHttpServerConfig::default();
    config.allowed_hosts = vec![
        "127.0.0.1".into(),
        "localhost".into(),
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
    ];
    let mcp_service = StreamableHttpService::new(
        {
            let ctrl = Arc::clone(&ctrl);
            move || {
                Ok(EddaMcp::with_turns(
                    Arc::new(ctrl.for_session()),
                    turns.clone(),
                ))
            }
        },
        LocalSessionManager::default().into(),
        config,
    );
    let mut app = Router::new().nest_service("/mcp", mcp_service);
    if let Some(bearer) = bearer {
        app = app.layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let authenticated = request
                    .headers()
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    == Some(bearer.as_str());
                async move {
                    if authenticated {
                        next.run(request).await
                    } else {
                        axum::response::IntoResponse::into_response(
                            axum::http::StatusCode::UNAUTHORIZED,
                        )
                    }
                }
            },
        ));
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .map_err(|e| AppError::message(format!("mcp server: {e}")))
}
