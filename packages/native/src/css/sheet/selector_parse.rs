//! Selectors 4 from tokens. A selector this engine cannot match (any other pseudo-class,
//! namespaces) is invalid, and an invalid selector in a rule's list drops the whole rule; only
//! `:is()` and `:where()` forgive, by dropping the argument.

use super::atoms::Atoms;
use super::has::{HasArguments, RelativeSelector};
use super::nth::{AnPlusB, Position};
use super::pseudo::Pseudo;
use super::states::{self, State};
use super::tree_states::TreeState;
use super::selector::{
    AttrMatcher, AttrName, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, SelectorList, Simple, Specificity, TypeName,
};
use super::tokenizer::{find_close, trim, Kind, Token};

#[derive(Debug, PartialEq)]
pub(super) struct InvalidSelector;

/// Functional pseudo-classes nest this deep; a deeper one is invalid, so hostile input cannot
/// overflow the stack.
pub(super) const MAX_FUNCTION_DEPTH: usize = 32;

/// What `&` stands for.
#[derive(Clone, Copy)]
pub(super) enum Nesting<'a> {
    /// A top-level rule: `&` is `:scope`, the root element.
    Top,
    /// A nested rule: `&` is `:is(parent selector list)`, and a selector that does not mention
    /// `&` is relative to it.
    Parent(&'a SelectorList),
}

pub(super) fn parse_selector_list(
    src: &str,
    tokens: &[Token],
    atoms: &mut Atoms,
    nesting: Nesting,
) -> Result<Vec<(ComplexSelector, Specificity)>, InvalidSelector> {
    let mut parser = Parser { src, atoms, nesting, saw_nesting: false, depth: 0, in_has: false, state_in_has: false };
    let relative = matches!(nesting, Nesting::Parent(_));
    let list = parser.list(tokens, false, relative, true)?;
    if list.is_empty() {
        return Err(InvalidSelector);
    }
    Ok(list.into_iter().map(|selector| {
        let specificity = selector.specificity();
        (selector, specificity)
    }).collect())
}

struct Parser<'a, 'n> {
    /// The text the tokens index, for the digits of an `An+B`.
    src: &'a str,
    atoms: &'a mut Atoms,
    nesting: Nesting<'n>,
    /// Whether the complex selector being parsed has named `&` so far.
    saw_nesting: bool,
    /// How many `:is(`, `:where(`, `:not(` and `:has(` the selector being parsed sits inside.
    depth: usize,
    /// Whether the selector being parsed is inside a `:has(`, where `:has()` nests no deeper and
    /// the states of the pointer and the focus are not read (a state in the subject compiles into
    /// the style block of the subject, which an element inside the argument is not, and the live
    /// states a change of the pointer marks do not reach the anchors of a `:has()`).
    in_has: bool,
    /// Whether a state was met inside the `:has(` being parsed, written there or brought in by `&`.
    /// A forgiving `:is()` drops the argument that holds it, so the `:has(` checks this when it ends.
    state_in_has: bool,
}

/// What `::name` or a legacy `:name` parsed to.
enum Parsed {
    Simple(Simple),
    /// `::before` or `::after`: not part of the compound, which is the originating element's.
    Generated(Pseudo),
}

fn combinator_of(kind: &Kind) -> Option<Combinator> {
    match kind {
        Kind::Delim('>') => Some(Combinator::Child),
        Kind::Delim('+') => Some(Combinator::NextSibling),
        Kind::Delim('~') => Some(Combinator::SubsequentSibling),
        _ => None,
    }
}

/// `(of_type, from_end)` of the functional pseudo-classes that take an `An+B`.
fn nth_function(name: &str) -> Option<(bool, bool)> {
    match name {
        "nth-child" => Some((false, false)),
        "nth-last-child" => Some((false, true)),
        "nth-of-type" => Some((true, false)),
        "nth-last-of-type" => Some((true, true)),
        _ => None,
    }
}

fn split_commas(tokens: &[Token]) -> Vec<&[Token]> {
    let mut pieces = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (index, token) in tokens.iter().enumerate() {
        if token.kind.is_opener() {
            depth += 1;
        } else if token.kind.is_closer() {
            depth = depth.saturating_sub(1);
        } else if token.kind == Kind::Comma && depth == 0 {
            pieces.push(&tokens[start..index]);
            start = index + 1;
        }
    }
    pieces.push(&tokens[start..]);
    pieces
}

impl Parser<'_, '_> {
    fn list(
        &mut self,
        tokens: &[Token],
        forgiving: bool,
        relative: bool,
        allow_pseudo_element: bool,
    ) -> Result<Vec<ComplexSelector>, InvalidSelector> {
        let mut list = Vec::new();
        for piece in split_commas(tokens) {
            let piece = trim(piece);
            let parsed = if piece.is_empty() {
                Err(InvalidSelector)
            } else {
                self.complex(piece, relative, allow_pseudo_element)
            };
            match parsed {
                Ok(selector) => list.push(selector),
                Err(_) if forgiving => {}
                Err(error) => return Err(error),
            }
        }
        Ok(list)
    }

