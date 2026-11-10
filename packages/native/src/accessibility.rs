//! GPUI accessibility props from React custom_props.
//!
//! A node reaches AccessKit only with both an `.id(...)` and a `.role(...)`.
//! GPUIX already sets the id. This module sets the role and ARIA fields.
//! Prop names match React DOM: `aria-label`, not `ariaLabel`, and the DOM `id`
//! is the node's author id.

mod aria;
pub(crate) mod label;
pub(crate) mod links;
pub(crate) mod relations;
pub(crate) mod skipped;

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{AccessibleAction, Role};

use crate::events::synthetic_click::click_payload;

/// Apply `role`, `id` and `aria-*` from React, plus a default role when the
/// app did not set one. `none` / `presentation` produce no node.
///
/// `host_id` is the element's renderer id, which finds the `<label>`s that
/// name it.
pub(crate) fn apply_accessibility<E>(
    el: E,
    host_id: u64,
    props: &HashMap<String, serde_json::Value>,
    default_role: Option<Role>,
) -> E
where
    E: StatefulInteractiveElement,
{
    apply(el, host_id, props, default_role, false)
}

/// [`apply_accessibility`] for an element that holds the nodes of content it skips
/// (`skipped`): it gets a node even with no role, so they have one to hang off.
pub(crate) fn apply_hosting<E>(
    el: E,
    host_id: u64,
    props: &HashMap<String, serde_json::Value>,
    default_role: Option<Role>,
) -> E
where
    E: StatefulInteractiveElement,
{
    apply(el, host_id, props, default_role, true)
}

fn resolve_role(props: &HashMap<String, serde_json::Value>, default_role: Option<Role>) -> Option<Role> {
    let explicit = props.get("role").and_then(|value| value.as_str());
    if matches!(explicit, Some("none" | "presentation")) {
        return None;
    }
    explicit
        .and_then(role_from_aria)
        .or(default_role)
        .filter(|role| *role != Role::GenericContainer)
}

/// Whether the author named the element with `aria-label` or `aria-labelledby`.
fn named_by_aria(props: &HashMap<String, serde_json::Value>) -> bool {
    props.contains_key("aria-label")
        || aria::relations(props)
            .iter()
            .any(|(relation, _)| *relation == gpui::A11yRelation::LabelledBy)
}

fn apply<E>(
    mut el: E,
    host_id: u64,
    props: &HashMap<String, serde_json::Value>,
    default_role: Option<Role>,
    hosts: bool,
) -> E
where
    E: StatefulInteractiveElement,
{
    let aria = aria::has_node_props(props).then(|| aria::AriaNode::parse(props));
    let hidden = aria.as_ref().is_some_and(aria::AriaNode::hidden);

    let role = resolve_role(props, default_role);
    let links = links::current();
    let referenced_text = links.referenced_text(host_id);
    // `aria-hidden` removes the whole subtree, and only a node can carry that.
    // An element an `aria-*` reference names needs a node to be the target.
    let fallback_role = (hidden || hosts || referenced_text.is_some()).then_some(Role::Group);
    let named_by_content = role.is_none() && fallback_role.is_some();
    let Some(role) = role.or(fallback_role) else {
        return el;
    };
    let role = if role == Role::TextInput && aria::is_true_prop(props, "aria-multiline") {
        Role::MultilineTextInput
    } else {
        role
    };
    el = el.role(role);

    if let Some(text) = referenced_text.filter(|text| named_by_content && !text.is_empty()) {
        el = el.aria_label(text.to_string());
    }
    let author_id = aria::string_prop(props, "id")
        .or_else(|| links.label_author_id(host_id).map(str::to_string));
    if let Some(author_id) = author_id {
        el = el.accessibility_id(author_id);
    }
    if let Some(aria) = aria {
        el = el.a11y_node(move |node| aria.write(node));
    }

    let mut relations = aria::relations(props);
    // A DOM `aria-label` or `aria-labelledby` outranks a `<label>`.
    if let Some(labels) = links.labels_of(host_id).filter(|_| !named_by_aria(props)) {
        let labels = labels
            .iter()
            .cloned()
            .map(gpui::SharedString::from)
            .collect();
        relations.push((gpui::A11yRelation::LabelledBy, labels));
    }
    for (relation, ids) in relations {
        el = el.a11y_relation(relation, ids);
    }
    el
}

