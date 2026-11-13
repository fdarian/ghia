//! A sheet change that matches again only the elements it can reach.
//!
//! A load numbers the rules of every sheet in cascade order, so inserting a rule renumbers every
//! rule after it, and a [`MatchedRules`] list is made of those numbers. Matching every element
//! again is what a change cost for that reason alone. But the loads are made of top-level rules
//! that are the same allocations when their text is (`parse_cache.rs`), so the rules of two loads
//! tell what changed: the rules they share at the start and at the end keep their selectors, and
//! only the ones in between are removed or added, which is one region.
//!
//! * An element that matched a removed rule has to be matched again.
//! * An element that an added rule can match carries a feature its subject compound requires (an
//!   id, a class, an attribute, a tag), so the elements that have one are matched again, found by
//!   looking at them and not by matching.
//! * Every other element keeps its match. Its list is renumbered, and its cascaded style, which
//!   the same declarations in the same order still make, is kept.
//!
//! Anything this cannot tell is a full reload (`RetainedTree::reload_sheets` matches everything): a
//! source parsed whole, a layer that moved, an added rule with no feature to look for.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::{Atom, Atoms};
use super::index::{IndexedRule, RuleIndex};
use super::invalidation::Reach;
use super::parse_cache::ParsedRule;
use super::selector::{AttrName, Simple, TypeName};
use super::tree::{class_atoms, id_atom};

