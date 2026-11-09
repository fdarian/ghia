//! The gpui element of a direct root. It makes the calls a `Div` makes for each node, in the order it
//! makes them, around a node's children: the text style, the clip, the box of the node.
//!
//! What a `Div` does that this does not, and why that is no difference for a plain node (see
//! [`super::eligible`]): element state, the listeners, focus, tab stops, scroll offset, sticky, the
//! transform space, `visibility`, and being a stacking context. The hitbox, the cursor, the layout probe
//! and the positioned frame are done per node, and a positioned node is handed to the stacking context
//! around the root, or drawn outside the clip of its parent, by an element of its own.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, CornerRadii, CornerRadius, Corners, Edges, Element, ElementId, Escape, GlobalElementId,
    HitboxBehavior, InspectorElementId, IntoElement, LayoutId, Pixels, Style, Window,
};

use super::node::{Arena, Child, Content, Node};

/// The element of a direct root, and of each positioned node below it: it walks the arena from its
/// own root node, and hands what is positioned below that to an element of its own, as a `Div` does
/// with a child that lifts or escapes.
pub(super) struct DirectRoot {
    id: ElementId,
    arena: Rc<Arena>,
    root: usize,
    cull_outset: Option<Edges<Pixels>>,
    /// The elements of the positioned nodes this one walks to, made in layout.
    lifted: Vec<Lifted>,
}

struct Lifted {
    node: usize,
    /// Handed to the stacking context in prepaint when the node lifts (the child of a `Div` is replaced the same way).
    element: Option<AnyElement>,
    /// What the stacking context calls the lifted element, which paint skips.
    ordinal: Option<u32>,
}

impl DirectRoot {
    pub fn new(id: ElementId, arena: Arena, root: usize, cull_outset: Option<Edges<Pixels>>) -> Self {
        Self { id, arena: Rc::new(arena), root, cull_outset, lifted: Vec::new() }
    }

    fn positioned(arena: Rc<Arena>, node: usize) -> Self {
        let id = crate::events::ids::host_element_id(arena.nodes[node].id);
        Self { id, arena, root: node, cull_outset: None, lifted: Vec::new() }
    }

    fn walk(&mut self) -> Walk<'_> {
        Walk { arena: &self.arena, root: self.root, lifted: &mut self.lifted }
    }
}

struct Walk<'a> {
    arena: &'a Rc<Arena>,
    root: usize,
    lifted: &'a mut Vec<Lifted>,
}

