//! Versioned settings introspection and validated, field-level Agent mutations.
//! The persisted type supplies the schema; the explicit policy supplies write authority.
use super::{normalize, AppSettings, AppSettingsStore};
use crate::core::error::AppError;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

pub const WRITABLE: &[&str] = &[
    "theme",
    "uiTheme",
    "locale",
    "uiScale",
    "editorFontSize",
    "editorLineHeight",
    "interfaceFontFamily",
    "textFontFamily",
    "monoFontFamily",
    "showEditorToolbar",
    "paperTreeLabelMode",
    "paperTreeSortMode",
    "paperNoteMode",
    "autoOpenPaperNotes",
    "replaceCurrentTabOnOpenPaper",
    "autoUpdateInternalLinks",
    "batchImportConcurrency",
    "autoPaperReader",
    "aiResponseLanguage",
    "exportWatermarkEnabled",
    "plazaEnabled",
    "pdfAsk.agentId",
    "pdfAsk.modelId",
    "translate.provider",
    "translate.targetLang",
    "translate.sourceLang",
    "translate.autoTranslateSelection",
    "translate.dualPaneTranslate",
    "translate.agentId",
    "translate.modelId",
    "layout.backend",
    "layout.parserBackend",
    "networkProxyEnabled",
    "networkProxyUrl",
    "githubMirrorEnabled",
    "githubMirrorBaseUrl",
    "translatorBaseUrl",
    "connectorPort",
    "mcpPort",
    "connectorEnabled",
    "mcpEnabled",
];

pub fn effect(path: &str) -> &'static str {
    match path {
        "mcpPort" | "connectorPort" | "mcpEnabled" | "connectorEnabled" => "listener-rebind; query environment after saving; external clients may need to reconnect",
        "networkProxyEnabled" | "networkProxyUrl" | "githubMirrorEnabled" | "githubMirrorBaseUrl" | "translatorBaseUrl" => "next-request; running requests and ACP processes keep their current connection",
        "pdfAsk.agentId" | "pdfAsk.modelId" | "translate.agentId" | "translate.modelId"
        | "aiResponseLanguage" | "autoPaperReader" | "paperNoteMode" => "next-task",
        "layout.backend" | "layout.parserBackend" | "translate.provider" | "translate.targetLang"
        | "translate.sourceLang" | "batchImportConcurrency" => "next-task; existing tasks are not restarted",
        _ => "live; existing windows receive settings:changed",
    }
}

pub fn describe() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"), "scope": "all-settings", "writable": true,
        "schema": schemars::schema_for!(AppSettings),
        "writePolicy": WRITABLE.iter().map(|path| json!({"path": path, "effect": effect(path), "restartRequired": false})).collect::<Vec<_>>(),
        "constraints": {
            "theme": ["system", "light", "dark"], "locale": ["system", "en", "zh-CN"],
            "uiTheme": theme_names(), "translate.provider": translation_providers(),
            "githubMirrorBaseUrl": super::GITHUB_MIRROR_PRESETS,
            "networkProxyUrl": "Absolute http/https/socks5/socks5h URL without credentials, query or fragment",
            "translatorBaseUrl": "Absolute http/https URL without credentials, query or fragment; no trailing slash",
            "uiScale": [0.8, 0.9, 1.0, 1.25, 1.5], "editorFontSize": {"min":10,"max":32},
            "editorLineHeight": {"min":1.4,"max":2.0,"step":0.1}, "batchImportConcurrency":{"min":1,"max":10},
            "aiResponseLanguage":["auto","en","zh-CN"],
            "paperTreeLabelMode":["title-author","title","author-year-title","folder"],
            "paperTreeSortMode":["folder","title","author","year-desc","year-asc","added-desc"],
            "paperNoteMode":["standard","title-only","blank","custom"],
            "autoUpdateInternalLinks":["ask","always"],
            "layout.backend":["local","paddle","mineru"],
            "layout.parserBackend":["local","paddle","mineru","openaiCompatible",super::BUILTIN_PROVIDER_ID],
            "translate.targetLang":["ui","en","zh-CN"], "translate.sourceLang":["auto"],
            "mcpPort":{"min":1,"max":65535}, "connectorPort":{"min":1,"max":65535}
        },
        "guidance": "Read fields or sections with settings_get. settings_set accepts exact dotted leaf paths and expected previous values, validates the entire batch before writing, and returns an inverse patch for conditional undo. Unlisted paths are read-only: credentials, permission policy, developer mode, plugin launch configuration and complex collections remain in Settings UI. Secret values and URL credentials are redacted. Do not edit settings.json. Persisted does not imply downstream service healthy; inspect environment and logs after a change."
    })
}