    fn complex(
        &mut self,
        tokens: &[Token],
        relative: bool,
        allow_pseudo_element: bool,
    ) -> Result<ComplexSelector, InvalidSelector> {
        let outer_saw_nesting = std::mem::replace(&mut self.saw_nesting, false);
        let parsed = self.complex_parts(tokens, relative, allow_pseudo_element);
        let saw_nesting = self.saw_nesting;
        self.saw_nesting = outer_saw_nesting || saw_nesting;
        let (mut parts, pseudo) = parsed?;
        if let Nesting::Parent(parent) = self.nesting {
            if relative {
                let leading = combinator_of(&tokens[0].kind);
                if leading.is_some() || !saw_nesting {
                    let implicit = Compound { simples: vec![Simple::Is(parent.clone())] };
                    parts.insert(0, (implicit, Some(leading.unwrap_or(Combinator::Descendant))));
                }
            }
        }
        // Stored subject first.
        let mut compounds = Vec::with_capacity(parts.len());
        let mut links = Vec::with_capacity(parts.len());
        for (compound, link) in parts.into_iter().rev() {
            compounds.push(compound);
            links.extend(link);
        }
        let condition = states::condition_of(&compounds).map_err(|_| InvalidSelector)?;
        Ok(ComplexSelector { compounds, links, condition, pseudo })
    }

    /// The compounds left to right, each with the combinator to the next, and the generated box
    /// the last one ends in.
    fn complex_parts(
        &mut self,
        tokens: &[Token],
        relative: bool,
        allow_pseudo_element: bool,
    ) -> Result<(Vec<(Compound, Option<Combinator>)>, Option<Pseudo>), InvalidSelector> {
        let mut parts = Vec::new();
        let mut index = 0;
        if relative && combinator_of(&tokens[0].kind).is_some() {
            index = 1;
            skip_whitespace(tokens, &mut index);
        }
        loop {
            let (compound, pseudo) = self.compound(tokens, &mut index, allow_pseudo_element)?;
            let before = index;
            skip_whitespace(tokens, &mut index);
            if index == tokens.len() {
                parts.push((compound, None));
                return Ok((parts, pseudo));
            }
            // A generated box is the end of the selector: nothing styles what is inside it.
            if pseudo.is_some() {
                return Err(InvalidSelector);
            }
            let spaced = index > before;
            let link = match combinator_of(&tokens[index].kind) {
                Some(combinator) => {
                    index += 1;
                    skip_whitespace(tokens, &mut index);
                    combinator
                }
                None if spaced => Combinator::Descendant,
                None => return Err(InvalidSelector),
            };
            parts.push((compound, Some(link)));
        }
    }

    fn compound(
        &mut self,
        tokens: &[Token],
        index: &mut usize,
        allow_pseudo_element: bool,
    ) -> Result<(Compound, Option<Pseudo>), InvalidSelector> {
        let mut simples = Vec::new();
        let mut has_type = false;
        let mut generated = None;
        while let Some(token) = tokens.get(*index) {
            if token.kind == Kind::Whitespace || combinator_of(&token.kind).is_some() {
                break;
            }
            // `::before:hover` and `::before::marker` are not selectors: a generated box takes no
            // user-action state and has no pseudo-element of its own here.
            if generated.is_some() {
                return Err(InvalidSelector);
            }
            match &token.kind {
                Kind::Ident(name) if !has_type && simples.is_empty() => {
                    has_type = true;
                    *index += 1;
                    simples.push(Simple::Tag(TypeName {
                        lower: self.atoms.intern(&name.to_ascii_lowercase()),
                        written: self.atoms.intern(name),
                    }));
                    self.reject_namespace(tokens, *index)?;
                }
                Kind::Delim('*') if !has_type && simples.is_empty() => {
                    has_type = true;
                    *index += 1;
                    self.reject_namespace(tokens, *index)?;
                }
                Kind::Delim('&') => {
                    *index += 1;
                    self.saw_nesting = true;
                    simples.push(match self.nesting {
                        Nesting::Top => Simple::Root,
                        Nesting::Parent(parent) => {
                            if self.in_has && parent.iter().any(states::reads_state) {
                                self.state_in_has = true;
                                return Err(InvalidSelector);
                            }
                            Simple::Is(parent.clone())
                        }
                    });
                }
                Kind::Delim('.') => match tokens.get(*index + 1).map(|next| &next.kind) {
                    Some(Kind::Ident(name)) => {
                        *index += 2;
                        simples.push(Simple::Class(self.atoms.intern(name)));
                    }
                    _ => return Err(InvalidSelector),
                },
                Kind::Hash { name, is_id: true } => {
                    *index += 1;
                    simples.push(Simple::Id(self.atoms.intern(name)));
                }
                Kind::OpenBracket => {
                    let close = find_close(tokens, *index);
                    let attribute = self.attribute(&tokens[*index + 1..close])?;
                    *index = (close + 1).min(tokens.len());
                    simples.push(Simple::Attr(attribute));
                }
                Kind::Colon => match self.pseudo(tokens, index, allow_pseudo_element)? {
                    Parsed::Simple(simple) => simples.push(simple),
                    Parsed::Generated(_) if simples.iter().any(|simple| matches!(simple, Simple::PseudoElement)) => {
                        return Err(InvalidSelector);
                    }
                    Parsed::Generated(pseudo) => generated = Some(pseudo),
                },
                _ => return Err(InvalidSelector),
            }
        }
        if simples.is_empty() && !has_type && generated.is_none() {
            return Err(InvalidSelector);
        }
        Ok((Compound { simples }, generated))
    }

