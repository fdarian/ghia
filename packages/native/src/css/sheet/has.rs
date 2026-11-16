//! `:has()`: a relative selector matched from the element it is asked of, and what a change marks
//! for the elements that ask.
//!
//! The element a `:has()` is written on is its anchor, and each argument says what the anchor has:
//! a leading combinator (`>`, `+`, `~`, or none for a descendant) to the argument's leftmost
//! compound, and the argument's own combinators from there. Matching walks down from the anchor
//! and never up: for a child it tries the children, for a descendant the subtree, for a sibling
//! the siblings after it.
//!
//! The harder half is the other direction. When some element changes, the anchors whose answer it
//! can change are not where the combinators of a selector lead (they lead from the anchor to the
//! element) but where they lead back: the ancestors of the element, or its earlier siblings.
//! [`HasInvalidation`] records, for each feature an argument reads, which of those places holds
//! an anchor, and the tree marks only the ones that have what the anchor compound requires
//! (`.btn` of `.btn:has(> svg)`), so a document whose sheets have no `:has()` marks nothing here
//! and one that has marks few elements for a change.

use std::ops::{BitOr, BitOrAssign, Deref};
use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::retained_tree::{RetainedElement, RetainedTree};

use super::atoms::Atom;
use super::document::StyleSheets;
use super::invalidation::Reach;
use super::matching::{compound_matches, ElementView};
use super::nth::Position;
use super::positions::SiblingRange;
use super::reload::Features;
use super::selector::{Combinator, ComplexSelector, Simple, Specificity};
use super::tree_states::{TreeState, TreeStates};
use super::view::count_sibling_work;

#[cfg(test)]
thread_local! {
    /// Searches the matcher ran (not the ones a remembered answer saved), and elements it tried
    /// a compound on or a structure read walked, which the tests read to check that an answer is
    /// worked out once.
    pub(super) static SEARCHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub(super) static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn count_search() {
    #[cfg(test)]
    SEARCHES.with(|count| count.set(count.get() + 1));
}

fn count_step() {
    #[cfg(test)]
    STEPS.with(|count| count.set(count.get() + 1));
}

/// One argument of `:has()`.
#[derive(Clone, PartialEq, Debug)]
pub struct RelativeSelector {
    /// How the anchor reaches the argument's leftmost compound: `a b` is [`Combinator::Descendant`].
    pub leading: Combinator,
    /// What follows the leading combinator, stored subject first like any complex selector.
    pub selector: ComplexSelector,
}

/// The arguments of one `:has()`. Shared like [`super::selector::SelectorList`], and the address
/// of the list is what a remembered answer is keyed by.
#[derive(Clone, PartialEq, Debug)]
pub struct HasArguments {
    relatives: Arc<[RelativeSelector]>,
    specificity: Specificity,
}

impl HasArguments {
    pub fn new(relatives: Vec<RelativeSelector>) -> Self {
        let specificity = relatives.iter().map(|relative| relative.selector.specificity()).max().unwrap_or_default();
        HasArguments { relatives: relatives.into(), specificity }
    }

    /// The most specific argument, as for `:is()`.
    pub(super) fn specificity(&self) -> Specificity {
        self.specificity
    }
}

impl Deref for HasArguments {
    type Target = [RelativeSelector];

    fn deref(&self) -> &[RelativeSelector] {
        &self.relatives
    }
}

// Matching.

pub(super) fn matches<E: ElementView>(arguments: &HasArguments, anchor: &E) -> bool {
    anchor.remembered_has(arguments.as_ptr() as usize, || {
        count_search();
        arguments.iter().any(|argument| argument.found_from(anchor))
    })
}

impl RelativeSelector {
    fn found_from<E: ElementView>(&self, anchor: &E) -> bool {
        let leftmost = self.selector.compounds.len() - 1;
        any_related(self.leading, anchor, &|candidate| self.matches_at(leftmost, candidate))
    }

    /// Whether `element` matches the compound at `index` and the compounds to its right, down to
    /// the subject, are found below it.
    fn matches_at<E: ElementView>(&self, index: usize, element: &E) -> bool {
        count_step();
        if !compound_matches(&self.selector.compounds[index], element) {
            return false;
        }
        index == 0 || any_related(self.selector.links[index - 1], element, &|next| self.matches_at(index - 1, next))
    }
}

/// Whether `test` holds for some element that `link` leads to from `from`, going right: the
/// children, the subtree, the next sibling, or the siblings after.
fn any_related<E: ElementView>(link: Combinator, from: &E, test: &impl Fn(&E) -> bool) -> bool {
    match link {
        Combinator::Child => from.children().iter().any(test),
        Combinator::Descendant => {
            let mut pending = from.children();
            while let Some(candidate) = pending.pop() {
                if test(&candidate) {
                    return true;
                }
                pending.extend(candidate.children());
            }
            false
        }
        Combinator::NextSibling => from.next_sibling().is_some_and(|sibling| test(&sibling)),
        Combinator::SubsequentSibling => {
            let mut next = from.next_sibling();
            while let Some(sibling) = next {
                if test(&sibling) {
                    return true;
                }
                next = sibling.next_sibling();
            }
            false
        }
    }
}

// Where the anchors of a change are.

/// How many levels up: bit `n` is exactly `n`, and every level from `from` on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Levels {
    exact: u32,
    from: u8,
}

