//! Rules, `@layer`, `@media`, `@supports` and nesting over the token list.

use std::sync::Arc;

use crate::css::lenient::Declaration;
use crate::css::media_query::MediaQueryList;

use super::atoms::Atoms;
use super::conditions::Conditions;
use super::declarations::{parse_declaration, push_declaration};
use super::layers::{LayerId, Layers};
use super::selector::{ComplexSelector, SelectorList, Specificity};
use super::selector_parse::{parse_selector_list, Nesting};
use super::supports;
use super::tokenizer::{find_close, tokenize, trim, Kind, Token};
use super::validate::Validator;
use super::{Rule, StyleSheet};

/// `validator` answers the `@supports (property: value)` conditions, which are decided here.
pub fn parse_sheet(text: &str, atoms: &mut Atoms, layers: &mut Layers, validator: &mut Validator) -> StyleSheet {
    let tokens = tokenize(text);
    let mut parser = Parser {
        src: text,
        tokens: &tokens,
        atoms,
        layers,
        validator,
        sheet: StyleSheet { rules: Vec::new(), unsupported: Vec::new() },
        depth: 0,
        conditions: None,
    };
    parser.rule_list(0, tokens.len(), None);
    parser.sheet
}

struct Parser<'a> {
    src: &'a str,
    tokens: &'a [Token],
    atoms: &'a mut Atoms,
    layers: &'a mut Layers,
    validator: &'a mut Validator,
    sheet: StyleSheet,
    /// How many style rules, `@layer`, `@media` and `@supports` blocks enclose the one being parsed.
    depth: usize,
    /// The `@media` queries around what is being parsed.
    conditions: Option<Arc<Conditions>>,
}

/// Blocks nest this deep; a rule or at-rule block inside more is dropped like an invalid rule, so
/// hostile input cannot overflow the stack.
const MAX_BLOCK_DEPTH: usize = 32;

enum Terminator {
    Block,
    Semicolon,
    End,
}

type Selectors = Vec<(ComplexSelector, Specificity)>;

