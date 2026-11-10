//! The retained tree's side of stylesheets: hooks that note what a mutation can change for the
//! selectors, and the flush that matches again and restyles.
//!
//! A hook only collects marks (an element, whether its subtree and following siblings are
//! included). `flush_styles` runs once at the end of a batch: it reloads the sheets when their
//! sources changed, expands the marks, matches each marked element and hands the ones whose
//! matched rules changed to `RetainedTree::apply_matched`, which restyles them as `set_style` does.

use std::borrow::Cow;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::attributes::attribute_name_of_prop;
use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::{Atom, Atoms};
use super::cascade::MatchedRules;
use super::invalidation::Reach;
use super::selector::Specificity;
use super::view::{count_sibling_work, SiblingPositions, TreeView};

/// Elements of a subtree `contains_style_element` walks for each `<style>` element there is, which
/// is about what walking up from that one costs.
const SUBTREE_WALK_PER_STYLE: usize = 8;

fn lowercase(name: &str) -> Cow<'_, str> {
    if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(name.to_ascii_lowercase())
    } else {
        Cow::Borrowed(name)
    }
}

/// A class or id no sheet names cannot match a selector, so it has no atom and an element keeps
/// nothing of it: the interner holds the names of the sheets, not of every element ever seen.
fn class_atoms(atoms: &Atoms, value: Option<Cow<'_, str>>) -> Vec<Atom> {
    value
        .map(|value| value.split_ascii_whitespace().filter_map(|class| atoms.get(class)).collect())
        .unwrap_or_default()
}

fn id_atom(atoms: &Atoms, value: Option<Cow<'_, str>>) -> Option<Atom> {
    value.and_then(|value| atoms.get(&value))
}

impl RetainedTree {
    // Sources.

    fn enable_sheets(&mut self) {
        if !self.sheets.enabled {
            self.sheets.enabled = true;
            self.sheets.atoms_fresh = false;
        }
    }

    /// Sets the text of a constructed sheet, or deletes it. It applies while it is adopted.
    pub fn set_style_sheet(&mut self, sheet_id: u64, text: Option<&str>) {
        match text {
            Some(text) => {
                if self.sheets.constructed.get(&sheet_id).is_some_and(|current| current == text) {
                    return;
                }
                self.sheets.constructed.insert(sheet_id, text.to_owned());
            }
            None => {
                if self.sheets.constructed.remove(&sheet_id).is_none() {
                    return;
                }
            }
        }
        self.enable_sheets();
        self.sheets.sources_dirty = true;
    }

    /// Replaces the list of constructed sheets that apply, which come after the `<style>` elements.
    pub fn set_adopted_style_sheets(&mut self, sheet_ids: Vec<u64>) {
        if self.sheets.adopted == sheet_ids {
            return;
        }
        self.sheets.adopted = sheet_ids;
        if self.sheets.enabled {
            self.sheets.sources_dirty = true;
        }
    }

    // Hooks. Each runs only while `sheets.enabled`, except the one for a created `<style>`.

    pub(crate) fn sheets_style_created(&mut self, id: u64) {
        self.enable_sheets();
        self.sheets.style_elements.insert(id);
        self.sheets.sources_dirty = true;
    }

    pub(crate) fn sheets_destroyed(&mut self, id: u64) {
        if self.sheets.style_elements.remove(&id) {
            self.sheets.sources_dirty = true;
        }
    }

    /// Before `child` leaves the place it has: what follows it there is matched without it.
    pub(crate) fn sheets_unlinking(&mut self, child: u64) {
        let Some(parent_id) = self.elements.get(&child).and_then(|element| element.parent) else {
            if self.contains_style_element(child) {
                self.sheets.sources_dirty = true;
            }
            return;
        };
        if self.sheets.style_elements.contains(&parent_id) || self.contains_style_element(child) {
            self.sheets.sources_dirty = true;
        }
        let structure = self.sheets.index.invalidation.structure;
        if self.sheets.atoms_fresh && !structure.is_empty() && self.elements.get(&child).is_some_and(RetainedElement::is_matchable) {
            if let Some(next) = self.next_element_sibling(child) {
                self.sheets.mark(next, structure.from_next_sibling());
            }
        }
    }

