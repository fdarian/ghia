//! `content` (CSS Generated Content 3): what the `::before` or `::after` box of an element holds.
//! It has no effect on an element, whose computed value is `normal`.
//!
//! The declared value ([`Content`], what a style holds) keeps `attr()` as it was written. The
//! computed value of a box ([`Computed`]) has read the attribute of the element it belongs to, so
//! it changes with that attribute and the declared value does not.
//!
//! A string and `attr()` are the items this engine draws. `counter()`, `counters()`, the quotes,
//! `url()` and the other images parse, and are kept as [`Item::Unsupported`] with their text, so
//! the box still holds the items around them.

use std::sync::Arc;

use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::url::unescape;

#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    /// The initial value: no box for a pseudo-element, nothing for an element.
    Normal,
    /// No box.
    None,
    Items(Arc<[Item]>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Text(String),
    /// `attr(<name>)`, the name as written (an HTML element reads it case-insensitively).
    Attr(String),
    /// An item this engine does not draw, as written.
    Unsupported(String),
}

/// What a box holds once the attributes of its element are read.
#[derive(Debug, Clone, PartialEq)]
pub enum Computed {
    Normal,
    None,
    /// Never empty; adjacent text is one item.
    Items(Vec<ComputedItem>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ComputedItem {
    Text(String),
    Unsupported(String),
}

/// Functions and keywords that are valid `content` items this engine does not draw.
const UNSUPPORTED_FUNCTIONS: [&str; 10] = [
    "counter", "counters", "url", "image-set", "image", "cross-fade", "element", "string", "leader", "target-counter",
];
const UNSUPPORTED_KEYWORDS: [&str; 5] = ["open-quote", "close-quote", "no-open-quote", "no-close-quote", "contents"];

impl Content {
    /// `None` for a value that is not valid.
    pub fn parse(text: &str) -> Option<Content> {
        let text = text.trim();
        if text.eq_ignore_ascii_case("normal") {
            return Some(Content::Normal);
        }
        if text.eq_ignore_ascii_case("none") {
            return Some(Content::None);
        }
        let mut items = Vec::new();
        let mut rest = text;
        loop {
            rest = rest.trim_start();
            let Some(first) = rest.chars().next() else {
                break;
            };
            if first == '/' {
                return (!items.is_empty() && alt_text_is_valid(&rest[1..])).then(|| Content::Items(items.into()));
            }
            let (item, after) = next_item(rest)?;
            items.push(item);
            rest = after;
        }
        (!items.is_empty()).then(|| Content::Items(items.into()))
    }

    /// The attribute names `attr()` items read.
    pub fn attributes(&self) -> impl Iterator<Item = &str> {
        self.items().iter().filter_map(|item| match item {
            Item::Attr(name) => Some(name.as_str()),
            Item::Text(_) | Item::Unsupported(_) => None,
        })
    }

    /// The items that are valid and not drawn, as written.
    pub fn unsupported(&self) -> impl Iterator<Item = &str> {
        self.items().iter().filter_map(|item| match item {
            Item::Unsupported(text) => Some(text.as_str()),
            Item::Text(_) | Item::Attr(_) => None,
        })
    }

    fn items(&self) -> &[Item] {
        match self {
            Content::Items(items) => items,
            Content::Normal | Content::None => &[],
        }
    }

    /// The value as `attr` reads it: the text of the attribute of the element, and `""` for one it
    /// does not have.
    pub fn compute(&self, attr: impl Fn(&str) -> Option<String>) -> Computed {
        let items = match self {
            Content::Normal => return Computed::Normal,
            Content::None => return Computed::None,
            Content::Items(items) => items,
        };
        let mut computed: Vec<ComputedItem> = Vec::with_capacity(items.len());
        for item in items.iter() {
            let text = match item {
                Item::Text(text) => text.clone(),
                Item::Attr(name) => attr(name).unwrap_or_default(),
                Item::Unsupported(text) => {
                    computed.push(ComputedItem::Unsupported(text.clone()));
                    continue;
                }
            };
            match computed.last_mut() {
                Some(ComputedItem::Text(last)) => last.push_str(&text),
                _ => computed.push(ComputedItem::Text(text)),
            }
        }
        Computed::Items(computed)
    }

    /// The declared value as CSS text.
    pub fn to_css(&self) -> String {
        match self {
            Content::Normal => "normal".to_owned(),
            Content::None => "none".to_owned(),
            Content::Items(items) => items
                .iter()
                .map(|item| match item {
                    Item::Text(text) => quoted(text),
                    Item::Attr(name) => format!("attr({name})"),
                    Item::Unsupported(text) => text.clone(),
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

impl Computed {
    /// Whether a box is generated: the value is a list of items.
    pub fn generates_box(&self) -> bool {
        matches!(self, Computed::Items(_))
    }

    /// The value as `getComputedStyle` writes it. A pseudo-element's `normal` is `none`.
    pub fn to_css(&self) -> String {
        match self {
            Computed::Normal | Computed::None => "none".to_owned(),
            Computed::Items(items) => items
                .iter()
                .map(|item| match item {
                    ComputedItem::Text(text) => quoted(text),
                    ComputedItem::Unsupported(text) => text.clone(),
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

/// A CSS string with double quotes: what serializing a string value gives.
fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\a "),
            c if c.is_control() => out.push_str(&format!("\\{:x} ", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The item that starts `text` (which does not start with whitespace) and what follows it.
fn next_item(text: &str) -> Option<(Item, &str)> {
    let first = text.chars().next()?;
    if first == '"' || first == '\'' {
        let end = string_end(text)?;
        return Some((Item::Text(unescape(&text[1..end - 1]).into_owned()), &text[end..]));
    }
    let end = word_end(text)?;
    let word = &text[..end];
    let rest = &text[end..];
    if let Some(open) = word.find('(') {
        let name = &word[..open];
        let inner = word[open + 1..].strip_suffix(')')?;
        if name.eq_ignore_ascii_case("attr") {
            return attr_item(inner, word).map(|item| (item, rest));
        }
        let known = UNSUPPORTED_FUNCTIONS.iter().any(|function| name.eq_ignore_ascii_case(function))
            || name.to_ascii_lowercase().ends_with("gradient");
        return known.then(|| (Item::Unsupported(word.to_owned()), rest));
    }
    UNSUPPORTED_KEYWORDS
        .iter()
        .any(|keyword| word.eq_ignore_ascii_case(keyword))
        .then(|| (Item::Unsupported(word.to_owned()), rest))
}

/// `attr(name)` is the item; a type or a fallback after the name is valid and not drawn, and no
/// name is not valid.
fn attr_item(inner: &str, word: &str) -> Option<Item> {
    let inner = inner.trim();
    let name_end = inner.find(|c: char| c.is_whitespace() || c == ',').unwrap_or(inner.len());
    let name = &inner[..name_end];
    let valid_name =
        !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ':') || !c.is_ascii());
    if !valid_name {
        return None;
    }
    Some(if name_end == inner.len() { Item::Attr(name.to_owned()) } else { Item::Unsupported(word.to_owned()) })
}

/// The index after the closing quote of the string `text` starts with. `None` when it is not closed
/// or holds a raw newline.
fn string_end(text: &str) -> Option<usize> {
    let quote = text.chars().next()?;
    let mut chars = text.char_indices().skip(1);
    while let Some((index, c)) = chars.next() {
        match c {
            c if c == quote => return Some(index + 1),
            '\n' => return None,
            '\\' => {
                chars.next();
            }
            _ => {}
        }
    }
    None
}

/// The end of the word (an identifier or a function call) that starts `text`: at whitespace, a
/// `/` or a quote outside parentheses. `None` for a word that is not closed.
fn word_end(text: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut chars = text.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        match c {
            '"' | '\'' if depth > 0 => {
                let end = string_end(&text[index..])?;
                while chars.peek().is_some_and(|(next, _)| *next < index + end) {
                    chars.next();
                }
            }
            '"' | '\'' => return Some(index).filter(|end| *end > 0),
            '(' => depth += 1,
            ')' => depth = depth.checked_sub(1)?,
            c if depth == 0 && (c.is_whitespace() || c == '/') => return Some(index).filter(|end| *end > 0),
            _ => {}
        }
    }
    (depth == 0).then_some(text.len())
}

/// What follows the `/` of `content: <items> / <alt>`: strings, `attr()` and counters, one or more.
fn alt_text_is_valid(mut text: &str) -> bool {
    let mut any = false;
    loop {
        text = text.trim_start();
        if text.is_empty() {
            return any;
        }
        match next_item(text) {
            Some((Item::Text(_) | Item::Attr(_), rest)) => {
                any = true;
                text = rest;
            }
            Some((Item::Unsupported(word), rest)) if word.to_ascii_lowercase().starts_with("counter") => {
                any = true;
                text = rest;
            }
            _ => return false,
        }
    }
}

impl Serialize for Content {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_css())
    }
}

/// A value CSS does not have is an invalid declaration, which is dropped and leaves the style
/// beneath it as it is.
pub(crate) fn deserialize_ignoring_invalid<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Content>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Declared {
        Text(String),
        Invalid(IgnoredAny),
    }
    Ok(match Option::<Declared>::deserialize(deserializer)? {
        Some(Declared::Text(text)) => Content::parse(&text),
        Some(Declared::Invalid(_)) | None => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(text: &str) -> Vec<Item> {
        match Content::parse(text) {
            Some(Content::Items(items)) => items.to_vec(),
            other => panic!("{text} parsed to {other:?}"),
        }
    }

    #[test]
    fn the_keywords_parse_in_any_case() {
        assert_eq!(Content::parse("normal"), Some(Content::Normal));
        assert_eq!(Content::parse(" NONE "), Some(Content::None));
    }

    #[test]
    fn strings_unescape_and_keep_their_spaces() {
        assert_eq!(items("\"a  b\""), [Item::Text("a  b".into())]);
        assert_eq!(items("'it\\'s'"), [Item::Text("it's".into())]);
        assert_eq!(items(r#""\201C""#), [Item::Text("\u{201C}".into())]);
        assert_eq!(items(r#""line\A two""#), [Item::Text("line\ntwo".into())]);
        assert_eq!(items(r#""""#), [Item::Text(String::new())]);
        assert_eq!(items(r#""a""b""#), [Item::Text("a".into()), Item::Text("b".into())]);
    }

    #[test]
    fn attr_reads_a_name_and_a_type_or_fallback_is_not_drawn() {
        assert_eq!(items("attr(data-x)"), [Item::Attr("data-x".into())]);
        assert_eq!(items("\"[\" attr( title ) \"]\""), [Item::Text("[".into()), Item::Attr("title".into()), Item::Text("]".into())]);
        assert_eq!(items("attr(data-x, \"none\")"), [Item::Unsupported("attr(data-x, \"none\")".into())]);
    }

    #[test]
    fn what_is_not_drawn_is_kept_with_its_text() {
        assert_eq!(
            items("counter(n) \". \" open-quote url(\"a b.png\") linear-gradient(red, blue)"),
            [
                Item::Unsupported("counter(n)".into()),
                Item::Text(". ".into()),
                Item::Unsupported("open-quote".into()),
                Item::Unsupported("url(\"a b.png\")".into()),
                Item::Unsupported("linear-gradient(red, blue)".into()),
            ]
        );
    }

    #[test]
    fn alt_text_is_checked_and_left_out() {
        assert_eq!(items("\"x\" / \"alt\""), [Item::Text("x".into())]);
        assert_eq!(items("url(a.png)/attr(alt)"), [Item::Unsupported("url(a.png)".into())]);
        assert_eq!(Content::parse("\"x\" /"), None);
        assert_eq!(Content::parse("/ \"alt\""), None);
        assert_eq!(Content::parse("\"x\" / bogus"), None);
    }

    #[test]
    fn a_value_that_is_not_a_content_list_is_invalid() {
        for bad in ["", "x", "normal \"x\"", "none none", "\"x", "\"x\" 3", "attr()", "attr(a b)x", "counter(", "foo(1)", "\"a\nb\""] {
            assert_eq!(Content::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn computing_reads_the_attribute_and_joins_adjacent_text() {
        let content = Content::parse("\"[\" attr(data-x) \"]\" counter(n) attr(missing)").unwrap();
        let computed = content.compute(|name| (name == "data-x").then(|| "v".to_owned()));
        assert_eq!(
            computed,
            Computed::Items(vec![
                ComputedItem::Text("[v]".into()),
                ComputedItem::Unsupported("counter(n)".into()),
                ComputedItem::Text(String::new()),
            ])
        );
        assert!(computed.generates_box());
        assert!(!Content::Normal.compute(|_| None).generates_box());
        assert!(!Content::None.compute(|_| None).generates_box());
    }

    #[test]
    fn computed_values_serialize_as_a_browser_does() {
        let css = |text: &str, attr: Option<&str>| Content::parse(text).unwrap().compute(|_| attr.map(str::to_owned)).to_css();
        assert_eq!(css("\"x\"", None), "\"x\"");
        assert_eq!(css("\"a\" \"b\"", None), "\"ab\"");
        assert_eq!(css("attr(data-x)", Some("he\"llo")), "\"he\\\"llo\"");
        assert_eq!(css("\"q\\\"r\\\\s\"", None), "\"q\\\"r\\\\s\"");
        assert_eq!(css("\"line\\A two\"", None), "\"line\\a two\"");
        assert_eq!(css("counter(x) \" \"", None), "counter(x) \" \"");
        assert_eq!(Content::Normal.compute(|_| None).to_css(), "none");
        assert_eq!(Content::None.compute(|_| None).to_css(), "none");
    }

    #[test]
    fn the_declared_value_reads_its_attribute_names_and_serializes_unresolved() {
        let content = Content::parse("attr(a) \"x\" attr(b)").unwrap();
        assert_eq!(content.attributes().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(content.to_css(), "attr(a) \"x\" attr(b)");
    }

    #[test]
    fn an_invalid_declaration_is_ignored() {
        #[derive(Deserialize)]
        struct Style {
            #[serde(default, deserialize_with = "deserialize_ignoring_invalid")]
            content: Option<Content>,
        }
        let parse = |json: &str| serde_json::from_str::<Style>(json).unwrap().content;
        assert_eq!(parse(r#"{"content":"\"x\""}"#), Some(Content::Items(vec![Item::Text("x".into())].into())));
        assert_eq!(parse(r#"{"content":"none"}"#), Some(Content::None));
        assert_eq!(parse(r#"{"content":"bogus"}"#), None);
        assert_eq!(parse(r#"{"content":3}"#), None);
        assert_eq!(parse(r#"{"content":null}"#), None);
    }
}
