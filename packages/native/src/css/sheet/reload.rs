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

use std::cell::OnceCell;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::Atom;
use super::cascade::Renumbering;
use super::document::StyleSheets;
use super::index::{bucket_simple, IndexedRule, RuleIndex};
use super::invalidation::Reach;
use super::parse_cache::ParsedRule;
use super::selector::{AttrName, ComplexSelector, Simple, TypeName};
use super::view::{has_attr, tag_of};

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
    /// How many rules the two loads share at the end.
    kept_after: u32,
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
            kept_after: u32::try_from(suffix).expect("fewer than 2^32 rules"),
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

    fn removes(&self) -> bool {
        self.old_suffix != self.prefix
    }

    /// Whether a rule that is kept gets a new number.
    fn shifts(&self) -> bool {
        self.kept_after != 0 && self.new_suffix != self.old_suffix
    }
}

/// One thing an element has, which a subject compound requires of the elements it matches.
#[derive(Clone, Copy, PartialEq)]
enum Feature {
    Id(Atom),
    Class(Atom),
    Attribute(AttrName),
    Tag(TypeName),
}

/// An element as the matcher reads it, once for the pass.
struct Read<'a> {
    sheets: &'a StyleSheets,
    element: &'a RetainedElement,
    tag: OnceCell<Option<Atom>>,
}

impl Read<'_> {
    /// The atom of the element's tag, `None` when no sheet names it. Read when a feature asks.
    fn tag(&self) -> Option<Atom> {
        *self.tag.get_or_init(|| tag_of(&self.sheets.atoms, self.element))
    }
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

    fn held_by(&self, read: &Read) -> bool {
        match self {
            Feature::Id(id) => read.element.css().is_some_and(|css| css.id == Some(*id)),
            Feature::Class(class) => read.element.css().is_some_and(|css| css.classes.contains(class)),
            Feature::Attribute(name) => has_attr(read.sheets, read.element, *name),
            Feature::Tag(name) => read.tag() == Some(name.for_element(read.element.is_svg())),
        }
    }
}

/// What the subject of a selector requires of an element, found under its first feature: the others
/// that it requires too, in a list that is empty for the many selectors with one.
type Others = Vec<Feature>;

/// Adds the requirements of one selector under a feature that already has some. An element that
/// holds a feature and nothing else is reached whatever the rest requires, so a list with an empty
/// `Others` holds no other.
fn push_option(options: &mut Vec<Others>, others: Others) {
    if options.iter().any(|held| held.is_empty() || *held == others) {
        return;
    }
    if others.is_empty() {
        options.clear();
    }
    options.push(others);
}

/// The elements an added rule can match, as what they have: for each selector of an added rule,
/// the features its subject compound requires. An element that has them all may be matched by it.
#[derive(Default)]
struct Features {
    ids: FxHashMap<Atom, Vec<Others>>,
    classes: FxHashMap<Atom, Vec<Others>>,
    attributes: FxHashMap<AttrName, Vec<Others>>,
    /// Under the lower-cased and the written atom of the tag, as the index files it.
    tags: FxHashMap<Atom, Vec<Others>>,
    /// The `:is()` and `:where()` lists already added, which nested rules share.
    lists: FxHashSet<usize>,
}

impl Features {
    /// `None` when the subject of a selector requires none of them (`*`, `:root`, `:not(.a)`), so any
    /// element could be matched.
    fn of(added: &[IndexedRule]) -> Option<Features> {
        let mut features = Features::default();
        for rule in added {
            for (selector, _) in &rule.selectors {
                features.add(selector)?;
            }
        }
        Some(features)
    }

    fn add(&mut self, selector: &ComplexSelector) -> Option<()> {
        let subject = &selector.compounds[0].simples;
        let Some(key) = bucket_simple(subject) else {
            // `&:hover` nested in `.a` is `:is(.a):hover`: an element has to match one of the
            // selectors of the list, and what the rest of the compound requires is left out.
            let list = subject.iter().find_map(|simple| match simple {
                Simple::Is(list) => Some(&list[..]),
                Simple::Where(list) => Some(&list[..]),
                _ => None,
            })?;
            if !self.lists.insert(list.as_ptr() as usize) {
                return Some(());
            }
            return list.iter().try_for_each(|inner| self.add(inner));
        };
        let others: Others = subject.iter().filter(|simple| !std::ptr::eq(*simple, key)).filter_map(Feature::of).collect();
        match key {
            Simple::Id(id) => push_option(self.ids.entry(*id).or_default(), others),
            Simple::Class(class) => push_option(self.classes.entry(*class).or_default(), others),
            Simple::Attr(attr) => push_option(self.attributes.entry(attr.name).or_default(), others),
            Simple::Tag(tag) => {
                if tag.written != tag.lower {
                    push_option(self.tags.entry(tag.written).or_default(), others.clone());
                }
                push_option(self.tags.entry(tag.lower).or_default(), others);
            }
            _ => unreachable!("an index key is an id, a class, an attribute or a tag"),
        }
        Some(())
    }