/// The role an element has when its props give none.
pub(crate) fn default_role(element: &crate::retained_tree::RetainedElement) -> Option<Role> {
    match element.element_type.as_str() {
        "form" => Some(Role::Form),
        "label" => Some(Role::Label),
        "img" => Some(Role::Image),
        "input" | "textarea" => {
            let input_type = element
                .custom_props()
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            Some(crate::custom_elements::input::default_role(
                crate::custom_elements::input_rules::InputType::parse(input_type),
                element.element_type == "textarea",
            ))
        }
        _ => None,
    }
}

/// Whether `element` carries the text of its paragraph: a host container that is not a string child.
pub(crate) fn carries_text(element: &crate::retained_tree::RetainedElement) -> bool {
    crate::text::inline::is_host_container(element) && element.element_type != crate::text::inline::TEXT_NODE
}

/// What a host container reads out when its content is one paragraph: that paragraph's text.
pub(crate) fn read_text(
    element: &crate::retained_tree::RetainedElement,
    planned: Option<&crate::text::plan_cache::Planned>,
) -> Option<String> {
    if !carries_text(element) {
        return None;
    }
    planned?.accessible_text.clone()
}

/// [`read_text`] for an element nobody planned: one below a skipped subtree, or one a reference names.
pub(crate) fn read_text_unplanned(
    tree: &crate::retained_tree::RetainedTree,
    element: &crate::retained_tree::RetainedElement,
) -> Option<String> {
    if !carries_text(element) || element.children.is_empty() {
        return None;
    }
    let plan = crate::text::inline::plan_children_at(tree, element);
    crate::text::inline::sole_paragraph_text(plan.iter().map(|(child, _)| child))
}

/// The role of `element` when its props give none: its type's, or `Label` when it reads out text.
/// An element an `aria-*` reference names has none from its text: it is a `Group` named by it
/// (`links::referenced_text`).
pub(crate) fn role_without_props(element: &crate::retained_tree::RetainedElement, text: Option<&str>) -> Option<Role> {
    default_role(element).or_else(|| {
        text.filter(|_| links::current().referenced_text(element.id).is_none())
            .map(|_| Role::Label)
    })
}

/// What a host container's `text` is to its node, which got `default_role` from
/// [`role_without_props`]: the name of a role ARIA names from content ([`names_from_content`]),
/// the value of any other (a `Label`, a `list`, a `region`), unless the author gave
/// `aria-valuetext`. An author's name (`aria-label`, `aria-labelledby`, a `<label>`) is kept, and so
/// is the one the `Group` of a referenced container got from the same text.
pub(crate) fn describe_text<E>(
    el: E,
    element: &crate::retained_tree::RetainedElement,
    default_role: Option<Role>,
    text: Option<String>,
) -> E
where
    E: StatefulInteractiveElement,
{
    let Some(text) = text else {
        return el;
    };
    let props = element.custom_props();
    let role = resolve_role(props, default_role);
    let links = links::current();
    if role.is_none() && links.referenced_text(element.id).is_some() {
        return el;
    }
    if !role.is_some_and(names_from_content) {
        return if props.contains_key("aria-valuetext") { el } else { el.aria_value(text) };
    }
    if named_by_aria(props) || links.labels_of(element.id).is_some() {
        return el;
    }
    el.aria_label(text)
}

/// Whether ARIA names a `role` from its content: a button is named by its text, a list is not.
fn names_from_content(role: Role) -> bool {
    matches!(
        role,
        Role::Button
            | Role::Link
            | Role::Heading
            | Role::CheckBox
            | Role::RadioButton
            | Role::Switch
            | Role::MenuItem
            | Role::MenuItemCheckBox
            | Role::MenuItemRadio
            | Role::Tab
            | Role::ListBoxOption
            | Role::TreeItem
            | Role::Cell
            | Role::GridCell
            | Role::ColumnHeader
            | Role::RowHeader
            | Role::Row
            | Role::Tooltip
    )
}

/// Whether each paragraph of `element` gets a node of its own: with a screen reader on, when blocks
/// stand beside the paragraphs, which then have no element to carry their text.
pub(crate) fn labels_paragraphs(
    a11y_active: bool,
    element: &crate::retained_tree::RetainedElement,
    plan: &[(crate::text::inline::Child, u32)],
) -> bool {
    use crate::text::inline::Child;
    a11y_active
        && carries_text(element)
        && plan.iter().any(|(child, _)| !matches!(child, Child::Paragraph(_) | Child::EmptyLine))
}