/// Levels past this are all "from here on": a deeper chain than a document nests is not told apart.
const EXACT_LEVELS: usize = 32;
const NO_LEVEL: u8 = u8::MAX;

impl Default for Levels {
    fn default() -> Self {
        Levels { exact: 0, from: NO_LEVEL }
    }
}

impl Levels {
    fn exactly(level: usize) -> Levels {
        if level < EXACT_LEVELS {
            Levels { exact: 1 << level, from: NO_LEVEL }
        } else {
            Levels::at_least(level)
        }
    }

    fn at_least(level: usize) -> Levels {
        Levels { exact: 0, from: level.min(EXACT_LEVELS) as u8 }
    }

    fn is_empty(self) -> bool {
        self.exact == 0 && self.from == NO_LEVEL
    }

    fn is_unbounded(self) -> bool {
        self.from != NO_LEVEL
    }

    fn contains(self, level: usize) -> bool {
        (level < EXACT_LEVELS && self.exact & (1 << level) != 0) || (self.is_unbounded() && level >= usize::from(self.from))
    }

    /// The deepest of the exact levels.
    fn deepest(self) -> Option<usize> {
        (self.exact != 0).then(|| 31 - self.exact.leading_zeros() as usize)
    }

    /// Every level from `lowest` to the deepest here: an element that comes with a subtree holds
    /// the one an argument reads at any depth below it, so the anchors are any of the levels
    /// that are above that depth.
    fn closed_from(self, lowest: usize) -> Levels {
        if self.is_unbounded() {
            return Levels::at_least(lowest);
        }
        let Some(deepest) = self.deepest() else {
            return Levels::default();
        };
        let through_deepest = (1u64 << (deepest + 1)) - 1;
        let below_lowest = (1u64 << lowest) - 1;
        Levels { exact: (through_deepest & !below_lowest) as u32, from: NO_LEVEL }
    }
}

impl BitOr for Levels {
    type Output = Levels;

    fn bitor(self, other: Levels) -> Levels {
        Levels { exact: self.exact | other.exact, from: self.from.min(other.from) }
    }
}

/// Where the anchors are, from the element that changed: an ancestor some levels up; the sibling
/// right before it, or before one of its ancestors; or any earlier sibling of those.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
struct Anchors {
    ancestors: Levels,
    /// The closest earlier element sibling of the element `n` levels up (0 is the element).
    previous: Levels,
    earlier: Levels,
}

impl Anchors {
    fn is_empty(self) -> bool {
        self.ancestors.is_empty() && self.previous.is_empty() && self.earlier.is_empty()
    }

    fn closed(self) -> Anchors {
        Anchors {
            ancestors: self.ancestors.closed_from(1),
            previous: self.previous.closed_from(0),
            earlier: self.earlier.closed_from(0),
        }
    }

