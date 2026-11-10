//! What a change can reach, so a toggled class marks the elements a selector could read it from
//! and no others.
//!
//! A selector reads a feature (a class, an id, an attribute name) on the element matching some
//! compound of it, and the element it styles is the subject, reached from there by the
//! combinators to the compound's right. Walking them from the feature gives where the affected
//! elements sit relative to the changed one: a [`Reach`]. A feature that no selector names has
//! no entry, and a change to it marks nothing.

use rustc_hash::FxHashMap;

use super::atoms::Atom;
use super::selector::{Combinator, ComplexSelector, Simple};

/// A set of places relative to an element: it, its children, everything below it, and the same
/// for its next sibling and for all its following siblings. Nine bits, `sibling * 3 + depth`.
/// "Children" and "below" are about the sibling named, so `NEXT_SIBLING_CHILDREN` is the
/// children of the next sibling.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct Reach(u16);

const DEPTH_MASK: u16 = 0b111;

impl Reach {
    // Only the tests read the places by name: a reach is built by walking combinators.
    pub const SELF: Reach = Reach(1 << 0);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const CHILDREN: Reach = Reach(1 << 1);
    pub const DESCENDANTS: Reach = Reach(1 << 2);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const NEXT_SIBLING: Reach = Reach(1 << 3);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const NEXT_SIBLING_CHILDREN: Reach = Reach(1 << 4);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const NEXT_SIBLING_DESCENDANTS: Reach = Reach(1 << 5);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const FOLLOWING_SIBLINGS: Reach = Reach(1 << 6);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const FOLLOWING_SIBLINGS_CHILDREN: Reach = Reach(1 << 7);
    #[cfg_attr(not(test), allow(dead_code))]
    pub const FOLLOWING_SIBLINGS_DESCENDANTS: Reach = Reach(1 << 8);

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn contains(self, other: Reach) -> bool {
        self.0 & other.0 == other.0
    }

    /// Where the elements that a selector reaches through `chain` sit, when the element that
    /// changed matches the compound the chain starts from. `chain` is read from that compound
    /// toward the subject.
    fn through(self, chain: &[Combinator]) -> Reach {
        chain.iter().fold(self, |reach, link| reach.step(*link))
    }

    fn step(self, link: Combinator) -> Reach {
        let mut out = 0;
        for sibling in 0..3u16 {
            for depth in 0..3u16 {
                if self.0 & (1 << (sibling * 3 + depth)) == 0 {
                    continue;
                }
                let (sibling, depth) = match link {
                    Combinator::Child => (sibling, if depth == 0 { 1 } else { 2 }),
                    Combinator::Descendant => (sibling, 2),
                    // The siblings of a child or of anything below are still those.
                    Combinator::NextSibling if depth == 0 => (if sibling == 0 { 1 } else { 2 }, 0),
                    Combinator::SubsequentSibling if depth == 0 => (2, 0),
                    Combinator::NextSibling | Combinator::SubsequentSibling => (sibling, depth),
                };
                out |= 1 << (sibling * 3 + depth);
            }
        }
        Reach(out)
    }

    /// The places of the element itself, as depths: bit 0 itself, bit 1 its children, bit 2 below.
    pub fn own(self) -> u8 {
        (self.0 & DEPTH_MASK) as u8
    }

    pub fn next_sibling(self) -> u8 {
        ((self.0 >> 3) & DEPTH_MASK) as u8
    }

    pub fn following_siblings(self) -> u8 {
        ((self.0 >> 6) & DEPTH_MASK) as u8
    }

    pub fn reaches_siblings(self) -> bool {
        self.0 >> 3 != 0
    }

    /// The same places seen from the next sibling instead: used when an element is gone and what
    /// was after it is what is left to mark.
    pub fn from_next_sibling(self) -> Reach {
        let next = (self.0 >> 3) & DEPTH_MASK;
        let following = (self.0 >> 6) & DEPTH_MASK;
        Reach(next | following | (following << 6))
    }
}

impl std::ops::BitOr for Reach {
    type Output = Reach;

    fn bitor(self, other: Reach) -> Reach {
        Reach(self.0 | other.0)
    }
}

impl std::ops::BitOrAssign for Reach {
    fn bitor_assign(&mut self, other: Reach) {
        self.0 |= other.0;
    }
}

/// The reach of every feature the selectors of a document read.
#[derive(Default)]
pub struct Invalidation {
    pub classes: FxHashMap<Atom, Reach>,
    pub ids: FxHashMap<Atom, Reach>,
    /// By attribute name, `class` and `id` included when a selector writes them as attributes,
    /// and `style` for the text of an own style.
    pub attributes: FxHashMap<Atom, Reach>,
    /// What an element appearing or disappearing among its siblings can reach: the places
    /// that sibling combinators look at it from.
    pub structure: Reach,
}

impl Invalidation {
    pub fn read(&mut self, selector: &ComplexSelector) {
        self.read_through(selector, &[]);
    }

