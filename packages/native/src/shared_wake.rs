//! The run-loop wake hook the renderers on one App share.
//!
//! `gpui_macos::set_run_loop_wake_hook` takes one hook for the process, so each renderer that asked
//! for wakes (`setFrameWakeCallback`) is an entry here, and the single hook calls every entry. A
//! second renderer asking never replaces the first: it would otherwise stop the first's frame loop
//! from waking. The frame loop in `@ghia/native/runtime` registers one callback for all the windows
//! of the App, so normally there is one entry at a time.
//!
//! `pending` is one flag for the hook: a wake that arrives while one is waiting for its tick is
//! dropped, and any renderer's `tick()` (which pumps the whole platform) ends the wait.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

/// Calls one renderer's wake callback. False when the call could not be queued.
pub(crate) type WakeCall = Arc<dyn Fn() -> bool + Send + Sync>;

pub(crate) type WakeHook = Arc<dyn Fn() + Send + Sync>;

struct Shared {
    pending: AtomicBool,
    entries: Mutex<Vec<(u64, WakeCall)>>,
}

static SHARED: LazyLock<Arc<Shared>> = LazyLock::new(|| {
    Arc::new(Shared { pending: AtomicBool::new(false), entries: Mutex::new(Vec::new()) })
});

/// Makes `call` what the run-loop watch wakes for `owner`, replacing the owner's earlier one, and
/// returns the hook the watch calls. The first entry installs it.
pub(crate) fn register(owner: u64, call: WakeCall) -> WakeHook {
    let shared = SHARED.clone();
    let first = {
        let mut entries = shared.entries.lock().unwrap();
        entries.retain(|(held, _)| *held != owner);
        entries.push((owner, call));
        entries.len() == 1
    };
    shared.pending.store(false, Ordering::Release);
    let hook: WakeHook = {
        let shared = shared.clone();
        Arc::new(move || {
            if shared.pending.swap(true, Ordering::AcqRel) {
                return;
            }
            let calls: Vec<WakeCall> =
                shared.entries.lock().unwrap().iter().map(|(_, call)| call.clone()).collect();
            // Every entry is called, so a wake reaches all of them; the flag clears when none queued.
            let queued = calls.iter().fold(false, |queued, call| call() || queued);
            if !queued {
                shared.pending.store(false, Ordering::Release);
            }
        })
    };
    // Unit tests call the hook themselves: installing it needs the main run loop.
    #[cfg(not(test))]
    if first {
        gpui_macos::set_run_loop_wake_hook(Some(hook.clone()));
    }
    #[cfg(test)]
    let _ = first;
    hook
}

/// Removes `owner`'s entry. The watch stops when none is left.
pub(crate) fn unregister(owner: u64) {
    let emptied = {
        let mut entries = SHARED.entries.lock().unwrap();
        let before = entries.len();
        entries.retain(|(held, _)| *held != owner);
        before > 0 && entries.is_empty()
    };
    if emptied {
        #[cfg(not(test))]
        gpui_macos::set_run_loop_wake_hook(None);
        SHARED.pending.store(false, Ordering::Release);
    }
}

/// After a tick, on every path: a wake that landed during it was dropped, and the watch only wakes
/// again once it is told the run loop was pumped.
pub(crate) fn tick_finished() {
    SHARED.pending.store(false, Ordering::Release);
    #[cfg(not(test))]
    gpui_macos::run_loop_pumped();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_second_entry_does_not_replace_the_first() {
        let first = Arc::new(AtomicUsize::new(0));
        let second = Arc::new(AtomicUsize::new(0));
        let hook = register(9001, {
            let first = first.clone();
            Arc::new(move || {
                first.fetch_add(1, Ordering::SeqCst);
                true
            })
        });
        register(9002, {
            let second = second.clone();
            Arc::new(move || {
                second.fetch_add(1, Ordering::SeqCst);
                true
            })
        });
        hook();
        assert_eq!((first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)), (1, 1));
        // The wake is pending until a tick ends it.
        hook();
        assert_eq!(first.load(Ordering::SeqCst), 1);
        SHARED.pending.store(false, Ordering::Release);
        unregister(9001);
        hook();
        assert_eq!((first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)), (1, 2));
        unregister(9002);
    }
}
