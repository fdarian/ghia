//! Which host subtrees are drawn direct.
//!
//! A root is direct when it and everything it builds is *plain*: a node needs nothing from a `Div`
//! that the arena does not give. It has a hitbox, a cursor, a bounds record and a positioned frame per
//! node, and an element of its own where it is handed to a stacking context, so a node is plain only
//! when none of the rest could show: no listener (but the root's, which the dispatcher runs), prop,
//! focus, scroll, sticky or fixed box, stacking context, pointer state, transition or animation, and
//! nothing the build of a `Div` registers for an accessibility node (the window's a11y being off is
//! checked at the root).
//!
//! A `position: absolute` box is placed by the nearest positioned ancestor, and a recording of a root
//! (`Retain`) can only be kept if that is in it: a node is plain with an absolute box below it only
//! where that has a positioned ancestor at or below the root.
//!
//! What a subtree is does not depend on what is above it, so it is judged once per revision of the
//! element and remembered ([`node_is_plain`]). What the subtree inherits is judged at the root
//! ([`is_direct_root`]): a descendant cannot declare its way out of it.

use std::cell::RefCell;

use rustc_hash::FxHashMap;

use crate::renderer::BuildCtx;
use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::StyleDesc;
use crate::text::inline::{Child, Paragraph};

/// The most nodes remembered; a window's tree is far smaller, so reaching it means ids that nothing
/// uses any more.
const MEMO_LIMIT: usize = 1 << 16;

thread_local! {
    /// `(tree, element)` to the revision of its subtree when it was judged, and the verdicts.
    static MEMO: RefCell<FxHashMap<(u64, u64), (u64, Verdict)>> = RefCell::new(FxHashMap::default());
}

/// Whether a subtree is plain, given where the nearest positioned ancestor is.
#[derive(Clone, Copy)]
struct Verdict {
    /// There is a positioned ancestor, at or below the root, above the subtree.
    positioned_above: bool,
    /// There is none.
    unpositioned_above: bool,
}

