//! What a tag means beyond how it looks: its implicit ARIA role, whether it takes focus, and what
//! a key activates. The element's own props (`href`, `type`, `disabled`) and, for a landmark, its
//! place in the tree decide; the elements built into Ghia are not here.

use gpui::Role;
use serde_json::Value;

use crate::retained_tree::{RetainedElement, RetainedTree};

/// The role HTML gives the element's tag when no `role` prop does, as Chrome's accessibility tree
/// has it. The tag's own tree role (`generic`, or no node at all) is `None`.
///
/// - `a` is a link only with an `href`; `section` is a region only with an accessible name; `header`
///   and `footer` are the banner and the content info of the page only outside `article`, `aside`,
///   `main`, `nav` and `section`.
/// - `th` is always a column header: the `scope` attribute is not forwarded, so there is no row header.
pub(crate) fn implicit_role(tree: &RetainedTree, element: &RetainedElement) -> Option<Role> {
    Some(match element.element_type.as_str() {
        "button" => Role::Button,
        "a" if has_href(element) => Role::Link,
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => Role::Heading,
        "ul" | "ol" => Role::List,
        "li" => Role::ListItem,
        "nav" => Role::Navigation,
        "main" => Role::Main,
        "header" if !in_sectioning_content(tree, element) => Role::Banner,
        "footer" if !in_sectioning_content(tree, element) => Role::ContentInfo,
        "aside" => Role::Complementary,
        "article" => Role::Article,
        "section" if crate::accessibility::named_by_aria(element.custom_props()) => Role::Region,
        "hr" => Role::Splitter,
        "blockquote" => Role::Blockquote,
        "dialog" => Role::Dialog,
        "p" => Role::Paragraph,
        "figure" => Role::Figure,
        "table" => Role::Table,
        "thead" | "tbody" | "tfoot" => Role::RowGroup,
        "tr" => Role::Row,
        "td" => Role::Cell,
        "th" => Role::ColumnHeader,
        "dl" => Role::DescriptionList,
        "dt" => Role::Term,
        "dd" => Role::Definition,
        _ => return None,
    })
}

/// The `aria-level` a heading tag has without one.
pub(crate) fn heading_level(element_type: &str) -> Option<usize> {
    match element_type {
        "h1" => Some(1),
        "h2" => Some(2),
        "h3" => Some(3),
        "h4" => Some(4),
        "h5" => Some(5),
        "h6" => Some(6),
        _ => None,
    }
}

fn has_href(element: &RetainedElement) -> bool {
    element.custom_props().get("href").is_some_and(Value::is_string)
}

fn in_sectioning_content(tree: &RetainedTree, element: &RetainedElement) -> bool {
    std::iter::successors(element.parent, |id| tree.elements.get(id).and_then(|element| element.parent))
        .filter_map(|id| tree.elements.get(&id))
        .any(|ancestor| matches!(ancestor.element_type.as_str(), "article" | "aside" | "main" | "nav" | "section"))
}

/// Whether the tag is focusable and a tab stop without a `tabIndex`: an enabled `button` and an
/// `a` with an `href`. A `tabIndex` still sets the order, or takes the element out of it with `-1`.
/// A disabled `button` is never focusable, whatever its `tabIndex`.
pub(crate) fn is_focusable_by_default(element: &RetainedElement) -> bool {
    match element.element_type.as_str() {
        "button" => !element.is_disabled(),
        "a" => has_href(element),
        _ => false,
    }
}

/// The keys that click a focused element.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ActivationKeys {
    pub enter: bool,
    pub space: bool,
}

/// What a key activates on the element: a `button` takes Enter on key down and Space on key up, an
/// `a` with an `href` takes Enter. A disabled button takes none.
pub(crate) fn activation_keys(element: &RetainedElement) -> Option<ActivationKeys> {
    match element.element_type.as_str() {
        "button" if !element.is_disabled() => Some(ActivationKeys { enter: true, space: true }),
        "a" if has_href(element) => Some(ActivationKeys { enter: true, space: false }),
        _ => None,
    }
}

/// Whether an assistive technology can press the element without a listener on it.
pub(crate) fn is_activatable(element: &RetainedElement) -> bool {
    element.element_type == "button" || (element.element_type == "a" && has_href(element))
}

/// What a `button` does when clicked inside a `form`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ButtonType {
    Submit,
    Reset,
    Button,
}

/// The `type` of a `button`: a missing or unknown value is `submit`.
pub(crate) fn button_type(element: &RetainedElement) -> ButtonType {
    match element.custom_props().get("type").and_then(Value::as_str) {
        Some("button") => ButtonType::Button,
        Some("reset") => ButtonType::Reset,
        _ => ButtonType::Submit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(batch: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        crate::batch::test_json::apply(&mut tree, batch).unwrap();
        tree
    }

    fn role(tree: &RetainedTree, id: u64) -> Option<Role> {
        implicit_role(tree, &tree.elements[&id])
    }

    #[test]
    fn a_link_needs_an_href_and_a_section_needs_a_name() {
        let tree = tree(
            r#"[["createElement",1,"div"],["setRoot",1],
                ["createElement",2,"a"],["appendChild",1,2],
                ["createElement",3,"a"],["appendChild",1,3],["setCustomProp",3,"href",""],
                ["createElement",4,"section"],["appendChild",1,4],
                ["createElement",5,"section"],["appendChild",1,5],["setCustomProp",5,"aria-label","Notes"]]"#,
        );
        assert_eq!(role(&tree, 2), None);
        assert_eq!(role(&tree, 3), Some(Role::Link));
        assert_eq!(role(&tree, 4), None);
        assert_eq!(role(&tree, 5), Some(Role::Region));
    }

    #[test]
    fn a_header_is_the_banner_only_outside_sectioning_content() {
        let tree = tree(
            r#"[["createElement",1,"div"],["setRoot",1],
                ["createElement",2,"header"],["appendChild",1,2],
                ["createElement",3,"article"],["appendChild",1,3],
                ["createElement",4,"div"],["appendChild",3,4],
                ["createElement",5,"footer"],["appendChild",4,5]]"#,
        );
        assert_eq!(role(&tree, 2), Some(Role::Banner));
        assert_eq!(role(&tree, 5), None);
    }

    #[test]
    fn a_button_and_a_link_take_keys_and_a_disabled_button_does_not() {
        let tree = tree(
            r#"[["createElement",1,"div"],["setRoot",1],
                ["createElement",2,"button"],["appendChild",1,2],
                ["createElement",3,"button"],["appendChild",1,3],["setCustomProp",3,"disabled",true],
                ["createElement",4,"a"],["appendChild",1,4],["setCustomProp",4,"href","/x"],
                ["createElement",5,"a"],["appendChild",1,5]]"#,
        );
        let keys = |id: u64| activation_keys(&tree.elements[&id]);
        assert_eq!(keys(2), Some(ActivationKeys { enter: true, space: true }));
        assert_eq!(keys(3), None);
        assert_eq!(keys(4), Some(ActivationKeys { enter: true, space: false }));
        assert_eq!(keys(5), None);
        assert!(tree.elements[&2].needs_focus() && tree.elements[&4].needs_focus());
        assert!(!tree.elements[&3].needs_focus() && !tree.elements[&5].needs_focus());
    }
}