fn theme_names() -> Vec<String> {
    let manifest: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../src/themes/tweakcn-manifest.json"
    ))
    .expect("bundled theme manifest");
    std::iter::once("default".into())
        .chain(
            manifest
                .iter()
                .filter_map(|v| v["name"].as_str().map(str::to_owned)),
        )
        .collect()
}

fn translation_providers() -> Vec<&'static str> {
    use edda_core::features::translate::{
        BUILTIN_PROVIDER_ID, COMMERCIAL_PROVIDERS, FREE_PROVIDERS,
    };
    [BUILTIN_PROVIDER_ID, "agent"]
        .into_iter()
        .chain(FREE_PROVIDERS.iter().copied())
        .chain(COMMERCIAL_PROVIDERS.iter().copied())
        .collect()
}

pub fn pointer(path: &str) -> String {
    format!(
        "/{}",
        path.split('.')
            .map(|s| s.replace('~', "~0").replace('/', "~1"))
            .collect::<Vec<_>>()
            .join("/")
    )
}

/// Redact by field, including headers/env and custom prompt bodies; never expose
/// the original settings file through a tool. URLs retain useful host/path only.
pub fn redact(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                let key = key.to_ascii_lowercase();
                if key.contains("apikey")
                    || key == "easyscholarkey"
                    || key == "headers"
                    || key == "env"
                    || key.contains("prompt")
                    || key == "args"
                    || key == "command"
                {
                    if !value.is_null() && value != "" {
                        *value = json!("[redacted]");
                    }
                } else {
                    redact(value);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        Value::String(text) => {
            if let Ok(mut url) = url::Url::parse(text) {
                if matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
                    && (!url.username().is_empty()
                        || url.password().is_some()
                        || url.query().is_some()
                        || url.fragment().is_some())
                {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    *text = url.to_string();
                }
            }
        }
        _ => {}
    }
}

pub fn read(settings: &AppSettings, fields: &[String]) -> Result<Value, AppError> {
    let mut value = serde_json::to_value(settings)?;
    redact(&mut value);
    if fields.is_empty() {
        return Ok(value);
    }
    let mut selected = Map::new();
    for field in fields {
        let v = value.pointer(&pointer(field)).ok_or_else(|| {
            AppError::message(format!(
                "Unknown settings path: {field}; consult settings_describe"
            ))
        })?;
        selected.insert(field.clone(), v.clone());
    }
    Ok(Value::Object(selected))
}

