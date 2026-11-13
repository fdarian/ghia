//! Sheets parsed one top-level rule at a time, so a change to one rule parses only that rule.
//!
//! Every sheet of a document is loaded again when any changes, because `@layer` order is
//! declared in parse order across all of them. A top-level rule parses to the same rules wherever
//! it stands, except for its layers: those are ids into the document's tree, which depends on the
//! rules before it. So a rule is parsed once against a tree of its own, and the tree is replayed
//! into the document's when the sheet is assembled ([`Layers::replay_into`]), in source order.
//!
//! A source that [`split_rules`] cannot cut with certainty is parsed whole, as before.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::atoms::Atoms;
use super::index::{DocRule, RuleBody};
use super::layers::{LayerId, Layers};
use super::parser::parse_sheet;
use super::validate::Validator;
use super::Rule;

/// What one top-level rule parsed to, with its declarations already judged by the validator.
pub(super) struct ParsedRule {
    /// In the order of the cascade, and without the rules no selector can match.
    rules: Vec<(Arc<RuleBody>, Option<LayerId>)>,
    unsupported: Vec<String>,
    /// The layers the rule declares, ids in `rules` index into it.
    layers: Layers,
}

impl ParsedRule {
    pub(super) fn len(&self) -> usize {
        self.rules.len()
    }
}

/// The rules of every source of a load, in cascade order.
pub(super) struct Assembled {
    pub(super) rules: Vec<DocRule>,
    /// The name of each skipped at-rule and the text of each invalid selector list, in source order.
    pub(super) unsupported: Vec<String>,
    /// The top-level rules the rules came from, in order, to tell what a change touched. `None`
    /// when a source was parsed whole.
    pub(super) units: Option<Vec<Arc<ParsedRule>>>,
}

#[derive(Default)]
pub(super) struct ParseCache {
    rules: FxHashMap<Arc<str>, Arc<ParsedRule>>,
    /// Per source of the last load, its top-level rule texts, `None` when it was parsed whole.
    sources: Vec<Option<Vec<Arc<str>>>>,
}

impl ParseCache {
    /// The rule texts of every source of the last [`ParseCache::parse`], to tell which rules a
    /// change touched.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn source_rules(&self) -> &[Option<Vec<Arc<str>>>] {
        &self.sources
    }

    pub(super) fn clear(&mut self) {
        self.rules.clear();
        self.sources.clear();
    }

    /// The sheets of `texts`, parsed as `parse_sheet` would parse them in turn with `layers`,
    /// then filtered by `validator`. Rules the cache does not hold are parsed; the cache keeps
    /// only the rules of `texts`.
    pub(super) fn parse(
        &mut self,
        texts: &[String],
        atoms: &mut Atoms,
        layers: &mut Layers,
        validator: &mut Validator,
    ) -> Assembled {
        let mut seen: FxHashMap<Arc<str>, Arc<ParsedRule>> = FxHashMap::default();
        let mut sources = Vec::with_capacity(texts.len());
        let mut assembled = Assembled { rules: Vec::new(), unsupported: Vec::new(), units: Some(Vec::new()) };
        for text in texts {
            let Some(ranges) = split_rules(text) else {
                let (rules, unsupported) = parse_whole(text, atoms, layers, validator);
                assembled.rules.extend(rules);
                assembled.unsupported.extend(unsupported);
                assembled.units = None;
                sources.push(None);
                continue;
            };
            let mut rule_texts = Vec::with_capacity(ranges.len());
            for range in ranges {
                let rule_text = &text[range];
                let (key, parsed) = match seen.get_key_value(rule_text).or_else(|| self.rules.get_key_value(rule_text)) {
                    Some((key, parsed)) => (key.clone(), parsed.clone()),
                    None => (Arc::<str>::from(rule_text), Arc::new(parse_rule(rule_text, atoms, validator))),
                };
                let mapped = parsed.layers.replay_into(layers);
                assembled.rules.extend(parsed.rules.iter().map(|(body, layer)| DocRule {
                    body: body.clone(),
                    layer: layer.map(|layer| mapped[layer.index()]),
                }));
                assembled.unsupported.extend(parsed.unsupported.iter().cloned());
                if let Some(units) = &mut assembled.units {
                    units.push(parsed.clone());
                }
                seen.insert(key.clone(), parsed);
                rule_texts.push(key);
            }
            sources.push(Some(rule_texts));
        }
        self.rules = seen;
        self.sources = sources;
        assembled
    }
}

