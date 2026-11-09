//! What a direct root keeps per node. The nodes are in a `Vec`, children by index, so an element
//! that walks them holds no borrow of one while it visits another.

use std::rc::Rc;

use gpui::{AnyElement, Bounds, LayoutId, Pixels, Style};

#[derive(Clone, Copy)]
pub(super) enum Child {
    Node(usize),
    Content(usize),
}

pub(super) struct Node {
    /// Shared so that paint can hold the style while it walks the children, which borrow the arena.
    pub style: Rc<Style>,
    pub children: Vec<Child>,
    pub layout_id: Option<LayoutId>,
    pub bounds: Bounds<Pixels>,
}

/// A text, a paragraph or an empty line: an element of its own that the node lays out among its children.
pub(super) struct Content {
    pub element: AnyElement,
    pub layout_id: Option<LayoutId>,
}

#[derive(Default)]
pub(super) struct Arena {
    pub nodes: Vec<Node>,
    pub contents: Vec<Content>,
}

impl Arena {
    pub fn push_node(&mut self, style: Style, children: Vec<Child>) -> usize {
        self.nodes.push(Node {
            style: Rc::new(style),
            children,
            layout_id: None,
            bounds: Bounds::default(),
        });
        self.nodes.len() - 1
    }

    pub fn push_content(&mut self, element: AnyElement) -> Child {
        self.contents.push(Content { element, layout_id: None });
        Child::Content(self.contents.len() - 1)
    }
}