/// The node of a paragraph that sits beside blocks in `host`, which has no element of its own to carry
/// its text. `anchor` is [`crate::text::inline::Paragraph::anchor`]: the node keeps its id when a
/// sibling is inserted before the paragraph.
pub(crate) fn paragraph_label(anchor: u64, text: String) -> gpui::Stateful<gpui::Div> {
    gpui::div()
        .id(gpui::ElementId::NamedInteger(gpui::SharedString::new_static("gpuix-paragraph"), anchor))
        .role(Role::Label)
        .aria_value(text)
}

/// What `apply_accessibility` reads of the elements around `host_id` rather than of it: the labels
/// that name it, the elements whose `aria-*` reference names it, the control it activates. None for
/// the many elements nothing links to. It is in the retained key, because none of it is in the
/// element's own subtree.
pub(crate) fn links_key(host_id: u64) -> Option<u64> {
    links::current().key(host_id)
}

/// `aria-label`, or `alt` when that is empty. Used by `<img>`.
pub(crate) fn apply_image_label<E>(
    el: E,
    props: &HashMap<String, serde_json::Value>,
    alt: &str,
) -> E
where
    E: StatefulInteractiveElement,
{
    if props.get("aria-label").is_some() || alt.is_empty() {
        return el;
    }
    el.aria_label(alt.to_string())
}

/// VoiceOver Press. GPUI auto-adds Click only for `.on_click()`. GPUIX
/// click is dispatched by `crate::events`, so register the action by hand and
/// make the click a non-pointer activation makes, with the activation behaviour
/// that follows it. `path` is the element and its retained ancestors, as built;
/// it is empty for an element nothing can receive a click on (see
/// `click_path`), which gets no action.
pub(crate) fn apply_a11y_click<E>(
    el: E,
    path: Vec<u64>,
    activation: &crate::events::activation::Activation,
) -> E
where
    E: StatefulInteractiveElement,
{
    if path.is_empty() {
        return el;
    }
    let activation = activation.clone();
    el.on_a11y_action(AccessibleAction::Click, move |_data, window, cx| {
        activation.click(click_payload(path.clone()), window, cx);
    })
}

