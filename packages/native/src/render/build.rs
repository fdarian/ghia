//! The build of a direct root: what `build_element_unpumped`, `build_plan` and `build_host_container`
//! do for a plain host, in the same order, with the result in an [`Arena`] and no `Div`.
//!
//! The root's own entry in `build_element_unpumped` (its pointer states, motion, resolved record,
//! retain facts) has run already; the nodes below it have no entry anywhere else, so what an entry
//! of theirs would have recorded is recorded here ([`build_node`]), or is nothing for a node that
//! [`super::eligible`] let through.

use gpui::{AnyElement, IntoElement, Refineable, Style, StyleRefinement, Styled};

use super::element::DirectRoot;
use super::node::{Arena, Child, NodeSpec, Placement};
use crate::layout::cull::Subtree;
use crate::renderer::{BuildCtx, GpuixView};
use crate::resolved_style::Resolved;
use crate::retained_tree::RetainedElement;
use crate::style::StyleDesc;
use crate::text::inline::Child as Planned;

/// Marks the key of a root built this way, so that a record of one built as `Div`s is not taken for it.
const SHAPE: u64 = 0xD1EC_7000;

pub(crate) fn build_direct(
    element: &RetainedElement,
    style: Option<&StyleDesc>,
    stacking_root: bool,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
) -> AnyElement {
    let mut arena = Arena::default();
    ctx.retain.shape(SHAPE);
    note_plain(element.id, ctx);
    note_listeners(element, ctx);
    let scroller = enter_scroller(element.id, style, ctx, window);
    let (root_style, mut placement) = resolve_style(element, style, ctx);
    // As `build_host_container` flags the host: the style says so, or it is the root of a list row.
    placement.context = crate::layout::stacking::forms_context(style, stacking_root, &ctx.inherited.colors, &ctx.inherited.lengths);
    let children = build_children(element, ctx, window, cx, &mut arena);
    let scroller = leave_scroller(scroller, ctx);
    ctx.subtree = Subtree::of_element(ctx.subtree, style, &ctx.inherited.colors, &ctx.inherited.lengths);
    let cull_outset = ctx.subtree.outset();
    let root = arena.push_node(NodeSpec {
        id: element.id,
        style: root_style,
        children,
        placement,
        passes_pointer: ctx.inherited.pointer_events_none,
        bounds_flags: bounds_flags(style, &scroller),
        scroller,
    });
    crate::perf_counters::direct_built(arena.nodes.len() as u64);
    DirectRoot::new(crate::events::ids::host_element_id(element.id), arena, root, cull_outset).into_any_element()
}

/// The node `id`, a block child of the node being built, as `build_element_unpumped` builds a host whose
/// style is its declared one and which nothing runs on.
fn build_node(
    id: u64,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
    arena: &mut Arena,
) -> usize {
    // Copied out of `ctx`, so that `element` borrows the tree and not the build context.
    let tree = ctx.tree;
    let element = tree.elements.get(&id).expect("a plan names elements of the tree");
    crate::perf_counters::element_built();
    let enclosing = std::mem::replace(&mut ctx.subtree, Subtree::empty());
    tree.relevance.note_layout_run(id, false);
    let style = element.style.as_deref();
    let descended = ctx.inherited.clone().descend(style, false);
    let parent_inherited = std::mem::replace(&mut ctx.inherited, descended);
    let resolved = Resolved::of(element, style, &ctx.inherited.colors, &ctx.inherited.lengths);
    tree.resolved.borrow_mut().record(id, resolved);
    note_plain(id, ctx);
    let scroller = enter_scroller(id, style, ctx, window);
    let (node_style, placement) = resolve_style(element, style, ctx);
    let children = build_children(element, ctx, window, cx, arena);
    let scroller = leave_scroller(scroller, ctx);
    ctx.subtree = Subtree::of_element(ctx.subtree, style, &ctx.inherited.colors, &ctx.inherited.lengths);
    ctx.retain.direct_descendant(id, placement.lift_z.is_some());
    let pointer_events_none = ctx.inherited.pointer_events_none;
    ctx.inherited = parent_inherited;
    let below = std::mem::replace(&mut ctx.subtree, enclosing);
    ctx.subtree.merge(below);
    arena.push_node(NodeSpec {
        id,
        style: node_style,
        children,
        placement,
        passes_pointer: pointer_events_none,
        bounds_flags: bounds_flags(style, &scroller),
        scroller,
    })
}

/// What `build_host_container` does for the listeners of a host that is not inert and has no focus handle,
/// scroll handle or accessibility node, which is every host a direct root holds: the pointer, wheel and click
/// events are the dispatcher's (`crate::events`), and the window's a11y being off, the click is not wired.
fn note_listeners(element: &RetainedElement, ctx: &mut BuildCtx) {
    ctx.note_host_clip_origin(element);
    ctx.retain.shape(crate::renderer::click_path(ctx.tree, element).len() as u64);
}

/// What `build_host_container` tells the registries about a host that has no scroller the user scrolls, no
/// `content-visibility` and no focus handle, which is every host a direct root holds.
fn note_plain(id: u64, ctx: &mut BuildCtx) {
    ctx.tree.relevance.built(id, false, false, false);
    ctx.retain.show_content(id);
}

/// A scroll container that is being built: its handle, which axes only code scrolls, and the container
/// its parent is in, which `leave_scroller` puts back.
struct EnteredScroller {
    handle: gpui::ScrollHandle,
    programmatic: gpui::Point<bool>,
    outer: Option<crate::retain::Scroller>,
}

