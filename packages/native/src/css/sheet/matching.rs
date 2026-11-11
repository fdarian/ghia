//! Right-to-left matching of a [`ComplexSelector`] against anything that can answer
//! [`ElementView`].

use std::borrow::Cow;
use std::ops::Deref;
use std::sync::Arc;

use super::atoms::Atom;
use super::selector::{AttrName, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, Simple};

/// An attribute's text: borrowed from the element, or shared with a cache that made it (the
/// `style` attribute, which is not stored anywhere as text).
pub enum AttrValue<'a> {
    Text(Cow<'a, str>),
    Shared(Arc<str>),
}

impl Deref for AttrValue<'_> {
    type Target = str;

    fn deref(&self) -> &str {
        match self {
            AttrValue::Text(text) => text,
            AttrValue::Shared(text) => text,
        }
    }
}

/// One element of a tree, cheap to copy (a handle).
pub trait ElementView: Sized {
    /// The tag name an element compares a type selector against: lower-cased for an HTML element,
    /// as given for an SVG one. `None` when no sheet names it.
    fn tag(&self) -> Option<Atom>;
    fn is_svg(&self) -> bool;
    /// `None` when the element has no id, or one no sheet names.
    fn id(&self) -> Option<Atom>;
    fn has_class(&self, class: Atom) -> bool;
    /// The value of the attribute, which includes `id` and `class` when a selector asks for them
    /// by attribute.
    fn attr(&self, name: AttrName) -> Option<AttrValue<'_>>;
    fn parent(&self) -> Option<Self>;
    /// The closest preceding sibling that is an element.
    fn prev_sibling(&self) -> Option<Self>;
    fn is_root(&self) -> bool;

    /// Whether `satisfies` holds for some sibling before this one. `key` names `satisfies` (it is
    /// the same for every element it is asked of, and its answer for a sibling does not depend on
    /// this element), so an implementation can remember what it learnt about a parent's children
    /// and answer the next sibling without walking them again: `.x ~ .item` over n siblings and
    /// no `.x` is n steps, not n squared.
    fn any_earlier_sibling(&self, _key: SiblingTest, satisfies: impl Fn(&Self) -> bool) -> bool {
        let mut sibling = self.prev_sibling();
        while let Some(candidate) = sibling {
            if satisfies(&candidate) {
                return true;
            }
            sibling = candidate.prev_sibling();
        }
        false
    }
}

/// Which `satisfies` of [`ElementView::any_earlier_sibling`]: the address of the selector it is
/// part of, which does not move while a pass of matching runs, and the compound it starts at.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct SiblingTest {
    selector: usize,
    compound: usize,
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
            let test = SiblingTest { selector: std::ptr::from_ref(selector) as usize, compound: index + 1 };
            element.any_earlier_sibling(test, |sibling| matches_from(selector, index + 1, sibling))
        }
    }
}

fn compound_matches(compound: &Compound, element: &impl ElementView) -> bool {
    compound.simples.iter().all(|simple| simple_matches(simple, element))
}

fn simple_matches<E: ElementView>(simple: &Simple, element: &E) -> bool {
    match simple {
        Simple::Tag(tag) => element.tag() == Some(tag.for_element(element.is_svg())),
        Simple::Class(class) => element.has_class(*class),
        Simple::Id(id) => element.id() == Some(*id),
        Simple::Attr(attr) => attr_matches(attr, element),
        Simple::Is(list) => list.iter().any(|selector| matches(selector, element)),
        Simple::Where(list) => list.iter().any(|selector| matches(selector, element)),
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
    let actual: &str = &actual;
    let expected: &str = &matcher.value;
    let same = |a: &str, b: &str| text_equals(a, b, matcher.case_insensitive);
    match matcher.op {
        AttrOp::Equals => same(actual, expected),
        AttrOp::Includes => {
            !expected.is_empty()
                && !expected.contains(char::is_whitespace)
                && actual.split_whitespace().any(|word| same(word, expected))
        }
        AttrOp::DashMatch => {
            same(actual, expected)
                || (actual.len() > expected.len()
                    && actual.as_bytes()[expected.len()] == b'-'
                    && text_equals(&actual[..expected.len()], expected, matcher.case_insensitive))
        }
        AttrOp::Prefix => {
            !expected.is_empty()
                && actual.len() >= expected.len()
                && bytes_equal(&actual.as_bytes()[..expected.len()], expected.as_bytes(), matcher.case_insensitive)
        }
        AttrOp::Suffix => {
            !expected.is_empty()
                && actual.len() >= expected.len()
                && bytes_equal(&actual.as_bytes()[actual.len() - expected.len()..], expected.as_bytes(), matcher.case_insensitive)
        }
        AttrOp::Substring => {
            !expected.is_empty()
                && actual
                    .as_bytes()
                    .windows(expected.len())
                    .any(|window| bytes_equal(window, expected.as_bytes(), matcher.case_insensitive))
        }
    }
}

fn bytes_equal(a: &[u8], b: &[u8], case_insensitive: bool) -> bool {
    if case_insensitive {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn text_equals(a: &str, b: &str, case_insensitive: bool) -> bool {
    bytes_equal(a.as_bytes(), b.as_bytes(), case_insensitive)
}