/// ARIA token → AccessKit role. Unknown tokens are ignored, like a bad style.
fn role_from_aria(token: &str) -> Option<Role> {
    Some(match token {
        "alert" => Role::Alert,
        "alertdialog" => Role::AlertDialog,
        "application" => Role::Application,
        "article" => Role::Article,
        "banner" => Role::Banner,
        "blockquote" => Role::Blockquote,
        "button" => Role::Button,
        "caption" => Role::Caption,
        "cell" => Role::Cell,
        "checkbox" => Role::CheckBox,
        "code" => Role::Code,
        "columnheader" => Role::ColumnHeader,
        "combobox" => Role::ComboBox,
        "complementary" => Role::Complementary,
        "contentinfo" => Role::ContentInfo,
        "definition" => Role::Definition,
        "deletion" => Role::ContentDeletion,
        "dialog" => Role::Dialog,
        "document" => Role::Document,
        "emphasis" => Role::Emphasis,
        "feed" => Role::Feed,
        "figure" => Role::Figure,
        "form" => Role::Form,
        "generic" => Role::GenericContainer,
        "grid" => Role::Grid,
        "gridcell" => Role::GridCell,
        "group" => Role::Group,
        "heading" => Role::Heading,
        "img" => Role::Image,
        "insertion" => Role::ContentInsertion,
        "link" => Role::Link,
        "list" => Role::List,
        "listbox" => Role::ListBox,
        "listitem" => Role::ListItem,
        "log" => Role::Log,
        "main" => Role::Main,
        "marquee" => Role::Marquee,
        "math" => Role::Math,
        "menu" => Role::Menu,
        "menubar" => Role::MenuBar,
        "menuitem" => Role::MenuItem,
        "menuitemcheckbox" => Role::MenuItemCheckBox,
        "menuitemradio" => Role::MenuItemRadio,
        "meter" => Role::Meter,
        "navigation" => Role::Navigation,
        "none" | "presentation" => Role::GenericContainer,
        "note" => Role::Note,
        "option" => Role::ListBoxOption,
        "paragraph" => Role::Paragraph,
        "progressbar" => Role::ProgressIndicator,
        "radio" => Role::RadioButton,
        "radiogroup" => Role::RadioGroup,
        "region" => Role::Region,
        "row" => Role::Row,
        "rowgroup" => Role::RowGroup,
        "rowheader" => Role::RowHeader,
        "scrollbar" => Role::ScrollBar,
        "search" => Role::Search,
        "searchbox" => Role::SearchInput,
        "separator" => Role::Splitter,
        "slider" => Role::Slider,
        "spinbutton" => Role::SpinButton,
        "status" => Role::Status,
        "strong" => Role::Strong,
        "subscript" => Role::GenericContainer,
        "superscript" => Role::GenericContainer,
        "switch" => Role::Switch,
        "tab" => Role::Tab,
        "table" => Role::Table,
        "tablist" => Role::TabList,
        "tabpanel" => Role::TabPanel,
        "term" => Role::Term,
        "textbox" => Role::TextInput,
        "time" => Role::Time,
        "timer" => Role::Timer,
        "toolbar" => Role::Toolbar,
        "tooltip" => Role::Tooltip,
        "tree" => Role::Tree,
        "treegrid" => Role::TreeGrid,
        "treeitem" => Role::TreeItem,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::role_from_aria;
    use gpui::Role;

    #[test]
    fn maps_common_aria_tokens() {
        assert_eq!(role_from_aria("button"), Some(Role::Button));
        assert_eq!(role_from_aria("heading"), Some(Role::Heading));
        assert_eq!(role_from_aria("textbox"), Some(Role::TextInput));
        assert_eq!(role_from_aria("img"), Some(Role::Image));
        assert_eq!(role_from_aria("option"), Some(Role::ListBoxOption));
        assert_eq!(role_from_aria("none"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("presentation"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("Button"), None);
        assert_eq!(role_from_aria("not-a-role"), None);
    }

    fn container(children: &[(&str, &str)]) -> crate::retained_tree::RetainedTree {
        let mut tree = crate::retained_tree::RetainedTree::new();
        tree.create_element(1, "div".to_string());
        for (index, (kind, text)) in children.iter().enumerate() {
            let id = 2 + index as u64;
            tree.create_element(id, kind.to_string());
            tree.append_child(1, id);
            if *kind == "#text" {
                tree.set_text(id, text.to_string());
            }
        }
        tree
    }

    #[test]
    fn paragraphs_beside_blocks_are_labelled_only_with_a_screen_reader() {
        let tree = container(&[("#text", "Before"), ("div", ""), ("#text", "After")]);
        let host = &tree.elements[&1];
        let plan = crate::text::inline::plan_children_at(&tree, host);
        assert!(super::labels_paragraphs(true, host, &plan));
        assert!(!super::labels_paragraphs(false, host, &plan));
        let one = container(&[("#text", "Only")]);
        let host = &one.elements[&1];
        let plan = crate::text::inline::plan_children_at(&one, host);
        assert!(!super::labels_paragraphs(true, host, &plan));
    }

    #[test]
    fn a_paragraph_beside_blocks_keeps_its_node_id_when_a_sibling_is_inserted_before_it() {
        let mut tree = container(&[("div", ""), ("#text", "After")]);
        let anchor = |tree: &crate::retained_tree::RetainedTree| {
            let plan = crate::text::inline::plan_children_at(tree, &tree.elements[&1]);
            plan.iter()
                .find_map(|(child, _)| match child {
                    crate::text::inline::Child::Paragraph(paragraph) => Some(paragraph.anchor),
                    _ => None,
                })
                .expect("a paragraph")
        };
        assert_eq!(anchor(&tree), 3);
        tree.create_element(9, "div".to_string());
        tree.insert_before(1, 9, 2);
        assert_eq!(anchor(&tree), 3);
    }

    #[test]
    fn a_container_reads_out_its_one_paragraph_and_has_the_label_role_unless_it_has_another() {
        let tree = container(&[("#text", "Hello")]);
        let host = &tree.elements[&1];
        let text = super::read_text_unplanned(&tree, host);
        assert_eq!(text.as_deref(), Some("Hello"));
        assert_eq!(super::role_without_props(host, text.as_deref()), Some(Role::Label));
        let mut form = container(&[("#text", "Hello")]);
        form.create_element(9, "form".to_string());
        form.append_child(1, 9);
        form.create_element(10, "#text".to_string());
        form.set_text(10, "Hi".to_string());
        form.append_child(9, 10);
        let host = &form.elements[&9];
        let text = super::read_text_unplanned(&form, host);
        assert_eq!(text.as_deref(), Some("Hi"));
        assert_eq!(super::role_without_props(host, text.as_deref()), Some(Role::Form));
        let blank = container(&[("#text", "  ")]);
        assert_eq!(super::read_text_unplanned(&blank, &blank.elements[&1]), None);
        let beside_block = container(&[("#text", "Before"), ("div", "")]);
        assert_eq!(super::read_text_unplanned(&beside_block, &beside_block.elements[&1]), None);
    }
}
