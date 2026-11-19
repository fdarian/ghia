//! `contenteditable`: which elements are editable and which are editing hosts.
//!
//! The attribute reaches native as a prop. React writes `contentEditable` (a boolean or text), Solid and
//! `setAttribute` write `contenteditable` (text); `js/editing/host.ts` keeps the same rule for the DOM
//! members. An element's own value is editable (`true`, an empty text, `"true"`, `"plaintext-only"`),
//! not (`false`, `"false"`) or none (any other text, no prop), and an element with none takes its
//! parent's.

use serde_json::Value;

use crate::retained_tree::{RetainedElement, RetainedTree};

/// Whether a prop write can change what is editable.
pub(crate) fn is_prop(key: &str) -> bool {
    key == "contentEditable" || key == "contenteditable"
}

/// What the element's own `contenteditable` says: `Some(true)` is editable, `Some(false)` is not, `None` inherits.
pub(crate) fn own_value(element: &RetainedElement) -> Option<bool> {
    let props = element.custom_props();
    match props.get("contentEditable").or_else(|| props.get("contenteditable"))? {
        Value::Bool(value) => Some(*value),
        Value::String(text) if text.is_empty() || text.eq_ignore_ascii_case("true") || text.eq_ignore_ascii_case("plaintext-only") => Some(true),
        Value::String(text) if text.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// Whether the element is editable: its own value, else the nearest ancestor's.
pub(crate) fn is_editable(tree: &RetainedTree, id: u64) -> bool {
    std::iter::successors(Some(id), |id| tree.elements.get(id).and_then(|element| element.parent))
        .filter_map(|id| tree.elements.get(&id))
        .find_map(own_value)
        .unwrap_or(false)
}

/// Whether the element is an editing host: its own value makes it editable and its parent is not
/// editable. It is the only element of its editable subtree that takes focus.
pub(crate) fn is_editing_host(tree: &RetainedTree, id: u64) -> bool {
    let Some(element) = tree.elements.get(&id) else {
        return false;
    };
    own_value(element) == Some(true) && !element.parent.is_some_and(|parent| is_editable(tree, parent))
}