    fn add(&mut self, place: Place) {
        let levels = if place.exact { Levels::exactly(place.levels) } else { Levels::at_least(place.levels) };
        match place.siblings {
            Siblings::None => self.ancestors = self.ancestors | levels,
            Siblings::One => self.previous = self.previous | levels,
            Siblings::Many => self.earlier = self.earlier | levels,
        }
    }

    /// The deepest level to look at, `None` when the anchors can be any way up.
    fn depth_limit(self) -> Option<usize> {
        let sets = [self.ancestors, self.previous, self.earlier];
        if sets.iter().any(|levels| levels.is_unbounded()) {
            return None;
        }
        Some(sets.iter().filter_map(|levels| levels.deepest()).max().unwrap_or(0))
    }
}

impl BitOr for Anchors {
    type Output = Anchors;

    fn bitor(self, other: Anchors) -> Anchors {
        Anchors {
            ancestors: self.ancestors | other.ancestors,
            previous: self.previous | other.previous,
            earlier: self.earlier | other.earlier,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Siblings {
    None,
    One,
    Many,
}

/// Where an element stands relative to an element that changed: levels up, then some siblings
/// before it.
#[derive(Clone, Copy)]
struct Place {
    levels: usize,
    /// False once a descendant combinator was walked: the element is some ancestor, not one.
    exact: bool,
    siblings: Siblings,
}

impl Place {
    const CHANGED: Place = Place { levels: 0, exact: true, siblings: Siblings::None };

    /// The place of the compound a link joins to the one at this place, written to its left.
    fn step(self, link: Combinator) -> Place {
        match link {
            Combinator::Child => Place { levels: self.levels + 1, siblings: Siblings::None, ..self },
            Combinator::Descendant => Place { levels: self.levels + 1, exact: false, siblings: Siblings::None },
            Combinator::NextSibling => {
                Place { siblings: if self.siblings == Siblings::None { Siblings::One } else { Siblings::Many }, ..self }
            }
            Combinator::SubsequentSibling => Place { siblings: Siblings::Many, ..self },
        }
    }

    /// The anchor of an argument when the element at `self` matches the compound `links` start from.
    fn anchor_through(self, links: &[Combinator], leading: Combinator) -> Place {
        links.iter().chain(std::iter::once(&leading)).fold(self, |place, link| place.step(*link))
    }
}

/// What a change reads of `:has()` through one feature: the anchors it can change, and what
/// marking one reaches (the places the rest of the selector leads to from the anchor).
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct HasRead {
    anchors: Anchors,
    mark: Reach,
    /// The anchors cannot be told from the element that changed (a combinator inside a `:is()`
    /// or `:not()` in an argument, or a `:has()` nested in one), so every element is matched again.
    wide: bool,
}

impl HasRead {
    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty() && !self.wide
    }

    fn wide(mark: Reach) -> HasRead {
        HasRead { anchors: Anchors::default(), mark, wide: true }
    }
}

impl BitOr for HasRead {
    type Output = HasRead;

    fn bitor(self, other: HasRead) -> HasRead {
        HasRead { anchors: self.anchors | other.anchors, mark: self.mark | other.mark, wide: self.wide || other.wide }
    }
}

impl BitOrAssign for HasRead {
    fn bitor_assign(&mut self, other: HasRead) {
        *self = *self | other;
    }
}

/// What the `:has()` of a document read, by feature. Empty, and `used` false, when no selector
/// has one.
#[derive(Default)]
pub struct HasInvalidation {
    used: bool,
    classes: FxHashMap<Atom, HasRead>,
    ids: FxHashMap<Atom, HasRead>,
    attributes: FxHashMap<Atom, HasRead>,
    tree_states: FxHashMap<TreeState, HasRead>,
    /// An element coming, going or moving, wherever it is in an argument or in the way of one,
    /// for the arguments that no feature of the element can rule out.
    structure: HasRead,
    /// The arguments an element coming or going can change only by holding what their subject
    /// requires, which is looked for in the element and below it.
    filtered: Vec<SubjectFilter>,
    /// What marking reaches, for the anchors of a position read in an argument (`:has(:first-child)`):
    /// a child that comes or goes changes the position of its siblings and the emptiness of its
    /// parent, which are below the anchors above them, so those are marked, all of them.
    positional_ancestors: Reach,
    /// The same for the arguments that also have a sibling combinator, whose anchors are among
    /// the siblings of the child and of its ancestors.
    positional_siblings: Reach,
    /// Whether an argument reads `:empty`, the only position a text node can change.
    reads_empty: bool,
    /// What the compound of each anchor requires of an element, for the anchors that hold one.
    anchor_keys: Features,
    /// An anchor compound that requires no id, class, attribute or tag: any element can be one.
    any_anchor: bool,
    /// An anchor compound with `:root`: the root element is the only one that can be.
    root_anchor: bool,
}

/// An argument that an element coming or going changes only when something in it matches the
/// subject of the argument, which holds at least what `features` lists.
struct SubjectFilter {
    features: Features,
    read: HasRead,
}

impl HasInvalidation {
    #[cfg(test)]
    pub(super) fn is_used(&self) -> bool {
        self.used
    }

    /// Reads a `:has()` written in the compound `anchor`. `hint` is the compound of the selector
    /// the `:has()` is an argument of, which is the same element when `anchor` names nothing
    /// itself (`.a:not(:has(.b))`). `mark` is what marking an anchor reaches: the places the rest
    /// of the selector leads to from it.
    pub(super) fn read(&mut self, arguments: &HasArguments, anchor: &[Simple], hint: Option<&[Simple]>, mark: Reach) {
        self.used = true;
        if anchor.iter().any(|simple| matches!(simple, Simple::Root)) {
            self.root_anchor = true;
        } else if self.anchor_keys.add_compound(anchor).is_none() && hint.and_then(|hint| self.anchor_keys.add_compound(hint)).is_none() {
            self.any_anchor = true;
        }
        for argument in arguments.iter() {
            self.read_argument(argument, mark);
        }
    }

    fn read_argument(&mut self, argument: &RelativeSelector, mark: Reach) {
        let links = &argument.selector.links;
        let is_sibling = |link: &Combinator| matches!(link, Combinator::NextSibling | Combinator::SubsequentSibling);
        let sibling_anchors = is_sibling(&argument.leading) || links.iter().any(is_sibling);
        let mut structure = HasRead::default();
        for (position, compound) in argument.selector.compounds.iter().enumerate() {
            let mut anchors = Anchors::default();
            anchors.add(Place::CHANGED.anchor_through(&links[position..], argument.leading));
            self.read_compound(&compound.simples, HasRead { anchors, mark, wide: false }, sibling_anchors);
            structure |= HasRead { anchors: anchors.closed(), mark, wide: false };
        }
        // An element between the two that a sibling combinator joins is in the way, and the anchor
        // is where the chain from the compound before it leads, one sibling further or more.
        for (position, link) in links.iter().enumerate() {
            let siblings = match link {
                Combinator::NextSibling => Siblings::One,
                Combinator::SubsequentSibling => Siblings::Many,
                Combinator::Child | Combinator::Descendant => continue,
            };
            let mut anchors = Anchors::default();
            anchors.add(Place { siblings, ..Place::CHANGED }.anchor_through(&links[position + 1..], argument.leading));
            structure |= HasRead { anchors, mark, wide: false };
        }
        let Some(features) = Self::subject_features(argument) else {
            self.structure |= structure;
            return;
        };
        self.filtered.push(SubjectFilter { features, read: structure });
        if argument.leading == Combinator::NextSibling {
            // Whatever comes right after the anchor is what it has next, so it is changed by an
            // element that holds nothing the argument reads.
            let mut anchors = Anchors::default();
            anchors.add(Place { siblings: Siblings::One, ..Place::CHANGED });
            self.structure |= HasRead { anchors, mark, wide: false };
        }
    }

    /// What an element that makes the argument match has to hold, when an element coming or going
    /// can change the argument only by being, or holding, a match of its subject: the argument
    /// has combinators that go down only (a sibling between two others is in the way whatever it
    /// is) and reads no position (which an element changes without holding anything), and the
    /// subject requires an id, a class, an attribute or a tag.
    fn subject_features(argument: &RelativeSelector) -> Option<Features> {
        let selector = &argument.selector;
        if selector.links.iter().any(|link| matches!(link, Combinator::NextSibling | Combinator::SubsequentSibling)) {
            return None;
        }
        if !selector.compounds.iter().all(|compound| is_plain(&compound.simples)) {
            return None;
        }
        let mut features = Features::default();
        features.add_compound(&selector.compounds[0].simples)?;
        Some(features)
    }

    fn read_compound(&mut self, simples: &[Simple], read: HasRead, sibling_anchors: bool) {
        for simple in simples {
            match simple {
                Simple::Class(class) => *self.classes.entry(*class).or_default() |= read,
                Simple::Id(id) => *self.ids.entry(*id).or_default() |= read,
                Simple::Attr(attr) => *self.attributes.entry(attr.name.lower).or_default() |= read,
                Simple::TreeState(state) => *self.tree_states.entry(*state).or_default() |= read,
                Simple::Position(position) => {
                    self.positional_ancestors |= read.mark;
                    if sibling_anchors {
                        self.positional_siblings |= read.mark;
                    }
                    self.reads_empty |= matches!(position, Position::Empty);
                }
                Simple::Is(list) => list.iter().for_each(|inner| self.read_inner(inner, read, sibling_anchors)),
                Simple::Where(list) | Simple::Not(list) => list.iter().for_each(|inner| self.read_inner(inner, read, sibling_anchors)),
                Simple::Has(arguments) => {
                    // Only a `&` can bring one into an argument.
                    for argument in arguments.iter() {
                        for compound in &argument.selector.compounds {
                            self.read_compound(&compound.simples, HasRead::wide(read.mark), true);
                        }
                    }
                    self.structure |= HasRead::wide(read.mark);
                }
                Simple::Tag(_) | Simple::Root | Simple::Host | Simple::PseudoElement | Simple::State(_) => {}
            }
        }
    }

    /// A selector inside `:is()`, `:where()` or `:not()` in an argument. One compound is the same
    /// element as the one that holds it. More are other elements, which is not told apart from the
    /// anchor: a feature of one of them re-matches everything.
    fn read_inner(&mut self, inner: &ComplexSelector, read: HasRead, sibling_anchors: bool) {
        if let [only] = &inner.compounds[..] {
            self.read_compound(&only.simples, read, sibling_anchors);
            return;
        }
        let wide = HasRead::wide(read.mark);
        for compound in &inner.compounds {
            self.read_compound(&compound.simples, wide, true);
        }
        self.structure |= wide;
    }

    fn holds_anchor_key(&self, sheets: &StyleSheets, element: &RetainedElement, is_root: bool) -> bool {
        self.any_anchor || (self.root_anchor && is_root) || self.anchor_keys.reach(sheets, element)
    }
}

fn is_plain_selector(selector: &ComplexSelector) -> bool {
    matches!(&selector.compounds[..], [only] if is_plain(&only.simples))
}

/// Whether a compound reads nothing of the element but what it holds and its state: no position,
/// no `:has()`, and no combinator inside an `:is()`, `:where()` or `:not()`.
fn is_plain(simples: &[Simple]) -> bool {
    simples.iter().all(|simple| match simple {
        Simple::Position(_) | Simple::Has(_) => false,
        Simple::Is(list) => list.iter().all(is_plain_selector),
        Simple::Where(list) | Simple::Not(list) => list.iter().all(is_plain_selector),
        Simple::Tag(_) | Simple::Class(_) | Simple::Id(_) | Simple::Attr(_) | Simple::TreeState(_) | Simple::Root | Simple::Host | Simple::PseudoElement | Simple::State(_) => true,
    })
}

impl StyleSheets {
    fn has_attribute_atom_read(&self, name: Atom) -> HasRead {
        self.index.invalidation.has.attributes.get(&name).copied().unwrap_or_default()
    }

    pub(crate) fn has_attribute_read(&self, name: &str) -> HasRead {
        if !self.index.invalidation.has.used {
            return HasRead::default();
        }
        self.atoms.get(name).map(|atom| self.has_attribute_atom_read(atom)).unwrap_or_default()
    }

    pub(crate) fn has_class_read(&self, before: &[Atom], after: &[Atom]) -> HasRead {
        let has = &self.index.invalidation.has;
        if !has.used {
            return HasRead::default();
        }
        let mut read = self.has_attribute_read("class");
        let gone = before.iter().filter(|class| !after.contains(class));
        let new = after.iter().filter(|class| !before.contains(class));
        for class in gone.chain(new) {
            read |= has.classes.get(class).copied().unwrap_or_default();
        }
        read
    }

    pub(crate) fn has_id_read(&self, before: Option<Atom>, after: Option<Atom>) -> HasRead {
        let has = &self.index.invalidation.has;
        if !has.used {
            return HasRead::default();
        }
        let mut read = self.has_attribute_read("id");
        if before != after {
            for id in before.iter().chain(after.iter()) {
                read |= has.ids.get(id).copied().unwrap_or_default();
            }
        }
        read
    }

    pub(crate) fn has_style_read(&self) -> HasRead {
        self.has_attribute_atom_read(self.style)
    }

    pub(crate) fn has_tree_state_read(&self, changed: TreeStates) -> HasRead {
        self.index
            .invalidation
            .has
            .tree_states
            .iter()
            .filter(|(state, _)| changed.contains(**state))
            .fold(HasRead::default(), |all, (_, read)| all | *read)
    }
}

// Marking.

/// Where a child that is coming or going is, for finding the siblings of it that stay.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Presence {
    /// In place and staying: an attribute of it changed.
    Staying,
    /// Just put last in its parent.
    Appended,
    /// About to leave its parent.
    Leaving,
}

impl RetainedTree {
    /// Marks the anchors `read` says a change of `changed` can reach, for the ones that have what
    /// their compound requires.
    pub(crate) fn mark_has_anchors(&mut self, changed: u64, read: HasRead) {
        self.mark_has_anchors_of(changed, read, Presence::Staying);
    }

