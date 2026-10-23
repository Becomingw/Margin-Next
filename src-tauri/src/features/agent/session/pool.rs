//! Pool of warm ACP connections reused across chat turns (TTFT optimization).
//!
//! `warm_agent` publishes its live connection + fresh session here instead of
//! tearing it down; `run_once` takes a matching slot to skip the
//! `spawn → initialize → session/new` cold chain (measured at 3.5s+ per turn,
//! see #536). Idle slots are recycled after [`POOL_IDLE_TTL`] (or EOF /
//! eviction), and a never-used slot's empty session is `session/delete`d at
//! teardown so warm starts do not pile up empty threads in agent history.

use crate::features::agent::acp::terminal::AcpTerminalManager;
use crate::features::agent::models::{AgentDescriptor, AgentModelsEvent};
use crate::features::agent::remote_host::RemoteAgentLaunch;
use crate::features::agent::session::handlers::TurnRegistry;
use crate::features::agent::workspace_tools::WorkspaceConnection;
use agent_client_protocol::schema::v1::{SessionConfigOption, SessionId};
use agent_client_protocol::{Agent, ConnectionTo};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// Idle time before a pooled connection is torn down (and its empty session
/// deleted when never used). Long-lived agent processes can grow memory and
/// drift, so the pool trades a little warmth for bounded resource use.
pub(crate) const POOL_IDLE_TTL: Duration = Duration::from_secs(600);

/// How long `take` polls for an in-flight warm setup before falling back to
/// the cold path (session/new alone measured 1–10s, so the wait is capped).
const POOL_TAKE_WAIT: Duration = Duration::from_secs(5);
const POOL_TAKE_POLL: Duration = Duration::from_millis(50);

/// Cached chat-UI payload a healthy slot can answer `agent_warm` with.
pub(crate) type WarmSnapshot = (Option<AgentModelsEvent>, Option<(u64, u64)>);

/// A connection is reusable only for the same launch configuration and workspace.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct PoolKey {
    pub agent_id: String,
    pub cwd: PathBuf,
    pub remote_tag: Option<String>,
    pub launch_fingerprint: [u8; 32],
}

/// Build the pool key for a run / warm request.
pub(crate) fn pool_key(
    desc: &AgentDescriptor,
    cwd: PathBuf,
    remote: Option<&Arc<dyn RemoteAgentLaunch>>,
) -> PoolKey {
    PoolKey {
        agent_id: desc.id.clone(),
        cwd,
        remote_tag: remote.map(|r| {
            format!(
                "{}{}:{}",
                if r.is_local_sim() { "sim:" } else { "ssh:" },
                r.host(),
                r.work_root().display()
            )
        }),
        launch_fingerprint: desc.launch_fingerprint(),
    }
}

/// One live warm connection available for the next turn.
pub(crate) struct PooledSlot {
    pub key: PoolKey,
    pub connection: ConnectionTo<Agent>,
    /// Fresh session created during warm setup; a turn without a resume id
    /// prompts directly on it.
    pub acp_session_id: SessionId,
    pub config_options: Vec<SessionConfigOption>,
    pub can_resume: bool,
    pub can_load: bool,
    /// Shared with the connection's terminal handler and the run context.
    pub terminals: Arc<tokio::sync::Mutex<AcpTerminalManager>>,
    pub registry: TurnRegistry,
    pub workspace_tools: WorkspaceConnection,
    /// Kill switch: sending `true` makes the keepalive loop exit, which ends
    /// the connect future and reaps the agent process.
    pub end: Arc<watch::Sender<bool>>,
    /// Heartbeat counter; every bump restarts the idle TTL.
    pub activity: watch::Sender<u64>,
    /// Set once a turn prompted on this slot (suppresses the empty-session
    /// delete at teardown).
    pub used: Arc<AtomicBool>,
    /// Cached setup results for `snapshot_warm_result`.
    pub models: Option<AgentModelsEvent>,
    pub usage: Option<(u64, u64)>,
}

impl PooledSlot {
    /// A driver can stop without incoming EOF (e.g. our idle teardown).
    pub fn is_alive(&self) -> bool {
        connection_is_reusable(&self.end, self.connection.is_incoming_closed())
    }

    /// Mark that a real turn ran on this slot (teardown keeps its session).
    pub fn mark_used(&self) {
        self.used.store(true, Ordering::SeqCst);
    }

    /// Heartbeat: restart the keepalive idle TTL.
    pub fn bump(&self) {
        let _ = self.activity.send_if_modified(|v| {
            *v += 1;
            true
        });
    }
}

fn connection_is_reusable(end: &watch::Sender<bool>, incoming_closed: bool) -> bool {
    !end.is_closed() && !*end.borrow() && !incoming_closed
}

/// Map-level bookkeeping shared by publish / take / release, generic over the
/// payload so unit tests can drive it without a live `ConnectionTo`.
struct SlotMap<T> {
    entries: HashMap<String, (PoolKey, T)>,
}