/// What `build_host_container` does for a host's scroll handle, which for a direct node is `overflow: hidden`
/// (a scroll container that only code scrolls: [`super::eligible`] has no other): `scroll::apply_container` keeps the
/// handle (the host that is none drops it) and `scroll::note_scroll_container` tells `Retain`. The children are built
/// in the container, and the offset is read by the record of the root, which holds the nodes below it.
fn enter_scroller(
    id: u64,
    style: Option<&StyleDesc>,
    ctx: &mut BuildCtx,
    window: &gpui::Window,
) -> Option<EnteredScroller> {
    let Some(axes) = style.map(crate::scroll::Axes::of).filter(|axes| axes.scrolls()) else {
        crate::scroll::not_a_scroller(id, ctx.scroll_handles);
        return None;
    };
    let style = style.expect("a style that scrolls is declared");
    let handle = crate::scroll::scroller_handle(id, style, ctx.scroll_handles);
    let outer = ctx.scroller;
    crate::scroll::note_scroll_container(&handle, Some(style), ctx, window);
    let hidden = |overflow| overflow == crate::scroll::Overflow::Hidden;
    Some(EnteredScroller { handle, programmatic: gpui::point(hidden(axes.x), hidden(axes.y)), outer })
}

fn leave_scroller(scroller: Option<EnteredScroller>, ctx: &mut BuildCtx) -> Option<(gpui::ScrollHandle, gpui::Point<bool>)> {
    scroller.map(|scroller| {
        ctx.scroller = scroller.outer;
        (scroller.handle, scroller.programmatic)
    })
}

fn bounds_flags(style: Option<&StyleDesc>, scroller: &Option<(gpui::ScrollHandle, gpui::Point<bool>)>) -> u8 {
    crate::automation::host_bounds_flags(crate::renderer::selection_start_flag(style), scroller.is_some())
}

/// The style of a host as `compute_style_internal` makes it from the `Div` that `build_host_container`
/// makes, which has only its base style set: `Style::default()` refined by what the build applied. With how
/// that `Div` is placed: `Element::lift_z` and `Element::escapes_to` read its base style, the refinement.
fn resolve_style(element: &RetainedElement, style: Option<&StyleDesc>, ctx: &BuildCtx) -> (Style, Placement) {
    let mut refinement = StyleRefinement::default();
    if let Some(style) = style {
        refinement = crate::css::style_cache::apply(
            refinement,
            element.style.as_ref(),
            style,
            &ctx.inherited.colors,
            &ctx.inherited.lengths,
        );
        let axes = crate::scroll::Axes::of(style);
        if axes.scrolls() {
            crate::scroll::scroll_container_style(&mut refinement, axes);
        }
        if let Some(features) = ctx.inherited.font_features.clone() {
            refinement = refinement.font_features(features);
        }
        if let Some(variations) = ctx.inherited.font_variations.clone() {
            refinement = refinement.font_variations(variations);
        }
    }
    ctx.inherited.direction.apply(&mut refinement);
    if style.and_then(|style| style.position.as_deref()).is_none() {
        refinement.position = Some(gpui::Position::Static);
    }
    let contains_fixed = refinement.contain_layout.unwrap_or_default() || refinement.contain_positioned.unwrap_or_default();
    let positioned = refinement.position != Some(gpui::Position::Static);
    let placement = Placement {
        lift_z: refinement.lift_z(),
        escape: refinement.escape(),
        frame: (positioned || contains_fixed).then_some(contains_fixed),
        context: false,
    };
    let mut resolved = Style::default();
    resolved.refine(&refinement);
    (resolved, placement)
}

/// What `build_content` builds for the children of `element`, with `ctx.inherited` the element's own.
fn build_children(
    element: &RetainedElement,
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
    arena: &mut Arena,
) -> Vec<Child> {
    let mut children = Vec::new();
    if element.children.is_empty() {
        if let Some(content) = crate::text::search::leaf_text(ctx.tree, element) {
            ctx.retain.text();
            ctx.inherited.colors.note_read();
            ctx.retain.digest(|| content.to_string());
            let text = crate::renderer::text_content(element, &content, Default::default(), ctx);
            children.push(arena.push_content(text));
            ctx.subtree.merge(Subtree::of_text(ctx.inherited.lengths.font_size as f32, ctx.inherited.underline_reach));
        }
        return children;
    }
    for (child, at) in crate::text::inline::plan_children_at(ctx.tree, element) {
        ctx.doc_path.push(at);
        match child {
            Planned::Block(id) => {
                let node = build_node(id, ctx, window, cx, arena);
                children.push(if arena.nodes[node].placement.is_positioned() { Child::Positioned(node) } else { Child::Node(node) });
            }
            Planned::Paragraph(paragraph) => {
                let (content, subtree) = crate::renderer::paragraph_content(&paragraph, Default::default(), ctx, window, cx);
                children.push(arena.push_content(content));
                ctx.subtree.merge(subtree);
            }
            Planned::EmptyLine => children.push(arena.push_content(gpui::div().into_any_element())),
            Planned::AnonymousCell(_) | Planned::AnonymousTable(_) => {
                unreachable!("a subtree with an anonymous table box is not direct")
            }
        }
        ctx.doc_path.pop();
    }
    children
}
