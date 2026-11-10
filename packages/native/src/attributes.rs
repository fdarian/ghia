//! DOM attributes on the native tree: what JS sets with `setAttribute`, kept so a selector
//! matcher reads them without a round trip to JS.
//!
//! Setting one is not a build input: it moves no revision and marks nothing dirty. The style
//! cascade that reads attributes decides what to invalidate when it exists.

use std::borrow::Cow;

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
            .find(|(stored, _)| stored.eq_ignore_ascii_case(name))
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
            .position(|(stored, _)| stored.eq_ignore_ascii_case(name));
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
                self.pairs.push((
                    name.to_ascii_lowercase().into_boxed_str(),
                    value.into_boxed_str(),
                ));
                true
            }
            (None, None) => false,
        }
    }
}

/// The text of a custom prop read as an attribute: `id`, `role` and `aria-*` arrive as props,
/// not through `setAttribute`.
fn attribute_text(value: &serde_json::Value) -> Option<Cow<'_, str>> {
    match value {
        serde_json::Value::String(text) => Some(Cow::Borrowed(text)),
        serde_json::Value::Number(number) => Some(Cow::Owned(number.to_string())),
        serde_json::Value::Bool(true) => Some(Cow::Borrowed("")),
        serde_json::Value::Bool(false) | serde_json::Value::Null => None,
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => None,
    }
}

impl RetainedElement {
    /// The attribute `name`: what `set_attribute` stored, else the custom prop of the same name
    /// read as DOM would print it.
    pub fn attribute(&self, name: &str) -> Option<Cow<'_, str>> {
        if let Some(value) = self.attribute_store().and_then(|store| store.get(name)) {
            return Some(Cow::Borrowed(value));
        }
        attribute_text(self.custom_props().get(name)?)
    }
}

impl RetainedTree {
    /// Sets (`Some`) or removes (`None`) an attribute; `name` is lower-cased. Returns whether
    /// it changed. An element that does not exist changes nothing.
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

    /// The attribute `name` of the element: what `set_attribute` stored, else the custom prop
    /// of the same name read as DOM would print it.
    pub fn attribute(&self, id: u64, name: &str) -> Option<Cow<'_, str>> {
        self.elements.get(&id)?.attribute(name)
    }

    /// The names the element has an attribute under: the stored ones, then the custom props
    /// that read as an attribute and are not stored.
    pub fn attribute_names(&self, id: u64) -> Vec<String> {
        let Some(element) = self.elements.get(&id) else {
            return Vec::new();
        };
        let mut names: Vec<String> = element
            .attribute_store()
            .map(|store| store.names().map(str::to_owned).collect())
            .unwrap_or_default();
        for (name, value) in element.custom_props() {
            if attribute_text(value).is_some() && !names.iter().any(|stored| stored == name) {
                names.push(name.clone());
            }
        }
        names
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
    fn custom_props_answer_where_the_store_has_nothing() {
        let mut tree = tree();
        tree.set_custom_prop(1, "id".into(), serde_json::json!("root"));
        tree.set_custom_prop(1, "tabindex".into(), serde_json::json!(3));
        tree.set_custom_prop(1, "aria-hidden".into(), serde_json::json!(true));
        tree.set_custom_prop(1, "aria-busy".into(), serde_json::json!(false));
        tree.set_custom_prop(1, "data-obj".into(), serde_json::json!({ "a": 1 }));
        assert_eq!(tree.attribute(1, "id").as_deref(), Some("root"));
        assert_eq!(tree.attribute(1, "tabindex").as_deref(), Some("3"));
        assert_eq!(tree.attribute(1, "aria-hidden").as_deref(), Some(""));
        assert_eq!(tree.attribute(1, "aria-busy"), None);
        assert_eq!(tree.attribute(1, "data-obj"), None);

        let mut names = tree.attribute_names(1);
        names.sort();
        assert_eq!(names, ["aria-hidden", "id", "tabindex"]);

        tree.set_attribute(1, "id", Some("stored".into()));
        assert_eq!(
            tree.attribute(1, "id").as_deref(),
            Some("stored"),
            "the store wins over the prop"
        );
        assert_eq!(tree.attribute_names(1).iter().filter(|name| *name == "id").count(), 1);
    }
}
