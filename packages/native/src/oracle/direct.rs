//! A message row as ONE gpui element: the Div-less variant of the row-cost oracle.
//!
//! [`DirectRow`] lays out and paints the same 9 divs (10 unread) and 5 texts as `RawRows::render_row`
//! from a template of [`Node`]s, with no `Div` per node: `request_layout` calls `Window::request_layout`
//! once per node (post-order, so a node's children ids are at hand), the texts are child elements
//! (`SharedString`, requested inside it), `prepaint` reads `Window::layout_bounds` per node and inserts
//! one hitbox per node, and `paint` calls `Style::paint_box_with_effects` per node. It prices a
//! render layer that owns its nodes; it is not a replacement for anything.
//!
//! What it leaves out, against the Div row: dispatch nodes and element ids of the sub-nodes, the
//! click listener, a11y, tab stops, focus, scroll, sticky, culling, `escapes_to`, the transform
//! space, and the exact hit mask of an overflow clip (a plain content mask is pushed instead).

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, App, Bounds, ContentMask, CornerRadii, CornerRadius, Corners, DispatchPhase, Element, ElementId,
    GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId, MouseMoveEvent, Overflow,
    Pixels, Refineable, SharedString, Style, StyleRefinement, Window,
};

use crate::automation::{LaidOut, note_host_node, record_bounds};

/// What a [`DirectRow`] adds beyond layout and paint, to price each part alone.
#[derive(Clone, Copy, Debug, Default)]
pub struct DirectKnobs {
    /// A hitbox per node (Ghia's host hitbox), where off only the row keeps one, for its hover.
    pub hitboxes: bool,
    /// A bounds write per node, as `track_host_bounds` makes: the layout box read in prepaint,
    /// `note_host_node` and `record_bounds` in paint.
    pub bounds: bool,
    /// The style of each node is resolved from its `StyleRefinement` in every frame, where off the
    /// template holds the resolved `Style` and a frame clones it.
    pub style_each_frame: bool,
}

pub enum Child {
    Node(usize),
    Text(usize),
}

pub struct Node {
    /// The style as the Div oracle's `compute_style_internal` makes it: `Style::default()` refined
    /// by the base style of the div.
    pub refinement: StyleRefinement,
    pub style: Style,
    pub children: Vec<Child>,
}

pub struct RowTemplate {
    pub nodes: Vec<Node>,
    /// The hover look of the row (node 0) when it is not selected.
    pub hover_root: Option<Style>,
    pub position: usize,
}

impl RowTemplate {
    pub fn style_of(refinement: &StyleRefinement) -> Style {
        let mut style = Style::default();
        style.refine(refinement);
        style
    }
}

pub struct DirectRow {
    template: Rc<RowTemplate>,
    texts: Vec<AnyElement>,
    knobs: DirectKnobs,
}

impl DirectRow {
    pub fn new(template: Rc<RowTemplate>, texts: impl IntoIterator<Item = SharedString>, knobs: DirectKnobs) -> Self {
        DirectRow { template, texts: texts.into_iter().map(IntoElement::into_any_element).collect(), knobs }
    }
}

/// A row has at most 10 nodes (9 divs and the unread dot).
const NODES: usize = 10;
/// The most children a node has: the row itself (dot, avatar, info, border).
const CHILDREN: usize = 4;

pub struct LayoutState {
    ids: [Option<LayoutId>; NODES],
    /// Only with `style_each_frame`.
    styles: [Option<Style>; NODES],
}

pub struct PrepaintState {
    bounds: [Bounds<Pixels>; NODES],
    hitboxes: [Option<Hitbox>; NODES],
    laid_out: [Option<LaidOut>; NODES],
}

fn node_element_id(node: usize) -> ElementId {
    ElementId::NamedInteger(SharedString::new_static("node"), node as u64)
}

/// `Style::border_box_radii`, which is `pub(crate)` in gpui.
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

/// The style a node paints and hit tests with; borrows the template or the layout state and never the
/// element, which the children are visited with.
fn node_style<'a>(template: &'a RowTemplate, each_frame: bool, layout: &'a LayoutState, node: usize) -> &'a Style {
    if each_frame {
        layout.styles[node].as_ref().expect("a node is requested before it is prepainted")
    } else {
        &template.nodes[node].style
    }
}

fn overflow_mask(style: &Style, bounds: Bounds<Pixels>, rem_size: Pixels) -> Option<ContentMask<Pixels>> {
    if style.overflow.x == Overflow::Visible && style.overflow.y == Overflow::Visible {
        return None;
    }
    style.overflow_mask(bounds, rem_size)
}

impl DirectRow {
    fn request_node(&mut self, node: usize, state: &mut LayoutState, window: &mut Window, cx: &mut App) {
        let template = self.template.clone();
        let description = &template.nodes[node];
        let style = if self.knobs.style_each_frame {
            RowTemplate::style_of(&description.refinement)
        } else {
            description.style.clone()
        };
        let text_style = style.text_style().cloned();
        let keep = self.knobs.style_each_frame;
        let (id, kept) = window.with_text_style(text_style, |window| {
            let mut children = [None; CHILDREN];
            for (slot, child) in children.iter_mut().zip(&description.children) {
                *slot = Some(match child {
                    Child::Node(child) => {
                        self.request_node(*child, state, window, cx);
                        state.ids[*child].expect("a child is requested before its parent")
                    }
                    Child::Text(text) => self.texts[*text].request_layout(window, cx),
                });
            }
            let children = children.into_iter().flatten();
            if keep {
                (window.request_layout(style.clone(), children, cx), Some(style))
            } else {
                (window.request_layout(style, children, cx), None)
            }
        });
        state.ids[node] = Some(id);
        state.styles[node] = kept;
    }

