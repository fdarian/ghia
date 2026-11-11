//! The retained tree as something selectors match against.

use std::cell::RefCell;

use rustc_hash::FxHashMap;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::Atom;
use super::matching::{AttrValue, ElementView};
use super::selector::AttrName;

// Children scanned and siblings stepped over by the matcher, which the tests read to check that
// sibling combinators cost work in proportion to the siblings and not their square.
#[cfg(test)]
thread_local! {
    pub(super) static SIBLING_WORK: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn count_sibling_work(steps: usize) {
    #[cfg(test)]
    SIBLING_WORK.with(|work| work.set(work.get() + steps));
    #[cfg(not(test))]
    let _ = steps;
}

enum Positions {
    /// Asked once: a scan answered it, which costs less than building the map.
    Asked,
    Map(FxHashMap<u64, usize>),
}

/// Where each element stands among its siblings, for one pass of matching over a tree that does
/// not change. A parent's map is built the second time it is asked, so one element among many
/// siblings costs a scan and the thousand that a mount matches cost one map.
#[derive(Default)]
pub struct SiblingPositions {
    parents: RefCell<FxHashMap<u64, Positions>>,
}

impl SiblingPositions {
    pub(super) fn position(&self, parent_id: u64, parent: &RetainedElement, id: u64) -> Option<usize> {
        let mut parents = self.parents.borrow_mut();
        match parents.get(&parent_id) {
            Some(Positions::Map(map)) => return map.get(&id).copied(),
            Some(Positions::Asked) => {
                count_sibling_work(parent.children.len());
                let map: FxHashMap<u64, usize> =
                    parent.children.iter().enumerate().map(|(position, child)| (*child, position)).collect();
                let position = map.get(&id).copied();
                parents.insert(parent_id, Positions::Map(map));
                return position;
            }
            None => {}
        }
        parents.insert(parent_id, Positions::Asked);
        let position = parent.children.iter().position(|child| *child == id);
        count_sibling_work(position.map_or(parent.children.len(), |position| position + 1));
        position
    }
}

#[derive(Clone, Copy)]
pub struct TreeView<'a> {
    tree: &'a RetainedTree,
    id: u64,
    positions: &'a SiblingPositions,
}

impl<'a> TreeView<'a> {
    pub fn new(tree: &'a RetainedTree, id: u64, positions: &'a SiblingPositions) -> Self {
        TreeView { tree, id, positions }
    }

    fn element(&self) -> &'a RetainedElement {
        self.tree.elements.get(&self.id).expect("a view is made of an element that exists")
    }

    fn with_id(&self, id: u64) -> Self {
        TreeView { tree: self.tree, id, positions: self.positions }
    }
}

impl ElementView for TreeView<'_> {
    fn tag(&self) -> Option<Atom> {
        self.tree.sheets.atoms.tag(&self.element().element_type)
    }

    fn id(&self) -> Option<Atom> {
        self.element().css().and_then(|css| css.id)
    }

    fn has_class(&self, class: Atom) -> bool {
        self.element().css().is_some_and(|css| css.classes.contains(&class))
    }

    fn attr(&self, name: AttrName) -> Option<AttrValue<'_>> {
        let sheets = &self.tree.sheets;
        let element = self.element();
        let name = if crate::custom_elements::svg_tree::is_svg_tag(&element.element_type) { name.written } else { name.lower };
        if name == sheets.style {
            let own = element.own_style()?;
            let raw = self.tree.styles.raw_of(own).expect("an own style comes from StyleTable::intern");
            return Some(AttrValue::Shared(sheets.style_text(own, &raw)));
        }
        element.attribute(sheets.atoms.name(name)).map(AttrValue::Text)
    }

    fn parent(&self) -> Option<Self> {
        Some(self.with_id(self.element().parent?))
    }

    fn prev_sibling(&self) -> Option<Self> {
        let parent_id = self.element().parent?;
        let parent = self.tree.elements.get(&parent_id)?;
        let position = self.positions.position(parent_id, parent, self.id)?;
        let mut steps = 0;
        let found = parent.children[..position].iter().rev().find(|sibling| {
            steps += 1;
            self.tree.elements.get(sibling).is_some_and(RetainedElement::is_matchable)
        });
        count_sibling_work(steps);
        found.map(|sibling| self.with_id(*sibling))
    }

    fn is_root(&self) -> bool {
        self.tree.root_id == Some(self.id)
    }
}