    fn mark_has_anchors_of(&mut self, changed: u64, read: HasRead, presence: Presence) {
        if read.is_empty() {
            return;
        }
        if read.wide {
            self.sheets.mark_all = true;
            return;
        }
        let (found, ranges) = self.has_anchors(changed, read, presence);
        for anchor in found {
            self.sheets.mark(anchor, read.mark);
        }
        for range in ranges {
            self.note_range(range);
        }
    }

    /// The anchors `read` finds from `changed` that are ancestors or the closest sibling before one,
    /// and the runs of siblings that hold the others, which the flush turns into marks.
    fn has_anchors(&self, changed: u64, read: HasRead, presence: Presence) -> (Vec<u64>, Vec<SiblingRange>) {
        let anchors = read.anchors;
        let limit = anchors.depth_limit();
        let mut found = Vec::new();
        let mut ranges = Vec::new();
        let (mut at, mut level) = (changed, 0usize);
        loop {
            if anchors.ancestors.contains(level) && self.holds_anchor_key(at) {
                found.push(at);
            }
            if anchors.earlier.contains(level) {
                let leaving = presence == Presence::Leaving && level == 0;
                if let Some(range) = self.earlier_range(at, read.mark, leaving) {
                    ranges.push(range);
                }
            } else if anchors.previous.contains(level) {
                self.closest_earlier_anchor(at, presence == Presence::Appended && level == 0, &mut found);
            }
            if limit.is_some_and(|limit| level >= limit) {
                break;
            }
            let Some(parent) = self.elements.get(&at).and_then(|element| element.parent) else {
                break;
            };
            (at, level) = (parent, level + 1);
        }
        (found, ranges)
    }

