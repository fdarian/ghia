//! DOM attributes on the native tree: what JS sets with `setAttribute`, kept so a selector
//! matcher reads them without a round trip to JS.
//!
//! The store holds exactly the DOM attributes of the element, named as the DOM names them
//! (`packages/native/js/dom/attribute-names.ts`): JS sends every prop `element.attributes` lists.
//!
//! Setting one is not a build input: it moves no revision and marks nothing dirty. The style
//! cascade that reads attributes decides what to invalidate when it exists.

use std::borrow::Cow;

use crate::custom_elements::svg_tree::is_svg_tag;
use crate::retained_tree::{RetainedElement, RetainedTree};

/// The attributes of one element. Most elements have none to three, so a list of pairs is
/// smaller and as fast as a map.
#[derive(Default)]
pub(crate) struct AttributeStore {
    pairs: Vec<(Box<str>, Box<str>)>,
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
    pub(crate) fn set(&mut self, name: &str, value: Option<String>) -> bool {
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
                    self.pairs = Vec::new();
                }
                true
            }
            (None, Some(value)) => {
                self.pairs.push((name.into(), value.into_boxed_str()));
                true
            }
            (None, None) => false,
        }
    }
}

/// The name an element of this type stores and reads an attribute under: HTML names are
/// case-insensitive and kept lower-cased, SVG names (`viewBox`) are case-sensitive.
pub(crate) fn stored_name<'a>(element_type: &str, name: &'a str) -> Cow<'a, str> {
    if is_svg_tag(element_type) || !name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Borrowed(name)
    } else {
        Cow::Owned(name.to_ascii_lowercase())
    }
}

impl RetainedElement {
    /// The attribute `name` JS stored with `set_attribute`, by the DOM's rule for the case of the
    /// name: ignored on an HTML element, kept on an SVG one.
    pub fn attribute(&self, name: &str) -> Option<Cow<'_, str>> {
        let name = stored_name(&self.element_type, name);
        self.attribute_store()?.get(&name).map(Cow::Borrowed)
    }
}

impl RetainedTree {
    /// Sets (`Some`) or removes (`None`) an attribute. The case of `name` counts on an SVG element
    /// and not on an HTML one (see `RetainedElement::attribute`). Returns whether it changed. An
    /// element that does not exist changes nothing.
    pub fn set_attribute(&mut self, id: u64, name: &str, value: Option<String>) -> bool {
        let changed = match self.elements.get_mut(&id) {
            Some(element) => element.set_attribute(name, value),
            None => false,
        };
        if changed && self.sheets.enabled {
            self.sheets_attribute_changed(id, name);
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
    fn a_custom_prop_is_not_an_attribute() {
        let mut tree = tree();
        tree.set_custom_prop(1, "id".into(), serde_json::json!("root"));
        tree.set_custom_prop(1, "tabIndex".into(), serde_json::json!(3));
        assert_eq!(tree.attribute(1, "id"), None);
        assert_eq!(tree.attribute(1, "tabindex"), None);
        assert!(tree.attribute_names(1).is_empty());
    }
}
