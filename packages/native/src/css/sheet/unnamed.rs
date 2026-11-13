//! The elements that carry a class or id name no sheet names.
//!
//! An element keeps an atom only for a name a sheet has, so that the interner holds the names of
//! the sheets and not of every element ever seen. A sheet that comes later and names one has to
//! find the elements that carry it, and reading every element's class and id again for each new
//! name costs the elements times their names for each CSS-in-JS rule inserted. This index finds
//! them by the name's hash.
//!
//! It is lazy: an element is noted whenever its atoms are read and forgotten only when it is
//! destroyed, so a class that is rewritten leaves its note behind. A note that no longer holds
//! (the element dropped the name, or the hash is another name's) costs a read of that element when
//! the sheet comes, which finds nothing to change. A lazy index cannot miss an element, as an
//! eager one did that dropped the note of an id when the class beside it was rewritten.

use std::hash::{Hash, Hasher};

use rustc_hash::{FxHashMap, FxHasher};
use smallvec::SmallVec;

type Carriers = SmallVec<[u64; 1]>;

fn hash(name: &str) -> u64 {
    let mut hasher = FxHasher::default();
    name.hash(&mut hasher);
    hasher.finish()
}

#[derive(Default)]
pub(super) struct UnnamedNames {
    carriers: FxHashMap<u64, Carriers>,
}

impl UnnamedNames {
    /// Notes that `element` carries `name`. Noting twice is harmless: a repeat is dropped when
    /// the list is full, so an element that toggles a class does not grow it.
    pub(super) fn note(&mut self, name: &str, element: u64) {
        let carriers = self.carriers.entry(hash(name)).or_default();
        if carriers.last() == Some(&element) {
            return;
        }
        if carriers.len() == carriers.capacity() {
            carriers.sort_unstable();
            carriers.dedup();
        }
        carriers.push(element);
    }

    pub(super) fn forget(&mut self, name: &str, element: u64) {
        let key = hash(name);
        let Some(carriers) = self.carriers.get_mut(&key) else {
            return;
        };
        carriers.retain(|carrier| *carrier != element);
        if carriers.is_empty() {
            self.carriers.remove(&key);
        }
    }

    /// The elements noted under `name`, which a sheet now names. They are noted again when read,
    /// for the names that are still no sheet's.
    pub(super) fn take(&mut self, name: &str) -> Carriers {
        self.carriers.remove(&hash(name)).unwrap_or_default()
    }

    #[cfg(test)]
    pub(super) fn names(&self) -> usize {
        self.carriers.len()
    }

    #[cfg(test)]
    pub(super) fn carriers(&self, name: &str) -> usize {
        let mut carriers = self.carriers.get(&hash(name)).cloned().unwrap_or_default();
        carriers.sort_unstable();
        carriers.dedup();
        carriers.len()
    }
}