    pub(super) fn holds_anchor_key(&self, id: u64) -> bool {
        self.elements.get(&id).is_some_and(|element| {
            element.is_matchable() && self.sheets.index.invalidation.has.holds_anchor_key(&self.sheets, element, self.root_id == Some(id))
        })
    }

    /// The element siblings before `at`, as a run for the flush. One that is leaving is not there
    /// at the flush, so the run ends at the sibling after it, or is the whole list when none is.
    fn earlier_range(&self, at: u64, reach: Reach, leaving: bool) -> Option<SiblingRange> {
        let parent = self.elements.get(&at)?.parent?;
        let anchor = if leaving { self.next_element_sibling(at) } else { Some(at) };
        Some(SiblingRange::anchors_before(parent, anchor, reach))
    }

    /// The closest element sibling before `at`, when it can be an anchor. `from_end` when `at` was
    /// just appended to its parent.
    fn closest_earlier_anchor(&self, at: u64, from_end: bool, found: &mut Vec<u64>) {
        let Some(parent) = self.elements.get(&at).and_then(|element| element.parent).and_then(|parent| self.elements.get(&parent)) else {
            return;
        };
        let position = if from_end {
            parent.children.iter().rposition(|id| *id == at)
        } else {
            parent.children.iter().position(|id| *id == at)
        };
        let Some(position) = position else {
            return;
        };
        let mut steps = 0;
        let closest = parent.children[..position].iter().rev().find(|sibling| {
            steps += 1;
            self.is_matchable_id(**sibling)
        });
        count_sibling_work(steps);
        if let Some(sibling) = closest.filter(|sibling| self.holds_anchor_key(**sibling)) {
            found.push(*sibling);
        }
    }

