//! The retained tree's side of stylesheets: hooks that note what a mutation can change for the
//! selectors, and the flush that matches again and restyles.
//!
//! A hook only collects marks (an element, whether its subtree and following siblings are
//! included). `flush_styles` runs once at the end of a batch: it reloads the sheets when their
//! sources changed, expands the marks, matches each marked element and hands the ones whose
//! matched rules changed to `RetainedTree::apply_matched`, which restyles them as `set_style` does.

use std::borrow::Cow;
use std::sync::Arc;

use rustc_hash::FxHashSet;

use crate::retained_tree::RetainedTree;

use super::atoms::{Atom, Atoms};
use super::cascade::MatchedRules;
use super::document::Mark;
use super::selector::Specificity;
use super::view::TreeView;

fn lowercase(name: &str) -> Cow<'_, str> {
    if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(name.to_ascii_lowercase())
    } else {
        Cow::Borrowed(name)
    }
}

fn class_atoms(atoms: &mut Atoms, value: Option<Cow<'_, str>>) -> Vec<Atom> {
    value
        .map(|value| value.split_ascii_whitespace().map(|class| atoms.intern(class)).collect())
        .unwrap_or_default()
}

fn id_atom(atoms: &mut Atoms, value: Option<Cow<'_, str>>) -> Option<Atom> {
    value.filter(|value| !value.is_empty()).map(|value| atoms.intern(&value))
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

    // Hooks. Each runs only while `sheets.enabled`, except the one for a created element.

    pub(crate) fn sheets_created(&mut self, id: u64, is_style: bool) {
        if is_style {
            self.enable_sheets();
            self.sheets.style_elements.insert(id);
            self.sheets.sources_dirty = true;
        }
        if self.sheets.atoms_fresh {
            self.init_css(id);
        }
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
        if self.sheets.atoms_fresh && self.sheets.index.features.siblings {
            let next = self.elements.get(&parent_id).and_then(|parent| {
                let position = parent.children.iter().position(|sibling| *sibling == child)?;
                parent.children.get(position + 1).copied()
            });
            if let Some(next) = next {
                self.sheets.mark(next, true, true);
            }
        }
    }

    /// After `child` was put where it is, or taken out of the document.
    pub(crate) fn sheets_linked(&mut self, child: u64) {
        let parent = self.elements.get(&child).and_then(|element| element.parent);
        if parent.is_some_and(|parent| self.sheets.style_elements.contains(&parent)) || self.contains_style_element(child) {
            self.sheets.sources_dirty = true;
        }
        if self.sheets.atoms_fresh {
            let siblings = self.sheets.index.features.siblings;
            self.sheets.mark(child, true, siblings);
        }
    }

    pub(crate) fn sheets_text_changed(&mut self, id: u64) {
        let parent = self.elements.get(&id).and_then(|element| element.parent);
        if parent.is_some_and(|parent| self.sheets.style_elements.contains(&parent)) {
            self.sheets.sources_dirty = true;
        }
        if self.sheets.atoms_fresh {
            self.sheets.mark(id, false, false);
        }
    }

    pub(crate) fn sheets_root_changed(&mut self) {
        self.sheets.sources_dirty = true;
        self.sheets.mark_all = true;
    }

    pub(crate) fn sheets_attribute_changed(&mut self, id: u64, name: &str) {
        if !self.sheets.atoms_fresh {
            return;
        }
        let name = lowercase(name);
        if *name == *"class" {
            self.refresh_class_atoms(id);
        } else if *name == *"id" {
            self.refresh_id_atom(id);
        }
        if self.sheets.reads_attribute(&name) {
            let siblings = self.sheets.index.features.siblings;
            self.sheets.mark(id, true, siblings);
        }
    }

    /// The own style of an element changed: only a `[style]` selector can tell.
    pub(crate) fn sheets_style_changed(&mut self, id: u64) {
        if self.sheets.atoms_fresh && self.sheets.reads_style() {
            let siblings = self.sheets.index.features.siblings;
            self.sheets.mark(id, true, siblings);
        }
    }

    fn contains_style_element(&self, ancestor: u64) -> bool {
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

    fn init_css(&mut self, id: u64) {
        let atoms = &mut self.sheets.atoms;
        let Some(element) = self.elements.get_mut(&id) else {
            return;
        };
        let tag = atoms.intern(&element.element_type.to_ascii_lowercase());
        let element_id = id_atom(atoms, element.attribute("id"));
        let classes = class_atoms(atoms, element.attribute("class"));
        let css = element.css_mut();
        css.tag = Some(tag);
        css.id = element_id;
        css.classes = classes;
    }

    fn refresh_class_atoms(&mut self, id: u64) {
        let atoms = &mut self.sheets.atoms;
        let Some(element) = self.elements.get_mut(&id) else {
            return;
        };
        let classes = class_atoms(atoms, element.attribute("class"));
        element.css_mut().classes = classes;
    }

    fn refresh_id_atom(&mut self, id: u64) {
        let atoms = &mut self.sheets.atoms;
        let Some(element) = self.elements.get_mut(&id) else {
            return;
        };
        let element_id = id_atom(atoms, element.attribute("id"));
        element.css_mut().id = element_id;
    }

    /// An element's `id` arrives as a prop, not through `setAttribute`, and so do `role` and
    /// `aria-*`: they read as attributes of the same name.
    pub(crate) fn sheets_prop_changed(&mut self, id: u64, key: &str) {
        if !self.sheets.atoms_fresh {
            return;
        }
        if key == "id" {
            self.refresh_id_atom(id);
        }
        if self.sheets.reads_attribute(key) {
            let siblings = self.sheets.index.features.siblings;
            self.sheets.mark(id, true, siblings);
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

    /// Positions of `id` and its ancestors among their siblings, from the top: tree order.
    fn tree_path(&self, id: u64) -> Vec<usize> {
        let mut path = Vec::new();
        let mut at = id;
        while let Some(parent) = self.elements.get(&at).and_then(|element| element.parent) {
            let position = self.elements.get(&parent).and_then(|parent| parent.children.iter().position(|child| *child == at));
            path.push(position.expect("an element is among its parent's children"));
            at = parent;
        }
        path.reverse();
        path
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
        let mut connected: Vec<u64> =
            self.sheets.style_elements.iter().copied().filter(|id| self.is_connected(*id)).collect();
        if connected.len() > 1 {
            connected.sort_by_cached_key(|id| self.tree_path(*id));
        }
        let texts = self.sheets.texts_with(connected.iter().map(|id| self.text_content(*id)).collect());
        if texts == self.sheets.loaded {
            return;
        }
        self.sheets.load(texts);
        self.styles.cascaded.clear();
        self.sheets.mark_all = true;
    }

    fn init_all_css(&mut self) {
        let atoms = &mut self.sheets.atoms;
        for element in self.elements.values_mut() {
            let tag = atoms.intern(&element.element_type.to_ascii_lowercase());
            let element_id = id_atom(atoms, element.attribute("id"));
            let classes = class_atoms(atoms, element.attribute("class"));
            let css = element.css_mut();
            css.tag = Some(tag);
            css.id = element_id;
            css.classes = classes;
        }
    }

    /// The elements to match again, each with whether it is in the document, once.
    fn restyle_set(&self, marks: &[(u64, Mark)], all: bool) -> Vec<(u64, bool)> {
        let mut out: Vec<(u64, bool)> = Vec::new();
        if all {
            let mut seen: FxHashSet<u64> = FxHashSet::default();
            for id in self.document_order(None) {
                seen.insert(id);
                out.push((id, true));
            }
            out.extend(self.elements.keys().filter(|id| !seen.contains(id)).map(|id| (*id, false)));
            return out;
        }
        let mut visited: FxHashSet<u64> = FxHashSet::default();
        let mut covered: FxHashSet<u64> = FxHashSet::default();
        let mut expand = |id: u64, subtree: bool, connected: bool, out: &mut Vec<(u64, bool)>| {
            if !subtree {
                if visited.insert(id) {
                    out.push((id, connected));
                }
                return;
            }
            if covered.contains(&id) {
                return;
            }
            let mut stack = vec![id];
            while let Some(at) = stack.pop() {
                if !covered.insert(at) {
                    continue;
                }
                if visited.insert(at) {
                    out.push((at, connected));
                }
                if let Some(element) = self.elements.get(&at) {
                    stack.extend(element.children.iter().copied());
                }
            }
        };
        for (id, mark) in marks {
            let Some(element) = self.elements.get(id) else {
                continue;
            };
            let connected = self.is_connected(*id);
            expand(*id, mark.subtree, connected, &mut out);
            if !mark.following {
                continue;
            }
            let Some(parent) = element.parent.and_then(|parent| self.elements.get(&parent)) else {
                continue;
            };
            let Some(position) = parent.children.iter().position(|child| child == id) else {
                continue;
            };
            for sibling in &parent.children[position + 1..] {
                expand(*sibling, true, connected, &mut out);
            }
        }
        out
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
        for (id, connected) in restyle {
            crate::perf_counters::element_rematched();
            let Some(element) = self.elements.get(&id) else {
                continue;
            };
            let css = element.css();
            let matched = if connected && element.is_matchable() {
                let css = css.expect("atoms are current while sheets match");
                self.sheets.index.matching(&TreeView::new(self, id), css.id, &css.classes)
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

        if self.sheets.reads_style() {
            self.sheets.release_unused();
        }
        if self.sheets.style_elements.is_empty() && self.sheets.constructed.is_empty() {
            self.wind_down_sheets();
        }
    }

    /// No sheet is left and every element has been matched against none: free what only sheets use.
    fn wind_down_sheets(&mut self) {
        self.sheets.enabled = false;
        self.sheets.atoms_fresh = false;
        self.sheets.loaded.clear();
        self.sheets.index = Default::default();
        self.sheets.interner = Default::default();
        self.styles.cascaded.clear();
        for element in self.elements.values_mut() {
            element.clear_css();
        }
    }
}
