//! Rules, `@layer` and nesting over the token list.

use crate::css::lenient::Declaration;

use super::atoms::Atoms;
use super::declarations::{parse_declaration, push_declaration};
use super::layers::{LayerId, Layers};
use super::selector::{ComplexSelector, Specificity};
use super::selector_parse::{parse_selector_list, Nesting};
use super::tokenizer::{find_close, tokenize, trim, Kind, Token};
use super::{Rule, StyleSheet};

pub fn parse_sheet(text: &str, atoms: &mut Atoms, layers: &mut Layers) -> StyleSheet {
    let tokens = tokenize(text);
    let mut parser = Parser {
        src: text,
        tokens: &tokens,
        atoms,
        layers,
        sheet: StyleSheet { rules: Vec::new(), unsupported: Vec::new() },
    };
    parser.rule_list(0, tokens.len(), None);
    parser.sheet
}

struct Parser<'a> {
    src: &'a str,
    tokens: &'a [Token],
    atoms: &'a mut Atoms,
    layers: &'a mut Layers,
    sheet: StyleSheet,
}

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
        match parse_selector_list(prelude, self.atoms, nesting) {
            Ok(selectors) => self.style_block(open + 1, contents_end, selectors, layer),
            Err(_) if open == start => {}
            Err(_) => {
                let text = self.src[self.tokens[start].start..self.tokens[open - 1].end].trim().to_owned();
                self.sheet.unsupported.push(text);
            }
        }
        after
    }

    fn at_rule(&mut self, start: usize, end: usize, name: &str, layer: Option<LayerId>) -> usize {
        let (stop, terminator) = self.scan_prelude(start + 1, end, true, true);
        let prelude = trim(&self.tokens[start + 1..stop]);
        let (contents_end, after) = match terminator {
            Terminator::Block => self.block(stop, end),
            Terminator::Semicolon => (stop, stop + 1),
            Terminator::End => (end, end),
        };
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
                self.rule_list(stop + 1, contents_end, Some(inner));
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
        let mut index = start;
        while index < end {
            match &self.tokens[index].kind {
                Kind::Whitespace | Kind::Semicolon => index += 1,
                Kind::AtKeyword(name) => {
                    let name = name.to_ascii_lowercase();
                    let (stop, terminator) = self.scan_prelude(index + 1, end, true, true);
                    self.sheet.unsupported.push(name);
                    index = match terminator {
                        Terminator::Block => self.block(stop, end).1,
                        _ => stop + 1,
                    };
                }
                _ => {
                    let custom_property = self.starts_custom_property(index, end);
                    let (stop, terminator) = self.scan_prelude(index, end, true, !custom_property);
                    if matches!(terminator, Terminator::Block) {
                        self.flush(&selectors, &mut normal, &mut important, layer);
                        let parents: Vec<ComplexSelector> =
                            selectors.iter().map(|(selector, _)| selector.clone()).collect();
                        index = self.qualified_rule(index, end, layer, Nesting::Parent(&parents));
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