    fn is_empty(&self) -> bool {
        self.ids.is_empty() && self.classes.is_empty() && self.attributes.is_empty() && self.tags.is_empty()
    }

    /// Whether `element` has the features of some added selector, from the atoms stored on it.
    fn reach(&self, sheets: &StyleSheets, element: &RetainedElement) -> bool {
        let read = Read { sheets, element, tag: OnceCell::new() };
        let any_held = |options: &Vec<Others>| options.iter().any(|others| others.iter().all(|feature| feature.held_by(&read)));
        if let Some(css) = element.css() {
            if css.id.and_then(|id| self.ids.get(&id)).is_some_and(any_held) {
                return true;
            }
            if !self.classes.is_empty() && css.classes.iter().any(|class| self.classes.get(class).is_some_and(any_held)) {
                return true;
            }
        }
        if self.attributes.iter().any(|(name, options)| has_attr(sheets, element, *name) && any_held(options)) {
            return true;
        }
        !self.tags.is_empty() && read.tag().and_then(|tag| self.tags.get(&tag)).is_some_and(any_held)
    }
}

/// What a scoped reload will do, decided before anything is changed.
pub(super) struct Plan {
    reload: Reload,
    /// The matched lists the new numbering changes.
    renumbering: Vec<Renumbering>,
    /// The elements to match again.
    reached: Vec<u64>,
    /// The elements that hold a list that is replaced by another.
    holders: Vec<u64>,
}

impl RetainedTree {
    /// What reloading only the elements `reload` reaches comes to, or `None` when most elements are
    /// reached and the caller matches every element, as it does for a change `reload` cannot take.
    /// Reads the elements' atoms, which have to be those of the names the sheets hold now.
    pub(super) fn plan_reload(&self, reload: Reload) -> Option<Plan> {
        let renumbering = if reload.removes() || reload.shifts() {
            self.sheets.interner.renumbering(|rule| reload.renumber(rule))
        } else {
            Vec::new()
        };
        let mut reached: Vec<u64> = Vec::new();
        let mut holders: Vec<u64> = Vec::new();
        if !reload.features.is_empty() || !renumbering.is_empty() {
            // Whether the list is gone, by address.
            let changed: FxHashMap<usize, bool> = renumbering.iter().map(|change| (change.address(), change.is_gone())).collect();
            let total = self.elements.len();
            for (id, element) in &self.elements {
                let fate = element.css().and_then(|css| css.matched.as_ref()).and_then(|matched| changed.get(&(Arc::as_ptr(matched) as usize)));
                if fate == Some(&false) {
                    holders.push(*id);
                }
                let read_removed = fate == Some(&true);
                if read_removed || (element.is_matchable() && !reload.features.is_empty() && reload.features.reach(&self.sheets, element)) {
                    reached.push(*id);
                    if reached.len() * 2 > total {
                        return None;
                    }
                }
            }
        }
        Some(Plan { reload, renumbering, reached, holders })
    }

    /// Brings the elements to the sheets just loaded: renumbers what they matched, and marks the
    /// elements the plan reached for the flush.
    pub(super) fn apply_reload(&mut self, plan: Plan) {
        if !plan.renumbering.is_empty() {
            let replaced = self.sheets.interner.replace(&self.sheets.index, &plan.renumbering);
            for id in &plan.holders {
                let element = self.elements.get_mut(id).expect("the plan found the element in this tree");
                let moved = element
                    .css()
                    .and_then(|css| css.matched.as_ref())
                    .and_then(|matched| replaced.get(&(Arc::as_ptr(matched) as usize)))
                    .and_then(Option::as_ref)
                    .expect("a holder holds a list that is replaced by another")
                    .clone();
                element.set_matched(Some(moved));
            }
            self.styles.cascaded.replaced(&replaced);
        }
        for id in plan.reached {
            self.sheets.mark(id, Reach::SELF);
        }
    }
}