    /// `child` comes into or goes out of its parent: the anchors that can have, or have had, what
    /// an argument reads in it, and the ones that read a position it changes.
    pub(super) fn has_structure_changed(&mut self, child: u64, parent: u64, presence: Presence) {
        let has = &self.sheets.index.invalidation.has;
        // A subtree outside the document is matched when it comes in, with everything below it
        // marked, so what a child does to the anchors around it there is not read: a tree built
        // bottom-up apart would otherwise be walked at every level.
        if !has.used || !self.is_connected(parent) {
            return;
        }
        let matchable = self.is_matchable_id(child);
        if matchable {
            let read = self.structure_read(child);
            self.mark_has_anchors_of(child, read, presence);
        }
        self.mark_positional_anchors(child, !matchable);
    }

    /// What `child` coming or going reads: the arguments no feature rules out, and the others when
    /// the element or something below it holds what their subject requires. Walks the subtree
    /// once for all of them, which is no more than matching it costs when it comes.
    fn structure_read(&self, child: u64) -> HasRead {
        let has = &self.sheets.index.invalidation.has;
        let mut read = has.structure;
        let mut wanted: Vec<&SubjectFilter> = has.filtered.iter().collect();
        let mut pending = vec![child];
        while let Some(id) = pending.pop() {
            if wanted.is_empty() {
                break;
            }
            let Some(element) = self.elements.get(&id).filter(|element| element.is_matchable()) else {
                continue;
            };
            count_step();
            wanted.retain(|filter| {
                let holds = filter.features.reach(&self.sheets, element);
                if holds {
                    read |= filter.read;
                }
                !holds
            });
            pending.extend(element.children.iter().copied());
        }
        read
    }

