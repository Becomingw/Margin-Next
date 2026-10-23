//! Desktop window helpers (new window, settings window).

pub mod commands;

use tauri::{AppHandle, Manager};

fn is_library_window(label: &str) -> bool {
    label == "main" || label.starts_with("edda-")
}

fn auxiliary_windows_to_close<'a>(closed: &str, labels: &'a [String]) -> Vec<&'a str> {
    if !is_library_window(closed)
        || labels
            .iter()
            .any(|label| label != closed && is_library_window(label))
    {
        return Vec::new();
    }
    labels
        .iter()
        .map(String::as_str)
        .filter(|label| {
            *label == commands::SETTINGS_WINDOW_LABEL
                || label.starts_with("feature-")
                || label.starts_with("doc-")
        })
        .collect()
}

/// Called after destruction, so a cancelled close never cascades. Use ordinary
/// close requests (not force-exit) and let Tauri retire the last window normally.
pub fn close_orphaned_auxiliary_windows(app: &AppHandle, closed: &str) {
    let windows = app.windows();
    let labels: Vec<_> = windows.keys().cloned().collect();
    for label in auxiliary_windows_to_close(closed, &labels) {
        if let Some(window) = windows.get(label) {
            log::info!(target: "edda::window", "window cascade_close parent={closed} window={label}");
            if let Err(error) = window.close() {
                log::warn!("window cascade_close failed window={label} error={error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_last_library_window_closes_auxiliary_windows() {
        let labels = [
            "main",
            "settings",
            "feature-library",
            "doc-draft",
            "browse-main-site",
        ]
        .map(str::to_string);
        assert_eq!(
            auxiliary_windows_to_close("main", &labels),
            vec!["settings", "feature-library", "doc-draft"]
        );
        let labels = ["main", "edda-other", "settings"].map(str::to_string);
        assert!(auxiliary_windows_to_close("main", &labels).is_empty());
        assert!(auxiliary_windows_to_close("edda-other", &labels).is_empty());
        let labels = ["settings", "doc-draft"].map(str::to_string);
        assert_eq!(
            auxiliary_windows_to_close("edda-last", &labels),
            vec!["settings", "doc-draft"]
        );
        assert!(auxiliary_windows_to_close("settings", &labels).is_empty());
        assert!(auxiliary_windows_to_close("doc-draft", &labels).is_empty());
    }
}