impl Parser<'_> {
    /// The end of the prelude that starts at `from` (before `end`), and what ended it.
    /// `block_ends_at_brace` is false in a custom property value, where `{}` is part of the value.
    fn scan_prelude(&self, from: usize, end: usize, semicolon_ends: bool, block_ends_at_brace: bool) -> (usize, Terminator) {
        let mut depth = 0usize;
        for index in from..end {
            match &self.tokens[index].kind {
                Kind::OpenBrace if depth == 0 && block_ends_at_brace => return (index, Terminator::Block),
                Kind::Semicolon if depth == 0 && semicolon_ends => return (index, Terminator::Semicolon),
                kind if kind.is_opener() => depth += 1,
                kind if kind.is_closer() => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        (end, Terminator::End)
    }

    /// The index after the block opened at `open`, and the range of its contents.
    fn block(&self, open: usize, end: usize) -> (usize, usize) {
        let close = find_close(&self.tokens[..end], open);
        (close.min(end), (close + 1).min(end))
    }

    fn rule_list(&mut self, start: usize, end: usize, layer: Option<LayerId>) {
        let mut index = start;
        while index < end {
            index = match &self.tokens[index].kind {
                Kind::Whitespace => index + 1,
                Kind::AtKeyword(name) => {
                    let name = name.to_ascii_lowercase();
                    self.at_rule(index, end, &name, layer)
                }
                _ => self.qualified_rule(index, end, layer, Nesting::Top),
            };
        }
    }

    /// A rule list for `@layer`'s block, a style rule's nested rules, or the sheet. Returns the
    /// index after the rule.
    fn qualified_rule(&mut self, start: usize, end: usize, layer: Option<LayerId>, nesting: Nesting) -> usize {
        // A stray `;` at the top of a sheet is part of the prelude, which then fails as a selector.
        let (open, terminator) = self.scan_prelude(start, end, false, true);
        if !matches!(terminator, Terminator::Block) {
            return end;
        }
        let (contents_end, after) = self.block(open, end);
        let prelude = &self.tokens[start..open];
        match parse_selector_list(self.src, prelude, self.atoms, nesting) {
            Ok(_) if self.depth == MAX_BLOCK_DEPTH => self.record_dropped(start, open),
            Ok(selectors) => {
                self.depth += 1;
                self.style_block(open + 1, contents_end, selectors, layer);
                self.depth -= 1;
            }
            Err(_) if open == start => {}
            Err(_) => self.record_dropped(start, open),
        }
        after
    }

    /// Records the prelude `start..open` as a rule that was dropped.
    fn record_dropped(&mut self, start: usize, open: usize) {
        let text = self.src[self.tokens[start].start..self.tokens[open - 1].end].trim().to_owned();
        self.sheet.unsupported.push(text);
    }

    /// Records an `@media` or `@supports` that has no block, or whose condition is not valid.
    fn record_dropped_at_rule(&mut self, name: &str, prelude: &[Token]) {
        let text = match (prelude.first(), prelude.last()) {
            (Some(first), Some(last)) => format!("@{name} {}", &self.src[first.start..last.end]),
            _ => format!("@{name}"),
        };
        self.sheet.unsupported.push(text);
    }

    /// Runs `parse_block` for the contents of an `@media` or `@supports` with `prelude`. An
    /// `@media` adds its queries to the conditions of every rule in the block. An `@supports` is
    /// decided now: the block is parsed only when it holds, and is dropped with a record when its
    /// condition is not valid.
    fn conditional(&mut self, name: &str, prelude: &[Token], parse_block: impl FnOnce(&mut Self)) {
        if self.depth == MAX_BLOCK_DEPTH {
            self.sheet.unsupported.push(name.to_owned());
            return;
        }
        let outer = self.conditions.clone();
        if name == "media" {
            let text = match (prelude.first(), prelude.last()) {
                (Some(first), Some(last)) => &self.src[first.start..last.end],
                _ => "",
            };
            let queries = Arc::new(MediaQueryList::parse(text));
            self.conditions = Some(Conditions::within(outer.as_ref(), queries));
        } else {
            match supports::evaluate(self.src, prelude, self.validator) {
                Some(true) => {}
                Some(false) => return,
                None => return self.record_dropped_at_rule(name, prelude),
            }
        }
        self.depth += 1;
        parse_block(self);
        self.depth -= 1;
        self.conditions = outer;
    }

    fn at_rule(&mut self, start: usize, end: usize, name: &str, layer: Option<LayerId>) -> usize {
        let (stop, terminator) = self.scan_prelude(start + 1, end, true, true);
        let prelude = trim(&self.tokens[start + 1..stop]);
        let (contents_end, after) = match terminator {
            Terminator::Block => self.block(stop, end),
            Terminator::Semicolon => (stop, stop + 1),
            Terminator::End => (end, end),
        };
        if matches!(name, "media" | "supports") {
            if !matches!(terminator, Terminator::Block) {
                self.record_dropped_at_rule(name, prelude);
                return after;
            }
            self.conditional(name, prelude, |parser| parser.rule_list(stop + 1, contents_end, layer));
            return after;
        }
        if name != "layer" {
            self.sheet.unsupported.push(name.to_owned());
            return after;
        }
        let Some(names) = layer_names(prelude) else {
            return after;
        };
        match terminator {
            Terminator::Block => {
                let inner = match names.as_slice() {
                    [] => self.layers.anonymous(layer),
                    [path] => self.declare_path(layer, path),
                    _ => return after,
                };
                if self.depth == MAX_BLOCK_DEPTH {
                    self.sheet.unsupported.push(name.to_owned());
                    return after;
                }
                self.depth += 1;
                self.rule_list(stop + 1, contents_end, Some(inner));
                self.depth -= 1;
            }
            _ => {
                for path in &names {
                    self.declare_path(layer, path);
                }
            }
        }
        after
    }

    fn declare_path(&mut self, parent: Option<LayerId>, path: &[String]) -> LayerId {
        let mut layer = parent;
        for name in path {
            layer = Some(self.layers.declare(layer, name));
        }
        layer.expect("a layer path has a name")
    }

    /// The contents of a style rule: declarations, and rules nested in it.
    fn style_block(&mut self, start: usize, end: usize, selectors: Selectors, layer: Option<LayerId>) {
        let mut normal = Vec::new();
        let mut important = Vec::new();
        let mut parents: Option<SelectorList> = None;
        let mut index = start;
        while index < end {
            match &self.tokens[index].kind {
                Kind::Whitespace | Kind::Semicolon => index += 1,
                Kind::AtKeyword(name) => {
                    let name = name.to_ascii_lowercase();
                    let (stop, terminator) = self.scan_prelude(index + 1, end, true, true);
                    let block = matches!(terminator, Terminator::Block).then(|| self.block(stop, end));
                    index = match block {
                        Some((contents_end, after)) if matches!(name.as_str(), "media" | "supports") => {
                            // What was written before the block comes first in the cascade.
                            self.flush(&selectors, &mut normal, &mut important, layer);
                            let prelude = trim(&self.tokens[index + 1..stop]);
                            let nested = selectors.clone();
                            self.conditional(&name, prelude, |parser| parser.style_block(stop + 1, contents_end, nested, layer));
                            after
                        }
                        Some((_, after)) => {
                            self.sheet.unsupported.push(name);
                            after
                        }
                        None if matches!(name.as_str(), "media" | "supports") => {
                            self.record_dropped_at_rule(&name, trim(&self.tokens[index + 1..stop]));
                            stop + 1
                        }
                        None => {
                            self.sheet.unsupported.push(name);
                            stop + 1
                        }
                    };
                }
                _ => {
                    let custom_property = self.starts_custom_property(index, end);
                    let (stop, terminator) = self.scan_prelude(index, end, true, !custom_property);
                    if matches!(terminator, Terminator::Block) {
                        self.flush(&selectors, &mut normal, &mut important, layer);
                        let parents = parents.get_or_insert_with(|| {
                            SelectorList::new(selectors.iter().map(|(selector, _)| selector.clone()).collect())
                        });
                        index = self.qualified_rule(index, end, layer, Nesting::Parent(parents));
                        continue;
                    }
                    if let Some(parsed) = parse_declaration(self.src, &self.tokens[index..stop]) {
                        let list = if parsed.important { &mut important } else { &mut normal };
                        push_declaration(list, parsed.declaration);
                    }
                    index = stop + 1;
                }
            }
        }
        self.flush(&selectors, &mut normal, &mut important, layer);
    }

    fn starts_custom_property(&self, index: usize, end: usize) -> bool {
        let is_custom = matches!(&self.tokens[index].kind, Kind::Ident(name) if name.starts_with("--"));
        let mut colon = index + 1;
        while colon < end && self.tokens[colon].kind == Kind::Whitespace {
            colon += 1;
        }
        is_custom && colon < end && self.tokens[colon].kind == Kind::Colon
    }

    fn flush(
        &mut self,
        selectors: &Selectors,
        normal: &mut Vec<Declaration>,
        important: &mut Vec<Declaration>,
        layer: Option<LayerId>,
    ) {
        if normal.is_empty() && important.is_empty() {
            return;
        }
        let order = u32::try_from(self.sheet.rules.len()).expect("fewer than 2^32 rules");
        self.sheet.rules.push(Rule {
            selectors: selectors.clone(),
            normal: std::mem::take(normal),
            important: std::mem::take(important),
            layer,
            conditions: self.conditions.clone(),
            order,
        });
    }
}

/// The comma-separated dotted names of an `@layer` prelude, or `None` when it is malformed.
fn layer_names(prelude: &[Token]) -> Option<Vec<Vec<String>>> {
    if prelude.is_empty() {
        return Some(Vec::new());
    }
    let mut names = Vec::new();
    for piece in prelude.split(|token| token.kind == Kind::Comma) {
        let mut path = Vec::new();
        let mut expect_ident = true;
        for token in trim(piece) {
            match (&token.kind, expect_ident) {
                (Kind::Ident(name), true) => path.push(name.clone()),
                (Kind::Delim('.'), false) => {}
                _ => return None,
            }
            expect_ident = !expect_ident;
        }
        if path.is_empty() || expect_ident {
            return None;
        }
        names.push(path);
    }
    Some(names)
}