// Manual impl: the derived one would require `T: Default`.
impl<T> Default for SlotMap<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> SlotMap<T> {
    /// Insert a slot for its agent, displacing any previous one.
    fn insert(&mut self, key: PoolKey, payload: T) -> Option<(PoolKey, T)> {
        self.entries.insert(key.agent_id.clone(), (key, payload))
    }

    /// Remove the slot for `key.agent_id` only when the full key matches;
    /// a mismatched slot (different cwd / remote) stays pooled.
    fn remove_matching(&mut self, key: &PoolKey) -> Option<(PoolKey, T)> {
        let entry = self.entries.remove(&key.agent_id)?;
        if entry.0 != *key {
            self.entries.insert(entry.0.agent_id.clone(), entry);
            return None;
        }
        Some(entry)
    }

    /// Borrow the payload for `key` when present and matching.
    fn get_matching(&self, key: &PoolKey) -> Option<&T> {
        self.entries
            .get(&key.agent_id)
            .and_then(|(slot_key, payload)| (slot_key == key).then_some(payload))
    }
}

/// Registry of pooled warm connections (at most one per agent).
pub struct AgentWarmPool {
    slots: Mutex<SlotMap<PooledSlot>>,
}

impl AgentWarmPool {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(SlotMap::default()),
        }
    }

    /// Insert a freshly set-up slot, tearing down any previous slot for the
    /// same agent, and log the replacement.
    pub(crate) fn publish(&self, slot: PooledSlot) {
        let displaced = self
            .slots
            .lock()
            .ok()
            .and_then(|mut slots| slots.insert(slot.key.clone(), slot));
        if let Some((key, old)) = displaced {
            log::debug!(
                target: "edda::agent",
                "agent={} warm pool replaced slot cwd={} remote={:?}",
                key.agent_id,
                key.cwd.display(),
                key.remote_tag
            );
            let _ = old.end.send(true);
        }
    }

    /// Take the healthy slot matching `key`, polling briefly for an in-flight
    /// warm setup to publish before giving up (cold-path fallback).
    pub(crate) async fn take(&self, key: &PoolKey) -> Option<PooledSlot> {
        let deadline = Instant::now() + POOL_TAKE_WAIT;
        loop {
            if let Some(slot) = self.take_ready(key) {
                return Some(slot);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(POOL_TAKE_POLL).await;
        }
    }

    fn take_ready(&self, key: &PoolKey) -> Option<PooledSlot> {
        let (slot_key, slot) = self
            .slots
            .lock()
            .ok()
            .and_then(|mut slots| slots.remove_matching(key))?;
        if !slot.is_alive() {
            log::debug!(
                target: "edda::agent",
                "agent={} warm slot retired or closed; cold fallback",
                slot_key.agent_id
            );
            let _ = slot.end.send(true);
            return None;
        }
        Some(slot)
    }

    /// Return a slot after a finished turn; a dead or displaced connection is
    /// torn down instead of pooled again.
    pub(crate) fn release(&self, slot: PooledSlot) {
        slot.activity.send_if_modified(|v| {
            *v += 1;
            true
        });
        if !slot.is_alive() {
            let _ = slot.end.send(true);
            return;
        }
        let agent_id = slot.key.agent_id.clone();
        let displaced = self
            .slots
            .lock()
            .ok()
            .and_then(|mut slots| slots.insert(slot.key.clone(), slot));
        if let Some((key, old)) = displaced {
            log::debug!(
                target: "edda::agent",
                "agent={} released slot displaced idle slot cwd={} remote={:?}",
                key.agent_id,
                key.cwd.display(),
                key.remote_tag
            );
            let _ = old.end.send(true);
        } else {
            log::debug!(
                target: "edda::agent",
                "agent={} warm slot released back to pool",
                agent_id
            );
        }
    }

    /// Tear a slot's process down (run error paths). The slot is already out
    /// of the map (it was taken), so this only signals the keepalive loop.
    pub(crate) fn evict(&self, slot: &PooledSlot) {
        let _ = slot.end.send(true);
    }

    /// Cached `(models, usage)` from a healthy matching slot — lets a Chat
    /// reopen skip a fresh warm spawn entirely.
    pub(crate) fn snapshot_warm_result(&self, key: &PoolKey) -> Option<WarmSnapshot> {
        let slots = self.slots.lock().ok()?;
        let slot = slots.get_matching(key)?;
        if !slot.is_alive() {
            return None;
        }
        Some((slot.models.clone(), slot.usage))
    }
}

#[cfg(test)]
mod slot_map_tests {
    use super::{connection_is_reusable, pool_key, SlotMap};
    use std::path::PathBuf;
    use tokio::sync::watch;

