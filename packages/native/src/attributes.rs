//! DOM attributes on the native tree: what JS sets with `setAttribute`, kept so a selector
//! matcher reads them without a round trip to JS.
//!
//! The store holds exactly the DOM attributes of the element, named as the DOM names them
//! (`packages/native/js/dom/attribute-names.ts`): JS sends every prop `element.attributes` lists.
//!
//! Setting one is not a build input: it moves no revision and marks nothing dirty. The style
//! cascade that reads attributes decides what to invalidate when it exists.

use std::borrow::Cow;
use std::sync::Arc;

use rustc_hash::FxHashSet;
use smallvec::SmallVec;

use crate::retained_tree::{RetainedElement, RetainedTree};

/// Names are pruned once the table has grown to this many, and again each time it doubles.
const PRUNE_FROM: usize = 64;

/// The attribute names the elements of a tree hold. An element stores a pointer to the name, not
/// a copy, so `class` on five thousand elements is one allocation.
pub(crate) struct AttributeNames {
    names: FxHashSet<Arc<str>>,
    prune_at: usize,
}

impl Default for AttributeNames {
    fn default() -> Self {
        AttributeNames { names: FxHashSet::default(), prune_at: PRUNE_FROM }
    }
}

impl AttributeNames {
    fn intern(&mut self, name: &str) -> Arc<str> {
        if let Some(name) = self.names.get(name) {
            return name.clone();
        }
        if self.names.len() >= self.prune_at {
            // An app that makes up names would otherwise keep every one it ever used.
            self.names.retain(|name| Arc::strong_count(name) > 1);
            self.prune_at = (self.names.len() * 2).max(PRUNE_FROM);
        }
        let name: Arc<str> = name.into();
        self.names.insert(name.clone());
        name
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.names.len()
    }
}

/// The attributes of one element. Most elements have none to three, so a list of pairs is
/// smaller and as fast as a map, and two of them sit inline.
#[derive(Default)]
pub(crate) struct AttributeStore {
    pairs: SmallVec<[(Arc<str>, Box<str>); 2]>,
}

impl AttributeStore {
    pub(crate) fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(stored, _)| &**stored == name)
            .map(|(_, value)| &**value)
    }

    pub(crate) fn names(&self) -> impl Iterator<Item = &str> {
        self.pairs.iter().map(|(name, _)| &**name)
    }

    /// Whether the store changed.
    pub(crate) fn set(&mut self, names: &mut AttributeNames, name: &str, value: Option<String>) -> bool {
        let position = self
            .pairs
            .iter()
            .position(|(stored, _)| &**stored == name);
        match (position, value) {
            (Some(position), Some(value)) => {
                if *self.pairs[position].1 == *value {
                    return false;
                }
                self.pairs[position].1 = value.into_boxed_str();
                true
            }
            (Some(position), None) => {
                self.pairs.remove(position);
                if self.pairs.is_empty() {
                    self.pairs = SmallVec::new();
                }
                true
            }
            (None, Some(value)) => {
                self.pairs.push((names.intern(name), value.into_boxed_str()));
                true
            }
            (None, None) => false,
        }
    }
}

/// The name an element of this type stores and reads an attribute under: HTML names are
/// case-insensitive and kept lower-cased, SVG names (`viewBox`) are case-sensitive.
pub(crate) fn stored_name(is_svg: bool, name: &str) -> Cow<'_, str> {
    if is_svg || !name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Borrowed(name)
    } else {
        Cow::Owned(name.to_ascii_lowercase())
    }
}

impl RetainedElement {
    /// The attribute `name` JS stored with `set_attribute`, by the DOM's rule for the case of the
    /// name: ignored on an HTML element, kept on an SVG one.
    pub fn attribute(&self, name: &str) -> Option<Cow<'_, str>> {
        let name = stored_name(self.is_svg(), name);
        self.attribute_store()?.get(&name).map(Cow::Borrowed)
    }
}