impl Verdict {
    fn at(self, positioned_above: bool) -> bool {
        if positioned_above { self.positioned_above } else { self.unpositioned_above }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Root,
    Descendant,
    /// A box inside a paragraph: it is no node of the arena, the paragraph paints what it declares.
    Inline,
}

/// Whether `element`, about to be built as a host with `style` (the one the build resolved: the pointer
/// states folded in), is drawn direct. `forced_context` is whether it is a stacking context whatever
/// its style says (the root of the page or of a list row, or an atomic inline).
pub(crate) fn is_direct_root(
    element: &RetainedElement,
    style: Option<&StyleDesc>,
    forced_context: bool,
    ctx: &BuildCtx,
    window: &gpui::Window,
) -> bool {
    if !super::enabled() || forced_context || window.is_a11y_active() {
        return false;
    }
    // The build around the element hands it nothing that a paragraph or a box inside it would take
    // (the line of an atomic inline, a baseline probe, the cell of its content height).
    let plain_context = ctx.baseline_probe.is_none()
        && ctx.inline_line.is_none()
        && ctx.doc_hosts.is_empty()
        && ctx.containing_heights.is_empty()
        && ctx.atomic_extracted.is_none()
        && !crate::text::atomic::is_collecting()
        && !ctx.text_box_trim.start
        && !ctx.text_box_trim.end;
    let inherited = &ctx.inherited;
    let plain_inheritance = !inherited.inert
        && !inherited.visibility_hidden
        && inherited.highlight.is_none()
        && !inherited.table.collapse
        && !inherited.direction.direction.is_rtl()
        && inherited.app_region.is_none()
        && inherited.self_container.is_none()
        && inherited.custom.is_empty();
    plain_context
        && plain_inheritance
        && !ctx.focus_handles.contains_key(&element.id)
        && own_is_plain(element, style, Kind::Root)
        && children_are_plain(ctx.tree, element, is_positioned(style))
}

/// Whether the box is a containing block for an absolute descendant (`position: static` is not).
fn is_positioned(style: Option<&StyleDesc>) -> bool {
    matches!(style.and_then(|style| style.position.as_deref()), Some("relative" | "absolute"))
}

fn is_absolute(style: Option<&StyleDesc>) -> bool {
    style.and_then(|style| style.position.as_deref()) == Some("absolute")
}

fn node_is_plain(tree: &RetainedTree, element: &RetainedElement, positioned_above: bool) -> bool {
    let key = (tree.id(), element.id);
    let revision = element.subtree_revision;
    let known = MEMO.with_borrow(|memo| memo.get(&key).copied());
    if let Some((_, verdict)) = known.filter(|(judged_at, _)| *judged_at == revision) {
        return verdict.at(positioned_above);
    }
    let style = element.style.as_deref();
    let own = own_is_plain(element, style, Kind::Descendant);
    let verdict = Verdict {
        positioned_above: own && children_are_plain(tree, element, true),
        unpositioned_above: own && !is_absolute(style) && children_are_plain(tree, element, is_positioned(style)),
    };
    MEMO.with_borrow_mut(|memo| {
        if memo.len() >= MEMO_LIMIT {
            memo.clear();
        }
        memo.insert(key, (revision, verdict));
    });
    verdict.at(positioned_above)
}

fn own_is_plain(element: &RetainedElement, style: Option<&StyleDesc>, kind: Kind) -> bool {
    let typed = match kind {
        Kind::Inline => matches!(element.element_type.as_str(), "text" | "span"),
        Kind::Root | Kind::Descendant => matches!(element.element_type.as_str(), "div" | "text") && !crate::renderer::is_text_node(element),
    };
    typed
        && element.custom_props().is_empty()
        && (kind == Kind::Root || element.events().is_empty())
        && !element.auto_focus
        && style.is_none_or(|style| style_is_plain(style, kind))
}

/// `positioned`: an absolute box below is placed by a box at or below the root.
fn children_are_plain(tree: &RetainedTree, element: &RetainedElement, positioned: bool) -> bool {
    if element.children.is_empty() {
        return true;
    }
    crate::text::inline::plan_children_at(tree, element).into_iter().all(|(child, _)| match child {
        Child::Block(id) => tree.elements.get(&id).is_some_and(|child| node_is_plain(tree, child, positioned)),
        Child::Paragraph(paragraph) => paragraph_is_plain(tree, &paragraph),
        Child::EmptyLine => true,
        Child::AnonymousCell(_) | Child::AnonymousTable(_) => false,
    })
}

fn paragraph_is_plain(tree: &RetainedTree, paragraph: &Paragraph) -> bool {
    paragraph.atomics().next().is_none()
        && paragraph
            .pieces
            .iter()
            .flat_map(|piece| piece.boxes.iter())
            .all(|id| tree.elements.get(id).is_some_and(|element| own_is_plain(element, element.style.as_deref(), Kind::Inline)))
}

/// Whether the style asks for nothing that a node of the arena does not do. A root may carry pointer
/// states (the build folds them in, and the root has the hitbox that tells them); no node below it may.
fn style_is_plain(style: &StyleDesc, kind: Kind) -> bool {
    let display = match kind {
        Kind::Inline => matches!(style.display.as_deref(), None | Some("inline")),
        Kind::Root | Kind::Descendant => matches!(style.display.as_deref(), None | Some("block" | "flex" | "grid")),
    };
    let pointer_states = [
        &style.hover,
        &style.active,
        &style.group_hover,
        &style.group_active,
        &style.has_hover,
        &style.has_active,
    ]
    .into_iter()
    .all(|state| state.is_none());
    let focus_states = [
        &style.focus_visible,
        &style.focus_within,
        &style.group_focus_within,
        &style.has_focus,
        &style.has_focus_visible,
        &style.disabled,
        &style.enabled,
        &style.has_disabled,
        &style.has_enabled,
    ]
    .into_iter()
    .all(|state| state.is_none());
    let transitions = style.transition.is_none()
        && style.transition_property.is_none()
        && style.transition_duration.is_none()
        && style.transition_timing_function.is_none()
        && style.transition_delay.is_none()
        && style.transition_behavior.is_none()
        && style.animation.is_none()
        && style.animation_name.is_none()
        && style.animation_duration.is_none()
        && style.animation_timing_function.is_none()
        && style.animation_delay.is_none()
        && style.animation_iteration_count.is_none()
        && style.animation_direction.is_none()
        && style.animation_fill_mode.is_none()
        && style.animation_play_state.is_none();
    let effects = style.opacity.is_none()
        && style.filter.is_none()
        && style.backdrop_filter.is_none()
        && style.mask_image.is_none()
        && style.mask.is_none()
        && style.mask_border_source.is_none()
        && style.mask_border.is_none()
        && style.clip_path.is_none();
    let transforms = style.transform.is_none()
        && style.translate.is_none()
        && style.rotate.is_none()
        && style.scale.is_none()
        && style.perspective.is_none()
        && style.transform_style.is_none()
        && style.backface_visibility.is_none()
        && style.x.is_none()
        && style.y.is_none()
        && style.z.is_none()
        && style.translate_x.is_none()
        && style.translate_y.is_none()
        && style.translate_z.is_none()
        && style.transform_perspective.is_none()
        && style.motion_scale.is_none()
        && style.scale_x.is_none()
        && style.scale_y.is_none()
        && style.scale_z.is_none()
        && style.motion_rotate.is_none()
        && style.rotate_x.is_none()
        && style.rotate_y.is_none()
        && style.rotate_z.is_none()
        && style.skew.is_none()
        && style.skew_x.is_none()
        && style.skew_y.is_none()
        && style.motion_transform.is_none()
        && !style.animating_transform
        && !style.transform_in_motion;
    let containment = style.container_type.is_none()
        && style.container_name.is_none()
        && style.container.is_none()
        && style.container_rules.is_none()
        && style.content_visibility.is_none()
        && style.contain_intrinsic_size.is_none()
        && style.contain_intrinsic_width.is_none()
        && style.contain_intrinsic_height.is_none()
        && style.contain_intrinsic_inline_size.is_none()
        && style.contain_intrinsic_block_size.is_none()
        && style.container_unit_axes == crate::css::container_query::Axes::NONE;
    let text = style.text_decoration.is_none()
        && style.text_decoration_line.is_none()
        && style.text_decoration_style.is_none()
        && style.text_decoration_color.is_none()
        && style.text_decoration_thickness.is_none()
        && style.text_underline_offset.is_none()
        && style.text_box.is_none()
        && style.text_box_trim.is_none()
        && style.text_box_edge.is_none();
    display
        && match kind {
            Kind::Root => focus_states,
            Kind::Descendant | Kind::Inline => pointer_states && focus_states && style.group.is_none(),
        }
        && style.keyboard_focus_dim.is_none()
        && style.visibility.is_none()
        && style.z_index.is_none()
        && match kind {
            // A box inside a paragraph is painted by it, in its place.
            Kind::Inline => matches!(style.position.as_deref(), None | Some("static")),
            Kind::Root | Kind::Descendant => matches!(style.position.as_deref(), None | Some("static" | "relative" | "absolute")),
        }
        && style.app_region.is_none()
        && transitions
        && effects
        && transforms
        && containment
        && text
        && style.custom_properties.is_none()
        && style.contents_levels.is_none()
        && style.direction.is_none_or(|direction| !direction.is_rtl())
        && style.border_collapse.is_none()
        && !crate::scroll::Axes::of(style).scrolls()
        && !style.lays_out_unstably()
        && !style.atomic_inline
        && !style.animating_opacity
        && !style.lift_absorbed
}
