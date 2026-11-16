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
use super::reload::Features;
use super::selector::{Combinator, ComplexSelector, Simple, Specificity};
use super::tree_states::{TreeState, TreeStates};
use super::view::count_sibling_work;

#[cfg(test)]
thread_local! {
    /// Searches the matcher ran (not the ones a remembered answer saved), and elements it tried
    /// a compound on, which the tests read to check that an answer is worked out once.
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
    /// An element coming, going or moving, wherever it is in an argument or in the way of one.
    structure: HasRead,
    /// What marking reaches, for the anchors of a position read in an argument (`:has(:first-child)`):
    /// a child that comes or goes changes the position of its siblings and the emptiness of its
    /// parent, so the anchors among its siblings and ancestors are marked, all of them.
    positional: Reach,
    /// What the compound of each anchor requires of an element, for the anchors that hold one.
    anchor_keys: Features,
    /// An anchor compound that requires no id, class, attribute or tag: any element can be one.
    any_anchor: bool,
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
        if self.anchor_keys.add_compound(anchor).is_none() && hint.and_then(|hint| self.anchor_keys.add_compound(hint)).is_none() {
            self.any_anchor = true;
        }
        for argument in arguments.iter() {
            self.read_argument(argument, mark);
        }
    }

    fn read_argument(&mut self, argument: &RelativeSelector, mark: Reach) {
        let links = &argument.selector.links;
        for (position, compound) in argument.selector.compounds.iter().enumerate() {
            let mut anchors = Anchors::default();
            anchors.add(Place::CHANGED.anchor_through(&links[position..], argument.leading));
            self.read_compound(&compound.simples, HasRead { anchors, mark, wide: false });
            self.structure |= HasRead { anchors: anchors.closed(), mark, wide: false };
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
            self.structure |= HasRead { anchors, mark, wide: false };
        }
    }

    fn read_compound(&mut self, simples: &[Simple], read: HasRead) {
        for simple in simples {
            match simple {
                Simple::Class(class) => *self.classes.entry(*class).or_default() |= read,
                Simple::Id(id) => *self.ids.entry(*id).or_default() |= read,
                Simple::Attr(attr) => *self.attributes.entry(attr.name.lower).or_default() |= read,
                Simple::TreeState(state) => *self.tree_states.entry(*state).or_default() |= read,
                Simple::Position(_) => self.positional |= read.mark,
                Simple::Is(list) => list.iter().for_each(|inner| self.read_inner(inner, read)),
                Simple::Where(list) | Simple::Not(list) => list.iter().for_each(|inner| self.read_inner(inner, read)),
                Simple::Has(arguments) => {
                    // Only a `&` can bring one into an argument.
                    for argument in arguments.iter() {
                        for compound in &argument.selector.compounds {
                            self.read_compound(&compound.simples, HasRead::wide(read.mark));
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
    fn read_inner(&mut self, inner: &ComplexSelector, read: HasRead) {
        if let [only] = &inner.compounds[..] {
            self.read_compound(&only.simples, read);
            return;
        }
        let wide = HasRead::wide(read.mark);
        for compound in &inner.compounds {
            self.read_compound(&compound.simples, wide);
        }
        self.structure |= wide;
    }

    fn holds_anchor_key(&self, sheets: &StyleSheets, element: &RetainedElement) -> bool {
        self.any_anchor || self.anchor_keys.reach(sheets, element)
    }
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

impl RetainedTree {
    /// Marks the anchors `read` says a change of `changed` can reach, for the ones that have what
    /// their compound requires. `from_end` when `changed` was just appended to its parent.
    pub(crate) fn mark_has_anchors(&mut self, changed: u64, read: HasRead, from_end: bool) {
        if read.is_empty() {
            return;
        }
        if read.wide {
            self.sheets.mark_all = true;
            return;
        }
        for anchor in self.has_anchors(changed, read.anchors, from_end) {
            self.sheets.mark(anchor, read.mark);
        }
    }

    fn has_anchors(&self, changed: u64, anchors: Anchors, from_end: bool) -> Vec<u64> {
        let limit = anchors.depth_limit();
        let mut found = Vec::new();
        let (mut at, mut level) = (changed, 0usize);
        loop {
            if anchors.ancestors.contains(level) && self.holds_anchor_key(at) {
                found.push(at);
            }
            let earlier = anchors.earlier.contains(level);
            if earlier || anchors.previous.contains(level) {
                self.earlier_anchors(at, !earlier, from_end && level == 0, &mut found);
            }
            if limit.is_some_and(|limit| level >= limit) {
                break;
            }
            let Some(parent) = self.elements.get(&at).and_then(|element| element.parent) else {
                break;
            };
            (at, level) = (parent, level + 1);
        }
        found
    }

    fn holds_anchor_key(&self, id: u64) -> bool {
        self.elements
            .get(&id)
            .is_some_and(|element| element.is_matchable() && self.sheets.index.invalidation.has.holds_anchor_key(&self.sheets, element))
    }

    /// The element siblings before `at` that can be anchors: the closest, or all.
    fn earlier_anchors(&self, at: u64, only_closest: bool, from_end: bool, found: &mut Vec<u64>) {
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
        for sibling in parent.children[..position].iter().rev() {
            steps += 1;
            if !self.is_matchable_id(*sibling) {
                continue;
            }
            if self.holds_anchor_key(*sibling) {
                found.push(*sibling);
            }
            if only_closest {
                break;
            }
        }
        count_sibling_work(steps);
    }

    /// `child` comes into or goes out of its parent (`appended`: it was just put last): the anchors
    /// that can have, or have had, what an argument reads in it, and the ones that read a
    /// position it changes.
    pub(super) fn has_structure_changed(&mut self, child: u64, appended: bool) {
        let has = &self.sheets.index.invalidation.has;
        if !has.used {
            return;
        }
        let (structure, positional) = (has.structure, has.positional);
        if self.is_matchable_id(child) {
            self.mark_has_anchors(child, structure, appended);
        }
        self.mark_positional_anchors(child, positional);
    }

    /// A text node's text became empty or stopped being.
    pub(super) fn has_text_emptiness_changed(&mut self, text: u64) {
        let positional = self.sheets.index.invalidation.has.positional;
        self.mark_positional_anchors(text, positional);
    }

    /// Every anchor among the ancestors of `changed` and the siblings of those and of `changed`.
    fn mark_positional_anchors(&mut self, changed: u64, mark: Reach) {
        if mark.is_empty() {
            return;
        }
        let mut found = Vec::new();
        let mut at = changed;
        while let Some(parent_id) = self.elements.get(&at).and_then(|element| element.parent) {
            if let Some(parent) = self.elements.get(&parent_id) {
                count_sibling_work(parent.children.len());
                found.extend(parent.children.iter().copied().filter(|id| self.holds_anchor_key(*id)));
            }
            if self.holds_anchor_key(parent_id) {
                found.push(parent_id);
            }
            at = parent_id;
        }
        for anchor in found {
            self.sheets.mark(anchor, mark);
        }
    }
}