#[cfg(test)]
thread_local! {
    /// Reloads that took the scoped path, which the tests read to tell it from a full one.
    pub(super) static SCOPED_RELOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn count_scoped() {
    #[cfg(test)]
    SCOPED_RELOADS.with(|count| count.set(count.get() + 1));
}

/// What changed between two loads of the same document.
pub(super) struct Reload {
    /// The rules numbered below this keep their number.
    prefix: u32,
    /// The old rules from `prefix` to here are gone, and the ones from here on are numbered from `new_suffix`.
    old_suffix: u32,
    /// The new rules from `prefix` to here are added.
    new_suffix: u32,
    features: Features,
}

impl Reload {
    /// `None` when the change cannot be told apart from a rule that moved a layer, or the added
    /// rules cannot be found by a feature of their subject.
    pub(super) fn between(
        old: &[Arc<ParsedRule>],
        new: &[Arc<ParsedRule>],
        old_index: &RuleIndex,
        new_index: &RuleIndex,
    ) -> Option<Reload> {
        let prefix_units = old.iter().zip(new).take_while(|(old, new)| Arc::ptr_eq(old, new)).count();
        let suffix_units = old[prefix_units..]
            .iter()
            .rev()
            .zip(new[prefix_units..].iter().rev())
            .take_while(|(old, new)| Arc::ptr_eq(old, new))
            .count();
        let rules = |units: &[Arc<ParsedRule>]| units.iter().map(|unit| unit.len()).sum::<usize>();
        let prefix = rules(&old[..prefix_units]);
        let suffix = rules(&old[old.len() - suffix_units..]);
        let old_suffix = old_index.rules.len() - suffix;
        let new_suffix = new_index.rules.len() - suffix;
        if old_index.unlayered_rank() != new_index.unlayered_rank() {
            return None;
        }
        let same_rank = |old_at: usize, new_at: usize| old_index.rules[old_at].layer_rank() == new_index.rules[new_at].layer_rank();
        if !(0..prefix).all(|at| same_rank(at, at)) || !(0..suffix).all(|at| same_rank(old_suffix + at, new_suffix + at)) {
            return None;
        }
        let features = Features::of(&new_index.rules[prefix..new_suffix])?;
        Some(Reload {
            prefix: u32::try_from(prefix).expect("fewer than 2^32 rules"),
            old_suffix: u32::try_from(old_suffix).expect("fewer than 2^32 rules"),
            new_suffix: u32::try_from(new_suffix).expect("fewer than 2^32 rules"),
            features,
        })
    }

    /// Where a rule of the old load is in the new, `None` when it is gone. Keeps the order of the
    /// rules it keeps.
    fn renumber(&self, old: u32) -> Option<u32> {
        if old < self.prefix {
            Some(old)
        } else if old < self.old_suffix {
            None
        } else {
            Some(old - self.old_suffix + self.new_suffix)
        }
    }

    fn is_noop(&self) -> bool {
        self.old_suffix == self.prefix && self.new_suffix == self.prefix
    }
}

/// One thing an element has, which a subject compound requires of the elements it matches.
enum Feature {
    Id(Atom),
    Class(Atom),
    Attribute(AttrName),
    Tag(TypeName),
}

impl Feature {
    fn of(simple: &Simple) -> Option<Feature> {
        match simple {
            Simple::Id(id) => Some(Feature::Id(*id)),
            Simple::Class(class) => Some(Feature::Class(*class)),
            Simple::Attr(attr) => Some(Feature::Attribute(attr.name)),
            Simple::Tag(tag) => Some(Feature::Tag(*tag)),
            _ => None,
        }
    }

    fn held_by(&self, element: &RetainedElement, atoms: &Atoms, style: Atom) -> bool {
        let is_svg = element.is_svg();
        match self {
            Feature::Id(id) => element.css().is_some_and(|css| css.id == Some(*id)),
            Feature::Class(class) => element.css().is_some_and(|css| css.classes.contains(class)),
            Feature::Attribute(name) => {
                let name = if is_svg { name.written } else { name.lower };
                if name == style {
                    element.own_style().is_some()
                } else {
                    element.attribute(atoms.name(name)).is_some()
                }
            }
            Feature::Tag(name) => {
                let tag = if is_svg { atoms.get(&element.element_type) } else { atoms.tag(&element.element_type) };
                tag == Some(name.for_element(is_svg))
            }
        }
    }
}

/// What the subject of a selector requires of an element, found under its first feature: the others
/// that it requires too, in a list that is empty for the many selectors with one.
type Others = Vec<Feature>;

/// The elements an added rule can match, as what they have: for each selector of an added rule,
/// the features its subject compound requires. An element that has them all may be matched by it.
#[derive(Default)]
struct Features {
    ids: FxHashMap<Atom, Vec<Others>>,
    classes: FxHashMap<Atom, Vec<Others>>,
    attributes: Vec<(AttrName, Others)>,
    tags: Vec<(TypeName, Others)>,
}

impl Features {
    /// `None` when the subject of a selector requires none of them (`*`, `:root`, `:not(.a)`,
    /// `:is(.a, .b)`), so any element could be matched.
    fn of(added: &[IndexedRule]) -> Option<Features> {
        let mut features = Features::default();
        for rule in added {
            for (selector, _) in &rule.selectors {
                let mut all: Vec<Feature> = selector.compounds[0].simples.iter().filter_map(Feature::of).collect();
                // Keyed as the index keys a selector, by what is likely to be the rarest.
                let first = all
                    .iter()
                    .position(|feature| matches!(feature, Feature::Id(_)))
                    .or_else(|| all.iter().position(|feature| matches!(feature, Feature::Class(_))))
                    .or_else(|| all.iter().position(|feature| matches!(feature, Feature::Attribute(_))))
                    .or_else(|| all.iter().position(|feature| matches!(feature, Feature::Tag(_))))?;
                let key = all.remove(first);
                match key {
                    Feature::Id(id) => features.ids.entry(id).or_default().push(all),
                    Feature::Class(class) => features.classes.entry(class).or_default().push(all),
                    Feature::Attribute(name) => features.attributes.push((name, all)),
                    Feature::Tag(tag) => features.tags.push((tag, all)),
                }
            }
        }
        Some(features)
    }

    fn is_empty(&self) -> bool {
        self.ids.is_empty() && self.classes.is_empty() && self.attributes.is_empty() && self.tags.is_empty()
    }

    /// Whether `element` has the features of some added selector, from the atoms stored on it.
    fn reach(&self, element: &RetainedElement, atoms: &Atoms, style: Atom) -> bool {
        let others_held = |others: &Others| others.iter().all(|feature| feature.held_by(element, atoms, style));
        if let Some(css) = element.css() {
            if css.id.and_then(|id| self.ids.get(&id)).is_some_and(|options| options.iter().any(others_held)) {
                return true;
            }
            if !self.classes.is_empty()
                && css.classes.iter().any(|class| self.classes.get(class).is_some_and(|options| options.iter().any(others_held)))
            {
                return true;
            }
        }
        let by_attribute = self
            .attributes
            .iter()
            .any(|(name, others)| Feature::Attribute(*name).held_by(element, atoms, style) && others_held(others));
        by_attribute
            || self.tags.iter().any(|(tag, others)| Feature::Tag(*tag).held_by(element, atoms, style) && others_held(others))
    }
}

impl RetainedTree {
    /// Brings the elements to the sheets just loaded by matching again only the ones `reload`
    /// reaches, which are marked for the flush. `names_before` is how many names the atoms held
    /// before the load. `false` when most elements are reached, and nothing is then to be relied on:
    /// the caller matches every element, as it does for a change this cannot take.
    pub(super) fn reload_scoped(&mut self, reload: &Reload, names_before: usize) -> bool {
        if reload.is_noop() {
            return true;
        }
        let (interner, replaced) = self.sheets.interner.renumbered(&self.sheets.index, |rule| reload.renumber(rule));
        self.sheets.interner = interner;
        // Elements keep atoms only for the names a sheet had when they were read.
        let names_grew = self.sheets.atoms.len() != names_before;
        if reload.features.is_empty() && replaced.is_empty() && !names_grew {
            return true;
        }
        let atoms = &self.sheets.atoms;
        let style = self.sheets.style;
        let total = self.elements.len();
        let mut reached: Vec<u64> = Vec::new();
        let mut moved: Vec<(u64, Arc<super::cascade::MatchedRules>)> = Vec::new();
        for (id, element) in self.elements.iter_mut() {
            let matchable = element.is_matchable();
            if names_grew && matchable {
                let element_id = id_atom(atoms, element.attribute("id"));
                let classes = class_atoms(atoms, element.attribute("class"));
                element.set_css_atoms(element_id, classes);
            }
            let mut is_reached = false;
            if !replaced.is_empty() {
                if let Some(matched) = element.css().and_then(|css| css.matched.as_ref()) {
                    match replaced.get(&(Arc::as_ptr(matched) as usize)) {
                        Some(Some(list)) => moved.push((*id, list.clone())),
                        Some(None) => is_reached = true,
                        None => {}
                    }
                }
            }
            if !is_reached && matchable && !reload.features.is_empty() && reload.features.reach(element, atoms, style) {
                is_reached = true;
            }
            if is_reached {
                reached.push(*id);
                if reached.len() * 2 > total {
                    return false;
                }
            }
        }
        for (id, list) in moved {
            if let Some(element) = self.elements.get_mut(&id) {
                element.set_matched(Some(list));
            }
        }
        self.styles.cascaded.replaced(&replaced);
        for id in reached {
            self.sheets.mark(id, Reach::SELF);
        }
        true
    }
}
