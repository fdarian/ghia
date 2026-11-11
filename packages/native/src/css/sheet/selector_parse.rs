//! Selectors 4 from tokens. A selector this engine cannot match (any other pseudo-class,
//! namespaces) is invalid, and an invalid selector in a rule's list drops the whole rule; only
//! `:is()` and `:where()` forgive, by dropping the argument.

use super::atoms::Atoms;
use super::selector::{
    AttrMatcher, AttrName, AttrOp, AttrSelector, Combinator, ComplexSelector, Compound, SelectorList, Simple, Specificity,
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
    tokens: &[Token],
    atoms: &mut Atoms,
    nesting: Nesting,
) -> Result<Vec<(ComplexSelector, Specificity)>, InvalidSelector> {
    let mut parser = Parser { atoms, nesting, saw_nesting: false, depth: 0 };
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
    atoms: &'a mut Atoms,
    nesting: Nesting<'n>,
    /// Whether the complex selector being parsed has named `&` so far.
    saw_nesting: bool,
    /// How many `:is(`, `:where(` and `:not(` the selector being parsed sits inside.
    depth: usize,
}

fn combinator_of(kind: &Kind) -> Option<Combinator> {
    match kind {
        Kind::Delim('>') => Some(Combinator::Child),
        Kind::Delim('+') => Some(Combinator::NextSibling),
        Kind::Delim('~') => Some(Combinator::SubsequentSibling),
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
        let mut parts = parsed?;
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
        Ok(ComplexSelector { compounds, links })
    }

    /// The compounds left to right, each with the combinator to the next.
    fn complex_parts(
        &mut self,
        tokens: &[Token],
        relative: bool,
        allow_pseudo_element: bool,
    ) -> Result<Vec<(Compound, Option<Combinator>)>, InvalidSelector> {
        let mut parts = Vec::new();
        let mut index = 0;
        if relative && combinator_of(&tokens[0].kind).is_some() {
            index = 1;
            skip_whitespace(tokens, &mut index);
        }
        loop {
            let compound = self.compound(tokens, &mut index, allow_pseudo_element)?;
            let before = index;
            skip_whitespace(tokens, &mut index);
            if index == tokens.len() {
                parts.push((compound, None));
                return Ok(parts);
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
    ) -> Result<Compound, InvalidSelector> {
        let mut simples = Vec::new();
        let mut has_type = false;
        while let Some(token) = tokens.get(*index) {
            if token.kind == Kind::Whitespace || combinator_of(&token.kind).is_some() {
                break;
            }
            match &token.kind {
                Kind::Ident(name) if !has_type && simples.is_empty() => {
                    has_type = true;
                    *index += 1;
                    simples.push(Simple::Tag(self.atoms.intern(&name.to_ascii_lowercase())));
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
                        Nesting::Parent(parent) => Simple::Is(parent.clone()),
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
                Kind::Colon => simples.push(self.pseudo(tokens, index, allow_pseudo_element)?),
                _ => return Err(InvalidSelector),
            }
        }
        if simples.is_empty() && !has_type {
            return Err(InvalidSelector);
        }
        Ok(Compound { simples })
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
    ) -> Result<Simple, InvalidSelector> {
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
                    return if allow_pseudo_element { Ok(Simple::PseudoElement) } else { Err(InvalidSelector) };
                }
                match name.as_str() {
                    "root" => Ok(Simple::Root),
                    "host" => Ok(Simple::Host),
                    _ => Err(InvalidSelector),
                }
            }
            Kind::Function(name) => {
                let close = find_close(tokens, *index);
                let arguments = &tokens[*index + 1..close];
                *index = (close + 1).min(tokens.len());
                let name = name.to_ascii_lowercase();
                if element {
                    return if allow_pseudo_element { Ok(Simple::PseudoElement) } else { Err(InvalidSelector) };
                }
                if !matches!(name.as_str(), "is" | "where" | "not") {
                    return Err(InvalidSelector);
                }
                if self.depth == MAX_FUNCTION_DEPTH {
                    return Err(InvalidSelector);
                }
                self.depth += 1;
                let result = self.functional_pseudo_class(&name, arguments);
                self.depth -= 1;
                result
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
            _ => unreachable!("the caller passed only is, where and not"),
        }
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