    /// After `child` was put where it is, or taken out of the document.
    pub(crate) fn sheets_linked(&mut self, child: u64) {
        let parent = self.elements.get(&child).and_then(|element| element.parent);
        if parent.is_some_and(|parent| self.sheets.style_elements.contains(&parent)) || self.contains_style_element(child) {
            self.sheets.sources_dirty = true;
        }
        if self.sheets.atoms_fresh && self.elements.get(&child).is_some_and(RetainedElement::is_matchable) {
            let structure = self.sheets.index.invalidation.structure;
            self.sheets.mark(child, Reach::SELF | Reach::DESCENDANTS | structure);
        }
    }

    /// `was_matchable` is whether the element was a matchable one before its string changed: a
    /// `text` element given a string turns into a text node, which leaves its siblings' selectors
    /// the way a removal does.
    pub(crate) fn sheets_text_changed(&mut self, id: u64, was_matchable: bool) {
        let parent = self.elements.get(&id).and_then(|element| element.parent);
        if parent.is_some_and(|parent| self.sheets.style_elements.contains(&parent)) {
            self.sheets.sources_dirty = true;
        }
        if self.sheets.atoms_fresh {
            self.sheets.mark(id, Reach::SELF);
            let structure = self.sheets.index.invalidation.structure;
            let is_matchable = self.elements.get(&id).is_some_and(RetainedElement::is_matchable);
            if was_matchable != is_matchable && !structure.is_empty() {
                if let Some(next) = self.next_element_sibling(id) {
                    self.sheets.mark(next, structure.from_next_sibling());
                }
            }
        }
    }

    pub(crate) fn sheets_root_changed(&mut self) {
        self.sheets.sources_dirty = true;
        self.sheets.mark_all = true;
    }

    pub(crate) fn sheets_attribute_changed(&mut self, id: u64, name: &str) {
        if self.sheets.atoms_fresh {
            self.attribute_changed(id, &lowercase(name));
        }
    }

    /// The own style of an element changed: only a `[style]` selector can tell.
    pub(crate) fn sheets_style_changed(&mut self, id: u64) {
        if self.sheets.atoms_fresh {
            let reach = self.sheets.style_reach();
            self.sheets.mark(id, reach);
        }
    }

    fn attribute_changed(&mut self, id: u64, name: &str) {
        let reach = match name {
            "class" => {
                let before = self.refresh_class_atoms(id);
                let after = self.elements.get(&id).and_then(|element| element.css()).map_or(&[][..], |css| &css.classes[..]);
                self.sheets.class_reach(&before, after)
            }
            "id" => {
                let before = self.refresh_id_atom(id);
                let after = self.elements.get(&id).and_then(|element| element.css()).and_then(|css| css.id);
                self.sheets.id_reach(before, after)
            }
            _ => self.sheets.attribute_reach(name),
        };
        self.sheets.mark(id, reach);
    }

    /// Whether `ancestor` is a `<style>` element or has one below it. Asked on every insert and
    /// removal of an element with children, so it has to cost little with a thousand `<style>`
    /// elements: a small subtree is walked, and only a large one is answered from the style
    /// elements' side, by walking up from each to the root.
    fn contains_style_element(&self, ancestor: u64) -> bool {
        let styles = &self.sheets.style_elements;
        if styles.is_empty() {
            return false;
        }
        if styles.contains(&ancestor) {
            return true;
        }
        let Some(element) = self.elements.get(&ancestor) else {
            return false;
        };
        if element.children.is_empty() {
            return false;
        }
        let mut budget = styles.len().saturating_mul(SUBTREE_WALK_PER_STYLE);
        let mut walk = vec![element.children.iter()];
        while let Some(children) = walk.last_mut() {
            let Some(id) = children.next() else {
                walk.pop();
                continue;
            };
            if styles.contains(id) {
                return true;
            }
            if budget == 0 {
                return self.style_elements_reach(ancestor);
            }
            budget -= 1;
            if let Some(element) = self.elements.get(id) {
                walk.push(element.children.iter());
            }
        }
        false
    }

    fn style_elements_reach(&self, ancestor: u64) -> bool {
        self.sheets.style_elements.iter().any(|style| {
            let mut at = Some(*style);
            while let Some(id) = at {
                if id == ancestor {
                    return true;
                }
                at = self.elements.get(&id).and_then(|element| element.parent);
            }
            false
        })
    }