/// A source parsed as one sheet, in its own order.
fn parse_whole(
    text: &str,
    atoms: &mut Atoms,
    layers: &mut Layers,
    validator: &mut Validator,
) -> (Vec<DocRule>, Vec<String>) {
    let mut sheet = parse_sheet(text, atoms, layers);
    validator.filter(&mut sheet.rules);
    (doc_rules(sheet.rules), sheet.unsupported)
}

fn parse_rule(text: &str, atoms: &mut Atoms, validator: &mut Validator) -> ParsedRule {
    let mut layers = Layers::default();
    let mut sheet = parse_sheet(text, atoms, &mut layers);
    validator.filter(&mut sheet.rules);
    let rules = doc_rules(sheet.rules).into_iter().map(|rule| (rule.body, rule.layer)).collect();
    ParsedRule { rules, unsupported: sheet.unsupported, layers }
}

/// `rules` in cascade order, without the selectors that name a pseudo-element and the rules that
/// are left with none.
fn doc_rules(mut rules: Vec<Rule>) -> Vec<DocRule> {
    rules.sort_by_key(|rule| rule.order);
    rules
        .into_iter()
        .filter_map(|rule| {
            let selectors: Vec<_> =
                rule.selectors.into_iter().filter(|(selector, _)| !selector.has_pseudo_element()).collect();
            if selectors.is_empty() {
                return None;
            }
            Some(DocRule {
                body: Arc::new(RuleBody { selectors, normal: rule.normal, important: rule.important }),
                layer: rule.layer,
            })
        })
        .collect()
}

/// The byte range of each top-level rule of `text`: a qualified rule up to the `}` of its block,
/// an at-rule up to its `;` or the `}` of its block. Comments and whitespace between rules are
/// left out.
///
/// `None` when the text is not certain to cut the way the parser does: an unterminated comment,
/// string or block, a closer that matches nothing, a rule with no block, `@` without a name, a
/// newline in a string, or an escape beside what may be a `url(`.
pub(super) fn split_rules(text: &str) -> Option<Vec<Range<usize>>> {
    let bytes = text.as_bytes();
    let mut ranges = Vec::new();
    let mut closers = Vec::new();
    let mut at = skip_trivia(bytes, 0)?;
    while at < bytes.len() {
        let end = rule_end(bytes, at, &mut closers)?;
        ranges.push(at..end);
        at = skip_trivia(bytes, end)?;
    }
    Some(ranges)
}

fn skip_trivia(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        match bytes.get(at) {
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') => at += 1,
            Some(b'/') if bytes.get(at + 1) == Some(&b'*') => at = skip_comment(bytes, at)?,
            _ => return Some(at),
        }
    }
}

/// The index after the comment that opens at `at`.
fn skip_comment(bytes: &[u8], at: usize) -> Option<usize> {
    let close = bytes[at + 2..].windows(2).position(|pair| pair == b"*/")?;
    Some(at + 2 + close + 2)
}

/// The index after the string that opens at `at`.
fn skip_string(bytes: &[u8], at: usize) -> Option<usize> {
    let quote = bytes[at];
    let mut index = at + 1;
    loop {
        match *bytes.get(index)? {
            byte if byte == quote => return Some(index + 1),
            b'\n' => return None,
            b'\\' => index += 2,
            _ => index += 1,
        }
    }
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') || !byte.is_ascii()
}

/// For the `(` at `open`: the index after the `)` of an unquoted `url(`, which the tokenizer
/// reads as one token whatever it holds; `Some(None)` for any other parenthesis.
fn skip_url(bytes: &[u8], open: usize) -> Option<Option<usize>> {
    let mut name_start = open;
    while name_start > 0 && is_name_byte(bytes[name_start - 1]) {
        name_start -= 1;
    }
    if name_start > 0 && bytes[name_start - 1] == b'\\' {
        return None;
    }
    if !bytes[name_start..open].eq_ignore_ascii_case(b"url") {
        return Some(None);
    }
    let mut index = open + 1;
    while matches!(bytes.get(index), Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')) {
        index += 1;
    }
    if matches!(bytes.get(index), Some(b'"' | b'\'')) {
        return Some(None);
    }
    index = open + 1;
    loop {
        match *bytes.get(index)? {
            b')' => return Some(Some(index + 1)),
            b'\\' => index += 2,
            _ => index += 1,
        }
    }
}

