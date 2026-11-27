//! Selectors as the matcher wants them: a complex selector stored right to left.

use std::ops::Deref;
use std::sync::Arc;

use super::atoms::Atom;
use super::has::HasArguments;
use super::nth::Position;
use super::pseudo::Pseudo;
use super::states::State;
use super::tree_states::TreeState;

/// What a [`ComplexSelector`] link says about the compound to its left.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Combinator {
    /// `a b`: the left compound matches some ancestor.
    Descendant,
    /// `a > b`: the left compound matches the parent.
    Child,
    /// `a + b`: the left compound matches the previous sibling.
    NextSibling,
    /// `a ~ b`: the left compound matches some earlier sibling.
    SubsequentSibling,
}

/// `compounds[0]` is the subject, the compound the element itself must match; `links[i]` joins
/// `compounds[i]` to `compounds[i + 1]`, the one written to its left.
#[derive(Clone, PartialEq, Debug)]
pub struct ComplexSelector {
    pub compounds: Vec<Compound>,
    pub links: Vec<Combinator>,
    /// The pointer or focus state the subject needs (`.a:hover`): not something the matcher
    /// reads, the rule applies under it (`states.rs`).
    pub condition: Option<State>,
    /// The generated box the selector styles (`.a::before`): `compounds` are then the originating
    /// element's, which the matcher reads, and the box is the target of the rule. A selector that
    /// is an argument of `:is()` and the like has none, and one that is the parent of a nested rule
    /// matches nothing.
    pub pseudo: Option<Pseudo>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Compound {
    pub simples: Vec<Simple>,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Simple {
    Tag(TypeName),
    Class(Atom),
    Id(Atom),
    Attr(AttrSelector),
    /// `:is()`, and `&` of a nested rule (its parent's selector list).
    Is(SelectorList),
    /// `:where()`: matches like `:is()`, contributes no specificity.
    Where(Vec<ComplexSelector>),
    Not(Vec<ComplexSelector>),
    Root,
    /// `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within`. Matches any element:
    /// the selector's [`ComplexSelector::condition`] carries it, since these are not tree state.
    State(State),
    /// `:popover-open`, `:disabled`, `:checked`, `:required`, `:read-write`, `:any-link` and the
    /// rest that read what the tree holds of the element.
    TreeState(TreeState),
    /// `:first-child`, `:nth-child()`, `:only-of-type`, `:empty` and the rest that read where an
    /// element stands among its siblings or what it holds.
    Position(Position),
    /// `:has()`: the element has something that one of the relative selectors matches.
    Has(HasArguments),
    /// Parses, but nothing in a document is a shadow host.
    Host,
    /// `::x` other than `::before` and `::after`, and the legacy `:first-line` and `:first-letter`:
    /// they style a part of an element this engine has no box for, so a selector holding one
    /// matches nothing ([`ComplexSelector::pseudo`] is the one that does).
    PseudoElement,
}

/// A selector list that `&` can share: nesting `n` deep copies a pointer per `&`, not the list,
/// and the specificity is worked out once, not once per level below.
#[derive(Clone, PartialEq, Debug)]
pub struct SelectorList {
    selectors: Arc<[ComplexSelector]>,
    specificity: Specificity,
}

impl SelectorList {
    pub fn new(selectors: Vec<ComplexSelector>) -> Self {
        let specificity = most_specific(&selectors);
        SelectorList { selectors: selectors.into(), specificity }
    }
}

impl Deref for SelectorList {
    type Target = [ComplexSelector];

    fn deref(&self) -> &[ComplexSelector] {
        &self.selectors
    }
}

/// The name a selector writes as a type. An HTML element's type is case-insensitive and compares
/// `lower`; an SVG element's is case-sensitive (`linearGradient`) and compares `written`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TypeName {
    pub lower: Atom,
    pub written: Atom,
}

impl TypeName {
    /// The atom an element of this kind compares the type against.
    pub fn for_element(self, is_svg: bool) -> Atom {
        if is_svg {
            self.written
        } else {
            self.lower
        }
    }
}

/// The name a selector writes for an attribute. An HTML element holds lower-cased names and
/// compares `lower`; an SVG element holds the name as written (`viewBox`) and compares `written`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct AttrName {
    pub lower: Atom,
    pub written: Atom,
}

#[derive(Clone, PartialEq, Debug)]
pub struct AttrSelector {
    pub name: AttrName,
    pub matcher: Option<AttrMatcher>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct AttrMatcher {
    pub op: AttrOp,
    pub value: String,
    pub case_insensitive: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AttrOp {
    /// `=`
    Equals,
    /// `~=`
    Includes,
    /// `|=`
    DashMatch,
    /// `^=`
    Prefix,
    /// `$=`
    Suffix,
    /// `*=`
    Substring,
}

/// Compares ids first, then classes, then types.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Default)]
pub struct Specificity {
    pub ids: u32,
    pub classes: u32,
    pub types: u32,
}

impl Specificity {
    pub const fn new(ids: u32, classes: u32, types: u32) -> Self {
        Specificity { ids, classes, types }
    }

    fn add(self, other: Specificity) -> Specificity {
        Specificity::new(
            self.ids.saturating_add(other.ids),
            self.classes.saturating_add(other.classes),
            self.types.saturating_add(other.types),
        )
    }
}

impl ComplexSelector {
    pub fn specificity(&self) -> Specificity {
        let total = self
            .compounds
            .iter()
            .flat_map(|compound| &compound.simples)
            .fold(Specificity::default(), |total, simple| total.add(simple.specificity()));
        if self.pseudo.is_some() {
            total.add(Specificity::new(0, 0, 1))
        } else {
            total
        }
    }

    /// Whether the selector names a pseudo-element that is never matched.
    pub fn has_pseudo_element(&self) -> bool {
        self.compounds
            .iter()
            .any(|compound| compound.simples.iter().any(|simple| matches!(simple, Simple::PseudoElement)))
    }
}

impl Simple {
    fn specificity(&self) -> Specificity {
        match self {
            Simple::Tag(_) | Simple::PseudoElement => Specificity::new(0, 0, 1),
            Simple::Class(_)
            | Simple::Attr(_)
            | Simple::Root
            | Simple::Host
            | Simple::State(_)
            | Simple::TreeState(_)
            | Simple::Position(_) => {
                Specificity::new(0, 1, 0)
            }
            Simple::Id(_) => Specificity::new(1, 0, 0),
            Simple::Is(list) => list.specificity,
            Simple::Has(arguments) => arguments.specificity(),
            Simple::Not(list) => most_specific(list),
            Simple::Where(_) => Specificity::default(),
        }
    }
}

/// The argument of `:is()` and `:not()` counts as its most specific selector, matching or not.
fn most_specific(list: &[ComplexSelector]) -> Specificity {
    list.iter().map(ComplexSelector::specificity).max().unwrap_or_default()
}