    // Atoms.

    /// Reads the class atoms again, and returns the ones the element had.
    fn refresh_class_atoms(&mut self, id: u64) -> Vec<Atom> {
        let atoms = &self.sheets.atoms;
        let Some(element) = self.elements.get_mut(&id) else {
            return Vec::new();
        };
        let classes = class_atoms(atoms, element.attribute("class"));
        element.replace_css_classes(classes)
    }

    /// Reads the id atom again, and returns the one the element had.
    fn refresh_id_atom(&mut self, id: u64) -> Option<Atom> {
        let atoms = &self.sheets.atoms;
        let element = self.elements.get_mut(&id)?;
        let element_id = id_atom(atoms, element.attribute("id"));
        element.replace_css_id(element_id)
    }

    /// An element's `id` arrives as a prop, not through `setAttribute`, and so do `role` and
    /// `aria-*`: they read as attributes of the same name, and `tabIndex` as `tabindex`.
    pub(crate) fn sheets_prop_changed(&mut self, id: u64, key: &str) {
        if self.sheets.atoms_fresh {
            self.attribute_changed(id, attribute_name_of_prop(key));
        }
    }

    // The tree.

    /// Whether `id` is `root_id` or below it.
    fn is_connected(&self, id: u64) -> bool {
        let Some(root) = self.root_id else {
            return false;
        };
        let mut at = id;
        loop {
            if at == root {
                return true;
            }
            match self.elements.get(&at).and_then(|element| element.parent) {
                Some(parent) => at = parent,
                None => return false,
            }
        }
    }

    /// Positions of `id` and its ancestors among their siblings, from the top: tree order. `None`
    /// when an ancestor does not list the element, which a batch that appends to a parent before
    /// creating it leaves behind: such an element is not in the document.
    fn tree_path(&self, id: u64) -> Option<Vec<usize>> {
        let mut path = Vec::new();
        let mut at = id;
        while let Some(parent) = self.elements.get(&at).and_then(|element| element.parent) {
            let position = self.elements.get(&parent)?.children.iter().position(|child| *child == at)?;
            path.push(position);
            at = parent;
        }
        path.reverse();
        Some(path)
    }

    fn text_content(&self, id: u64) -> String {
        let Some(element) = self.elements.get(&id) else {
            return String::new();
        };
        element
            .children
            .iter()
            .filter_map(|child| self.elements.get(child))
            .filter(|child| child.element_type == "text")
            .filter_map(|child| child.content.as_deref())
            .collect()
    }

    /// Parses the sheets again when their texts differ from the ones the index was built from.
    fn reload_sheets(&mut self) {
        let mut connected: Vec<(Vec<usize>, u64)> = self
            .sheets
            .style_elements
            .iter()
            .copied()
            .filter(|id| self.is_connected(*id))
            .filter_map(|id| self.tree_path(id).map(|path| (path, id)))
            .collect();
        connected.sort();
        let texts = self.sheets.texts_with(connected.iter().map(|(_, id)| self.text_content(*id)).collect());
        if texts == self.sheets.loaded {
            return;
        }
        let names = self.sheets.atoms.len();
        self.sheets.load(texts);
        // Elements keep atoms only for the names a sheet had when they were read, so a name the
        // new sheets bring has to be looked for in every element's class and id again.
        if self.sheets.atoms.len() != names {
            self.sheets.atoms_fresh = false;
        }
        self.styles.cascaded.clear();
        self.sheets.mark_all = true;
    }

    fn init_all_css(&mut self) {
        let atoms = &self.sheets.atoms;
        for element in self.elements.values_mut() {
            let element_id = id_atom(atoms, element.attribute("id"));
            let classes = class_atoms(atoms, element.attribute("class"));
            element.set_css_atoms(element_id, classes);
        }
    }

    /// The first sibling after `id` that selectors can match.
    fn next_element_sibling(&self, id: u64) -> Option<u64> {
        let parent = self.elements.get(self.elements.get(&id)?.parent.as_ref()?)?;
        let position = parent.children.iter().position(|child| *child == id)?;
        parent.children[position + 1..]
            .iter()
            .copied()
            .find(|sibling| self.elements.get(sibling).is_some_and(RetainedElement::is_matchable))
    }

