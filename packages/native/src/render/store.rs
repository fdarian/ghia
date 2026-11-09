//! What a node of a direct root keeps from one frame to the next, in the tree of its window.
//!
//! The style of a node is made from the declared style of its element and from what the node
//! inherits, and an element whose style is the same `Arc` under the same inheritance resolves to the
//! same gpui [`Style`]. The store keeps the result by host id, so a frame that builds the node again
//! (a commit that touched a sibling, the next frame of a root that is built whole) takes the `Rc` that
//! the arena holds and does not resolve it. The style cache (`css::style_cache`) already keeps the
//! step that is the most of the resolve, by style and not by node; what the store saves is the rest:
//! the refinement laid over the defaults, the font features and the direction, the placement, and the
//! `Style` that is put into the arena.
//!
//! The key is everything the resolve reads: the style (by identity, which the entry keeps alive so that
//! the address cannot be given to another), the colour and length contexts, the font features and
//! variations and the direction the node inherits, and for the root of a list row whether it lifts.
//! An entry goes when its element is destroyed (`RetainedTree::destroy_element_recursive`).

use std::rc::Rc;
use std::sync::Arc;

use gpui::Style;
use rustc_hash::FxHashMap;

use super::node::Placement;
use crate::color::{ColorContext, ColorReads};
use crate::css::length::LengthContext;
use crate::renderer::BuildCtx;
use crate::retained_tree::{RetainedElement, RetainedTree};
use crate::style::StyleDesc;
use crate::text::inline::Child;
use crate::text::white_space::WhiteSpace;

/// Whether nodes keep their styles: with the style cache, whose switch it follows.
pub(super) fn enabled() -> bool {
    crate::css::style_cache::mode() != crate::css::style_cache::Mode::Off
}

/// What the resolve of a node's style reads besides the style.
#[derive(Clone, PartialEq)]
pub(super) struct Inputs {
    colors: ColorContext,
    lengths: LengthContext,
    direction: crate::css::direction::Inherited,
    font_features: Option<gpui::FontFeatures>,
    font_variations: Option<gpui::FontVariations>,
    lift_absorbed: bool,
}

impl Inputs {
    pub(super) fn of(ctx: &BuildCtx, lift_absorbed: bool) -> Self {
        Self {
            colors: ctx.inherited.colors,
            lengths: ctx.inherited.lengths,
            direction: ctx.inherited.direction,
            font_features: ctx.inherited.font_features.clone(),
            font_variations: ctx.inherited.font_variations.clone(),
            lift_absorbed,
        }
    }
}

pub(super) struct Kept {
    style: Arc<StyleDesc>,
    inputs: Inputs,
    /// What the resolve read of the colour the node inherits, which taking the style says again.
    pub(super) reads: ColorReads,
    pub(super) resolved: Rc<Style>,
    /// Without `Placement::context`, which only the root has and the build sets.
    pub(super) placement: Placement,
}

/// How a node's children are laid into paragraphs and blocks ([`plan_children_at`]), which reads the subtree of the node and
/// the `white-space` it inherits, and nothing else: the plan of a node whose subtree has the revision it had, under the same
/// `white-space`, is the plan it had.
struct KeptPlan {
    revision: u64,
    white_space: WhiteSpace,
    plan: Rc<Vec<(Child, u32)>>,
}

#[derive(Default)]
pub(crate) struct Store {
    kept: FxHashMap<u64, Kept>,
    plans: FxHashMap<u64, KeptPlan>,
}

impl Store {
    pub(super) fn find(&self, id: u64, style: &Arc<StyleDesc>, inputs: &Inputs) -> Option<&Kept> {
        self.kept.get(&id).filter(|kept| Arc::ptr_eq(&kept.style, style) && kept.inputs == *inputs)
    }

    pub(super) fn keep(
        &mut self,
        id: u64,
        style: &Arc<StyleDesc>,
        inputs: Inputs,
        reads: ColorReads,
        resolved: Rc<Style>,
        placement: Placement,
    ) {
        self.kept.insert(id, Kept { style: Arc::clone(style), inputs, reads, resolved, placement });
    }

    pub(crate) fn forget(&mut self, id: u64) {
        self.kept.remove(&id);
        self.plans.remove(&id);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.kept.len()
    }
}

/// `plan_children_at(tree, element)`, kept while the subtree of `element` and the `white-space` it inherits (`white_space`: the
/// element's own computed one) are what they were.
pub(super) fn plan_children(tree: &RetainedTree, element: &RetainedElement, white_space: WhiteSpace) -> Rc<Vec<(Child, u32)>> {
    if !enabled() {
        return Rc::new(crate::text::inline::plan_children_at(tree, element));
    }
    let kept = tree
        .direct
        .borrow()
        .plans
        .get(&element.id)
        .filter(|kept| kept.revision == element.subtree_revision && kept.white_space == white_space)
        .map(|kept| Rc::clone(&kept.plan));
    if let Some(plan) = kept {
        if crate::css::style_cache::mode() == crate::css::style_cache::Mode::Verify {
            let fresh = crate::text::inline::plan_children_at(tree, element);
            assert!(
                *plan == fresh,
                "the node {} kept a plan that is made differently now\n kept {plan:?}\n now  {fresh:?}",
                element.id,
            );
        }
        return plan;
    }
    let plan = Rc::new(crate::text::inline::plan_children_at(tree, element));
    tree.direct.borrow_mut().plans.insert(
        element.id,
        KeptPlan { revision: element.subtree_revision, white_space, plan: Rc::clone(&plan) },
    );
    plan
}
