//! A CSS-wide keyword written by an author beats the layers under the author's style.
//!
//! The declared style of an element (its sheets' cascade and its inline style) is laid over the
//! universal style, which is laid over the user agent style of the tag and of a `popover`. A
//! keyword cannot be a value in that style, so it would leave the value below in place, and
//! `margin: unset` on an open `[popover]` would keep the user agent's `margin: auto`. In CSS an
//! author `initial`, `unset` and `inherit` come before the user agent origin in the cascade, and
//! `revert` is the keyword that gives it back.
//!
//! [`resolve`] runs where a style is interned, on the text of the style the cascade merged or an
//! inline style as it came, and rewrites its top-level keywords:
//! - `initial` and `unset` (and `inherit` where the property inherits) reset the properties they
//!   name: the style's [`reset`](crate::style::StyleDesc::reset) lists them and `overlay` clears
//!   them from the layers under it. A property that does not inherit is then at its initial value,
//!   which needs no value of its own, and one that inherits takes its parent's. A shorthand that a
//!   layer keeps still gives a longhand its value (`padding-left: unset` over `padding: 1px 6px`),
//!   so `overlay` writes the initial value of such a longhand (`initial.rs`);
//! - a longhand that a shorthand written earlier in the same declarations gave a value is written
//!   at its initial value, in place, after the shorthand, whichever keyword it is (`inset: 0` and
//!   then `right: unset`);
//! - `revert` and `revert-layer` take back the author's earlier declarations of the property and
//!   leave the layers under it.
//!
//! The blocks of the states (`hover`, `focusVisible`, ...) are resolved the same way, each on its own
//! declarations, and what they reset is the block's: `overlay` clears those properties from the
//! style the state is folded over while the state applies, so `.a { color: red } .a:hover { color:
//! initial }` loses the red on hover. `revert` in a block also lists the properties in
//! [`revert`](crate::style::StyleDesc::revert), for the layer that knows the user agent value to
//! write into the block (`universal_style::layer_under`). A keyword inside an `@container` block is
//! still dropped (`css::lenient`).

use std::sync::Arc;

use crate::css::covers::{self, KeyId};
use crate::css::lenient::{object_text, Declaration, Declarations};

use super::initial;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Keyword {
    Initial,
    Unset,
    Inherit,
    Revert,
    RevertLayer,
}

fn keyword_of(value: &str) -> Option<Keyword> {
    // A string value that is not valid JSON text is not one a style object holds, so it is no keyword.
    let text = initial::string_value(value)?;
    let text = text.trim();
    [
        ("initial", Keyword::Initial),
        ("unset", Keyword::Unset),
        ("inherit", Keyword::Inherit),
        ("revert", Keyword::Revert),
        ("revert-layer", Keyword::RevertLayer),
    ]
    .into_iter()
    .find(|(name, _)| text.eq_ignore_ascii_case(name))
    .map(|(_, keyword)| keyword)
}

/// Whether the JSON text of a value is a CSS-wide keyword string.
pub(super) fn is_css_wide(value: &str) -> bool {
    keyword_of(value).is_some()
}

/// The properties of `StyleDesc` that inherit, by the name a style object writes them. `inherit`
/// on one of these takes the parent's value, which is what a reset leaves.
const INHERITED: &[&str] = &[
    "visibility", "color", "colorScheme", "fontStyle", "fontSize", "fontFamily", "fontWeight",
    "fontVariantNumeric", "fontFeatureSettings", "fontVariationSettings", "WebkitFontSmoothing",
    "textAlign", "direction", "lineHeight", "whiteSpace", "tabSize", "wordBreak", "overflowWrap",
    "textWrap", "textWrapMode", "textWrapStyle", "textUnderlineOffset", "borderSpacing",
    "borderCollapse", "captionSide", "emptyCells", "cursor", "pointerEvents", "userSelect",
    "scrollbarColor", "interpolateSize", "appRegion", "textBoxEdge", "selectionColor",
];

/// A style text with its keywords rewritten, and what they reset.
pub(crate) struct Resolved {
    pub(crate) text: String,
    pub(crate) reset: Option<Arc<[String]>>,
    /// The state blocks that had a keyword, which the parsed style takes the lists of.
    pub(crate) blocks: Vec<ResolvedBlock>,
}