impl Walk<'_> {
    /// Calls `f` with the host id of `node` on the element id stack where the id of a positioned node
    /// below it is checked against it: its element is made in layout and drawn in paint with the same
    /// stack that it is prepainted with (`prepaint_node` has every id).
    fn on_path<R>(&mut self, node: usize, window: &mut Window, f: impl FnOnce(&mut Self, &mut Window) -> R) -> R {
        let target = &self.arena.nodes[node];
        if node != self.root && target.holds_positioned {
            window.with_id(crate::events::ids::host_element_id(target.id), |window| f(self, window))
        } else {
            f(self, window)
        }
    }

    fn lifted_at(&mut self, node: usize) -> &mut Lifted {
        self.lifted.iter_mut().find(|lifted| lifted.node == node).expect("a positioned node is requested before it is prepainted")
    }

    fn request_node(&mut self, node: usize, window: &mut Window, cx: &mut App) -> LayoutId {
        let arena = self.arena;
        let target = &arena.nodes[node];
        let style = target.style.clone();
        let layout_id = self.on_path(node, window, |walk, window| {
            window.with_text_style(style.text_style().cloned(), |window| {
                let mut ids = Vec::with_capacity(target.children.len());
                for child in &target.children {
                    ids.push(match *child {
                        Child::Node(child) => walk.request_node(child, window, cx),
                        Child::Content(content) => {
                            let content = &arena.contents[content];
                            let id = content.element.borrow_mut().request_layout(window, cx);
                            content.layout_id.set(Some(id));
                            id
                        }
                        Child::Positioned(child) => {
                            let mut element = DirectRoot::positioned(arena.clone(), child).into_any_element();
                            let id = element.request_layout(window, cx);
                            walk.lifted.push(Lifted { node: child, element: Some(element), ordinal: None });
                            id
                        }
                    });
                }
                window.request_layout(Style::clone(&style), ids, cx)
            })
        });
        target.layout_id.set(Some(layout_id));
        layout_id
    }

    /// The host's id is on the element id stack while its node is prepainted, as `Element::id` of a `Div` puts it there,
    /// since the hitbox is named by it and the dispatcher maps a hit to a host by it. The root's is pushed by gpui.
    fn prepaint_node(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        if node == self.root {
            self.prepaint_host(node, window, cx);
        } else {
            let id = crate::events::ids::host_element_id(self.arena.nodes[node].id);
            window.with_id(id, |window| self.prepaint_host(node, window, cx));
        }
    }

    fn prepaint_host(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let arena = self.arena;
        let target = &arena.nodes[node];
        let layout_id = target.layout_id.get().expect("a node is requested before it is prepainted");
        let bounds = window.layout_bounds(layout_id);
        target.bounds.set(bounds);
        sample_layout(target, layout_id, bounds, window);
        let style = target.style.clone();
        let rem_size = window.rem_size();
        let behavior = if target.passes_pointer { HitboxBehavior::PassThrough } else { HitboxBehavior::Normal };
        window.with_text_style(style.text_style().cloned(), |window| {
            window.with_exact_hit_mask(style.overflow_mask(bounds, rem_size), |window| {
                let escapes_before = window.escapes_prepainted();
                // `Interactivity::should_insert_hitbox` for a host that is not a text node, which `always_hitbox` makes of
                // every one, and has nothing of the rest that asks for one (listener, focus, scroll, group, clip path).
                let hitbox = (behavior != HitboxBehavior::Normal || window.dom_hit_testing() || style.mouse_cursor.is_some())
                    .then(|| window.insert_hitbox_shaped(bounds, behavior, border_box_radii(&style, bounds, rem_size), None));
                match hitbox.as_ref() {
                    Some(parent) => window.with_hitbox_parent(parent, |window| self.prepaint_in_frame(node, window, cx)),
                    None => self.prepaint_in_frame(node, window, cx),
                }
                target.escape_inside.set(window.escapes_prepainted() != escapes_before);
                *target.hitbox.borrow_mut() = hitbox;
            })
        });
    }

    /// The children of a positioned box (or of one that contains fixed boxes) are prepainted in a frame
    /// that an absolute descendant is placed by.
    fn prepaint_in_frame(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        match self.arena.nodes[node].placement.frame {
            Some(contains_fixed) => window.with_frame(contains_fixed, |window| self.prepaint_children(node, window, cx)),
            None => self.prepaint_children(node, window, cx),
        }
    }

    fn prepaint_children(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let arena = self.arena;
        let lifting = window.lifting();
        for child in &arena.nodes[node].children {
            match *child {
                Child::Node(child) => self.prepaint_node(child, window, cx),
                Child::Content(content) => prepaint_content(&arena.contents[content], window, cx),
                Child::Positioned(child) => self.prepaint_positioned(child, lifting, window, cx),
            }
        }
    }

    /// `prepaint_child` of a `Div`: a positioned child that the stacking context takes is lifted out of the children,
    /// leaving nothing to paint in its place.
    fn prepaint_positioned(&mut self, node: usize, lifting: bool, window: &mut Window, cx: &mut App) {
        let placement = self.arena.nodes[node].placement;
        let layout_id = self.arena.nodes[node].layout_id.get();
        let lifted = self.lifted_at(node);
        lifted.ordinal = None;
        let element = lifted.element.as_mut().expect("a positioned node is prepainted once");
        let Some(z) = lifting.then_some(placement.lift_z).flatten() else {
            prepaint_unlifted_child(element, layout_id, window, cx);
            return;
        };
        let ticket = window.begin_lift();
        element.prepaint(window, cx);
        let element = lifted.element.take().expect("checked above");
        lifted.ordinal = Some(window.finish_lift(ticket, z, element));
    }

    /// What a `Div` does for a subtree that is culled (`Window::is_culling`): nothing of its own is drawn or
    /// hit, and what is in it is still prepainted, to publish what layout readers see of it.
    fn prepaint_node_culled(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let arena = self.arena;
        let target = &arena.nodes[node];
        let layout_id = target.layout_id.get().expect("a node is requested before it is prepainted");
        let bounds = window.layout_bounds(layout_id);
        target.bounds.set(bounds);
        sample_layout(target, layout_id, bounds, window);
        let mut prepaint_children = |walk: &mut Self, window: &mut Window| {
            for child in &target.children {
                match *child {
                    Child::Node(child) => walk.prepaint_node_culled(child, window, cx),
                    Child::Content(content) => {
                        arena.contents[content].element.borrow_mut().prepaint(window, cx);
                    }
                    Child::Positioned(child) => {
                        walk.lifted_at(child).element.as_mut().expect("a positioned node is prepainted once").prepaint(window, cx);
                    }
                }
            }
        };
        match target.placement.frame {
            Some(contains_fixed) => window.with_frame(contains_fixed, |window| prepaint_children(self, window)),
            None => prepaint_children(self, window),
        }
    }

    fn paint_node_culled(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let arena = self.arena;
        paint_bounds(&arena.nodes[node], window);
        for child in &arena.nodes[node].children {
            match *child {
                Child::Node(child) => self.paint_node_culled(child, window, cx),
                Child::Content(content) => arena.contents[content].element.borrow_mut().paint(window, cx),
                Child::Positioned(child) => self.paint_positioned(child, window, cx),
            }
        }
    }

    fn paint_node(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        self.on_path(node, window, |walk, window| {
            let arena = walk.arena;
            let target = &arena.nodes[node];
            let bounds = target.bounds.get();
            let style = target.style.clone();
            paint_bounds(target, window);
            // Where an active drag of the platform (files from outside) decides the cursor, a `Div` sets none.
            if let (Some(cursor), Some(hitbox), false) = (style.mouse_cursor, target.hitbox.borrow().as_ref(), cx.has_active_drag()) {
                window.set_cursor_style(cursor, hitbox);
            }
            style.paint_box_with_effects(bounds, bounds, window, cx, |window, cx| {
                window.with_text_style(style.text_style().cloned(), |window| {
                    window.with_overflow_clip(style.overflow_mask(bounds, window.rem_size()), target.escape_inside.get(), |window| {
                        for child in &target.children {
                            match *child {
                                Child::Node(child) => walk.paint_node(child, window, cx),
                                Child::Content(content) => arena.contents[content].element.borrow_mut().paint(window, cx),
                                Child::Positioned(child) => walk.paint_positioned(child, window, cx),
                            }
                        }
                    })
                })
            });
        });
    }

    /// A lifted child is painted by the stacking context that took it, and is skipped here (`mark_lifted`).
    fn paint_positioned(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let lifted = self.lifted_at(node);
        match lifted.ordinal {
            Some(ordinal) => window.mark_lifted(ordinal),
            None => lifted.element.as_mut().expect("a positioned node that is not lifted is painted by its parent").paint(window, cx),
        }
    }
}

