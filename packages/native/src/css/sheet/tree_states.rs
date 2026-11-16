//! The pseudo-classes that read what the tree holds of an element and not what a selector can see
//! of it: `:popover-open`, `:disabled`, `:checked`, `:required`, `:read-write`, `:any-link` and the
//! rest.
//!
//! A state is read from what native already keeps (the props of the element, the live checkedness
//! in `Choices`), and a write to one of those marks the elements the index says read it: `reach`
//! tells which states a prop can change, and [`TreeStateReach`] where each state is read.

use serde_json::Value;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::invalidation::Reach;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TreeState {
    /// An element with the `popover` attribute that `showPopover()` opened.
    PopoverOpen,
    Disabled,
    Enabled,
    Checked,
    Indeterminate,
    Required,
    Optional,
    ReadOnly,
    ReadWrite,
    AnyLink,
}

impl TreeState {
    const COUNT: usize = 10;

    fn index(self) -> usize {
        self as usize
    }

    /// The state a pseudo-class names. `:link` is `:any-link`: nothing here is visited.
    pub fn parse(name: &str) -> Option<TreeState> {
        Some(match name {
            "popover-open" => TreeState::PopoverOpen,
            "disabled" => TreeState::Disabled,
            "enabled" => TreeState::Enabled,
            "checked" => TreeState::Checked,
            "indeterminate" => TreeState::Indeterminate,
            "required" => TreeState::Required,
            "optional" => TreeState::Optional,
            "read-only" => TreeState::ReadOnly,
            "read-write" => TreeState::ReadWrite,
            "any-link" | "link" => TreeState::AnyLink,
            _ => return None,
        })
    }
}

/// A set of states, one bit each.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct TreeStates(u16);

impl TreeStates {
    pub const NONE: TreeStates = TreeStates(0);
    pub const POPOVER_OPEN: TreeStates = TreeStates::of(TreeState::PopoverOpen);
    pub const DISABLED: TreeStates = TreeStates::of(TreeState::Disabled);
    pub const ENABLED: TreeStates = TreeStates::of(TreeState::Enabled);
    pub const CHECKED: TreeStates = TreeStates::of(TreeState::Checked);
    pub const INDETERMINATE: TreeStates = TreeStates::of(TreeState::Indeterminate);
    pub const REQUIRED: TreeStates = TreeStates::of(TreeState::Required);
    pub const OPTIONAL: TreeStates = TreeStates::of(TreeState::Optional);
    pub const READ_ONLY: TreeStates = TreeStates::of(TreeState::ReadOnly);
    pub const READ_WRITE: TreeStates = TreeStates::of(TreeState::ReadWrite);
    pub const ANY_LINK: TreeStates = TreeStates::of(TreeState::AnyLink);

    const fn of(state: TreeState) -> TreeStates {
        TreeStates(1 << state as u16)
    }

    pub fn is_empty(self) -> bool {
        self == TreeStates::NONE
    }

    /// The states a write of the prop `key` can change the answer of. Not `popoverOpen` and
    /// `popover`, which `html::popover::is_popover_prop` tells apart.
    pub fn changed_by_prop(key: &str) -> TreeStates {
        match key {
            "disabled" => TreeStates::DISABLED | TreeStates::ENABLED | TreeStates::READ_WRITE | TreeStates::READ_ONLY,
            "formControl" => TreeStates::DISABLED | TreeStates::ENABLED,
            "required" => TreeStates::REQUIRED | TreeStates::OPTIONAL,
            "readOnly" => TreeStates::READ_ONLY | TreeStates::READ_WRITE,
            "href" => TreeStates::ANY_LINK,
            "type" => TreeStates::CHECKED | TreeStates::INDETERMINATE | TreeStates::READ_ONLY | TreeStates::READ_WRITE,
            _ => TreeStates::NONE,
        }
    }
}

impl std::ops::BitOr for TreeStates {
    type Output = TreeStates;

    fn bitor(self, other: TreeStates) -> TreeStates {
        TreeStates(self.0 | other.0)
    }
}

/// Where each state is read, by the selectors of a document: empty for a state no selector names,
/// so a document that uses none marks nothing when a prop changes.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct TreeStateReach([Reach; TreeState::COUNT]);

impl TreeStateReach {
    pub(super) fn read(&mut self, state: TreeState, reach: Reach) {
        self.0[state.index()] |= reach;
    }

    /// Where an element's answer to any of `changed` is read from.
    pub fn of(&self, changed: TreeStates) -> Reach {
        self.0
            .iter()
            .enumerate()
            .filter(|(index, _)| changed.0 & (1 << index) != 0)
            .fold(Reach::default(), |all, (_, reach)| all | *reach)
    }

    pub fn state(&self, state: TreeState) -> Reach {
        self.0[state.index()]
    }
}

/// Whether the element `id`, which is `element`, is in `state`.
pub(super) fn read(tree: &RetainedTree, id: u64, element: &RetainedElement, state: TreeState) -> bool {
    match state {
        TreeState::PopoverOpen => crate::html::popover::is_open(element),
        TreeState::Disabled => element.control_disabled() == Some(true),
        TreeState::Enabled => element.control_disabled() == Some(false),
        TreeState::Checked => is_choice(element, true) && tree.is_checked(id),
        TreeState::Indeterminate => is_choice(element, false) && tree.is_indeterminate(id),
        TreeState::Required => takes_required(element) && flag(element, "required"),
        TreeState::Optional => takes_required(element) && !flag(element, "required"),
        TreeState::ReadWrite => is_read_write(element),
        TreeState::ReadOnly => !is_read_write(element),
        TreeState::AnyLink => matches!(element.element_type.as_str(), "a" | "area") && crate::html::has_href(element),
    }
}

fn flag(element: &RetainedElement, key: &str) -> bool {
    element.custom_props().get(key).and_then(Value::as_bool) == Some(true)
}

/// A checkbox or a radio; only a checkbox when `radio` is not allowed.
fn is_choice(element: &RetainedElement, radio: bool) -> bool {
    match crate::custom_elements::input_choice::choice_of(element) {
        Some(crate::custom_elements::input_choice::Choice::Checkbox) => true,
        Some(crate::custom_elements::input_choice::Choice::Radio) => radio,
        None => false,
    }
}

fn takes_required(element: &RetainedElement) -> bool {
    matches!(element.element_type.as_str(), "input" | "select" | "textarea")
}

/// A `textarea`, or an `input` that is edited as text, that is neither `readOnly` nor disabled.
fn is_read_write(element: &RetainedElement) -> bool {
    let editable = match element.element_type.as_str() {
        "textarea" => true,
        "input" => takes_text(element.custom_props().get("type").and_then(Value::as_str).unwrap_or_default()),
        _ => false,
    };
    editable && !flag(element, "readOnly") && !element.is_disabled()
}

/// Every `type` but the ones that are not text, which includes a token no type has: it is `text`.
fn takes_text(input_type: &str) -> bool {
    !matches!(
        input_type.trim().to_ascii_lowercase().as_str(),
        "checkbox" | "radio" | "range" | "hidden" | "color" | "file" | "button" | "submit" | "reset" | "image"
    )
}
