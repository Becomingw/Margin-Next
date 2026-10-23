use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

#[derive(Clone)]
pub struct AgentEventEmitter {
    app: AppHandle,
    window_label: String,
}

impl AgentEventEmitter {
    pub(crate) fn app_handle(&self) -> &AppHandle {
        &self.app
    }

    pub fn new(app: AppHandle, window_label: impl Into<String>) -> Self {
        Self {
            app,
            window_label: window_label.into(),
        }
    }

    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        self.app.emit_to(
            EventTarget::webview_window(self.window_label.clone()),
            event,
            payload,
        )
    }
}
