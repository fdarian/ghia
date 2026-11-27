//! The generated boxes of `::before` and `::after`, drawn as virtual children of their element.
//!
//! A box is a `span` element of the retained tree with the cascaded style the sheets gave the box
//! and, when its `content` has text, one `#text` child. Neither is in `children` of the element
//! they belong to, so everything that walks the document (selectors, `:nth-child`, `:has()`, the
//! DOM mirror, selection by node) never sees them, and `layout_children` puts them in the list
//! that layout, the paragraph planner and the build read: `::before` first, `::after` last. From
//! there a box is planned and built as any child is, so every `display` works (a piece of the
//! paragraph for `inline`, a block, a flex or grid item, `position: absolute`), and so does
//! `order`.
//!
//! The elements are made and removed here, by the flush that matched the boxes
//! (`apply_pseudo`) and by a change of an attribute `content: attr()` reads, never by a build.
//! They are in `RetainedTree::elements` (a build looks every child up there) and are skipped by
//! what visits every element: the universal layer and a restyle by the sheets leave them alone.
//!
//! # Ids
//!
//! A box is a host element for GPUI and for the painted boxes, under an id derived from the
//! element it belongs to (the owner), in bits no host id has (`GENERATED`, `AFTER`, `TEXT`).
//! `events::ids::host_id_of` reads such an id as the owner's, so a hit on a box is a hit on the
//! owner: `elementFromPoint`, the target of a pointer event and `:hover` are the owner's, as in
//! the DOM. The states of a box (`.btn:hover::before`, a focus variant, `:disabled`) are the
//! owner's, `state_owner` gives the id they are read under.
//!
//! The text of a box is not a DOM node: it has no `TextSource`, so no DOM position is made of it,
//! and selection and find leave it out (`Piece::generated`).

use std::borrow::Cow;
use std::sync::Arc;

use crate::css::content::{Computed, ComputedItem};
use crate::css::sheet::Pseudo;
use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::StyleDesc;

/// Set in the id of a generated box and of its text.
const GENERATED: u64 = 1 << 62;
/// The box is the `::after` one.
const AFTER: u64 = 1 << 61;
/// The id is the text of a box.
const TEXT: u64 = 1 << 60;

const BITS: u64 = GENERATED | AFTER | TEXT;

pub(crate) fn box_id(owner: u64, pseudo: Pseudo) -> u64 {
    owner | GENERATED | if pseudo == Pseudo::After { AFTER } else { 0 }
}

fn text_id(box_id: u64) -> u64 {
    box_id | TEXT
}

pub(crate) fn is_generated(id: u64) -> bool {
    id & GENERATED != 0
}

/// The element a generated box (or its text) belongs to, `id` itself for any other.
pub(crate) fn owner_of(id: u64) -> u64 {
    id & !BITS
}

/// The id the states of the element `id` are read under: a box has the states of its owner.
pub(crate) fn state_owner(id: u64) -> u64 {
    owner_of(id)
}

/// The ids of the boxes `element` has now, `::before` then `::after`.
pub(crate) fn boxes_of<'a>(tree: &'a RetainedTree, element: &RetainedElement) -> impl Iterator<Item = u64> + 'a {
    let present = element.pseudo_matches().is_some();
    let owner = element.id;
    Pseudo::BOTH
        .into_iter()
        .map(move |pseudo| box_id(owner, pseudo))
        .filter(move |id| present && tree.elements.contains_key(id))
}

/// The children of `element` that layout, the planner and the build take: its own with its boxes.
pub(crate) fn layout_children<'a>(tree: &RetainedTree, element: &'a RetainedElement) -> Cow<'a, [u64]> {
    if element.pseudo_matches().is_none() {
        return Cow::Borrowed(&element.children);
    }
    let before = box_id(element.id, Pseudo::Before);
    let after = box_id(element.id, Pseudo::After);
    let (has_before, has_after) = (tree.elements.contains_key(&before), tree.elements.contains_key(&after));
    if !has_before && !has_after {
        return Cow::Borrowed(&element.children);
    }
    let mut all = Vec::with_capacity(element.children.len() + 2);
    all.extend(has_before.then_some(before));
    all.extend_from_slice(&element.children);
    all.extend(has_after.then_some(after));
    Cow::Owned(all)
}

/// Whether `element` has no child to lay out: no child and no box.
pub(crate) fn childless(tree: &RetainedTree, element: &RetainedElement) -> bool {
    element.children.is_empty() && boxes_of(tree, element).next().is_none()
}

