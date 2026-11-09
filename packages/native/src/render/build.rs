//! The build of a direct root: what `build_element_unpumped`, `build_plan` and `build_host_container`
//! do for a plain host, in the same order, with the result in an [`Arena`] and no `Div`.
//!
//! The root's own entry in `build_element_unpumped` (its pointer states, motion, resolved record,
//! retain facts) has run already; the nodes below it have no entry anywhere else, so what an entry
//! of theirs would have recorded is recorded here ([`build_node`]), or is nothing for a node that
//! [`super::eligible`] let through.

use gpui::{AnyElement, IntoElement, Refineable, Style, StyleRefinement, Styled};

use super::element::DirectRoot;
use super::node::{Arena, Child};
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
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<GpuixView>,
) -> AnyElement {
    let mut arena = Arena::default();
    ctx.retain.shape(SHAPE);
    note_plain(element.id, ctx);
    let root_style = resolve_style(element, style, ctx);
    let children = build_children(element, ctx, window, cx, &mut arena);
    ctx.subtree = Subtree::of_element(ctx.subtree, style, &ctx.inherited.colors, &ctx.inherited.lengths);
    let cull_outset = ctx.subtree.outset();
    let root = arena.push_node(
        element.id,
        root_style,
        children,
        ctx.inherited.pointer_events_none,
        crate::automation::host_bounds_flags(crate::renderer::selection_start_flag(style)),
    );
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
    let node_style = resolve_style(element, style, ctx);
    let children = build_children(element, ctx, window, cx, arena);
    ctx.subtree = Subtree::of_element(ctx.subtree, style, &ctx.inherited.colors, &ctx.inherited.lengths);
    ctx.retain.direct_descendant(id);
    let pointer_events_none = ctx.inherited.pointer_events_none;
    ctx.inherited = parent_inherited;
    let below = std::mem::replace(&mut ctx.subtree, enclosing);
    ctx.subtree.merge(below);
    arena.push_node(
        id,
        node_style,
        children,
        pointer_events_none,
        crate::automation::host_bounds_flags(crate::renderer::selection_start_flag(style)),
    )
}

/// What `build_host_container` tells the registries about a host that has no scroller, no
/// `content-visibility` and no focus handle, which is every host a direct root holds.
fn note_plain(id: u64, ctx: &mut BuildCtx) {
    ctx.tree.relevance.built(id, false, false, false);
    ctx.retain.show_content(id);
    crate::scroll::not_a_scroller(id, ctx.scroll_handles);
}

/// The style of a host as `compute_style_internal` makes it from the `Div` that `build_host_container`
/// makes, which has only its base style set: `Style::default()` refined by what the build applied.
fn resolve_style(element: &RetainedElement, style: Option<&StyleDesc>, ctx: &BuildCtx) -> Style {
    let mut refinement = StyleRefinement::default();
    if let Some(style) = style {
        refinement = crate::css::style_cache::apply(
            refinement,
            element.style.as_ref(),
            style,
            &ctx.inherited.colors,
            &ctx.inherited.lengths,
        );
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
    let mut resolved = Style::default();
    resolved.refine(&refinement);
    resolved
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
                children.push(Child::Node(node));
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
