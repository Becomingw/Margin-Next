//! Review workspace (`reviews/<id>/`): manuscripts under review.
//!
//! Bodies live in `edda_core::features::review`; this module keeps the
//! desktop shells (IPC commands + the per-unit edit cache).

pub use edda_core::features::review::*;

pub mod commands;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Last confirmed manuscript text per `(vault, review id)`, used by
/// `review_record_edit` to compute the changed span without trusting the
/// renderer. Seeded on `review_open`; cleared on vault release.
#[derive(Default, Clone)]
pub struct ReviewEditCache(Arc<Mutex<HashMap<(String, String), String>>>);

fn cache_vault_key(vault: &str) -> String {
    let path = vault.trim().replace('\\', "/");
    let path = path.trim_end_matches('/');
    #[cfg(windows)]
    {
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

impl ReviewEditCache {
    pub fn get(&self, vault: &str, id: &str) -> Option<String> {
        self.0
            .lock()
            .ok()?
            .get(&(cache_vault_key(vault), id.to_string()))
            .cloned()
    }

    pub fn set(&self, vault: &str, id: &str, text: String) {
        if let Ok(mut guard) = self.0.lock() {
            guard.insert((cache_vault_key(vault), id.to_string()), text);
        }
    }

    pub fn clear_vault(&self, vault: &str) {
        if let Ok(mut guard) = self.0.lock() {
            let key = cache_vault_key(vault);
            guard.retain(|(v, _), _| v != &key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ReviewEditCache;

    #[test]
    fn cache_uses_same_key_for_ipc_and_mcp_vault_paths() {
        let cache = ReviewEditCache::default();
        cache.set("E:\\Vault\\", "draft", "agent text".into());
        assert_eq!(
            cache.get("E:/Vault", "draft").as_deref(),
            Some("agent text")
        );
        cache.clear_vault("E:/Vault/");
        assert!(cache.get("E:/Vault", "draft").is_none());
    }
}