    /// The elements to match again, each with whether it is in the document, once.
    fn restyle_set(&self, marks: &[(u64, Reach)], all: bool) -> Vec<(u64, bool)> {
        if all {
            let walked = self.document_order(None);
            let mut out: Vec<(u64, bool)> = Vec::with_capacity(self.elements.len());
            out.extend(walked.iter().map(|id| (*id, true)));
            if walked.len() < self.elements.len() {
                let in_document: FxHashSet<u64> = walked.into_iter().collect();
                out.extend(self.elements.keys().filter(|id| !in_document.contains(id)).map(|id| (*id, false)));
            }
            return out;
        }
        let out: Vec<(u64, bool)> = Vec::with_capacity(marks.len());
        let mut expansion = Expansion {
            tree: self,
            visited: FxHashSet::with_capacity_and_hasher(marks.len(), Default::default()),
            covered: FxHashSet::default(),
            out,
        };
        // Marks of siblings come in a run, so the last parent's answer is most often the one needed.
        let mut last_parent: Option<(u64, bool)> = None;
        // The marks that reach siblings, by parent in the order the parents were first marked.
        let mut by_parent: Vec<(u64, Vec<(u64, Reach)>)> = Vec::new();
        let mut slot_of: FxHashMap<u64, usize> = FxHashMap::default();
        for (id, reach) in marks {
            let Some(element) = self.elements.get(id) else {
                continue;
            };
            let connected = match element.parent {
                Some(parent) if self.root_id != Some(*id) => match last_parent {
                    Some((last, connected)) if last == parent => connected,
                    _ => {
                        let connected = self.is_connected(parent);
                        last_parent = Some((parent, connected));
                        connected
                    }
                },
                _ => self.is_connected(*id),
            };
            expansion.add(*id, reach.own(), connected);
            if !reach.reaches_siblings() {
                continue;
            }
            let Some(parent) = element.parent.filter(|parent| self.elements.contains_key(parent)) else {
                continue;
            };
            let slot = *slot_of.entry(parent).or_insert_with(|| {
                by_parent.push((parent, Vec::new()));
                by_parent.len() - 1
            });
            by_parent[slot].1.push((*id, *reach));
        }
        for (parent, siblings) in &by_parent {
            self.expand_siblings(&mut expansion, *parent, siblings);
        }
        expansion.out
    }

    /// The siblings `marks` (all children of `parent_id`) reach: for each, the next matchable
    /// sibling, and the following ones. The following siblings are walked once, from the first
    /// mark, with the places of every mark before each of them folded together, so n marks among
    /// n siblings cost n and not n squared.
    fn expand_siblings(&self, expansion: &mut Expansion<'_>, parent_id: u64, marks: &[(u64, Reach)]) {
        let parent = &self.elements[&parent_id];
        let connected = self.is_connected(parent_id);
        count_sibling_work(parent.children.len());
        let mut placed: Vec<(usize, Reach)> = if let [(id, reach)] = marks {
            parent.children.iter().position(|child| child == id).map(|position| (position, *reach)).into_iter().collect()
        } else {
            let positions: FxHashMap<u64, usize> =
                parent.children.iter().enumerate().map(|(position, child)| (*child, position)).collect();
            marks.iter().filter_map(|(id, reach)| positions.get(id).map(|position| (*position, *reach))).collect()
        };
        for (position, reach) in &placed {
            if reach.next_sibling() == 0 {
                continue;
            }
            let mut steps = 0;
            let next = parent.children[position + 1..].iter().copied().find(|sibling| {
                steps += 1;
                self.elements.get(sibling).is_some_and(RetainedElement::is_matchable)
            });
            count_sibling_work(steps);
            if let Some(next) = next {
                expansion.add(next, reach.next_sibling(), connected);
            }
        }
        placed.retain(|(_, reach)| reach.following_siblings() != 0);
        placed.sort_by_key(|(position, _)| *position);
        let Some((first, _)) = placed.first() else {
            return;
        };
        let mut folded = 0u8;
        let mut pending = placed.iter().peekable();
        for (position, sibling) in parent.children.iter().enumerate().skip(first + 1) {
            while let Some((_, reach)) = pending.next_if(|(mark, _)| *mark < position) {
                folded |= reach.following_siblings();
            }
            count_sibling_work(1);
            expansion.add(*sibling, folded, connected);
        }
    }

