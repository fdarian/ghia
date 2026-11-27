//! The retained tree as something selectors match against.

use std::borrow::Cow;
use std::cell::RefCell;

use rustc_hash::FxHashMap;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::{Atom, Atoms};
use super::document::StyleSheets;
use super::matching::{AttrValue, ElementView, SiblingTest};
use super::selector::AttrName;
use super::states::State;
use super::tree_states::TreeState;

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

/// An element's place among the element children of its parent, from 1.
#[derive(Clone, Copy)]
pub(super) struct Slot {
    from_start: u32,
    from_end: u32,
    of_type_from_start: u32,
    of_type_from_end: u32,
}

impl Slot {
    fn get(self, of_type: bool, from_end: bool) -> u32 {
        match (of_type, from_end) {
            (false, false) => self.from_start,
            (false, true) => self.from_end,
            (true, false) => self.of_type_from_start,
            (true, true) => self.of_type_from_end,
        }
    }
}

enum Slots {
    /// Asked once: a scan answered it, which costs less than numbering every child.
    Asked,
    Map(FxHashMap<u64, Slot>),
}

/// Whether two elements are of one type: an HTML type is case-insensitive, an SVG one as written.
/// An element is SVG by its tag name alone (`is_svg`), so an `a` inside an `<svg>` is an HTML `a`
/// here, unlike in a DOM.
fn same_type(a: &RetainedElement, b: &RetainedElement) -> bool {
    a.is_svg() == b.is_svg()
        && if a.is_svg() { a.element_type == b.element_type } else { a.element_type.eq_ignore_ascii_case(&b.element_type) }
}

/// The key an element's type is counted under, equal for elements [`same_type`] holds for.
fn type_key(element: &RetainedElement) -> (bool, Cow<'_, str>) {
    if element.is_svg() || !element.element_type.bytes().any(|byte| byte.is_ascii_uppercase()) {
        (element.is_svg(), Cow::Borrowed(element.element_type.as_str()))
    } else {
        (false, Cow::Owned(element.element_type.to_ascii_lowercase()))
    }
}

/// How far the children of one parent have been tried against one [`SiblingTest`].
#[derive(Clone, Copy, Default)]
struct Scan {
    /// The first position that satisfies the test, once one has been met.
    first: Option<usize>,
    /// Positions before this one have been tried.
    tried: usize,
}