    /// `tail` is what leads on from the subject of `selector` to the subject of the selector it
    /// is an argument of: empty for a selector that is not one.
    ///
    /// A feature in an argument has the reach it has through the argument's own combinators and
    /// then through the rest of the selector that holds it, so `:is(.a .b)` is read as the
    /// descendant combinator it holds and the combinators around it.
    fn read_through(&mut self, selector: &ComplexSelector, tail: &[Combinator]) {
        for (position, compound) in selector.compounds.iter().enumerate() {
            let chain = chain_from(selector, position, tail);
            let reach = Reach::SELF.through(&chain);
            for simple in &compound.simples {
                match simple {
                    Simple::Class(class) => *self.classes.entry(*class).or_default() |= reach,
                    Simple::Id(id) => *self.ids.entry(*id).or_default() |= reach,
                    Simple::Attr(attr) => *self.attributes.entry(attr.name).or_default() |= reach,
                    Simple::Is(list) | Simple::Where(list) | Simple::Not(list) => {
                        for inner in list {
                            self.read_through(inner, &chain);
                        }
                    }
                    Simple::Tag(_) | Simple::Root | Simple::Host | Simple::PseudoElement => {}
                }
            }
        }
        for (position, link) in selector.links.iter().enumerate() {
            if matches!(link, Combinator::NextSibling | Combinator::SubsequentSibling) {
                // The element in the way sits where the compound left of the link matches.
                self.structure |= Reach::SELF.through(&chain_from(selector, position + 1, tail));
            }
        }
    }

}

/// The links from the compound at `position` to the subject, then `tail`.
fn chain_from(selector: &ComplexSelector, position: usize, tail: &[Combinator]) -> Vec<Combinator> {
    let mut chain: Vec<Combinator> = selector.links[..position].iter().rev().copied().collect();
    chain.extend_from_slice(tail);
    chain
}

#[cfg(test)]
mod tests {
    use super::super::atoms::Atoms;
    use super::super::layers::Layers;
    use super::super::parser::parse_sheet;
    use super::*;

    struct Read {
        atoms: Atoms,
        invalidation: Invalidation,
    }

    fn read(selector: &str) -> Read {
        let mut atoms = Atoms::default();
        let sheet = parse_sheet(&format!("{selector} {{ color: red }}"), &mut atoms, &mut Layers::default());
        let mut invalidation = Invalidation::default();
        for (selector, _) in &sheet.rules[0].selectors {
            invalidation.read(selector);
        }
        Read { atoms, invalidation }
    }

    impl Read {
        fn class(&self, name: &str) -> Reach {
            self.invalidation.classes[&self.atoms.get(name).unwrap()]
        }
    }

    #[test]
    fn a_feature_reaches_what_the_combinators_lead_to() {
        assert_eq!(read(".a").class("a"), Reach::SELF);
        let descendant = read(".a .b");
        assert_eq!(descendant.class("a"), Reach::DESCENDANTS);
        assert_eq!(descendant.class("b"), Reach::SELF);
        assert_eq!(read(".a > .b").class("a"), Reach::CHILDREN);
        assert_eq!(read(".a + .b").class("a"), Reach::NEXT_SIBLING);
        assert_eq!(read(".a ~ .b").class("a"), Reach::FOLLOWING_SIBLINGS);
    }

    #[test]
    fn a_sibling_combinator_with_a_descendant_one_after_it_reaches_below_the_siblings() {
        assert_eq!(read(".a + .b .c").class("a"), Reach::NEXT_SIBLING_DESCENDANTS);
        assert_eq!(read(".a ~ .b > .c").class("a"), Reach::FOLLOWING_SIBLINGS_CHILDREN);
        assert_eq!(read(".a ~ .b .c").class("a"), Reach::FOLLOWING_SIBLINGS_DESCENDANTS);
        assert_eq!(read(".a + .b + .c").class("a"), Reach::FOLLOWING_SIBLINGS, "two places on, conservatively all after");
        assert_eq!(read(".a > .b + .c").class("a"), Reach::CHILDREN);
        assert_eq!(read(".a > .b > .c").class("a"), Reach::DESCENDANTS);
    }

    #[test]
    fn a_feature_in_an_argument_takes_the_place_of_the_compound_that_holds_it() {
        assert_eq!(read(":not(.a)").class("a"), Reach::SELF);
        let parent = read(":is(.a, .b) > .c");
        assert_eq!(parent.class("a"), Reach::CHILDREN);
        assert_eq!(parent.class("b"), Reach::CHILDREN);
        let nested = read(":is(.a .b)");
        assert_eq!(nested.class("a"), Reach::DESCENDANTS);
        assert_eq!(nested.class("b"), Reach::SELF);
        assert_eq!(read(".x :where(.a + .b)").class("a"), Reach::NEXT_SIBLING);
    }

    #[test]
    fn a_selector_without_a_sibling_combinator_reaches_nothing_by_structure() {
        assert!(read(".a .b > .c").invalidation.structure == Reach::default());
        assert_eq!(read(".a + .b").invalidation.structure, Reach::NEXT_SIBLING);
        assert_eq!(read(".a ~ .b .c").invalidation.structure, Reach::FOLLOWING_SIBLINGS_DESCENDANTS);
        assert!(read(".a + .b").invalidation.structure.contains(Reach::NEXT_SIBLING));
    }

    #[test]
    fn attribute_and_id_features_are_recorded_by_name() {
        let read = read("#x [data-k] > .c");
        assert_eq!(read.invalidation.ids[&read.atoms.get("x").unwrap()], Reach::DESCENDANTS);
        assert_eq!(read.invalidation.attributes[&read.atoms.get("data-k").unwrap()], Reach::CHILDREN);
    }

    #[test]
    fn reach_from_the_next_sibling_shifts_the_siblings_down() {
        let following = Reach::FOLLOWING_SIBLINGS_CHILDREN | Reach::NEXT_SIBLING;
        assert_eq!(
            following.from_next_sibling(),
            Reach::SELF | Reach::CHILDREN | Reach::FOLLOWING_SIBLINGS_CHILDREN
        );
    }
}