/// What the keywords of one state block reset.
pub(crate) struct ResolvedBlock {
    /// The key of the block in the style (`hover`).
    pub(crate) key: String,
    pub(crate) reset: Option<Arc<[String]>>,
    pub(crate) revert: Option<Arc<[String]>>,
}

impl Resolved {
    /// Sets the lists of the blocks on the style the text parsed into, and the style's own.
    pub(crate) fn apply_to(self, style: &mut crate::style::StyleDesc) {
        style.reset = self.reset;
        for block in self.blocks {
            let Some(Some(parsed)) = crate::css::var_substitution::state_slot(style, &block.key) else {
                continue;
            };
            parsed.reset = block.reset;
            parsed.revert = block.revert;
        }
    }
}

#[derive(Default)]
struct Lists {
    reset: Vec<String>,
    revert: Vec<String>,
}

/// [`Lists`] sorted and shared, `None` for an empty one.
struct Arcs {
    reset: Option<Arc<[String]>>,
    revert: Option<Arc<[String]>>,
}

impl Lists {
    fn arcs(mut self) -> Arcs {
        let finish = |list: &mut Vec<String>| {
            list.sort();
            list.dedup();
            (!list.is_empty()).then(|| Arc::from(std::mem::take(list)))
        };
        Arcs { reset: finish(&mut self.reset), revert: finish(&mut self.revert) }
    }

    /// A declaration of `key` written after a `revert` gives the property, and what it overwrites,
    /// a value of its own, which the user agent value would otherwise be written over.
    fn forget_revert(&mut self, key: &str) {
        if self.revert.is_empty() {
            return;
        }
        let clobbered = covers::key_id(key).map_or(&[][..], covers::clobbered);
        self.revert.retain(|name| name != key && covers::key_id(name).is_none_or(|name| !clobbered.contains(&name)));
    }

    /// Whether a shorthand that is still reverted covers `longhand`, so the user agent value of it
    /// is written under the longhand, which a declaration of it has to win over.
    fn reverts_a_cover_of(&self, longhand: KeyId) -> bool {
        self.revert
            .iter()
            .any(|name| covers::key_id(name).is_some_and(|shorthand| covers::covered_by(shorthand).contains(&longhand)))
    }
}

/// A search of the bytes for a keyword, or for a property of [`initial::UNREPRESENTABLE`] followed
/// by its own keyword as a value (`"maxWidth":"none"`), which a payload that has neither pays for
/// and nothing else. The payload is compact JSON, as `JSON.stringify` writes it (the sheets rewrite
/// these keywords to `"initial"` in `validate::judge`), so the search expects `"key":"value"`
/// with no whitespace around the colon. A payload that writes `gap: 8` or `zIndex: 3` does not pass: `resolve` would
/// parse it for nothing.
fn mentions_keyword(raw: &[u8]) -> bool {
    let starts = |at: usize, word: &[u8]| raw.get(at..at + word.len()).is_some_and(|slice| slice.eq_ignore_ascii_case(word));
    let has_value = |at: usize, key: &str, keyword: &str| {
        let Some(after) = raw.get(at + key.len()..).filter(|_| starts(at, key.as_bytes())) else {
            return false;
        };
        let Some(value) = after.strip_prefix(b"\":\"") else {
            return false;
        };
        let value = value.trim_ascii_start();
        value.len() >= keyword.len() && value[..keyword.len()].eq_ignore_ascii_case(keyword.as_bytes())
    };
    (0..raw.len()).any(|at| match raw[at].to_ascii_lowercase() {
        b'u' => starts(at, b"unset"),
        b'i' => starts(at, b"initial") || starts(at, b"inherit"),
        b'r' => starts(at, b"revert"),
        b'z' | b'm' | b'g' | b'l' => initial::UNREPRESENTABLE.iter().any(|(key, keyword)| has_value(at, key, keyword)),
        _ => false,
    })
}

/// The keyword a declaration is: a CSS-wide keyword, or the initial value of a property written as
/// the keyword the style parser has no form for, which is `initial` here.
fn keyword_of_declaration(declaration: &Declaration) -> Option<Keyword> {
    keyword_of(&declaration.value).or_else(|| initial::is_unrepresentable_initial(declaration).then_some(Keyword::Initial))
}

fn has_keyword(declarations: &[Declaration]) -> bool {
    declarations.iter().any(|declaration| !declaration.key.starts_with("--") && keyword_of_declaration(declaration).is_some())
}