    /// Matches what the batch marked, and restyles the elements whose rules changed.
    pub fn flush_styles(&mut self) {
        if !self.sheets.has_work() {
            return;
        }
        if self.sheets.sources_dirty {
            self.sheets.sources_dirty = false;
            self.reload_sheets();
        }
        if !self.sheets.atoms_fresh {
            self.init_all_css();
            self.sheets.atoms_fresh = true;
            self.sheets.mark_all = true;
        }
        let marks = std::mem::take(&mut self.sheets.pending);
        let all = std::mem::take(&mut self.sheets.mark_all);
        let restyle = self.restyle_set(&marks, all);

        let mut found: Vec<(u64, Vec<(u32, Specificity)>)> = Vec::new();
        let positions = SiblingPositions::default();
        for (id, connected) in restyle {
            crate::perf_counters::element_rematched();
            let Some(element) = self.elements.get(&id) else {
                continue;
            };
            let css = element.css();
            let (element_id, classes) = css.map_or((None, &[][..]), |css| (css.id, &css.classes[..]));
            let matched = if connected && element.is_matchable() && self.sheets.index.may_match(element_id, classes) {
                self.sheets.index.matching(&TreeView::new(self, id, &positions), element_id, classes)
            } else {
                Vec::new()
            };
            let was_matched = css.is_some_and(|css| css.matched.is_some());
            if !matched.is_empty() || was_matched {
                found.push((id, matched));
            }
        }

        let mut changes: Vec<(u64, Option<Arc<MatchedRules>>)> = Vec::new();
        for (id, matched) in found {
            let new = if matched.is_empty() { None } else { Some(self.sheets.interner.intern(&self.sheets.index, matched)) };
            let old = self.elements.get(&id).and_then(|element| element.css()).and_then(|css| css.matched.as_ref());
            let same = match (old, &new) {
                (None, None) => true,
                (Some(old), Some(new)) => Arc::ptr_eq(old, new),
                _ => false,
            };
            if !same {
                changes.push((id, new));
            }
        }
        self.apply_matched(changes);

        self.sheets.release_unused();
        if self.sheets.style_elements.is_empty() && self.sheets.constructed.is_empty() {
            self.wind_down_sheets();
        }
    }

    /// No sheet is left and every element has been matched against none: free what only sheets use.
    fn wind_down_sheets(&mut self) {
        self.sheets.wind_down();
        self.styles.cascaded.clear();
        for element in self.elements.values_mut() {
            element.clear_css();
        }
    }
}

/// The elements a set of marks comes to, each once. `covered` holds the elements whose whole
/// subtree is in `out`, so overlapping marks do not walk it again.
struct Expansion<'a> {
    tree: &'a RetainedTree,
    visited: FxHashSet<u64>,
    covered: FxHashSet<u64>,
    out: Vec<(u64, bool)>,
}

impl Expansion<'_> {
    fn visit(&mut self, id: u64, connected: bool) {
        let Some(element) = self.tree.elements.get(&id) else {
            return;
        };
        // An element that stopped being matchable (a text node given its string) still has to
        // drop what it matched.
        let relevant = element.is_matchable() || element.css().is_some_and(|css| css.matched.is_some());
        if relevant && self.visited.insert(id) {
            self.out.push((id, connected));
        }
    }

    fn children(&self, id: u64) -> &[u64] {
        self.tree.elements.get(&id).map_or(&[], |element| &element.children)
    }

    /// `depths` of `base`: bit 0 itself, bit 1 its children, bit 2 everything below it.
    fn add(&mut self, base: u64, depths: u8, connected: bool) {
        if depths & 1 != 0 {
            self.visit(base, connected);
        }
        if depths & 0b100 != 0 {
            if self.covered.contains(&base) {
                return;
            }
            let mut stack: Vec<u64> = self.children(base).to_vec();
            while let Some(at) = stack.pop() {
                if !self.covered.insert(at) {
                    continue;
                }
                self.visit(at, connected);
                stack.extend_from_slice(self.children(at));
            }
        } else if depths & 0b10 != 0 {
            for child in self.children(base).to_vec() {
                self.visit(child, connected);
            }
        }
    }
}