pub fn prepare(
    current: &AppSettings,
    changes: &Map<String, Value>,
    expected: &Map<String, Value>,
) -> Result<(AppSettings, Value), AppError> {
    if changes.is_empty() || changes.len() > WRITABLE.len() {
        return Err(AppError::message(
            "Provide a nonempty batch of writable settings paths",
        ));
    }
    let mut value = serde_json::to_value(current)?;
    let mut previous = Map::new();
    for (path, next) in changes {
        if !WRITABLE.contains(&path.as_str()) {
            return Err(AppError::message(format!(
                "Settings path is not writable: {path}; consult settings_describe"
            )));
        }
        if matches!(
            path.as_str(),
            "networkProxyUrl" | "translatorBaseUrl" | "githubMirrorBaseUrl"
        ) {
            validate_endpoint(path, next)?;
            if let Some(previous) = value.pointer(&pointer(path)) {
                validate_endpoint(path, previous).map_err(|_|AppError::message("This endpoint contains private or legacy configuration; change it in Settings UI"))?;
            }
        }
        let slot = value
            .pointer_mut(&pointer(path))
            .ok_or_else(|| AppError::message("Settings schema changed; read again"))?;
        if !expected.get(path).is_some_and(|old| same_value(old, slot)) {
            return Err(AppError::message(format!(
                "Settings conflict at {path}; read current values before changing or undoing"
            )));
        }
        if next.is_null()
            || next.is_array()
            || next.is_object()
            || next.as_str().is_some_and(|s| s.len() > 512)
        {
            return Err(AppError::message(format!(
                "Invalid scalar value for {path}"
            )));
        }
        previous.insert(path.clone(), slot.clone());
        *slot = next.clone();
    }
    let mut candidate: AppSettings = serde_json::from_value(value)
        .map_err(|_| AppError::message("Invalid settings value type; consult settings_describe"))?;
    normalize(&mut candidate);
    let normalized = serde_json::to_value(&candidate)?;
    for (path, next) in changes {
        if !normalized
            .pointer(&pointer(path))
            .is_some_and(|actual| same_value(actual, next))
        {
            return Err(AppError::message(format!("Invalid value for {path}; normalization would change it; consult settings_describe")));
        }
    }
    // These strings have no strict normalization in the persisted legacy type.
    if changes.contains_key("uiTheme") && !theme_names().contains(&candidate.ui_theme) {
        return Err(AppError::message(
            "Unknown bundled UI theme; consult settings_describe",
        ));
    }
    if changes.contains_key("translate.provider")
        && !translation_providers().contains(&candidate.translate.provider.as_str())
    {
        return Err(AppError::message("Unknown translation provider"));
    }
    Ok((candidate, Value::Object(previous)))
}

fn same_value(a: &Value, b: &Value) -> bool {
    if a.is_number() && b.is_number() {
        a.as_f64() == b.as_f64()
    } else {
        a == b
    }
}

fn validate_endpoint(path: &str, value: &Value) -> Result<(), AppError> {
    let valid = value
        .as_str()
        .and_then(|s| url::Url::parse(s).ok())
        .is_some_and(|u| {
            (matches!(u.scheme(), "http" | "https")
                || (path == "networkProxyUrl" && matches!(u.scheme(), "socks5" | "socks5h")))
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
                && u.query().is_none()
                && u.fragment().is_none()
        });
    if valid {
        Ok(())
    } else {
        Err(AppError::message(format!(
            "Invalid or credential-bearing endpoint for {path}"
        )))
    }
}

