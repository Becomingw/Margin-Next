//! App settings commands — durable XDG config file.
//!
//! `settings_set` is schema-agnostic: validate proxy → persist → broadcast.
//! Domain reactions (connector port rebind, agent proxy, import parser
//! refresh, jobs layout cap) subscribe via [`AppSettingsStore::subscribe`]
//! at app assembly, so this feature imports no other domain.

use crate::core::blocking::run_blocking;
use crate::core::error::{map_err, ApiResult, AppError};
use crate::core::json::JsonValue;
use crate::features::system::settings::{AppSettings, AppSettingsStore, SettingsGetResult};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
#[specta::specta]
pub async fn settings_get(app: AppHandle) -> ApiResult<SettingsGetResult> {
    run_blocking(move || match app.state::<AppSettingsStore>().get() {
        Ok(r) => ApiResult::ok(r),
        Err(e) => map_err(e),
    })
    .await
}

/// Detected OS system proxy (Windows "Internet Settings"). Host requests
/// already fall back to it when the app proxy is off; the updater plugin and
/// the settings UI query it here.
#[tauri::command]
#[specta::specta]
pub fn network_system_proxy() -> ApiResult<Option<String>> {
    ApiResult::ok(crate::core::http::system_proxy_url())
}

/// Return unique system font family names (sorted). Empty on mobile / failure.
///
/// Scanning system fonts is slow (disk walk on Windows), so it runs in
/// `run_blocking` and the result is cached for the process lifetime — the
/// installed-font set does not change while the app is running.
#[tauri::command]
#[specta::specta]
pub async fn list_system_fonts() -> ApiResult<Vec<String>> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        ApiResult::ok(Vec::new())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        use crate::core::blocking::run_blocking;
        use std::sync::OnceLock;

        static FONTS: OnceLock<Vec<String>> = OnceLock::new();
        if let Some(names) = FONTS.get() {
            return ApiResult::ok(names.clone());
        }
        run_blocking(move || {
            let names = FONTS.get_or_init(|| {
                use std::collections::BTreeSet;
                let mut db = fontdb::Database::new();
                db.load_system_fonts();
                let mut names = BTreeSet::new();
                for face in db.faces() {
                    for (family, _) in &face.families {
                        let t = family.trim();
                        if !t.is_empty() {
                            names.insert(t.to_string());
                        }
                    }
                }
                names.into_iter().collect()
            });
            ApiResult::ok(names.clone())
        })
        .await
    }
}

/// Persist the full settings snapshot and broadcast `settings:changed`.
///
/// Domain side effects are not wired here: they run as
/// [`AppSettingsStore::subscribe`] listeners registered by the app assembly
/// (see `app/mod.rs`), fired inside `store.set` with the redacted snapshot.
#[tauri::command]
#[specta::specta]
pub async fn settings_set(app: AppHandle, settings: AppSettings) -> ApiResult<AppSettings> {
    let store = app.state::<AppSettingsStore>();
    let save = store.write_gate.clone().lock_owned().await;
    let app = app.clone();
    run_blocking(move || {
        let _save = save;
        persist_settings(&app, settings)
    })
    .await
}

fn persist_settings(app: &AppHandle, settings: AppSettings) -> ApiResult<AppSettings> {
    match persist_settings_result(app, settings) {
        Ok(s) => {
            let _ = app.emit("settings:changed", &s);
            ApiResult::ok(s)
        }
        Err(e) => map_err(e),
    }
}

pub(super) fn persist_settings_result(
    app: &AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, AppError> {
    let previous = app.state::<AppSettingsStore>().get()?.settings;
    crate::core::http::configure_proxy(
        settings.network_proxy_enabled,
        &settings.network_proxy_url,
    )?;
    if let Err(e) = crate::core::http::configure_github_mirror(
        settings.github_mirror_enabled,
        &settings.github_mirror_base_url,
    ) {
        let _ = crate::core::http::configure_proxy(
            previous.network_proxy_enabled,
            &previous.network_proxy_url,
        );
        return Err(e);
    }
    match app.state::<AppSettingsStore>().set(settings) {
        Ok(s) => Ok(s),
        Err(e) => {
            let _ = crate::core::http::configure_proxy(
                previous.network_proxy_enabled,
                &previous.network_proxy_url,
            );
            let _ = crate::core::http::configure_github_mirror(
                previous.github_mirror_enabled,
                &previous.github_mirror_base_url,
            );
            Err(e)
        }
    }
}

/// Probe the configured EasyScholar key by querying a stable journal.
/// Returns false when no key is configured, the request fails, or the API
/// rejects the key (non-200 / non-200 code).
#[tauri::command]
#[specta::specta]
pub async fn easy_scholar_probe(app: AppHandle) -> ApiResult<bool> {
    use crate::features::paper::scholar_api::sources::easy_scholar::EasyScholarApi;

    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.easy_scholar_key() else {
        return ApiResult::ok(false);
    };
    let source = EasyScholarApi::new(key);
    let ok = match source.fetch_raw("Nature").await {
        Ok(json) => json
            .get("code")
            .and_then(|v| v.as_i64())
            .is_some_and(|code| code == 200),
        Err(_) => false,
    };
    ApiResult::ok(ok)
}

/// Query EasyScholar for a publication's rank data.
/// Returns the full API response so the WebView can extract `officialRank.all`
/// and build namespaced tags.
#[tauri::command]
#[specta::specta]
pub async fn easy_scholar_get_rank(
    app: AppHandle,
    publication_name: String,
) -> ApiResult<JsonValue> {
    use crate::features::paper::scholar_api::sources::easy_scholar::EasyScholarApi;

    let store = app.state::<AppSettingsStore>();
    let Some(key) = store.easy_scholar_key() else {
        return map_err(AppError::domain(
            "easyScholarKeyMissing",
            "EasyScholar key is not configured.",
        ));
    };
    if publication_name.trim().is_empty() {
        return map_err(AppError::domain(
            "easyScholarEmptyPublication",
            "Publication name is empty.",
        ));
    }

    let source = EasyScholarApi::new(key);
    match source.fetch_raw(&publication_name).await {
        Ok(json) => {
            if json
                .get("code")
                .and_then(|v| v.as_i64())
                .is_some_and(|code| code == 200)
            {
                ApiResult::ok(JsonValue(json))
            } else {
                map_err(AppError::domain(
                    "easyScholarApiError",
                    "EasyScholar API returned an error response.",
                ))
            }
        }
        Err(e) => map_err(e.into()),
    }
}
