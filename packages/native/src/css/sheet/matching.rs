//! Right-to-left matching of a [`ComplexSelector`] against anything that can answer
//! [`ElementView`].

use std::borrow::Cow;

use super::atoms::Atom;
use super::selector::{AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, Simple};

/// One element of a tree, cheap to copy (a handle).
pub trait ElementView: Sized {
    /// The lower-cased tag name.
    fn tag(&self) -> Atom;
    /// `None` when the element has no id, or one no sheet names.
    fn id(&self) -> Option<Atom>;
    fn has_class(&self, class: Atom) -> bool;
    /// The value of the attribute, which includes `id` and `class` when a selector asks for them
    /// by attribute.
    fn attr(&self, name: Atom) -> Option<Cow<'_, str>>;
    fn parent(&self) -> Option<Self>;
    /// The closest preceding sibling that is an element.
    fn prev_sibling(&self) -> Option<Self>;
    fn is_root(&self) -> bool;
}

pub fn matches(selector: &ComplexSelector, element: &impl ElementView) -> bool {
    matches_from(selector, 0, element)
}

fn matches_from<E: ElementView>(selector: &ComplexSelector, index: usize, element: &E) -> bool {
    if !compound_matches(&selector.compounds[index], element) {
        return false;
    }
    if index + 1 == selector.compounds.len() {
        return true;
    }
    match selector.links[index] {
        Combinator::Child => element.parent().is_some_and(|parent| matches_from(selector, index + 1, &parent)),
        Combinator::NextSibling => {
            element.prev_sibling().is_some_and(|sibling| matches_from(selector, index + 1, &sibling))
        }
        Combinator::Descendant => {
            let mut ancestor = element.parent();
            while let Some(candidate) = ancestor {
                if matches_from(selector, index + 1, &candidate) {
                    return true;
                }
                ancestor = candidate.parent();
            }
            false
        }
        Combinator::SubsequentSibling => {
            let mut sibling = element.prev_sibling();
            while let Some(candidate) = sibling {
                if matches_from(selector, index + 1, &candidate) {
                    return true;
                }
                sibling = candidate.prev_sibling();
            }
            false
        }
    }
}

fn compound_matches(compound: &Compound, element: &impl ElementView) -> bool {
    compound.simples.iter().all(|simple| simple_matches(simple, element))
}

fn simple_matches<E: ElementView>(simple: &Simple, element: &E) -> bool {
    match simple {
        Simple::Tag(tag) => element.tag() == *tag,
        Simple::Class(class) => element.has_class(*class),
        Simple::Id(id) => element.id() == Some(*id),
        Simple::Attr(attr) => attr_matches(attr, element),
        Simple::Is(list) | Simple::Where(list) => list.iter().any(|selector| matches(selector, element)),
        Simple::Not(list) => !list.iter().any(|selector| matches(selector, element)),
        Simple::Root => element.is_root(),
        Simple::Host | Simple::PseudoElement => false,
    }
}

fn attr_matches(selector: &AttrSelector, element: &impl ElementView) -> bool {
    let Some(actual) = element.attr(selector.name) else {
        return false;
    };
    let Some(matcher) = &selector.matcher else {
        return true;
    };
    let (actual, expected) = if matcher.case_insensitive {
        (actual.to_lowercase(), matcher.value.to_lowercase())
    } else {
        (actual.into_owned(), matcher.value.clone())
    };
    match matcher.op {
        AttrOp::Equals => actual == expected,
        AttrOp::Includes => {
            !expected.is_empty()
                && !expected.contains(char::is_whitespace)
                && actual.split_whitespace().any(|word| word == expected)
        }
        AttrOp::DashMatch => {
            actual == expected || (actual.starts_with(&expected) && actual[expected.len()..].starts_with('-'))
        }
        AttrOp::Prefix => !expected.is_empty() && actual.starts_with(&expected),
        AttrOp::Suffix => !expected.is_empty() && actual.ends_with(&expected),
        AttrOp::Substring => !expected.is_empty() && actual.contains(&expected),
    }
}
