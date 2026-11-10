//! `var()` in any style property, as in CSS.
//!
//! A value with a `var()` cannot be parsed until the custom properties of the element it is built
//! for are known, and those come from its ancestors. So the style table does not parse such a
//! declaration into its field: [`parse`] holds its text, in written order, as a [`VarDeclaration`],
//! and [`resolve`] parses it when the element is built, against the custom properties it computes
//! to (`Inherited::custom`). A declaration that cannot be substituted (a missing name without a
//! fallback, a cycle) or that does not parse once substituted is invalid at computed-value time:
//! its property is unset, which is the initial value, and for a shorthand so is what it covers.
//!
//! The transform properties keep the text, `var()` included, in their own fields (`transform`,
//! `translate`, ...), because the parsers and the readers of the transform want one text to look at.
//! [`resolve`] substitutes those in place.
//!
//! Written order decides between a held declaration and the others, as it does in CSS
//! (`css::covers`): one laid over the style covers what it covers, except what was written after
//! it ([`VarDeclaration::kept`]), and one that a later shorthand covers is dropped when it is held.
//!
//! What is not done: a held declaration is not a value a transition or an animation can start from,
//! and what the engine reads of the declared style before the build (see `docs/fork/deviations.md`)
//! does not see it.

use std::cell::RefCell;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::css::covers::{self, KeyId};
use crate::css::custom_properties::{self, CustomProperties};
use crate::css::lenient::{json_string, object_text, recover, Declaration, Declarations};
use crate::css::transform::{DEFAULT_ORIGIN_TEXT, DEFAULT_PERSPECTIVE_ORIGIN_TEXT};
use crate::events::state_styles::laid_over;
use crate::retained_tree::parse_style;
use crate::style::StyleDesc;

/// The properties that keep a `var()` in their own text: see the module comment.
const TRANSFORM_TEXTS: [&str; 7] =
    ["transform", "translate", "rotate", "scale", "transformOrigin", "perspective", "perspectiveOrigin"];

/// How many parsed declarations are remembered before the memory starts over.
const PARSED_LIMIT: usize = 1024;

/// A declaration of a style whose text has a `var()`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VarDeclaration {
    /// The property, as written in a style object (camel case).
    key: String,
    text: String,
    /// What this declaration covers that was written after it, as plain declarations: they win.
    kept: Box<[KeyId]>,
}

/// Whether a style payload may hold a `var()`: a search of the bytes, which a payload that has none
/// pays for and nothing else.
pub(crate) fn mentions_var(raw: &[u8]) -> bool {
    raw.windows(4).any(|window| window.eq_ignore_ascii_case(b"var("))
}

/// `raw` as `StyleTable::intern` parses a payload, with the declarations that have a `var()` held
/// instead of parsed, in the state styles and `@container` blocks as well.
pub(crate) fn parse(raw: &[u8]) -> Result<StyleDesc, String> {
    let text = std::str::from_utf8(raw).map_err(|error| error.to_string())?;
    let mut style = parse_object(text)?;
    // Read from the text: which container units a style names is a property of all of it.
    style.container_unit_axes = crate::css::length::LengthReads::container_axes(text);
    Ok(style)
}

fn strict_or_recover(text: &str) -> Result<StyleDesc, String> {
    parse_style(text.as_bytes()).or_else(|error| recover(text.as_bytes(), error))
}

struct Written {
    key_id: Option<KeyId>,
    held: bool,
}