    /// `ns|a` and `*|a` are not supported.
    fn reject_namespace(&self, tokens: &[Token], index: usize) -> Result<(), InvalidSelector> {
        let bar = tokens.get(index).is_some_and(|token| token.kind == Kind::Delim('|'));
        let attribute_operator = tokens.get(index + 1).is_some_and(|token| token.kind == Kind::Delim('='));
        if bar && !attribute_operator {
            return Err(InvalidSelector);
        }
        Ok(())
    }

    fn pseudo(
        &mut self,
        tokens: &[Token],
        index: &mut usize,
        allow_pseudo_element: bool,
    ) -> Result<Parsed, InvalidSelector> {
        *index += 1;
        let element = tokens.get(*index).is_some_and(|token| token.kind == Kind::Colon);
        if element {
            *index += 1;
        }
        let Some(token) = tokens.get(*index) else {
            return Err(InvalidSelector);
        };
        match &token.kind {
            Kind::Ident(name) => {
                *index += 1;
                let name = name.to_ascii_lowercase();
                if element || matches!(name.as_str(), "before" | "after" | "first-line" | "first-letter") {
                    if !allow_pseudo_element {
                        return Err(InvalidSelector);
                    }
                    return Ok(match Pseudo::named(&name) {
                        Some(pseudo) => Parsed::Generated(pseudo),
                        None => Parsed::Simple(Simple::PseudoElement),
                    });
                }
                let simple = match name.as_str() {
                    "root" => Ok(Simple::Root),
                    "host" => Ok(Simple::Host),
                    "hover" | "active" | "focus" | "focus-visible" | "focus-within" if self.in_has => {
                        self.state_in_has = true;
                        Err(InvalidSelector)
                    }
                    "hover" => Ok(Simple::State(State::Hover)),
                    "active" => Ok(Simple::State(State::Active)),
                    "focus" => Ok(Simple::State(State::Focus)),
                    "focus-visible" => Ok(Simple::State(State::FocusVisible)),
                    "focus-within" => Ok(Simple::State(State::FocusWithin)),
                    "first-child" => Ok(Simple::Position(Position::first(false))),
                    "last-child" => Ok(Simple::Position(Position::last(false))),
                    "only-child" => Ok(Simple::Position(Position::Only { of_type: false })),
                    "first-of-type" => Ok(Simple::Position(Position::first(true))),
                    "last-of-type" => Ok(Simple::Position(Position::last(true))),
                    "only-of-type" => Ok(Simple::Position(Position::Only { of_type: true })),
                    "empty" => Ok(Simple::Position(Position::Empty)),
                    _ => TreeState::parse(&name).map(Simple::TreeState).ok_or(InvalidSelector),
                };
                simple.map(Parsed::Simple)
            }
            Kind::Function(name) => {
                let close = find_close(tokens, *index);
                let arguments = &tokens[*index + 1..close];
                *index = (close + 1).min(tokens.len());
                let name = name.to_ascii_lowercase();
                if element {
                    return if allow_pseudo_element { Ok(Parsed::Simple(Simple::PseudoElement)) } else { Err(InvalidSelector) };
                }
                if let Some((of_type, from_end)) = nth_function(&name) {
                    // `of S` is not supported: it is left in the arguments, which then are no `An+B`.
                    let an_b = AnPlusB::parse(self.src, arguments).ok_or(InvalidSelector)?;
                    return Ok(Parsed::Simple(Simple::Position(Position::Nth { of_type, from_end, an_b })));
                }
                if !matches!(name.as_str(), "is" | "where" | "not" | "has") {
                    return Err(InvalidSelector);
                }
                if self.depth == MAX_FUNCTION_DEPTH {
                    return Err(InvalidSelector);
                }
                self.depth += 1;
                let result = self.functional_pseudo_class(&name, arguments);
                self.depth -= 1;
                result.map(Parsed::Simple)
            }
            _ => Err(InvalidSelector),
        }
    }