/// Whether a box of `element` declares a style `has` says yes to: what a state of the element
/// restyles, when its own style does not.
pub(crate) fn declares(tree: &RetainedTree, element: &RetainedElement, has: impl Fn(&StyleDesc) -> bool) -> bool {
    boxes_of(tree, element).any(|id| tree.elements.get(&id).and_then(|generated| generated.style.as_deref()).is_some_and(&has))
}

/// [`declares`] for the element `id`.
pub(crate) fn declares_of(tree: &RetainedTree, id: u64, has: impl Fn(&StyleDesc) -> bool) -> bool {
    tree.elements.get(&id).is_some_and(|element| declares(tree, element, has))
}

/// Elements that generate no box: they have no content for one to be in.
fn takes_boxes(element: &RetainedElement) -> bool {
    crate::text::inline::is_host_container(element)
        && !crate::text::inline::is_raw_text(element)
        && !matches!(
            element.element_type.as_str(),
            "img" | "input" | "textarea" | "select" | "br" | "wbr" | "hr" | "svg" | "nativeview" | "head"
        )
}

/// The style and the text of the box `pseudo` of `element` as it is now, `None` when it has no
/// box.
fn wanted(element: &RetainedElement, pseudo: Pseudo) -> Option<(Arc<StyleDesc>, String)> {
    if !takes_boxes(element) {
        return None;
    }
    let style = element.pseudo_style(pseudo)?;
    let computed = style.content.as_ref()?.compute(|name| element.attribute(name).map(|value| value.into_owned()));
    let Computed::Items(items) = computed else {
        return None;
    };
    let text = items
        .into_iter()
        .filter_map(|item| match item {
            ComputedItem::Text(text) => Some(text),
            ComputedItem::Unsupported(_) => None,
        })
        .collect();
    Some((style.clone(), text))
}

impl RetainedTree {
    /// Makes the boxes of `owner` what its rules and attributes say now. Marks the element when
    /// anything it draws changed.
    pub(crate) fn sync_generated(&mut self, owner: u64) {
        let Some(element) = self.elements.get(&owner) else {
            return;
        };
        let wanted = Pseudo::BOTH.map(|pseudo| wanted(element, pseudo));
        let mut changed = false;
        for (pseudo, wanted) in Pseudo::BOTH.into_iter().zip(wanted) {
            changed |= self.settle_box(owner, box_id(owner, pseudo), wanted);
        }
        if changed {
            self.mark_render_changed(owner);
        }
    }

    fn settle_box(&mut self, owner: u64, id: u64, wanted: Option<(Arc<StyleDesc>, String)>) -> bool {
        let Some((style, text)) = wanted else {
            if !self.elements.contains_key(&id) {
                return false;
            }
            self.destroy_generated(id);
            return true;
        };
        let text_id = text_id(id);
        let mut changed = false;
        if !self.elements.contains_key(&id) {
            self.create_element(id, "span".to_owned());
            self.elements.get_mut(&id).expect("just created").parent = Some(owner);
            changed = true;
        }
        changed |= self.assign_style(id, Some(style), false).changed;
        let held = self.elements.get(&text_id).and_then(|element| element.content.clone());
        match (held, text.is_empty()) {
            (None, true) => {}
            (Some(_), true) => {
                let mut gone = Vec::new();
                self.destroy_element_recursive(text_id, &mut gone);
                self.elements.get_mut(&id).expect("the box exists").children.clear();
                changed = true;
            }
            (Some(held), false) if held == text => {}
            (held, false) => {
                if held.is_none() {
                    self.create_element(text_id, "#text".to_owned());
                    self.elements.get_mut(&text_id).expect("just created").parent = Some(id);
                    self.elements.get_mut(&id).expect("the box exists").children = vec![text_id];
                }
                self.elements.get_mut(&text_id).expect("the text exists").content = Some(text);
                changed = true;
            }
        }
        if changed {
            self.mark_render_changed(id);
        }
        changed
    }

    /// Takes the boxes of `owner` out of the tree, before the owner itself goes.
    pub(crate) fn destroy_generated_of(&mut self, owner: u64) {
        for pseudo in Pseudo::BOTH {
            let id = box_id(owner, pseudo);
            if self.elements.contains_key(&id) {
                self.destroy_generated(id);
            }
        }
    }

    fn destroy_generated(&mut self, id: u64) {
        let mut gone = Vec::with_capacity(2);
        self.destroy_element_recursive(id, &mut gone);
    }
}