fn parse_object(text: &str) -> Result<StyleDesc, String> {
    let Ok(declarations) = serde_json::from_str::<Declarations>(text) else {
        return strict_or_recover(text);
    };
    let mut plain: Vec<Declaration> = Vec::new();
    let mut written: Vec<Written> = Vec::new();
    let mut held: Vec<(usize, String, String)> = Vec::new();
    let mut states: Vec<(String, StyleDesc)> = Vec::new();
    let mut blocks = None;
    for declaration in declarations.0 {
        let key_id = covers::key_id(&declaration.key);
        if let Some(text) = held_text(&declaration) {
            held.push((written.len(), declaration.key, text));
            written.push(Written { key_id, held: true });
            continue;
        }
        if declaration.value.starts_with('{') && mentions_var(declaration.value.as_bytes()) {
            if state_slot(&mut StyleDesc::default(), &declaration.key).is_some() {
                states.push((declaration.key, parse_object(&declaration.value)?));
                continue;
            }
            if declaration.key == "@container" {
                blocks = Some(parse_blocks(&declaration.value)?);
                continue;
            }
        }
        written.push(Written { key_id, held: false });
        plain.push(declaration);
    }
    let mut style = strict_or_recover(&object_text(&plain))?;
    for (key, state) in states {
        *state_slot(&mut style, &key).expect("a state key has a slot") = Some(Box::new(state));
    }
    if let Some(blocks) = blocks {
        style.container_rules = Some(blocks);
    }
    let held: Vec<VarDeclaration> = held
        .into_iter()
        .filter_map(|(position, key, text)| {
            let key_id = written[position].key_id;
            let later = &written[position + 1..];
            // A shorthand written after it covers it, held or not.
            let covered_later = key_id.is_some_and(|id| {
                later.iter().filter_map(|other| other.key_id).any(|other| other != id && covers::covered_by(other).contains(&id))
            });
            if covered_later {
                return None;
            }
            let kept = key_id.map_or_else(Vec::new, |id| {
                later
                    .iter()
                    .filter(|other| !other.held)
                    .filter_map(|other| other.key_id)
                    .filter(|other| covers::covered_by(id).contains(other))
                    .collect()
            });
            Some(VarDeclaration { key, text, kept: kept.into() })
        })
        .collect();
    style.var_declarations = (!held.is_empty()).then(|| held.into());
    Ok(style)
}

/// The text of a declaration that is held: a string with a `var()` in a property that is not a
/// custom property and does not keep the text in its own field.
fn held_text(declaration: &Declaration) -> Option<String> {
    if !declaration.value.starts_with('"')
        || custom_properties::is_name(&declaration.key)
        || TRANSFORM_TEXTS.contains(&declaration.key.as_str())
    {
        return None;
    }
    let text: String = serde_json::from_str(&declaration.value).ok()?;
    custom_properties::has_var(&text).then_some(text)
}

fn parse_blocks(text: &str) -> Result<crate::layout::container::ContainerRules, String> {
    let declarations = serde_json::from_str::<Declarations>(text).map_err(|error| error.to_string())?;
    let blocks = declarations
        .0
        .into_iter()
        .map(|block| Ok((block.key, parse_object(&block.value)?)))
        .collect::<Result<Vec<_>, String>>()?;
    crate::layout::container::ContainerRules::from_blocks(blocks)
}

fn state_slot<'a>(style: &'a mut StyleDesc, key: &str) -> Option<&'a mut Option<Box<StyleDesc>>> {
    Some(match key {
        "hover" => &mut style.hover,
        "active" => &mut style.active,
        "focusVisible" => &mut style.focus_visible,
        "focusWithin" => &mut style.focus_within,
        "groupHover" => &mut style.group_hover,
        "groupActive" => &mut style.group_active,
        "groupFocusWithin" => &mut style.group_focus_within,
        "hasHover" => &mut style.has_hover,
        "hasActive" => &mut style.has_active,
        "hasFocus" => &mut style.has_focus,
        "hasFocusVisible" => &mut style.has_focus_visible,
        "disabled" => &mut style.disabled,
        "enabled" => &mut style.enabled,
        "hasDisabled" => &mut style.has_disabled,
        "hasEnabled" => &mut style.has_enabled,
        _ => return None,
    })
}