/// The block a declaration holds when its key is a state's and its value an object, with the
/// keywords it has.
fn block_with_keyword(declaration: &Declaration) -> Option<Vec<Declaration>> {
    crate::css::var_substitution::is_state_key(&declaration.key).then_some(())?;
    let block = serde_json::from_str::<Declarations>(&declaration.value).ok()?.0;
    has_keyword(&block).then_some(block)
}

/// `raw` with the keywords of its declarations and of its state blocks resolved, or `None` when it
/// has none.
pub(crate) fn resolve(raw: &[u8]) -> Option<Resolved> {
    if !mentions_keyword(raw) {
        return None;
    }
    let declarations = serde_json::from_slice::<Declarations>(raw).ok()?.0;
    let blocks: Vec<Option<Vec<Declaration>>> = declarations.iter().map(block_with_keyword).collect();
    if !has_keyword(&declarations) && blocks.iter().all(Option::is_none) {
        return None;
    }
    let mut resolved = Vec::new();
    let mut lists = Lists::default();
    let mut list: Vec<Declaration> = Vec::with_capacity(declarations.len());
    for (declaration, block) in declarations.into_iter().zip(blocks) {
        list.retain(|earlier| earlier.key != declaration.key);
        // A block written again replaces the earlier one, and what that one reset with it.
        resolved.retain(|earlier: &ResolvedBlock| earlier.key != declaration.key);
        match block {
            Some(block) => {
                let mut inner = Lists::default();
                let rewritten = rewrite_block(block, &mut inner);
                let arcs = inner.arcs();
                resolved.push(ResolvedBlock { key: declaration.key.clone(), reset: arcs.reset, revert: arcs.revert });
                list.push(Declaration { key: declaration.key, value: object_text(&rewritten) });
            }
            None => rewrite_declaration(&mut list, &mut lists, declaration, false),
        }
    }
    Some(Resolved { text: object_text(&list), reset: lists.arcs().reset, blocks: resolved })
}

/// The declarations of a state block with their keywords resolved.
fn rewrite_block(declarations: Vec<Declaration>, lists: &mut Lists) -> Vec<Declaration> {
    let mut list: Vec<Declaration> = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        list.retain(|earlier| earlier.key != declaration.key);
        lists.forget_revert(&declaration.key);
        rewrite_declaration(&mut list, lists, declaration, true);
    }
    list
}

fn rewrite_declaration(list: &mut Vec<Declaration>, lists: &mut Lists, declaration: Declaration, in_block: bool) {
    match keyword_of_declaration(&declaration) {
        Some(keyword) if !declaration.key.starts_with("--") => apply(list, lists, &declaration.key, keyword, in_block),
        _ => list.push(declaration),
    }
}

