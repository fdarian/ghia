//! A hover whose colours are `var()` references (Tailwind v4: `.hover\:bg-blue-500:hover { background-color:
//! var(--color-blue-500) }`).
//!
//! The style holds such a declaration as text until the element is built, against the custom properties it
//! computes to (`css/var_substitution.rs`). A hover is paint only when the colours it gives resolve to a pair that
//! passes the rules of a literal pair (`hover_paint::differs_by_paint_only`: a colour that turns transparent adds or
//! takes away an operation), so the check resolves both sides against the custom properties of the element, which
//! are worked out here from the elements above it: a walk of the ancestors, not of the subtree.
//!
//! The custom properties are the ones the elements declare. An element on the path that declares one in a state or an
//! `@container` block may be in that state, which the tree does not say, so the answer is "not known" and the hover is
//! built whole. The refinement of the hover itself sets none: a `--x` there is not paint only
//! (`hover_paint::differs_by_paint_only` compares it), so both sides resolve against the same set.

use crate::css::custom_properties::CustomProperties;
use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;

/// What element `id` computes its custom properties to, or `None` when an element on the path from the root declares
/// one under a state or an `@container` block.
pub(crate) fn custom_properties_of(tree: &RetainedTree, id: u64) -> Option<CustomProperties> {
    let mut path = Vec::new();
    let mut current = Some(id);
    while let Some(id) = current {
        let element = tree.elements.get(&id)?;
        path.push(element);
        current = element.parent;
    }
    let mut custom = CustomProperties::with_registered(tree.sheets.registered.clone());
    for element in path.into_iter().rev() {
        let Some(style) = element.style.as_deref() else {
            custom = custom.inherit();
            continue;
        };
        if declares_under_a_condition(style) {
            return None;
        }
        custom = match style.custom_properties.as_ref() {
            Some(declared) => custom.descend(declared),
            None => custom.inherit(),
        };
    }
    Some(custom)
}

fn declares_under_a_condition(style: &StyleDesc) -> bool {
    style.container_rules.is_some()
        || crate::css::var_substitution::state_blocks(style)
            .into_iter()
            .any(|(_, state)| state.is_some_and(|state| state.custom_properties.is_some()))
}
