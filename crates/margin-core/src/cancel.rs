//! Cooperative-cancellation probe for long-running work.
//!
//! Cancellation state is owned by the host's job supervisor (desktop: the
//! JobCenter per-job tokens, indexed by task id). Core code only polls
//! [`is_cancelled`]; the host installs the backing lookup once at startup with
//! [`install_cancel_probe`]. Without a probe (headless CLI, unit tests) no task
//! is ever cancelled.

use std::sync::RwLock;

type Probe = dyn Fn(&str) -> bool + Send + Sync;

static PROBE: RwLock<Option<Box<Probe>>> = RwLock::new(None);

/// Install the host-backed cancellation lookup, replacing any previous probe.
pub fn install_cancel_probe(probe: impl Fn(&str) -> bool + Send + Sync + 'static) {
    if let Ok(mut slot) = PROBE.write() {
        *slot = Some(Box::new(probe));
    }
}

/// Whether the host supervisor has cancelled `task_id`.
pub fn is_cancelled(task_id: &str) -> bool {
    PROBE
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().map(|probe| probe(task_id)))
        .unwrap_or(false)
}

/// Test stand-in for the host supervisor: a crate-local cancelled-id set
/// behind the probe. Ids are unique per test, so parallel tests are safe.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    fn cancelled() -> &'static Mutex<HashSet<String>> {
        static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        SET.get_or_init(|| Mutex::new(HashSet::new()))
    }

    pub(crate) fn cancel(task_id: &str) {
        super::install_cancel_probe(|id| cancelled().lock().is_ok_and(|set| set.contains(id)));
        if let Ok(mut set) = cancelled().lock() {
            set.insert(task_id.to_string());
        }
    }

    pub(crate) fn finish(task_id: &str) {
        if let Ok(mut set) = cancelled().lock() {
            set.remove(task_id);
        }
    }
}

#[cfg(test)]
mod tests {
    /// An id no supervisor ever cancelled is never reported cancelled — the
    /// headless (no probe) default and the settled-id case share this path.
    #[test]
    fn unknown_id_is_never_cancelled() {
        assert!(!super::is_cancelled("cancel-probe-unknown-id"));
    }

    /// The host-backed probe reports a cancelled id until the supervisor
    /// clears it, mirroring the JobCenter registration lifecycle.
    #[test]
    fn probe_reports_cancelled_until_finished() {
        let id = format!("cancel-probe-{}", uuid::Uuid::new_v4());
        assert!(!super::is_cancelled(&id));
        super::testing::cancel(&id);
        assert!(super::is_cancelled(&id));
        super::testing::finish(&id);
        assert!(!super::is_cancelled(&id));
    }
}