    fn prepaint_node(
        &mut self,
        node: usize,
        layout: &LayoutState,
        prepaint: &mut PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let template = self.template.clone();
        let layout_id = layout.ids[node].expect("a node is requested before it is prepainted");
        let bounds = window.layout_bounds(layout_id);
        prepaint.bounds[node] = bounds;
        if self.knobs.bounds {
            let border_box = window.layout_unsnapped_bounds(layout_id);
            prepaint.laid_out[node] = Some(LaidOut {
                border_box,
                content: border_box.size,
                scale: window.scale_factor(),
                collapsed_table: false,
                culled: window.is_culling(),
                to_window: window.layout_to_window(layout_id, border_box),
                faces_away: window.layout_faces_away(layout_id, border_box),
            });
        }
        let style = node_style(&template, self.knobs.style_each_frame, layout, node);
        let rem_size = window.rem_size();
        let mask = overflow_mask(style, bounds, rem_size);
        let wants_hitbox = self.knobs.hitboxes || node == 0;
        window.with_text_style(style.text_style().cloned(), |window| {
            window.with_content_mask(mask, |window| {
                let hitbox = wants_hitbox.then(|| {
                    window.with_id(node_element_id(node), |window| {
                        window.insert_hitbox_shaped(
                            bounds,
                            HitboxBehavior::Normal,
                            border_box_radii(style, bounds, rem_size),
                            None,
                        )
                    })
                });
                let mut prepaint_children = |window: &mut Window| {
                    for child in &template.nodes[node].children {
                        match child {
                            Child::Node(child) => self.prepaint_node(*child, layout, prepaint, window, cx),
                            Child::Text(text) => {
                                self.texts[*text].prepaint(window, cx);
                            }
                        }
                    }
                };
                match hitbox.as_ref() {
                    Some(parent) => window.with_hitbox_parent(parent, prepaint_children),
                    None => prepaint_children(window),
                }
                prepaint.hitboxes[node] = hitbox;
            })
        });
    }

    fn paint_node(
        &mut self,
        node: usize,
        layout: &LayoutState,
        prepaint: &PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let template = self.template.clone();
        let bounds = prepaint.bounds[node];
        if let Some(laid_out) = prepaint.laid_out[node] {
            let layout_id = layout.ids[node].expect("a node is requested before it is painted");
            let insets = window.layout_insets(layout_id);
            let window_id = window.window_handle().window_id();
            let id = (1 << 40) + ((template.position as u64) << 4) + node as u64;
            note_host_node(window, id, layout_id);
            record_bounds(window_id, id, laid_out, bounds.origin, insets);
        }
        let hovered = node == 0 && prepaint.hitboxes[0].as_ref().is_some_and(|hitbox| hitbox.is_hovered(window));
        let style = match (&template.hover_root, hovered) {
            (Some(hover), true) => hover,
            _ => node_style(&template, self.knobs.style_each_frame, layout, node),
        };
        let mask = overflow_mask(style, bounds, window.rem_size());
        style.paint_box_with_effects(bounds, bounds, window, cx, |window, cx| {
            window.with_text_style(style.text_style().cloned(), |window| {
                window.with_content_mask(mask, |window| {
                    for child in &template.nodes[node].children {
                        match child {
                            Child::Node(child) => self.paint_node(*child, layout, prepaint, window, cx),
                            Child::Text(text) => self.texts[*text].paint(window, cx),
                        }
                    }
                })
            })
        });
    }
}

impl IntoElement for DirectRow {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for DirectRow {
    // Boxed: gpui moves the state of an element out of its draw phase and back in at every phase, and an
    // array of ten `Style`s or `Hitbox`es is kilobytes of memmove each time.
    type RequestLayoutState = Box<LayoutState>;
    type PrepaintState = Box<PrepaintState>;

    fn id(&self) -> Option<ElementId> {
        Some(ElementId::Integer(self.template.position as u64))
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Box<LayoutState>) {
        let mut state = Box::new(LayoutState { ids: [None; NODES], styles: [const { None }; NODES] });
        self.request_node(0, &mut state, window, cx);
        (state.ids[0].expect("the row is requested"), state)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        layout: &mut Box<LayoutState>,
        window: &mut Window,
        cx: &mut App,
    ) -> Box<PrepaintState> {
        let mut prepaint = Box::new(PrepaintState {
            bounds: [Bounds::default(); NODES],
            hitboxes: [const { None }; NODES],
            laid_out: [None; NODES],
        });
        self.prepaint_node(0, layout, &mut prepaint, window, cx);
        prepaint
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        layout: &mut Box<LayoutState>,
        prepaint: &mut Box<PrepaintState>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let row_id = id.expect("a direct row has an id");
        // The hover memo and the move listener of a Div with `.hover()`: the view is notified when
        // the pointer enters or leaves the row, so that the next build picks the other look.
        if let Some(hitbox) = prepaint.hitboxes[0].clone() {
            let hovered = window.with_element_state::<Rc<Cell<bool>>, _>(row_id, |state, _| {
                let state = state.unwrap_or_default();
                (state.clone(), state)
            });
            let view = window.current_view();
            window.on_mouse_event(move |_: &MouseMoveEvent, phase, window, cx| {
                let now = hitbox.is_hovered(window);
                if phase == DispatchPhase::Capture && now != hovered.get() {
                    hovered.set(now);
                    cx.notify(view);
                }
            });
        }
        self.paint_node(0, layout, prepaint, window, cx);
    }
}
