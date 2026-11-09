//! The gpui element of a direct root. It makes the calls a `Div` makes for each node, in the order it
//! makes them, around a node's children: the text style, the clip, the box of the node.
//!
//! What a `Div` does that this does not, and why that is no difference for a plain node (see
//! [`super::eligible`]): a hitbox, element state and layout probe per node (only the root has a
//! hitbox, below it the pointer is over the root), the listeners, focus, tab stops, scroll offset,
//! sticky and lifted children, the transform space, `visibility`, and the stacking context.

use gpui::{
    App, Bounds, CornerRadii, CornerRadius, Corners, Edges, Element, ElementId, GlobalElementId,
    HitboxBehavior, InspectorElementId, IntoElement, LayoutId, Pixels, Style, Window,
};

use super::node::{Arena, Child};

pub(super) struct DirectRoot {
    id: ElementId,
    arena: Arena,
    root: usize,
    cull_outset: Option<Edges<Pixels>>,
}

impl DirectRoot {
    pub fn new(id: ElementId, arena: Arena, root: usize, cull_outset: Option<Edges<Pixels>>) -> Self {
        Self { id, arena, root, cull_outset }
    }

    fn request_node(&mut self, node: usize, window: &mut Window, cx: &mut App) -> LayoutId {
        let style = self.arena.nodes[node].style.clone();
        let layout_id = window.with_text_style(style.text_style().cloned(), |window| {
            let count = self.arena.nodes[node].children.len();
            let mut ids = Vec::with_capacity(count);
            for position in 0..count {
                ids.push(match self.arena.nodes[node].children[position] {
                    Child::Node(child) => self.request_node(child, window, cx),
                    Child::Content(content) => {
                        let id = self.arena.contents[content].element.request_layout(window, cx);
                        self.arena.contents[content].layout_id = Some(id);
                        id
                    }
                });
            }
            window.request_layout(Style::clone(&style), ids, cx)
        });
        self.arena.nodes[node].layout_id = Some(layout_id);
        layout_id
    }

    fn prepaint_node(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let layout_id = self.arena.nodes[node].layout_id.expect("a node is requested before it is prepainted");
        let bounds = window.layout_bounds(layout_id);
        self.arena.nodes[node].bounds = bounds;
        let style = self.arena.nodes[node].style.clone();
        let rem_size = window.rem_size();
        let is_root = node == self.root;
        window.with_text_style(style.text_style().cloned(), |window| {
            window.with_exact_hit_mask(style.overflow_mask(bounds, rem_size), |window| {
                let hitbox = (is_root && window.dom_hit_testing()).then(|| {
                    window.insert_hitbox_shaped(
                        bounds,
                        HitboxBehavior::Normal,
                        border_box_radii(&style, bounds, rem_size),
                        None,
                    )
                });
                let mut prepaint_children = |window: &mut Window| {
                    for position in 0..self.arena.nodes[node].children.len() {
                        match self.arena.nodes[node].children[position] {
                            Child::Node(child) => self.prepaint_node(child, window, cx),
                            Child::Content(content) => {
                                self.arena.contents[content].element.prepaint(window, cx);
                            }
                        }
                    }
                };
                match hitbox.as_ref() {
                    Some(parent) => window.with_hitbox_parent(parent, prepaint_children),
                    None => prepaint_children(window),
                }
            })
        });
    }

    fn paint_node(&mut self, node: usize, window: &mut Window, cx: &mut App) {
        let bounds = self.arena.nodes[node].bounds;
        let style = self.arena.nodes[node].style.clone();
        style.paint_box_with_effects(bounds, bounds, window, cx, |window, cx| {
            window.with_text_style(style.text_style().cloned(), |window| {
                window.with_exact_content_mask(style.overflow_mask(bounds, window.rem_size()), |window| {
                    for position in 0..self.arena.nodes[node].children.len() {
                        match self.arena.nodes[node].children[position] {
                            Child::Node(child) => self.paint_node(child, window, cx),
                            Child::Content(content) => self.arena.contents[content].element.paint(window, cx),
                        }
                    }
                })
            })
        });
    }
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
        self.cull_outset
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.request_node(self.root, window, cx), ())
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
        self.prepaint_node(self.root, window, cx);
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
        self.paint_node(self.root, window, cx);
    }
}
