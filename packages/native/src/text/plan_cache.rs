//! The children plan of a host element, kept on the element for the frame after.
//!
//! `plan_children_at` walks the children of an element, collapses their white space into
//! paragraphs and decides which of them are boxes of their own. A build asks for it for every host
//! element with children, and it is the same answer until something it reads moves. It reads:
//!
//! - the element and everything the paragraph builder walks below it (children, content, styles,
//!   `display: contents` splices, listeners and props that make a `<text>` a box): the element's
//!   `subtree_revision`, which every mutation of it or a descendant moves;
//! - the `white-space` the element inherits, from ancestors that `subtree_revision` does not
//!   cover: its computed value is in the key;
//! - the `display` and `order` that `@container` blocks gave the elements it reads
//!   (`RetainedElement::container_display`, `container_order`), which a build writes after the
//!   revision was taken (`layout::container::settle`): [`settled`] counts the times one of them
//!   changed, for the whole thread, which is more than the element reads and never less;
//! - the elements a `display` transition keeps rendered (`box_generation::hold_display`): while
//!   there are any, the plan is made and not kept.
//!
//! Beside the plan is the text a `<text>` host reads out to accessibility, which is a function of
//! the plan alone.
//!
//! The cache follows the style cache's switch (`css::style_cache::mode`): off plans every time,
//! and verifying plans again for every plan it finds kept and panics when the two differ.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use super::inline::{self, Child};
use super::white_space::{self, WhiteSpace};
use crate::css::style_cache::{self, Mode};
use crate::retained_tree::{RetainedElement, RetainedTree};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Key {
    revision: u64,
    white_space: WhiteSpace,
    settled: u64,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Planned {
    key: Key,
    /// `plan_children_at`, see there.
    pub children: Vec<(Child, u32)>,
    /// What the element reads out, when it is a `<text>` host (`accessibility::is_text_host`).
    pub accessible_text: Option<String>,
}

/// What `RetainedElement` keeps, empty until its first plan.
pub(crate) type Slot = RefCell<Option<Rc<Planned>>>;

// The build runs on the one thread that owns the window, and so does `settle`.
thread_local! {
    static SETTLED: Cell<u64> = const { Cell::new(0) };
}

/// A `display` or an `order` that an element's `@container` blocks gave it is not what the build
/// before assumed, see `layout::container::settle`.
pub(crate) fn settled() {
    SETTLED.with(|count| count.set(count.get() + 1));
}

fn compute(tree: &RetainedTree, element: &RetainedElement, key: Key) -> Planned {
    let children = inline::plan_children_at(tree, element);
    let accessible_text = crate::accessibility::is_text_host(element)
        .then(|| inline::accessible_text(children.iter().map(|(child, _)| child)))
        .flatten();
    Planned { key, children, accessible_text }
}

/// `plan_children_at(tree, element)`, and what `<text>` reads out of it, kept on the element.
pub(crate) fn planned(tree: &RetainedTree, element: &RetainedElement) -> Rc<Planned> {
    let mode = style_cache::mode();
    let key = Key {
        revision: element.subtree_revision,
        white_space: white_space::computed(tree, element),
        settled: SETTLED.with(Cell::get),
    };
    if mode == Mode::Off || crate::layout::box_generation::any_display_held() {
        crate::perf_counters::plan_made(false);
        return Rc::new(compute(tree, element, key));
    }
    let kept = element.kept_plan.borrow().as_ref().filter(|kept| kept.key == key).cloned();
    if let Some(kept) = kept {
        if mode == Mode::Verify {
            let fresh = compute(tree, element, key);
            assert!(
                fresh == *kept,
                "the plan cache kept the children plan of element {} that is planned differently now\n kept {:?}\n now  {:?}",
                element.id,
                kept,
                fresh,
            );
        }
        crate::perf_counters::plan_made(true);
        return kept;
    }
    crate::perf_counters::plan_made(false);
    let planned = Rc::new(compute(tree, element, key));
    *element.kept_plan.borrow_mut() = Some(planned.clone());
    planned
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn tree() -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "text".to_string());
        for (id, content) in [(2, "Hello "), (3, "world")] {
            tree.create_element(id, "text".to_string());
            tree.set_text(id, content.to_string());
            tree.append_child(1, id);
        }
        tree
    }

    fn text(planned: &Planned) -> &str {
        match &planned.children[0].0 {
            Child::Paragraph(paragraph) => &paragraph.text,
            other => panic!("a paragraph, got {other:?}"),
        }
    }

    #[test]
    fn a_plan_is_kept_until_the_subtree_changes() {
        let mut tree = tree();
        let first = planned(&tree, &tree.elements[&1]);
        assert_eq!(text(&first), "Hello world");
        assert_eq!(first.accessible_text.as_deref(), Some("Hello world"));
        if style_cache::mode() != Mode::Off {
            assert!(Rc::ptr_eq(&first, &planned(&tree, &tree.elements[&1])));
        }
        tree.set_text(3, "there".to_string());
        let second = planned(&tree, &tree.elements[&1]);
        assert_eq!(text(&second), "Hello there");
        assert_eq!(second.accessible_text.as_deref(), Some("Hello there"));
    }

    #[test]
    fn the_white_space_an_ancestor_declares_is_in_the_key() {
        let mut tree = RetainedTree::new();
        for id in [1, 2] {
            tree.create_element(id, "div".to_string());
        }
        tree.append_child(1, 2);
        tree.create_element(3, "text".to_string());
        tree.set_text(3, "a   b".to_string());
        tree.append_child(2, 3);
        assert_eq!(text(&planned(&tree, &tree.elements[&2])), "a b");
        tree.set_style(1, Arc::new(serde_json::from_value(serde_json::json!({ "whiteSpace": "pre" })).unwrap()));
        assert_eq!(text(&planned(&tree, &tree.elements[&2])), "a   b");
    }

    #[test]
    fn a_display_a_container_block_gave_is_in_the_key() {
        let mut tree = RetainedTree::new();
        for (id, kind) in [(1, "div"), (2, "text"), (3, "div"), (4, "text")] {
            tree.create_element(id, kind.to_string());
        }
        tree.set_text(2, "a".to_string());
        tree.set_text(4, "b".to_string());
        tree.append_child(1, 2);
        tree.append_child(1, 3);
        tree.append_child(3, 4);
        let block = planned(&tree, &tree.elements[&1]);
        assert_eq!(block.children.len(), 2, "a paragraph and a block: {:?}", block.children);
        // The build of the parent found that the `@container` blocks of the div make it inline.
        *tree.elements[&3].container_display.borrow_mut() = Some(Some("inline".to_string()));
        settled();
        let inline = planned(&tree, &tree.elements[&1]);
        assert_eq!(inline.children.len(), 1, "one paragraph: {:?}", inline.children);
        assert_eq!(text(&inline), "ab");
    }
}
