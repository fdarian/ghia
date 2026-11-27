//! State keyed by host element id, kept per window.
//!
//! Host ids are allocated by each renderer, so the same id names an element in every window on the
//! App. A thread-local `HashMap<u64, _>` that outlives a frame (a scroll handle napi reads without
//! an App, a smooth scroll in flight) therefore has to say which window the id is in.

use std::collections::HashMap;

use gpui::WindowId;
use rustc_hash::FxHashMap;

pub(crate) struct WindowMap<V> {
    windows: FxHashMap<WindowId, HashMap<u64, V>>,
    empty: HashMap<u64, V>,
}

impl<V> Default for WindowMap<V> {
    fn default() -> Self {
        Self { windows: FxHashMap::default(), empty: HashMap::new() }
    }
}

impl<V> WindowMap<V> {
    pub(crate) fn get(&self, window: WindowId, id: u64) -> Option<&V> {
        self.windows.get(&window)?.get(&id)
    }

    pub(crate) fn contains(&self, window: WindowId, id: u64) -> bool {
        self.get(window, id).is_some()
    }

    pub(crate) fn insert(&mut self, window: WindowId, id: u64, value: V) -> Option<V> {
        self.windows.entry(window).or_default().insert(id, value)
    }

    pub(crate) fn remove(&mut self, window: WindowId, id: u64) -> Option<V> {
        self.windows.get_mut(&window)?.remove(&id)
    }

    /// Everything of `window`, empty when it has nothing.
    pub(crate) fn of(&self, window: WindowId) -> &HashMap<u64, V> {
        self.windows.get(&window).unwrap_or(&self.empty)
    }

    pub(crate) fn of_mut(&mut self, window: WindowId) -> &mut HashMap<u64, V> {
        self.windows.entry(window).or_default()
    }

    /// Hands over everything of `window`, leaving it empty.
    pub(crate) fn take(&mut self, window: WindowId) -> HashMap<u64, V> {
        self.windows.remove(&window).unwrap_or_default()
    }

    pub(crate) fn clear(&mut self, window: WindowId) {
        if let Some(held) = self.windows.get_mut(&window) {
            held.clear();
        }
    }

    pub(crate) fn forget(&mut self, window: WindowId) {
        self.windows.remove(&window);
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.windows.values().all(|held| held.is_empty())
    }
}

impl<V: Clone> WindowMap<V> {
    /// Makes `window` hold what `from` holds in `source`, as a snapshot.
    pub(crate) fn copy_window_from(&mut self, window: WindowId, source: &WindowMap<V>) {
        self.windows.insert(window, source.of(window).clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(n: u64) -> WindowId {
        WindowId::from(n)
    }

    #[test]
    fn the_same_id_in_two_windows_is_two_entries() {
        let mut map = WindowMap::default();
        map.insert(window(1), 7, "first");
        map.insert(window(2), 7, "second");
        assert_eq!(map.get(window(1), 7), Some(&"first"));
        assert_eq!(map.get(window(2), 7), Some(&"second"));
        assert_eq!(map.remove(window(1), 7), Some("first"));
        assert_eq!(map.get(window(2), 7), Some(&"second"));
    }

    #[test]
    fn clearing_or_forgetting_a_window_leaves_the_others() {
        let mut map = WindowMap::default();
        map.insert(window(1), 1, 10);
        map.insert(window(2), 1, 20);
        map.clear(window(1));
        assert!(map.of(window(1)).is_empty());
        assert_eq!(map.get(window(2), 1), Some(&20));
        map.forget(window(2));
        assert!(map.is_empty());
    }

    #[test]
    fn a_window_that_holds_nothing_reads_as_empty() {
        let map: WindowMap<u8> = WindowMap::default();
        assert!(map.of(window(9)).is_empty());
        assert!(!map.contains(window(9), 1));
    }

    #[test]
    fn a_copy_is_a_snapshot_of_one_window() {
        let mut live = WindowMap::default();
        live.insert(window(1), 1, 10);
        live.insert(window(2), 1, 20);
        let mut kept = WindowMap::default();
        kept.copy_window_from(window(1), &live);
        live.insert(window(1), 2, 11);
        assert_eq!(kept.of(window(1)).len(), 1);
        assert!(kept.of(window(2)).is_empty());
    }
}