/// The index after the rule that starts at `start`. `closers` is scratch space.
fn rule_end(bytes: &[u8], start: usize, closers: &mut Vec<u8>) -> Option<usize> {
    let is_at_rule = bytes[start] == b'@';
    if is_at_rule && !bytes.get(start + 1).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    closers.clear();
    let mut index = start;
    while index < bytes.len() {
        match bytes[index] {
            b'"' | b'\'' => index = skip_string(bytes, index)?,
            b'/' if bytes.get(index + 1) == Some(&b'*') => index = skip_comment(bytes, index)?,
            b'\\' => {
                bytes.get(index + 1)?;
                index += 2;
            }
            b'(' => match skip_url(bytes, index)? {
                Some(after) => index = after,
                None => {
                    closers.push(b')');
                    index += 1;
                }
            },
            b'[' => {
                closers.push(b']');
                index += 1;
            }
            b'{' => {
                closers.push(b'}');
                index += 1;
            }
            closer @ (b')' | b']' | b'}') => {
                if closers.pop() != Some(closer) {
                    return None;
                }
                index += 1;
                if closer == b'}' && closers.is_empty() {
                    return Some(index);
                }
            }
            b';' if is_at_rule && closers.is_empty() => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str) -> Option<Vec<&str>> {
        split_rules(text).map(|ranges| ranges.into_iter().map(|range| &text[range]).collect())
    }

    #[test]
    fn rules_and_statements_are_cut_at_their_own_end() {
        assert_eq!(
            split("@layer a, b;\n.x { color: red }\n  @media (min-width: 1px) { .y { top: 0 } }\n@import url(a.css);").unwrap(),
            [
                "@layer a, b;",
                ".x { color: red }",
                "@media (min-width: 1px) { .y { top: 0 } }",
                "@import url(a.css);"
            ]
        );
        assert_eq!(split("").unwrap(), Vec::<&str>::new());
        assert_eq!(split(" /* only a comment */ \n").unwrap(), Vec::<&str>::new());
    }

    #[test]
    fn braces_in_comments_and_strings_do_not_count() {
        assert_eq!(
            split(r#"/* } */ .a { content: "}" } /* { */ .b[x="{;"] { color: red /* } */ }"#).unwrap(),
            [r#".a { content: "}" }"#, r#".b[x="{;"] { color: red /* } */ }"#]
        );
        assert_eq!(split(r#".a { content: '\'}' } .b { top: 0 }"#).unwrap(), [r#".a { content: '\'}' }"#, ".b { top: 0 }"]);
    }

    #[test]
    fn a_semicolon_in_a_string_or_parenthesis_does_not_end_an_at_rule() {
        assert_eq!(
            split(r#"@import "a;b.css"; @import url(data:text/css;base64,AAAA); @import url("x;y") layer(a); .z { top: 0 }"#).unwrap(),
            [r#"@import "a;b.css";"#, "@import url(data:text/css;base64,AAAA);", r#"@import url("x;y") layer(a);"#, ".z { top: 0 }"]
        );
        assert_eq!(split("@layer a { .x { top: 0 } } @layer b;").unwrap(), ["@layer a { .x { top: 0 } }", "@layer b;"]);
    }

    #[test]
    fn escapes_do_not_open_or_close_anything() {
        assert_eq!(
            split(r".md\:flex { display: flex } .a\{b { top: 0 } .c\} { top: 1 } .d { content: url(a\).png) }").unwrap(),
            [r".md\:flex { display: flex }", r".a\{b { top: 0 }", r".c\} { top: 1 }", r".d { content: url(a\).png) }"]
        );
    }

    #[test]
    fn nested_rules_stay_in_their_parent() {
        assert_eq!(
            split(".a { color: red; &:hover { color: blue; .b { top: 0 } } } .c:is(.d, .e) { top: 1 }").unwrap(),
            [".a { color: red; &:hover { color: blue; .b { top: 0 } } }", ".c:is(.d, .e) { top: 1 }"]
        );
    }

    #[test]
    fn a_text_that_may_cut_differently_is_not_cut() {
        for text in [
            ".a { top: 0 ",
            ".a { top: 0 } .b",
            ".a { top: 0 } } .b { top: 1 }",
            ".a { top: 0 ) }",
            ".a { top: (1 } ",
            "/* open .a { top: 0 }",
            ".a { content: \"open } .b { top: 0 }",
            ".a { content: \"new\nline\" }",
            "@ { top: 0 }",
            "@layer a",
            ".a { top: 0 } .b \\",
            ".a { background: \\75 rl(x) }.b{",
            ".a { background: ur\\6c(x) } .b { top: 0 }",
        ] {
            assert!(split(text).is_none(), "{text:?}");
        }
    }

    const SHEETS: [&str; 3] = [
        "@layer base, theme;
         .a { color: red; &:hover { color: blue } .b & { top: 0 } }
         @layer theme { .a { color: green } @layer inner { .t { top: 1 } } }
         @layer { .anon { top: 2 } }
         @media (min-width: 10px) { .m { top: 3 } }
         .a, .c > .d { right: bogus; width: 4px; color: red !important }
         @layer base { .base { top: 4 } }
         .dup { top: 5 } .dup { top: 5 }
         :bogus(1) { top: 6 }
         @layer { .anon { top: 2 } }",
        "@layer reset, base;
         @layer reset { * { margin: 0 } }
         .a { top: 7 }
         @layer theme.dark { .a { color: black } }
         @layer theme { .after { top: 8 } }
         @layer { .anon { top: 2 } }
         .dup { top: 5 }",
        ".broken { top: 9 } .open { top: 10 ",
    ];

    fn describe(assembled: &Assembled, layers: &Layers) -> Vec<String> {
        let order = layers.order();
        let mut lines: Vec<String> = assembled
            .rules
            .iter()
            .map(|rule| {
                format!(
                    "rank {} {:?} {:?} {:?}",
                    order.rank(rule.layer),
                    rule.body.selectors,
                    rule.body.normal,
                    rule.body.important
                )
            })
            .collect();
        lines.push(format!("unsupported {:?}", assembled.unsupported));
        lines
    }

    fn whole(texts: &[String], atoms: &mut Atoms) -> Vec<String> {
        let (mut layers, mut validator) = (Layers::default(), Validator::default());
        let mut assembled = Assembled { rules: Vec::new(), unsupported: Vec::new(), units: None };
        for text in texts {
            let (rules, unsupported) = parse_whole(text, atoms, &mut layers, &mut validator);
            assembled.rules.extend(rules);
            assembled.unsupported.extend(unsupported);
        }
        describe(&assembled, &layers)
    }

    fn uncached(texts: &[String]) -> Vec<String> {
        whole(texts, &mut Atoms::default())
    }

    fn cached(cache: &mut ParseCache, atoms: &mut Atoms, texts: &[String]) -> Vec<String> {
        let (mut layers, mut validator) = (Layers::default(), Validator::default());
        let assembled = cache.parse(texts, atoms, &mut layers, &mut validator);
        describe(&assembled, &layers)
    }

    #[test]
    fn cached_sheets_come_out_as_parsed_whole() {
        let texts: Vec<String> = SHEETS.iter().map(|text| text.to_string()).collect();
        // The atoms are shared by every run, so a selector's atoms are comparable.
        let mut atoms = Atoms::default();
        let mut cache = ParseCache::default();
        let first = cached(&mut cache, &mut atoms, &texts);
        let again = cached(&mut cache, &mut atoms, &texts);
        assert_eq!(first, again);
        assert!(first.len() > 15);
        assert_eq!(first, whole(&texts, &mut Atoms::default()));
        assert_eq!(first, uncached(&texts));
    }

    #[test]
    fn a_changed_rule_reparses_and_the_unseen_ones_are_forgotten() {
        let mut atoms = Atoms::default();
        let mut cache = ParseCache::default();
        let mut texts: Vec<String> = SHEETS[..2].iter().map(|text| text.to_string()).collect();
        cached(&mut cache, &mut atoms, &texts);
        let held = cache.rules.len();
        let sources_before = cache.source_rules().to_vec();
        assert!(sources_before.iter().all(Option::is_some));

        texts[1].push_str("\n@layer late { .late { top: 11 } }\n.a { top: 12 }");
        assert_eq!(cached(&mut cache, &mut atoms, &texts), uncached(&texts));
        assert_eq!(cache.rules.len(), held + 2);
        // The untouched rules are the same allocations.
        let sources_after = cache.source_rules();
        let before = sources_before[0].as_ref().unwrap();
        let after = sources_after[0].as_ref().unwrap();
        assert!(before.iter().zip(after).all(|(old, new)| Arc::ptr_eq(old, new)));

        texts.truncate(1);
        assert_eq!(cached(&mut cache, &mut atoms, &texts), uncached(&texts));
        assert!(cache.rules.len() < held);
    }
}