/// Where each element stands among its siblings, and what a sibling combinator has learnt about
/// them, for one pass of matching over a tree that does not change. A parent's map is built the
/// second time it is asked, so one element among many siblings costs a scan and the thousand that
/// a mount matches cost one map.
#[derive(Default)]
pub struct SiblingPositions {
    parents: RefCell<FxHashMap<u64, Positions>>,
    scans: RefCell<FxHashMap<(u64, SiblingTest), Scan>>,
    slots: RefCell<FxHashMap<u64, Slots>>,
    /// What each `:has()` answered for the elements it was asked of: the element, and the address
    /// of its argument list.
    has: RefCell<FxHashMap<(u64, usize), bool>>,
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

impl SiblingPositions {
    /// The place of the child `id` among the element children of `parent`, which counts the
    /// children once: by a scan the first time a parent is asked, and from a map of all of them
    /// from the second. `None` when the parent does not list it.
    pub(super) fn slot(&self, tree: &RetainedTree, parent_id: u64, parent: &RetainedElement, id: u64) -> Option<Slot> {
        let mut slots = self.slots.borrow_mut();
        match slots.get(&parent_id) {
            Some(Slots::Map(map)) => return map.get(&id).copied(),
            Some(Slots::Asked) => {
                count_sibling_work(parent.children.len());
                let map = number_children(tree, parent);
                let slot = map.get(&id).copied();
                slots.insert(parent_id, Slots::Map(map));
                return slot;
            }
            None => {}
        }
        slots.insert(parent_id, Slots::Asked);
        count_sibling_work(parent.children.len());
        scan_child(tree, parent, id)
    }
}

/// The slot of one child, found by walking the children.
fn scan_child(tree: &RetainedTree, parent: &RetainedElement, id: u64) -> Option<Slot> {
    let element = tree.elements.get(&id)?;
    let (mut before, mut before_of_type, mut found) = (0u32, 0u32, false);
    let (mut after, mut after_of_type) = (0u32, 0u32);
    for child_id in &parent.children {
        let Some(child) = tree.elements.get(child_id).filter(|child| child.is_matchable()) else {
            continue;
        };
        let of_type = same_type(child, element);
        if *child_id == id {
            found = true;
        } else if found {
            after += 1;
            after_of_type += u32::from(of_type);
        } else {
            before += 1;
            before_of_type += u32::from(of_type);
        }
    }
    found.then_some(Slot {
        from_start: before + 1,
        from_end: after + 1,
        of_type_from_start: before_of_type + 1,
        of_type_from_end: after_of_type + 1,
    })
}

/// The slot of every element child of `parent`.
fn number_children(tree: &RetainedTree, parent: &RetainedElement) -> FxHashMap<u64, Slot> {
    let children: Vec<(u64, &RetainedElement)> = parent
        .children
        .iter()
        .filter_map(|id| tree.elements.get(id).filter(|child| child.is_matchable()).map(|child| (*id, child)))
        .collect();
    let mut totals: FxHashMap<(bool, Cow<'_, str>), u32> = FxHashMap::default();
    for &(_, child) in &children {
        *totals.entry(type_key(child)).or_default() += 1;
    }
    let total = children.len() as u32;
    let mut seen: FxHashMap<(bool, Cow<'_, str>), u32> = FxHashMap::default();
    let mut map = FxHashMap::with_capacity_and_hasher(children.len(), Default::default());
    for (position, &(id, child)) in children.iter().enumerate() {
        let key = type_key(child);
        let before_of_type = seen.entry(key.clone()).or_default();
        let of_type_total = totals[&key];
        map.insert(
            id,
            Slot {
                from_start: position as u32 + 1,
                from_end: total - position as u32,
                of_type_from_start: *before_of_type + 1,
                of_type_from_end: of_type_total - *before_of_type,
            },
        );
        *before_of_type += 1;
    }
    map
}

impl SiblingPositions {
    /// Whether `satisfies` holds for a child of `parent` before `position`. The children are
    /// tried in order and once, up to the furthest position asked: the first to satisfy the test
    /// answers every sibling after it, and a run of children that do not answers every sibling
    /// inside it.
    fn any_before(
        &self,
        parent_id: u64,
        parent: &RetainedElement,
        position: usize,
        test: SiblingTest,
        satisfies: impl Fn(u64) -> bool,
    ) -> bool {
        let key = (parent_id, test);
        // `satisfies` matches the rest of the selector, which can ask this cache again, so no
        // borrow is held while it runs.
        let mut scan = self.scans.borrow().get(&key).copied().unwrap_or_default();
        if let Some(first) = scan.first {
            return first < position;
        }
        if scan.tried < position {
            let found = parent.children[scan.tried..position].iter().position(|child| satisfies(*child));
            match found {
                Some(offset) => {
                    count_sibling_work(offset + 1);
                    scan.first = Some(scan.tried + offset);
                    scan.tried += offset + 1;
                }
                None => {
                    count_sibling_work(position - scan.tried);
                    scan.tried = position;
                }
            }
            self.scans.borrow_mut().insert(key, scan);
        }
        scan.first.is_some()
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

/// What the matcher reads of an element, for code that has to agree with it on which elements
/// have a tag or an attribute.
pub(super) fn tag_of(atoms: &Atoms, element: &RetainedElement) -> Option<Atom> {
    if element.is_svg() {
        atoms.get(&element.element_type)
    } else {
        atoms.tag(&element.element_type)
    }
}

/// An HTML element holds lower-cased attribute names and an SVG one the names as written.
fn attribute_name(element: &RetainedElement, name: AttrName) -> Atom {
    if element.is_svg() {
        name.written
    } else {
        name.lower
    }
}

/// Whether [`TreeView::attr`] finds the attribute: `style` is the element's own style.
pub(super) fn has_attr(sheets: &StyleSheets, element: &RetainedElement, name: AttrName) -> bool {
    let name = attribute_name(element, name);
    if name == sheets.style {
        element.own_style().is_some()
    } else {
        element.attribute(sheets.atoms.name(name)).is_some()
    }
}

impl ElementView for TreeView<'_> {
    fn tag(&self) -> Option<Atom> {
        tag_of(&self.tree.sheets.atoms, self.element())
    }

    fn is_svg(&self) -> bool {
        self.element().is_svg()
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
        let name = attribute_name(element, name);
        if name == sheets.style {
            let own = element.own_style()?;
            let raw = self.tree.styles.raw_of(own);
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

    fn tree_state(&self, state: TreeState) -> bool {
        super::tree_states::read(self.tree, self.id, self.element(), state)
    }

    fn live_state(&self, state: State) -> bool {
        self.tree.sheets.live.has(self.id, state)
    }

    fn child_index(&self, of_type: bool, from_end: bool) -> Option<u32> {
        let Some(parent_id) = self.element().parent else {
            return Some(1);
        };
        let parent = self.tree.elements.get(&parent_id)?;
        self.positions.slot(self.tree, parent_id, parent, self.id).map(|slot| slot.get(of_type, from_end))
    }

    fn is_empty(&self) -> bool {
        !self.element().children.iter().filter_map(|id| self.tree.elements.get(id)).any(|child| {
            child.is_matchable() || child.content.as_deref().is_some_and(|text| !text.is_empty())
        })
    }

    fn children(&self) -> Vec<Self> {
        let children = &self.element().children;
        count_sibling_work(children.len());
        children
            .iter()
            .filter(|id| self.tree.elements.get(id).is_some_and(RetainedElement::is_matchable))
            .map(|id| self.with_id(*id))
            .collect()
    }

    fn next_sibling(&self) -> Option<Self> {
        let parent_id = self.element().parent?;
        let parent = self.tree.elements.get(&parent_id)?;
        let position = self.positions.position(parent_id, parent, self.id)?;
        let mut steps = 0;
        let found = parent.children[position + 1..].iter().find(|sibling| {
            steps += 1;
            self.tree.elements.get(sibling).is_some_and(RetainedElement::is_matchable)
        });
        count_sibling_work(steps);
        found.map(|sibling| self.with_id(*sibling))
    }

    fn remembered_has(&self, list: usize, compute: impl FnOnce() -> bool) -> bool {
        if let Some(known) = self.positions.has.borrow().get(&(self.id, list)) {
            return *known;
        }
        let answer = compute();
        self.positions.has.borrow_mut().insert((self.id, list), answer);
        answer
    }

    fn any_earlier_sibling(&self, test: SiblingTest, satisfies: impl Fn(&Self) -> bool) -> bool {
        let Some(parent_id) = self.element().parent else {
            return false;
        };
        let Some(parent) = self.tree.elements.get(&parent_id) else {
            return false;
        };
        let Some(position) = self.positions.position(parent_id, parent, self.id) else {
            return false;
        };
        self.positions.any_before(parent_id, parent, position, test, |sibling| {
            self.tree.elements.get(&sibling).is_some_and(RetainedElement::is_matchable)
                && satisfies(&self.with_id(sibling))
        })
    }
}
