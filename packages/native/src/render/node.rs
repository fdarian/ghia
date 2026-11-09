//! What a direct root keeps per node. The nodes are in a `Vec`, children by index, so an element
//! that walks them holds no borrow of one while it visits another. The arena is shared (`Rc`) by the
//! root and by the elements of its positioned nodes, each of which walks the part of it below its
//! node, so what changes per frame is in cells.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui::{AnyElement, Bounds, Escape, Hitbox, LayoutId, LayoutSample, Pixels, Point, ScrollHandle, ScrollerFrame, Style};

#[derive(Clone, Copy)]
pub(super) enum Child {
    Node(usize),
    Content(usize),
    /// A node `Div` hands to the stacking context around it, or draws without the clip of its
    /// parent: the walk of an element of its own ([`super::element::DirectRoot`]), as a `Div`
    /// child is one.
    Positioned(usize),
}

/// How a node is placed: what `Element::lift_z` and `Element::escapes_to` say of a `Div`, and whether
/// its children are drawn in a positioned frame (`Window::with_frame`).
#[derive(Clone, Copy, Default)]
pub(super) struct Placement {
    pub lift_z: Option<i32>,
    pub escape: Option<Escape>,
    /// `Some(contains_fixed)` for a positioned box or a box that contains fixed ones.
    pub frame: Option<bool>,
    /// The node is a stacking context: what is lifted below it is painted and hit by it. Only the root of a direct
    /// root is one.
    pub context: bool,
}

impl Placement {
    pub fn is_positioned(self) -> bool {
        self.lift_z.is_some() || self.escape.is_some()
    }
}

/// A scroll container (`overflow: hidden`, which only code scrolls): the handle the host has in
/// `scroll_handles`, which gpui keeps the offset and the range in.
pub(super) struct Scroller {
    pub handle: ScrollHandle,
    /// The axes the user does not scroll.
    pub programmatic: Point<bool>,
    /// What prepaint measured of the layout, for the clamp of the offset.
    pub frame: RefCell<Option<ScrollerFrame>>,
}

pub(super) struct Node {
    /// The host id of the element, which names its hitbox.
    pub id: u64,
    /// Shared so that paint can hold the style while it walks the children, which borrow the arena.
    pub style: Rc<Style>,
    pub children: Vec<Child>,
    pub placement: Placement,
    /// The hitbox is only a link in the chain of a descendant that is hit (`pointer-events: none`).
    pub passes_pointer: bool,
    /// What `crate::automation::host_bounds_flags` says of the node's `user-select` and of whether it scrolls.
    pub bounds_flags: u8,
    pub scroller: Option<Scroller>,
    pub layout_id: Cell<Option<LayoutId>>,
    pub bounds: Cell<Bounds<Pixels>>,
    /// Set in prepaint: a box below escaped the clip of the node, which paint then does not make exact.
    pub escape_inside: Cell<bool>,
    /// Set in prepaint, which paint reads back.
    pub hitbox: RefCell<Option<Hitbox>>,
    pub sample: Cell<Option<LayoutSample>>,
}

/// A text, a paragraph or an empty line: an element of its own that the node lays out among its children.
pub(super) struct Content {
    pub element: RefCell<AnyElement>,
    pub layout_id: Cell<Option<LayoutId>>,
}

#[derive(Default)]
pub(super) struct Arena {
    pub nodes: Vec<Node>,
    pub contents: Vec<Content>,
}

pub(super) struct NodeSpec {
    pub id: u64,
    pub style: Style,
    pub children: Vec<Child>,
    pub placement: Placement,
    pub passes_pointer: bool,
    pub bounds_flags: u8,
    pub scroller: Option<(ScrollHandle, Point<bool>)>,
}

impl Arena {
    pub fn push_node(&mut self, spec: NodeSpec) -> usize {
        self.nodes.push(Node {
            id: spec.id,
            style: Rc::new(spec.style),
            children: spec.children,
            placement: spec.placement,
            passes_pointer: spec.passes_pointer,
            bounds_flags: spec.bounds_flags,
            scroller: spec.scroller.map(|(handle, programmatic)| Scroller { handle, programmatic, frame: RefCell::new(None) }),
            layout_id: Cell::new(None),
            bounds: Cell::new(Bounds::default()),
            escape_inside: Cell::new(false),
            hitbox: RefCell::new(None),
            sample: Cell::new(None),
        });
        self.nodes.len() - 1
    }

    pub fn push_content(&mut self, element: AnyElement) -> Child {
        self.contents.push(Content { element: RefCell::new(element), layout_id: Cell::new(None) });
        Child::Content(self.contents.len() - 1)
    }
}