    /// A text node's text became empty or stopped being.
    pub(super) fn has_text_emptiness_changed(&mut self, text: u64) {
        if self.is_connected(text) {
            self.mark_positional_anchors(text, true);
        }
    }

    /// The anchors of a position read that `changed` changes: the ancestors, and the siblings of
    /// it and of the ancestors for an argument with a sibling combinator. A text node changes only
    /// the emptiness of its parent, so its own siblings are left out.
    fn mark_positional_anchors(&mut self, changed: u64, is_text: bool) {
        let has = &self.sheets.index.invalidation.has;
        let (ancestors, siblings) = (has.positional_ancestors, has.positional_siblings);
        if ancestors.is_empty() || (is_text && !has.reads_empty) {
            return;
        }
        let mut found = Vec::new();
        let mut ranges = Vec::new();
        let mut at = changed;
        while let Some(parent_id) = self.elements.get(&at).and_then(|element| element.parent) {
            if !siblings.is_empty() && !(is_text && at == changed) {
                ranges.push(SiblingRange::anchors_among_children(parent_id, siblings));
            }
            if self.holds_anchor_key(parent_id) {
                found.push(parent_id);
            }
            at = parent_id;
        }
        for anchor in found {
            self.sheets.mark(anchor, ancestors);
        }
        for range in ranges {
            self.note_range(range);
        }
    }
}