impl RetainedTree {
    /// Sets (`Some`) or removes (`None`) an attribute. The case of `name` counts on an SVG element
    /// and not on an HTML one (see `RetainedElement::attribute`). Returns whether it changed. An
    /// element that does not exist changes nothing.
    pub fn set_attribute(&mut self, id: u64, name: &str, value: Option<String>) -> bool {
        let names_noted = self.sheets.enabled && (name.eq_ignore_ascii_case("class") || name.eq_ignore_ascii_case("id"));
        if names_noted {
            self.sheets_attribute_changing(id, name);
        }
        let changed = match self.elements.get_mut(&id) {
            Some(element) => element.set_attribute(&mut self.attribute_names, name, value),
            None => false,
        };
        if self.sheets.enabled {
            if changed {
                self.sheets_attribute_changed(id, name);
            } else if names_noted {
                self.sheets_attribute_kept(id, name);
            }
        }
        changed
    }

    /// The attribute `name` of the element: what `set_attribute` stored.
    pub fn attribute(&self, id: u64, name: &str) -> Option<Cow<'_, str>> {
        self.elements.get(&id)?.attribute(name)
    }

    /// The names the element has an attribute under.
    pub fn attribute_names(&self, id: u64) -> Vec<String> {
        self.elements
            .get(&id)
            .and_then(RetainedElement::attribute_store)
            .map(|store| store.names().map(str::to_owned).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".into());
        tree
    }

    #[test]
    fn set_reads_back_and_reports_change() {
        let mut tree = tree();
        assert!(tree.set_attribute(1, "class", Some("a b".into())));
        assert_eq!(tree.attribute(1, "class").as_deref(), Some("a b"));
        assert!(!tree.set_attribute(1, "class", Some("a b".into())));
        assert!(tree.set_attribute(1, "class", Some("c".into())));
        assert_eq!(tree.attribute(1, "class").as_deref(), Some("c"));
    }

    #[test]
    fn names_are_ascii_lower_cased() {
        let mut tree = tree();
        assert!(tree.set_attribute(1, "Data-X", Some("1".into())));
        assert_eq!(tree.attribute(1, "data-x").as_deref(), Some("1"));
        assert_eq!(tree.attribute(1, "DATA-X").as_deref(), Some("1"));
        assert_eq!(tree.attribute_names(1), ["data-x"]);
        assert!(!tree.set_attribute(1, "DATA-x", Some("1".into())));
    }

    #[test]
    fn an_empty_value_is_present_and_none_removes() {
        let mut tree = tree();
        assert!(tree.set_attribute(1, "hidden", Some(String::new())));
        assert_eq!(tree.attribute(1, "hidden").as_deref(), Some(""));
        assert!(tree.set_attribute(1, "hidden", None));
        assert_eq!(tree.attribute(1, "hidden"), None);
        assert!(!tree.set_attribute(1, "hidden", None));
        assert!(tree.attribute_names(1).is_empty());
    }

    #[test]
    fn the_store_is_released_when_the_last_attribute_goes_and_on_destroy() {
        let mut tree = tree();
        tree.set_attribute(1, "a", Some("1".into()));
        tree.set_attribute(1, "b", Some("2".into()));
        tree.set_attribute(1, "a", None);
        assert_eq!(tree.attribute(1, "b").as_deref(), Some("2"));
        tree.set_attribute(1, "b", None);
        assert!(tree.elements[&1].attribute_store().is_none());

        tree.set_attribute(1, "a", Some("1".into()));
        tree.destroy_element(1);
        assert_eq!(tree.attribute(1, "a"), None);
        assert!(!tree.set_attribute(1, "a", Some("1".into())));
        tree.create_element(1, "div".into());
        assert_eq!(tree.attribute(1, "a"), None, "a recycled id starts empty");
    }

    #[test]
    fn setting_an_attribute_marks_nothing() {
        let mut tree = tree();
        let revision = tree.elements[&1].subtree_revision;
        let search = tree.elements[&1].search_revision;
        tree.take_dirty();
        tree.set_attribute(1, "class", Some("a".into()));
        tree.set_attribute(1, "class", None);
        assert_eq!(tree.elements[&1].subtree_revision, revision);
        assert_eq!(tree.elements[&1].search_revision, search);
        assert_eq!(tree.take_dirty(), crate::retained_tree::Dirty::Clean);
    }

    #[test]
    fn an_html_element_ignores_the_case_of_a_name() {
        let mut tree = tree();
        assert!(tree.set_attribute(1, "tabIndex", Some("3".into())));
        assert_eq!(tree.attribute(1, "tabindex").as_deref(), Some("3"));
        assert_eq!(tree.attribute(1, "TABINDEX").as_deref(), Some("3"));
        assert_eq!(tree.attribute_names(1), ["tabindex"]);
        assert!(!tree.set_attribute(1, "tabindex", Some("3".into())));
        assert!(tree.set_attribute(1, "TabIndex", None));
        assert!(tree.attribute_names(1).is_empty());
    }

    #[test]
    fn an_svg_element_keeps_the_case_of_a_name() {
        let mut tree = RetainedTree::new();
        for (id, tag) in [(1, "svg"), (2, "path"), (3, "text")] {
            tree.create_element(id, tag.into());
            assert!(tree.set_attribute(id, "viewBox", Some("0 0 1 1".into())));
            assert_eq!(tree.attribute(id, "viewBox").as_deref(), Some("0 0 1 1"), "{tag}");
            assert_eq!(tree.attribute(id, "viewbox"), None, "{tag}");
            assert_eq!(tree.attribute_names(id), ["viewBox"], "{tag}");
        }
    }

    #[test]
    fn elements_share_the_allocation_of_a_name_and_a_name_nobody_holds_is_pruned() {
        let mut tree = tree();
        for id in 2..6 {
            tree.create_element(id, "div".into());
            tree.set_attribute(id, "class", Some("a".into()));
        }
        assert_eq!(tree.attribute_names.len(), 1);
        let first = tree.elements[&2].attribute_store().unwrap().pairs[0].0.clone();
        let last = tree.elements[&5].attribute_store().unwrap().pairs[0].0.clone();
        assert!(Arc::ptr_eq(&first, &last));

        for index in 0..PRUNE_FROM * 3 {
            tree.set_attribute(1, &format!("data-{index}"), Some("1".into()));
            tree.set_attribute(1, &format!("data-{index}"), None);
        }
        assert!(tree.attribute_names.len() <= PRUNE_FROM + 1, "{}", tree.attribute_names.len());
        assert_eq!(tree.attribute(2, "class").as_deref(), Some("a"));
    }

    #[test]
    fn more_attributes_than_sit_inline_read_back() {
        let mut tree = tree();
        for index in 0..5 {
            tree.set_attribute(1, &format!("data-{index}"), Some(index.to_string()));
        }
        assert_eq!(tree.attribute_names(1).len(), 5);
        assert_eq!(tree.attribute(1, "data-4").as_deref(), Some("4"));
        tree.set_attribute(1, "data-0", None);
        assert_eq!(tree.attribute(1, "data-0"), None);
        assert_eq!(tree.attribute(1, "data-4").as_deref(), Some("4"));
    }

    #[test]
    fn a_custom_prop_is_not_an_attribute() {
        let mut tree = tree();
        tree.set_custom_prop(1, "id".into(), serde_json::json!("root"));
        tree.set_custom_prop(1, "tabIndex".into(), serde_json::json!(3));
        assert_eq!(tree.attribute(1, "id"), None);
        assert_eq!(tree.attribute(1, "tabindex"), None);
        assert!(tree.attribute_names(1).is_empty());
    }
}