    #[test]
    fn retired_or_dropped_driver_is_not_reusable_without_eof() {
        let (end, keepalive) = watch::channel(false);
        assert!(connection_is_reusable(&end, false));
        // Retirement happens before asynchronous empty-session cleanup ends.
        end.send_replace(true);
        assert!(!connection_is_reusable(&end, false));
        drop(keepalive);

        let (end, keepalive) = watch::channel(false);
        // An aborted/failed driver drops the owner without ever observing EOF.
        drop(keepalive);
        assert!(!connection_is_reusable(&end, false));
    }

    #[test]
    fn eof_rejects_a_slot_even_when_keepalive_is_still_owned() {
        let (end, _keepalive) = watch::channel(false);
        assert!(!connection_is_reusable(&end, true));
    }

    fn key(agent: &str, cwd: &str) -> super::PoolKey {
        super::PoolKey {
            agent_id: agent.to_string(),
            cwd: PathBuf::from(cwd),
            remote_tag: None,
            launch_fingerprint: [0; 32],
        }
    }

    #[test]
    fn take_requires_full_key_match() {
        let mut map: SlotMap<u8> = SlotMap::default();
        map.insert(key("codex", "/vault-a"), 1);
        // Same agent, different cwd → miss, and the slot stays pooled.
        assert!(map.remove_matching(&key("codex", "/vault-b")).is_none());
        // Exact key → hit.
        assert_eq!(
            map.remove_matching(&key("codex", "/vault-a")),
            Some((key("codex", "/vault-a"), 1))
        );
        // Pooled slot survived the mismatched take attempt.
        assert!(map.remove_matching(&key("codex", "/vault-b")).is_none());
    }

    #[test]
    fn insert_displaces_previous_slot() {
        let mut map: SlotMap<u8> = SlotMap::default();
        assert!(map.insert(key("codex", "/vault"), 1).is_none());
        assert_eq!(
            map.insert(key("codex", "/vault"), 2),
            Some((key("codex", "/vault"), 1))
        );
        assert_eq!(map.get_matching(&key("codex", "/vault")), Some(&2));
    }

    #[test]
    fn snapshot_misses_on_missing_or_mismatched_key() {
        let mut map: SlotMap<u8> = SlotMap::default();
        assert_eq!(map.get_matching(&key("codex", "/vault")), None);
        map.insert(key("codex", "/vault"), 7);
        assert_eq!(map.get_matching(&key("codex", "/vault")), Some(&7));
        assert_eq!(map.get_matching(&key("grok", "/vault")), None);
    }

    #[test]
    fn remote_tag_distinguishes_keys() {
        let desc = descriptor();
        let mut local = pool_key(&desc, PathBuf::from("/vault"), None);
        assert!(local.remote_tag.is_none());
        local.remote_tag = Some("sim:host".to_string());
        let mut other = pool_key(&desc, PathBuf::from("/vault"), None);
        other.remote_tag = Some("host".to_string());
        assert_ne!(local, other);
    }

    fn descriptor() -> crate::features::agent::models::AgentDescriptor {
        serde_json::from_value(serde_json::json!({"id":"codex","name":"Codex","template":"codex-acp","command":"codex-acp","args":[],"env":{}})).unwrap()
    }

    #[test]
    fn launch_changes_do_not_reuse_connections_or_cached_models() {
        let desc = descriptor();
        let original = pool_key(&desc, PathBuf::from("/vault"), None);
        let mut map = SlotMap::default();
        map.insert(original.clone(), "old connection");
        let mut changed = desc.clone();
        changed
            .env
            .insert("OPENAI_BASE_URL".into(), "https://different.example".into());
        let next = pool_key(&changed, PathBuf::from("/vault"), None);
        assert_ne!(original, next);
        assert!(map.get_matching(&next).is_none());
        assert!(map.remove_matching(&next).is_none());
        changed = desc.clone();
        changed.args.push("--different-profile".into());
        assert!(map
            .get_matching(&pool_key(&changed, PathBuf::from("/vault"), None))
            .is_none());
        changed = desc;
        changed.command = "other-adapter".into();
        assert!(map
            .get_matching(&pool_key(&changed, PathBuf::from("/vault"), None))
            .is_none());
        assert_eq!(map.remove_matching(&original).unwrap().1, "old connection");
    }

    #[test]
    fn launch_identity_ignores_env_order_and_probe_display_changes() {
        let mut a = descriptor();
        a.env.insert("A".into(), "value".into());
        a.env.insert("API_KEY".into(), "secret-not-for-logs".into());
        let mut b = descriptor();
        b.env.insert("API_KEY".into(), "secret-not-for-logs".into());
        b.env.insert("A".into(), "value".into());
        b.name = "Renamed".into();
        b.last_probe_ok = Some(true);
        let key = pool_key(&a, PathBuf::from("/vault"), None);
        assert_eq!(key, pool_key(&b, PathBuf::from("/vault"), None));
        assert!(!format!("{key:?}").contains("secret-not-for-logs"));
        b.template = crate::features::agent::models::AgentTemplate::Custom;
        assert_ne!(key, pool_key(&b, PathBuf::from("/vault"), None));
    }
}
