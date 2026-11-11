//! Selectors as the matcher wants them: a complex selector stored right to left.

use std::ops::Deref;
use std::sync::Arc;

use super::atoms::Atom;

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
    /// Parses, but nothing in a document is a shadow host.
    Host,
    /// `::x` and the legacy `:before`, `:after`, `:first-line`, `:first-letter`: they style a part
    /// of an element, so a selector holding one matches no element.
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
        self.compounds
            .iter()
            .flat_map(|compound| &compound.simples)
            .fold(Specificity::default(), |total, simple| total.add(simple.specificity()))
    }

    /// Whether the selector can ever match an element.
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
            Simple::Class(_) | Simple::Attr(_) | Simple::Root | Simple::Host => Specificity::new(0, 1, 0),
            Simple::Id(_) => Specificity::new(1, 0, 0),
            Simple::Is(list) => list.specificity,
            Simple::Not(list) => most_specific(list),
            Simple::Where(_) => Specificity::default(),
        }
    }
}

/// The argument of `:is()` and `:not()` counts as its most specific selector, matching or not.
fn most_specific(list: &[ComplexSelector]) -> Specificity {
    list.iter().map(ComplexSelector::specificity).max().unwrap_or_default()
}
