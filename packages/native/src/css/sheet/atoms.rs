//! Names the matcher compares as integers: classes, ids, attribute names and tags.

use rustc_hash::FxHashMap;

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct Atom(u32);

/// One interner per document, shared by every sheet of it. Case is the caller's business: the
/// parser lower-cases tags and attribute names, and keeps classes and ids as written.
#[derive(Default)]
pub struct Atoms {
    by_name: FxHashMap<Box<str>, Atom>,
    names: Vec<Box<str>>,
}

impl Atoms {
    pub fn intern(&mut self, name: &str) -> Atom {
        if let Some(atom) = self.by_name.get(name) {
            return *atom;
        }
        let atom = Atom(u32::try_from(self.names.len()).expect("fewer than 2^32 atoms"));
        self.names.push(name.into());
        self.by_name.insert(name.into(), atom);
        atom
    }

    /// The atom of `name` if a sheet named it. A name no sheet uses cannot match any selector.
    pub fn get(&self, name: &str) -> Option<Atom> {
        self.by_name.get(name).copied()
    }

    pub fn name(&self, atom: Atom) -> &str {
        &self.names[atom.0 as usize]
    }
}