/// `in_block`: the keyword is in the block of a state, where `revert` has to take back what the
/// style under the block sets while the state applies. At the top level it only takes back the
/// author's earlier declarations, and the layers under the style show.
fn apply(list: &mut Vec<Declaration>, lists: &mut Lists, key: &str, keyword: Keyword, in_block: bool) {
    let id = covers::key_id(key);
    let covered: &[KeyId] = id.map_or(&[], covers::covered_by);
    list.retain(|earlier| covers::key_id(&earlier.key).is_none_or(|earlier| !covered.contains(&earlier)));
    let longhands: Vec<KeyId> = match id {
        Some(id) if covered.is_empty() => vec![id],
        Some(_) => covered.iter().copied().filter(|target| covers::covered_by(*target).is_empty()).collect(),
        None => Vec::new(),
    };
    for longhand in longhands {
        // A shorthand written earlier still gives the longhand a value, and the keyword has to take
        // that back: the initial value written after it wins over it. A shorthand reverted in the
        // block gives it the user agent's value, which `reverted` writes into the block. A `revert`
        // of the longhand takes that value as well, so it has nothing written over it.
        let reverted_under = !matches!(keyword, Keyword::Revert | Keyword::RevertLayer) && lists.reverts_a_cover_of(longhand);
        let shadowed = is_shadowed(list, longhand) || reverted_under;
        if let Some(initial) = initial::of(longhand).filter(|_| shadowed) {
            list.push(initial.clone());
        }
    }
    // `display` is no value of the style when it is a block, so a reset would leave the layers under
    // it showing (`a` is `inline` there, `div` a block): the initial value has to be written.
    if key == "display" && matches!(keyword, Keyword::Initial | Keyword::Unset) {
        list.push(Declaration { key: key.to_owned(), value: r#""inline""#.to_owned() });
    }
    let named = || std::iter::once(key.to_owned()).chain(covered.iter().map(|target| covers::name_of(*target)));
    match keyword {
        Keyword::Initial | Keyword::Unset => lists.reset.extend(named()),
        Keyword::Inherit => lists.reset.extend(named().filter(|name| INHERITED.contains(&name.as_str()))),
        Keyword::Revert | Keyword::RevertLayer if in_block => {
            lists.reset.extend(named());
            lists.revert.extend(named());
        }
        Keyword::Revert | Keyword::RevertLayer => {}
    }
}

fn is_shadowed(list: &[Declaration], longhand: KeyId) -> bool {
    list.iter()
        .any(|earlier| covers::key_id(&earlier.key).is_some_and(|shorthand| covers::covered_by(shorthand).contains(&longhand)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(json: &str) -> (serde_json::Value, Vec<String>) {
        let resolved = resolve(json.as_bytes()).expect("the style has a keyword");
        let text = serde_json::from_str(&resolved.text).expect("the text is JSON");
        (text, resolved.reset.map(|reset| reset.to_vec()).unwrap_or_default())
    }

    #[test]
    fn the_prefilter_finds_every_unrepresentable_initial() {
        for (key, keyword) in initial::UNREPRESENTABLE {
            let payload = format!(r#"{{"{key}":"{keyword}"}}"#);
            assert!(mentions_keyword(payload.as_bytes()), "{payload}");
        }
    }

    #[test]
    fn a_style_with_no_keyword_is_left_alone() {
        for json in [
            r#"{"color":"red","right":0}"#,
            r#"{"content":"an unset value"}"#,
            r#"{"hover":{"width":"1px"}}"#,
            r#"{"hover":{"content":"an unset value"}}"#,
            r#"{"@container":{"width":"unset"}}"#,
            r#"{"--x":"initial"}"#,
            "[1]",
            "5",
        ] {
            assert!(resolve(json.as_bytes()).is_none(), "{json}");
        }
    }

    #[test]
    fn a_keyword_is_removed_from_the_text_and_resets_what_it_names() {
        let (text, reset) = resolved(r#"{"right":"unset","left":"1px"}"#);
        assert_eq!(text, serde_json::json!({"left": "1px"}));
        assert_eq!(reset, ["right"]);
    }

    #[test]
    fn a_keyword_on_a_shorthand_resets_the_names_it_covers_and_takes_back_the_longhands_before_it() {
        let (text, reset) = resolved(r#"{"marginTop":"4px","margin":"initial"}"#);
        assert_eq!(text, serde_json::json!({}));
        for name in ["margin", "marginBlock", "marginInline", "marginTop", "marginLeft"] {
            assert!(reset.contains(&name.to_owned()), "{name}");
        }
    }

    #[test]
    fn a_property_with_no_initial_value_to_write_is_only_reset() {
        let (text, reset) = resolved(r#"{"color":"unset","width":"INITIAL"}"#);
        assert_eq!(text, serde_json::json!({}));
        assert_eq!(reset, ["color", "width"]);
    }

    fn resolved_block(json: &str, key: &str) -> (serde_json::Value, Vec<String>, Vec<String>) {
        let resolved = resolve(json.as_bytes()).expect("the style has a keyword");
        let block = resolved.blocks.iter().find(|block| block.key == key).expect("the block had a keyword");
        let text: serde_json::Value = serde_json::from_str(&resolved.text).expect("the text is JSON");
        (
            text[key].clone(),
            block.reset.as_deref().map(<[String]>::to_vec).unwrap_or_default(),
            block.revert.as_deref().map(<[String]>::to_vec).unwrap_or_default(),
        )
    }

    #[test]
    fn a_keyword_in_a_state_block_resets_what_it_names_in_the_block_and_not_in_the_style() {
        let (text, reset, revert) = resolved_block(r#"{"color":"red","hover":{"color":"initial","opacity":0.5}}"#, "hover");
        assert_eq!(text, serde_json::json!({"opacity": 0.5}));
        assert_eq!(reset, ["color"]);
        assert!(revert.is_empty());
        let resolved = resolve(br#"{"color":"red","hover":{"color":"initial"}}"#).expect("a keyword");
        assert!(resolved.reset.is_none(), "the style's own list is its own declarations'");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&resolved.text).expect("JSON")["color"], "red");
    }

    #[test]
    fn revert_in_a_state_block_resets_and_lists_what_it_names_and_inherit_follows_the_property() {
        let (text, reset, revert) = resolved_block(
            r#"{"focusVisible":{"margin":"revert","fontWeight":"inherit","width":"inherit","display":"unset"}}"#,
            "focusVisible",
        );
        assert_eq!(text, serde_json::json!({"display": "inline"}));
        assert!(revert.contains(&"margin".to_owned()) && revert.contains(&"marginTop".to_owned()));
        assert!(!revert.contains(&"fontWeight".to_owned()));
        for name in ["margin", "marginTop", "fontWeight", "display"] {
            assert!(reset.contains(&name.to_owned()), "{name}");
        }
        assert!(!reset.contains(&"width".to_owned()), "inherit on a property that does not inherit is dropped");
    }

    #[test]
    fn a_state_block_without_a_keyword_is_left_as_it_is() {
        let resolved = resolve(br#"{"hover":{"color":"red"},"hasHover":{"width":"unset"},"width":5}"#).expect("one has a keyword");
        assert_eq!(resolved.blocks.len(), 1);
        assert_eq!(resolved.blocks[0].key, "hasHover");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&resolved.text).expect("JSON")["hover"], serde_json::json!({"color": "red"}));
    }

    #[test]
    fn inherit_resets_a_property_that_inherits_and_no_other() {
        let (_, reset) = resolved(r#"{"fontWeight":"inherit","marginTop":"inherit","width":"inherit"}"#);
        assert_eq!(reset, ["fontWeight"]);
    }

    #[test]
    fn revert_takes_back_the_authors_declarations_and_resets_nothing() {
        let (text, reset) = resolved(r#"{"color":"revert","opacity":0.5,"width":"revert-layer"}"#);
        assert_eq!(text, serde_json::json!({"opacity": 0.5}));
        assert!(reset.is_empty());
    }

    #[test]
    fn a_longhand_a_shorthand_before_the_keyword_gave_is_written_at_its_initial_value() {
        for keyword in ["revert", "unset", "inherit"] {
            let (text, _) = resolved(&format!(r#"{{"inset":0,"right":"{keyword}"}}"#));
            assert_eq!(text, serde_json::json!({"inset": 0, "right": "auto"}), "{keyword}");
        }
    }

    #[test]
    fn a_property_whose_initial_value_the_parser_has_no_form_for_is_reset_by_its_keyword() {
        let (text, reset) = resolved(r#"{"maxWidth":"none","gap":"Normal","zIndex":"auto","lineClamp":"none","color":"red"}"#);
        assert_eq!(text, serde_json::json!({"color": "red"}));
        for name in ["maxWidth", "gap", "rowGap", "columnGap", "zIndex", "lineClamp"] {
            assert!(reset.contains(&name.to_owned()), "{name}");
        }
        assert!(resolve(br#"{"maxWidth":"10px","zIndex":3,"gap":1}"#).is_none());
    }

    #[test]
    fn a_style_that_writes_a_value_for_a_property_with_a_keyword_initial_is_not_searched() {
        for json in [
            r#"{"gap":8,"zIndex":3,"rowGap":"8px","columnGap":"1rem","maxWidth":"10px","maxHeight":0,"lineClamp":2}"#,
            r#"{"gap":"1px","zIndex":"3","gapless":"normal","content":"gap normal"}"#,
        ] {
            assert!(!mentions_keyword(json.as_bytes()), "{json}");
        }
        for json in [
            r#"{"gap":"normal"}"#,
            r#"{"color":"red","zINDEX":"AUTO"}"#,
            r#"{"rowGap":"Normal"}"#,
        ] {
            assert!(mentions_keyword(json.as_bytes()), "{json}");
        }
    }

    #[test]
    fn every_inherited_name_the_contents_hand_down_is_inherited_here() {
        macro_rules! names {
            ($($field:ident),*) => { [$(crate::css::covers::style_key(stringify!($field))),*] };
        }
        let mut handed_down = crate::layout::contents::inheritable_fields!(names).to_vec();
        handed_down.push("textBoxEdge".to_owned());
        for name in handed_down {
            assert!(INHERITED.contains(&name.as_str()), "{name}");
        }
    }

    #[test]
    fn every_inherited_name_is_a_property_of_the_style() {
        for name in INHERITED {
            assert!(crate::events::state_styles::is_property(name), "{name}");
        }
    }
}