/// The held declarations of `base` that survive `over` laid on it, then those of `over`. A plain
/// declaration of `over` for a property wins over a held one of `base`, as does a shorthand of
/// `over` that covers it; a held declaration of `over` is read after, so it wins by its place.
pub(crate) fn merge(base: &StyleDesc, over: &StyleDesc) -> Option<Arc<[VarDeclaration]>> {
    let Some(held) = &base.var_declarations else {
        return over.var_declarations.clone();
    };
    let mut written = None;
    let survivors: Vec<&VarDeclaration> =
        held.iter().filter(|declaration| !is_overridden(declaration, over, &mut written)).collect();
    let after = over.var_declarations.as_deref().unwrap_or_default();
    if survivors.len() == held.len() && after.is_empty() {
        return base.var_declarations.clone();
    }
    let merged: Vec<VarDeclaration> = survivors.into_iter().chain(after).cloned().collect();
    (!merged.is_empty()).then(|| merged.into())
}

fn is_overridden(declaration: &VarDeclaration, over: &StyleDesc, written: &mut Option<serde_json::Value>) -> bool {
    if let Some(id) = covers::key_id(&declaration.key) {
        return covers::is_set(over, id) || covers::is_covered_in(over, id);
    }
    let written = written.get_or_insert_with(|| serde_json::to_value(over).expect("a style serializes"));
    written.get(&declaration.key).is_some_and(|value| !value.is_null())
}

/// Whether `style` has a `var()` that the custom properties of its element substitute, in a
/// transform text or a held declaration, or in a focus style, which is laid over it when it is built.
pub(crate) fn reads_vars(style: &StyleDesc) -> bool {
    style.var_declarations.is_some()
        || crate::css::transform::reads_vars(style)
        || [&style.focus_visible, &style.focus_within].into_iter().flatten().any(|state| reads_vars(state))
}

/// `style` with every `var()` in it substituted by what `custom`, the custom properties its element
/// computes to, says, so that everything that reads the style (the build, the readers of the
/// transform, stacking, the containing block, painting) sees the same values. `None` when there
/// is none.
///
/// A transform text that cannot be resolved is the initial value of its property: `none`, and
/// `50% 50%` for an origin. The focus styles are laid over the element when it is built, so they
/// are substituted too. The pointer states are folded into the style before this runs.
pub(crate) fn resolve(style: &StyleDesc, custom: &CustomProperties) -> Option<StyleDesc> {
    if !reads_vars(style) {
        return None;
    }
    let mut resolved = style.clone();
    resolve_in(&mut resolved, custom);
    Some(resolved)
}

