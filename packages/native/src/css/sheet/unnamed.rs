//! The class and id names no sheet names, and the elements that carry them.
//!
//! An element keeps an atom only for a name a sheet has, so that the interner holds the names of
//! the sheets and not of every element ever seen. A sheet that comes later and names one has to
//! find the elements that carry it, and reading every element's class and id again for each new
//! name costs the elements times their names for each CSS-in-JS rule inserted. This index finds
//! them by name.

use rustc_hash::{FxHashMap, FxHashSet};

#[derive(Default)]
pub(super) struct UnnamedNames {
    elements: FxHashMap<Box<str>, FxHashSet<u64>>,
}

impl UnnamedNames {
    pub(super) fn note(&mut self, name: &str, element: u64) {
        match self.elements.get_mut(name) {
            Some(carriers) => {
                carriers.insert(element);
            }
            None => {
                self.elements.insert(name.into(), FxHashSet::from_iter([element]));
            }
        }
    }

    pub(super) fn forget(&mut self, name: &str, element: u64) {
        let Some(carriers) = self.elements.get_mut(name) else {
            return;
        };
        carriers.remove(&element);
        if carriers.is_empty() {
            self.elements.remove(name);
        }
    }

    /// The elements that carry `name`, which a sheet now names.
    pub(super) fn take(&mut self, name: &str) -> FxHashSet<u64> {
        self.elements.remove(name).unwrap_or_default()
    }

    pub(super) fn clear(&mut self) {
        self.elements.clear();
    }

    #[cfg(test)]
    pub(super) fn names(&self) -> usize {
        self.elements.len()
    }

    #[cfg(test)]
    pub(super) fn carriers(&self, name: &str) -> usize {
        self.elements.get(name).map_or(0, FxHashSet::len)
    }
}