    fn functional_pseudo_class(&mut self, name: &str, arguments: &[Token]) -> Result<Simple, InvalidSelector> {
        match name {
            "is" => Ok(Simple::Is(SelectorList::new(self.list(arguments, true, false, false)?))),
            "where" => Ok(Simple::Where(self.list(arguments, true, false, false)?)),
            "not" => {
                let list = self.list(arguments, false, false, false)?;
                if list.is_empty() {
                    return Err(InvalidSelector);
                }
                Ok(Simple::Not(list))
            }
            "has" => {
                if self.in_has {
                    return Err(InvalidSelector);
                }
                self.in_has = true;
                self.state_in_has = false;
                let relatives = self.relative_list(arguments);
                self.in_has = false;
                if std::mem::take(&mut self.state_in_has) {
                    return Err(InvalidSelector);
                }
                Ok(Simple::Has(HasArguments::new(relatives?)))
            }
            _ => unreachable!("the caller passed only is, where, not and has"),
        }
    }

    /// The arguments of `:has()`: one invalid argument invalidates the selector.
    fn relative_list(&mut self, tokens: &[Token]) -> Result<Vec<RelativeSelector>, InvalidSelector> {
        split_commas(tokens)
            .into_iter()
            .map(|piece| {
                let piece = trim(piece);
                if piece.is_empty() {
                    return Err(InvalidSelector);
                }
                self.relative(piece)
            })
            .collect()
    }

    fn relative(&mut self, tokens: &[Token]) -> Result<RelativeSelector, InvalidSelector> {
        let leading = combinator_of(&tokens[0].kind).unwrap_or(Combinator::Descendant);
        let (parts, _) = self.complex_parts(tokens, true, false)?;
        let mut compounds = Vec::with_capacity(parts.len());
        let mut links = Vec::with_capacity(parts.len());
        for (compound, link) in parts.into_iter().rev() {
            compounds.push(compound);
            links.extend(link);
        }
        Ok(RelativeSelector { leading, selector: ComplexSelector { compounds, links, condition: None, pseudo: None } })
    }

    /// The tokens between `[` and `]`.
    fn attribute(&mut self, tokens: &[Token]) -> Result<AttrSelector, InvalidSelector> {
        let mut index = 0;
        skip_whitespace(tokens, &mut index);
        let name = match tokens.get(index).map(|token| &token.kind) {
            Some(Kind::Ident(name)) => name.clone(),
            _ => return Err(InvalidSelector),
        };
        index += 1;
        let name = AttrName { lower: self.atoms.intern(&name.to_ascii_lowercase()), written: self.atoms.intern(&name) };
        skip_whitespace(tokens, &mut index);
        if index == tokens.len() {
            return Ok(AttrSelector { name, matcher: None });
        }
        let op = match tokens[index].kind {
            Kind::Delim('=') => AttrOp::Equals,
            Kind::Delim(prefix) => {
                let op = match prefix {
                    '~' => AttrOp::Includes,
                    '|' => AttrOp::DashMatch,
                    '^' => AttrOp::Prefix,
                    '$' => AttrOp::Suffix,
                    '*' => AttrOp::Substring,
                    _ => return Err(InvalidSelector),
                };
                index += 1;
                if tokens.get(index).map(|token| &token.kind) != Some(&Kind::Delim('=')) {
                    return Err(InvalidSelector);
                }
                op
            }
            _ => return Err(InvalidSelector),
        };
        index += 1;
        skip_whitespace(tokens, &mut index);
        let value = match tokens.get(index).map(|token| &token.kind) {
            Some(Kind::Ident(value) | Kind::Str(value)) => value.clone(),
            _ => return Err(InvalidSelector),
        };
        index += 1;
        skip_whitespace(tokens, &mut index);
        let case_insensitive = match tokens.get(index).map(|token| &token.kind) {
            None => false,
            Some(Kind::Ident(flag)) if flag.eq_ignore_ascii_case("i") => true,
            Some(Kind::Ident(flag)) if flag.eq_ignore_ascii_case("s") => false,
            _ => return Err(InvalidSelector),
        };
        if index < tokens.len() {
            index += 1;
            skip_whitespace(tokens, &mut index);
            if index < tokens.len() {
                return Err(InvalidSelector);
            }
        }
        Ok(AttrSelector { name, matcher: Some(AttrMatcher { op, value, case_insensitive }) })
    }
}

fn skip_whitespace(tokens: &[Token], index: &mut usize) {
    while tokens.get(*index).is_some_and(|token| token.kind == Kind::Whitespace) {
        *index += 1;
    }
}