fn own_texts(style: &mut StyleDesc) -> [(&mut Option<String>, &'static str); 7] {
    [
        (&mut style.transform, "none"),
        (&mut style.translate, "none"),
        (&mut style.rotate, "none"),
        (&mut style.scale, "none"),
        (&mut style.transform_origin, DEFAULT_ORIGIN_TEXT),
        (&mut style.perspective, "none"),
        (&mut style.perspective_origin, DEFAULT_PERSPECTIVE_ORIGIN_TEXT),
    ]
}

fn resolve_in(style: &mut StyleDesc, custom: &CustomProperties) {
    for (slot, initial) in own_texts(style) {
        let Some(text) = slot.as_deref().filter(|text| custom_properties::has_var(text)) else {
            continue;
        };
        *slot = Some(match custom_properties::substitute(text, custom) {
            Some(substituted) => substituted.trim().to_owned(),
            None => initial.to_owned(),
        });
    }
    if let Some(held) = style.var_declarations.take() {
        lay_declarations(style, &held, custom);
    }
    for state in [&mut style.focus_visible, &mut style.focus_within].into_iter().flatten() {
        resolve_in(state, custom);
    }
}

/// The held declarations laid over `style`, one after the other.
fn lay_declarations(style: &mut StyleDesc, held: &[VarDeclaration], custom: &CustomProperties) {
    // What a shorthand covers but was written before the plain declarations after it.
    let plain = held.iter().any(|declaration| !declaration.kept.is_empty()).then(|| style.clone());
    for declaration in held {
        let key_id = covers::key_id(&declaration.key);
        let parsed = custom_properties::substitute(&declaration.text, custom)
            .and_then(|text| parse_declaration(&declaration.key, text.trim()));
        match parsed {
            Some(parsed) => {
                let mut laid = laid_over(style, &parsed);
                if let Some(plain) = &plain {
                    covers::restore(&mut laid, plain, &declaration.kept);
                }
                *style = laid;
            }
            None => {
                if let Some(id) = key_id {
                    covers::reset(style, id, &declaration.kept);
                }
            }
        }
    }
}

thread_local! {
    static PARSED: RefCell<FxHashMap<(String, String), Option<Arc<StyleDesc>>>> = RefCell::default();
}

/// The style `key: text` makes alone, or `None` when it is not a value of the property. The same
/// few texts come back every frame (`120px` from one `--w`), so they are parsed once.
fn parse_declaration(key: &str, text: &str) -> Option<Arc<StyleDesc>> {
    let memo_key = (key.to_owned(), text.to_owned());
    if let Some(known) = PARSED.with_borrow(|parsed| parsed.get(&memo_key).cloned()) {
        return known;
    }
    let alone = format!("{{{}:{}}}", json_string(key), json_string(text));
    let parsed = parse_style(alone.as_bytes()).ok().map(Arc::new);
    PARSED.with_borrow_mut(|memory| {
        if memory.len() >= PARSED_LIMIT {
            memory.clear();
        }
        memory.insert(memo_key, parsed.clone());
    });
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(json: &str) -> StyleDesc {
        parse(json.as_bytes()).unwrap_or_else(|error| panic!("{json}: {error}"))
    }

    fn custom(entries: &[(&str, &str)]) -> CustomProperties {
        CustomProperties::declared(entries.iter().map(|(name, value)| (name.to_string(), value.to_string())))
            .unwrap_or_default()
    }

    fn resolved(json: &str, entries: &[(&str, &str)]) -> StyleDesc {
        let style = style(json);
        resolve(&style, &custom(entries)).unwrap_or(style)
    }

    #[test]
    fn a_payload_without_a_var_is_not_looked_at() {
        assert!(!mentions_var(br#"{"width":"10px","--v":"vars"}"#));
        assert!(mentions_var(br#"{"width":"VAR(--w)"}"#));
    }

    #[test]
    fn a_declaration_with_a_var_is_held_and_not_parsed() {
        let held = style(r#"{"width":"var(--w)","height":10,"opacity":0.5}"#);
        assert_eq!(held.width, None);
        assert!(held.height.is_some());
        assert_eq!(held.opacity, Some(0.5));
        assert_eq!(held.var_declarations.as_deref().map(<[_]>::len), Some(1));
    }

    #[test]
    fn a_style_without_one_holds_nothing() {
        assert_eq!(style(r#"{"width":"10px","--a":"var(--b)"}"#).var_declarations, None);
    }

    #[test]
    fn a_dimension_is_substituted() {
        let sized = resolved(r#"{"width":"var(--w)"}"#, &[("--w", "120px")]);
        assert_eq!(sized.width, style(r#"{"width":"120px"}"#).width);
        assert!(sized.width.is_some());
        assert_eq!(sized.var_declarations, None);
    }

    #[test]
    fn a_calc_around_a_var_is_substituted() {
        let sized = resolved(r#"{"maxHeight":"calc(var(--h) - 8px)"}"#, &[("--h", "100px")]);
        assert_eq!(sized.max_height, style(r#"{"maxHeight":"calc(100px - 8px)"}"#).max_height);
        assert!(sized.max_height.is_some());
    }

    #[test]
    fn a_color_is_substituted() {
        let colored = resolved(r##"{"backgroundColor":"var(--bg)","color":"var(--fg)"}"##, &[("--bg", "#ff0000"), ("--fg", "blue")]);
        assert_eq!(colored.background_color.as_deref(), Some("#ff0000"));
        assert_eq!(colored.color.as_deref(), Some("blue"));
    }

    #[test]
    fn a_border_shorthand_is_substituted() {
        let bordered = resolved(r#"{"border":"var(--b)"}"#, &[("--b", "2px solid red")]);
        assert_eq!(bordered.border.as_deref(), Some("2px solid red"));
    }

    #[test]
    fn a_fallback_is_used_when_the_name_is_missing() {
        let sized = resolved(r#"{"width":"var(--x, 10px)"}"#, &[]);
        assert_eq!(sized.width, style(r#"{"width":"10px"}"#).width);
        let named = resolved(r#"{"width":"var(--x, 10px)"}"#, &[("--x", "30px")]);
        assert_eq!(named.width, style(r#"{"width":"30px"}"#).width);
    }

    #[test]
    fn an_unresolvable_declaration_is_the_initial_value() {
        for json in [r#"{"width":"var(--missing)"}"#, r#"{"width":"var(--w)"}"#] {
            let sized = resolved(json, &[("--w", "not a length")]);
            assert_eq!(sized.width, None, "{json}");
            assert_eq!(sized.var_declarations, None, "{json}");
        }
        let kept = resolved(r#"{"width":"var(--missing)","height":10}"#, &[]);
        assert!(kept.height.is_some());
    }

    #[test]
    fn a_shorthand_written_after_plain_longhands_covers_them() {
        let shorthand = resolved(r#"{"borderWidth":"2px","border":"var(--b)"}"#, &[("--b", "1px solid red")]);
        assert_eq!(shorthand.border.as_deref(), Some("1px solid red"));
        assert_eq!(shorthand.border_width, None);

        let unresolved = resolved(r#"{"borderWidth":"2px","border":"var(--b)"}"#, &[]);
        assert_eq!(unresolved.border, None);
        assert_eq!(unresolved.border_width, None);
    }

    #[test]
    fn a_plain_longhand_written_after_a_shorthand_wins() {
        let longhand = resolved(r#"{"border":"var(--b)","borderWidth":"2px"}"#, &[("--b", "1px solid red")]);
        assert_eq!(longhand.border.as_deref(), Some("1px solid red"));
        assert_eq!(longhand.border_width, style(r#"{"borderWidth":"2px"}"#).border_width);
        assert!(longhand.border_width.is_some());

        let unresolved = resolved(r#"{"border":"var(--b)","borderWidth":"2px"}"#, &[]);
        assert_eq!(unresolved.border, None);
        assert!(unresolved.border_width.is_some());
    }

    #[test]
    fn a_held_longhand_covered_by_a_later_shorthand_is_dropped() {
        let covered = style(r#"{"paddingTop":"var(--p)","padding":8}"#);
        assert_eq!(covered.var_declarations, None);
        let after = resolved(r#"{"padding":8,"paddingTop":"var(--p)"}"#, &[("--p", "4px")]);
        assert_eq!(after.padding_top, style(r#"{"paddingTop":"4px"}"#).padding_top);
        assert!(after.padding_top.is_some());
        assert!(after.padding.is_some());
    }

    #[test]
    fn held_declarations_follow_written_order_between_themselves() {
        let longhand_last = resolved(
            r#"{"padding":"var(--all)","paddingTop":"var(--top)"}"#,
            &[("--all", "8px"), ("--top", "4px")],
        );
        assert!(longhand_last.padding.is_some());
        assert!(longhand_last.padding_top.is_some());
        let longhand_first = resolved(r#"{"paddingTop":"var(--top)","padding":"var(--all)"}"#, &[("--all", "8px"), ("--top", "4px")]);
        assert!(longhand_first.padding.is_some());
        assert_eq!(longhand_first.padding_top, None);
    }

    #[test]
    fn the_transform_texts_keep_their_text_and_resolve_through_the_same_function() {
        let held = style(r#"{"transformOrigin":"var(--o)","transform":"translateX(var(--x))","width":"var(--w)"}"#);
        assert_eq!(held.transform_origin.as_deref(), Some("var(--o)"));
        assert_eq!(held.var_declarations.as_deref().map(<[_]>::len), Some(1));
        let resolved = resolve(&held, &custom(&[("--o", "top left"), ("--x", "4px"), ("--w", "5px")])).unwrap();
        assert_eq!(resolved.transform_origin.as_deref(), Some("top left"));
        assert_eq!(resolved.transform.as_deref(), Some("translateX( 4px )"));
        assert!(resolved.width.is_some());
        let initial = resolve(&held, &custom(&[])).unwrap();
        assert_eq!(initial.transform_origin.as_deref(), Some(DEFAULT_ORIGIN_TEXT));
        assert_eq!(initial.transform.as_deref(), Some("none"));
    }

    #[test]
    fn a_state_style_holds_its_own_declarations() {
        let held = style(r#"{"backgroundColor":"red","hover":{"backgroundColor":"var(--hover)","opacity":0.5}}"#);
        assert_eq!(held.var_declarations, None);
        assert!(held.holds_var_declarations());
        let hover = held.hover.as_deref().expect("the state style stays");
        assert_eq!(hover.opacity, Some(0.5));
        assert_eq!(hover.background_color, None);
        assert_eq!(hover.var_declarations.as_deref().map(<[_]>::len), Some(1));
    }

    #[test]
    fn a_container_block_holds_its_own_declarations() {
        let held = style(r#"{"@container":{"(min-width: 10px)":{"width":"var(--w)"}}}"#);
        assert!(held.container_rules.as_ref().is_some_and(|rules| rules.any_style(|block| block.var_declarations.is_some())));
        assert!(held.holds_var_declarations());
    }

    #[test]
    fn a_state_style_laid_over_a_held_declaration_wins_where_it_declares_the_property() {
        let button = style(
            r##"{"backgroundColor":"var(--bg)","width":"var(--w)","hover":{"backgroundColor":"#222222"}}"##,
        );
        let hovered = crate::events::state_styles::resolve_state_styles(&button, true, false);
        assert_eq!(hovered.background_color.as_deref(), Some("#222222"));
        let hovered = resolve(&hovered, &custom(&[("--bg", "red"), ("--w", "7px")])).unwrap();
        assert_eq!(hovered.background_color.as_deref(), Some("#222222"));
        assert!(hovered.width.is_some());

        let at_rest = crate::events::state_styles::resolve_state_styles(&button, false, true);
        let at_rest = resolve(&at_rest, &custom(&[("--bg", "red")])).unwrap();
        assert_eq!(at_rest.background_color.as_deref(), Some("red"));
        assert_eq!(at_rest.width, None);
    }

    #[test]
    fn a_state_style_with_a_held_declaration_lays_it_after_the_base() {
        let base = style(r#"{"width":10}"#);
        let with_hover = style(r#"{"width":10,"hover":{"width":"var(--w)"}}"#);
        assert!(base.holds_var_declarations() == false);
        let hovered = crate::events::state_styles::resolve_state_styles(&with_hover, true, false);
        let hovered = resolve(&hovered, &custom(&[("--w", "50px")])).unwrap();
        assert_eq!(hovered.width, style(r#"{"width":"50px"}"#).width);
    }

    #[test]
    fn the_flags_of_the_element_survive_the_substitution() {
        let mut held = style(r#"{"width":"var(--w)"}"#);
        held.measure_natural_width = true;
        held.atomic_inline = true;
        let resolved = resolve(&held, &custom(&[("--w", "5px")])).unwrap();
        assert!(resolved.measure_natural_width && resolved.atomic_inline);
    }

    #[test]
    fn an_invalid_plain_value_still_drops_alone_beside_a_held_one() {
        let held = style(r#"{"border":0,"width":"var(--w)","height":"inherit","opacity":0.5}"#);
        assert_eq!(held.height, None);
        assert_eq!(held.opacity, Some(0.5));
        assert_eq!(held.var_declarations.as_deref().map(<[_]>::len), Some(1));
    }

    #[test]
    fn the_same_text_parses_once() {
        let first = parse_declaration("width", "9px").unwrap();
        let again = parse_declaration("width", "9px").unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert!(parse_declaration("width", "nonsense").is_none());
    }

    #[test]
    fn a_length_is_what_the_property_reads() {
        let sized = resolved(r#"{"width":"var(--w)"}"#, &[("--w", "120px")]);
        assert_eq!(sized.width, Some(crate::style::DimensionValue::Pixels(120.0)));
    }
}