/// Same gate, persistence, domain listeners and broadcast as UI saves. Read and
/// merge inside the gate so concurrent patches cannot clobber unrelated fields.
pub async fn patch(
    app: AppHandle,
    changes: Map<String, Value>,
    expected: Map<String, Value>,
    dry_run: bool,
) -> Result<Value, AppError> {
    let store = app.state::<AppSettingsStore>();
    let gate = store.write_gate.clone().lock_owned().await;
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        // A disconnected/cancelled MCP request cannot release the write lock
        // while its already-started blocking commit is still running.
        let _gate = gate;
        let store = handle.state::<AppSettingsStore>();
        let (candidate, previous) = prepare(&store.get()?.settings, &changes, &expected)?;
        let fields = changes.keys().cloned().collect::<Vec<_>>();
        if !dry_run {
            let saved = super::commands::persist_settings_result(&handle, candidate)?;
            log::info!(target: "edda::settings", "source=mcp fields={} persisted=true", fields.join(","));
            let _ = handle.emit("settings:changed", &saved);
        }
        Ok(json!({"dryRun": dry_run, "persisted": !dry_run, "values": changes,
            "undo": {"changes": previous, "expected": changes},
            "effects": fields.iter().map(|p| json!({"path":p,"effect":effect(p)})).collect::<Vec<_>>(),
            "verification": "Use settings_get and environment_inspect; listener rebind and queued task changes can complete asynchronously."}))
    }).await.map_err(|e| AppError::message(format!("Settings worker failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn patch_rejects_invalid_batch_unknown_paths_and_conflicts_without_mutating() {
        let current = AppSettings::default();
        let expected =
            object(json!({"theme":current.theme,"editorFontSize":current.editor_font_size}));
        assert!(prepare(
            &current,
            &object(json!({"theme":"dark","editorFontSize":999})),
            &expected
        )
        .is_err());
        assert!(prepare(
            &current,
            &object(json!({"theme":"dark"})),
            &object(json!({"theme":"stale"}))
        )
        .is_err());
        for path in [
            "developerMode",
            "agentPermissionMode",
            "unknown",
            "translate.providerConfigs.openaiCompatible.apiKey",
        ] {
            assert!(prepare(
                &current,
                &object(json!({path:"auto"})),
                &object(json!({path:"ask"}))
            )
            .is_err());
        }
        for value in [json!("huge"), json!(null), json!(true), json!(1.1)] {
            assert!(prepare(
                &current,
                &object(json!({"uiScale":value})),
                &object(json!({"uiScale":current.ui_scale}))
            )
            .is_err());
        }
        assert!(prepare(
            &current,
            &object(json!({"uiScale":1})),
            &object(json!({"uiScale":1}))
        )
        .is_ok());
        assert!(prepare(
            &current,
            &object(json!({"networkProxyUrl":"http://localhost:7891"})),
            &object(json!({"networkProxyUrl":current.network_proxy_url}))
        )
        .is_ok());
        for endpoint in [
            "file:///private",
            "http://user:password@localhost",
            "http://localhost/?token=secret",
        ] {
            assert!(prepare(
                &current,
                &object(json!({"networkProxyUrl":endpoint})),
                &object(json!({"networkProxyUrl":current.network_proxy_url}))
            )
            .is_err());
        }
    }

    #[test]
    fn patch_persists_preserves_secrets_and_supports_conditional_undo() {
        let store = AppSettingsStore::for_tests(AppSettings {
            easy_scholar_key: "known-private-key".into(),
            ..AppSettings::default()
        });
        let original = store.get().unwrap().settings;
        let changes = object(json!({"editorFontSize":20,"translate.targetLang":"en"}));
        let expected = object(
            read(
                &original,
                &["editorFontSize".into(), "translate.targetLang".into()],
            )
            .unwrap(),
        );
        let (next, undo) = prepare(&original, &changes, &expected).unwrap();
        store.set(next).unwrap();
        assert_eq!(
            store.easy_scholar_key().as_deref(),
            Some("known-private-key")
        );
        let saved = store.get().unwrap().settings;
        assert_eq!(saved.editor_font_size, 20);
        assert_eq!(saved.theme, original.theme);
        assert!(prepare(&saved, &changes, &expected).is_err());
        let (reverted, _) = prepare(&saved, &object(undo), &changes).unwrap();
        store.set(reverted).unwrap();
        assert_eq!(
            store.get().unwrap().settings.editor_font_size,
            original.editor_font_size
        );
        std::fs::remove_file(store.path()).unwrap();
    }

    #[test]
    fn full_projection_covers_schema_without_exposing_secrets() {
        let mut settings = AppSettings {
            easy_scholar_key: "SECRET_KEY".into(),
            agent_personal_prompt: "SECRET_PROMPT".into(),
            network_proxy_url: "http://user:SECRET_PASS@localhost:7890/?token=SECRET_TOKEN".into(),
            ..AppSettings::default()
        };
        settings
            .agent_mcp_servers
            .push(super::super::AgentMcpServer {
                name: "custom".into(),
                enabled: true,
                url: "".into(),
                command: "node".into(),
                args: vec!["SECRET_ARG".into()],
                env: std::collections::BTreeMap::from([("TOKEN".into(), "SECRET_ENV".into())]),
                headers: std::collections::BTreeMap::new(),
            });
        let projection = read(&settings, &[]).unwrap();
        assert!(!projection.to_string().contains("SECRET"));
        for path in WRITABLE {
            assert!(read(&settings, &[(*path).into()]).is_ok(), "{path}");
        }
        let schema = describe();
        for key in serde_json::to_value(settings)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
        {
            assert!(!schema["schema"]["properties"][key].is_null(), "{key}");
        }
        assert!(read(&AppSettings::default(), &["typo".into()]).is_err());
    }
}