/// What `Interactivity::run_prepaint_listeners` and the publication of `prepaint_with` do for the layout probe of
/// `HostBoundsProbe`: the box is read where layout left it, and a pass that does not paint reports it from here.
fn sample_layout(node: &Node, layout_id: LayoutId, bounds: Bounds<Pixels>, window: &mut Window) {
    window.note_publication();
    let sample = crate::automation::read_layout(window, layout_id, false);
    node.sample.set(Some(sample));
    crate::automation::publish_host_bounds(node.id, node.bounds_flags, sample, bounds, layout_id, window);
}

fn paint_bounds(node: &Node, window: &mut Window) {
    let layout_id = node.layout_id.get().expect("a node is requested before it is painted");
    let sample = node.sample.get().expect("a node is prepainted before it is painted");
    window.note_publication();
    crate::automation::paint_host_bounds(node.id, node.bounds_flags, sample, node.bounds.get(), layout_id, window);
}

fn prepaint_content(content: &Content, window: &mut Window, cx: &mut App) {
    prepaint_unlifted_child(&mut content.element.borrow_mut(), content.layout_id.get(), window, cx);
}

/// `prepaint_unlifted_child` of a `Div`: a child that is not handed to a stacking context is prepainted as the
/// top of a culled subtree when it lies outside the content mask for good. A child that escapes the clip of its
/// ancestors, or is lifted, is placed by something else than its parent's box.
fn prepaint_unlifted_child(child: &mut AnyElement, layout_id: Option<LayoutId>, window: &mut Window, cx: &mut App) {
    if let (Some(outset), Some(layout_id)) = (child.cull_outset(), layout_id) {
        if !window.is_culling() && child.escapes_to().is_none() && child.lift_z().is_none() {
            let bounds = window.layout_bounds(layout_id);
            if window.lies_outside_the_mask(layout_id, bounds, outset) {
                child.prepaint_culled(window, cx);
                return;
            }
        }
    }
    child.prepaint(window, cx);
}

/// `Style::border_box_radii`, which gpui keeps to itself: the corners of the border box, fitted to it.
fn border_box_radii(style: &Style, bounds: Bounds<Pixels>, rem_size: Pixels) -> CornerRadii<Pixels> {
    let radius = |corner: &CornerRadius| corner.to_pixels(bounds.size, rem_size);
    let top_left = radius(&style.corner_radii.top_left);
    let top_right = radius(&style.corner_radii.top_right);
    let bottom_right = radius(&style.corner_radii.bottom_right);
    let bottom_left = radius(&style.corner_radii.bottom_left);
    CornerRadii::new(
        Corners {
            top_left: top_left.width,
            top_right: top_right.width,
            bottom_right: bottom_right.width,
            bottom_left: bottom_left.width,
        },
        Corners {
            top_left: top_left.height,
            top_right: top_right.height,
            bottom_right: bottom_right.height,
            bottom_left: bottom_left.height,
        },
        bounds.size,
    )
}

impl IntoElement for DirectRoot {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for DirectRoot {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn cull_outset(&self) -> Option<Edges<Pixels>> {
        // As for a `Div`: a box placed by its containing block is not outside the clip of its parent.
        self.cull_outset.filter(|_| self.arena.nodes[self.root].placement.escape.is_none())
    }

    fn escapes_to(&self) -> Option<Escape> {
        self.arena.nodes[self.root].placement.escape
    }

    fn lift_z(&self) -> Option<i32> {
        self.arena.nodes[self.root].placement.lift_z
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let root = self.root;
        (self.walk().request_node(root, window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let root = self.root;
        self.walk().prepaint_node(root, window, cx);
    }

    fn prepaint_culled(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let root = self.root;
        self.walk().prepaint_node_culled(root, window, cx);
    }

    fn paint_culled(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let root = self.root;
        self.walk().paint_node_culled(root, window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut (),
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let root = self.root;
        self.walk().paint_node(root, window, cx);
    }
}
