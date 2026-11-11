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
//! (`css::covers`). A plain declaration written after a held one that overlaps it is held too, as
//! text, and [`resolve`] lays the held declarations one after the other with the layering a state
//! style gets, so a shorthand resets what it covers and an all-sides border value is split as for
//! literals. One that a later held declaration covers is dropped. The same holds between layers (a
//! state style, an `@container` block, the universal style over or under an element's own):
//! [`merge`] adds what the layer above sets that overlaps a held declaration of the layer below to
//! its [`VarDeclaration::kept`], and it is laid under those.
//!
//! The renderer resolves a style right after the pointer states are folded into it and before
//! anything reads it (`renderer::build_element`): inheritance, transitions, animations and motion
//! all see the values. What the engine reads of the declared style before that (the retained tree,
//! the parents' pass over their children) does not see a held declaration, see
//! `docs/fork/deviations.md`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::css::covers::{self, KeyId};
use crate::css::custom_properties::{self, CustomProperties};
use crate::css::lenient::{is_unitless, json_string, number_text, object_text, recover, Declaration, Declarations};
use crate::css::transform::{DEFAULT_ORIGIN_TEXT, DEFAULT_PERSPECTIVE_ORIGIN_TEXT};
use crate::events::state_styles::{is_no_layer, laid_over, sets_property, without_invalid_values};
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
    /// What a plain declaration of a layer above sets that this one is in the way of
    /// (`covers::overlapping`): those win. Empty from `parse`: within one object the declarations
    /// that overlap a held one are held too, and laid in written order.
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

/// A declaration of the object being parsed, with what is known of it in written order.
struct Entry {
    declaration: Declaration,
    key_id: Option<KeyId>,
    /// The text to substitute and parse when the element is built, when the declaration is held.
    held: Option<String>,
    /// Held although its text has no `var()`: a declaration written after a held one that overlaps
    /// it, which has to be laid in written order with it.
    promoted: bool,
}

fn parse_object(text: &str) -> Result<StyleDesc, String> {
    let Ok(declarations) = serde_json::from_str::<Declarations>(text) else {
        return strict_or_recover(text);
    };
    let mut entries: Vec<Entry> = Vec::new();
    let mut states: Vec<(String, StyleDesc)> = Vec::new();
    let mut blocks = None;
    for declaration in declarations.0 {
        let key_id = covers::key_id(&declaration.key);
        if let Some(held) = held_text(&declaration) {
            entries.push(Entry { declaration, key_id, held: Some(held), promoted: false });
            continue;
        }
        if declaration.value.starts_with('{') && mentions_var(declaration.value.as_bytes()) {
            if state_slot(&mut StyleDesc::default(), &declaration.key).is_some() {
                states.push((declaration.key, parse_object(&declaration.value)?));
                continue;
            }
            if declaration.key == "@container" {
                blocks = Some(parse_blocks(&declaration.value));
                continue;
            }
        }
        // One that is invalid stays plain, to be dropped with the rest of the plain ones, and so
        // covers nothing.
        let held = key_id
            .filter(|&id| entries.iter().any(|earlier| earlier.is_held_overlapping(id)))
            .and_then(|_| valid_text(&declaration));
        entries.push(Entry { declaration, key_id, promoted: held.is_some(), held });
    }
    settle_held(&mut entries);
    let mut plain: Vec<Declaration> = Vec::new();
    let mut held: Vec<VarDeclaration> = Vec::new();
    for entry in entries {
        match entry.held {
            Some(text) => held.push(VarDeclaration { key: entry.declaration.key, text, kept: Box::default() }),
            None => plain.push(entry.declaration),
        }
    }
    let mut style = strict_or_recover(&object_text(&plain))?;
    for (key, state) in states {
        *state_slot(&mut style, &key).expect("a state key has a slot") = Some(Box::new(state));
    }
    if let Some(blocks) = blocks {
        style.container_rules = Some(blocks);
    }
    style.var_declarations = (!held.is_empty()).then(|| held.into());
    Ok(style)
}

impl Entry {
    fn is_held_overlapping(&self, key: KeyId) -> bool {
        self.held.is_some() && self.key_id.is_some_and(|held| covers::overlaps(held, key))
    }
}

/// Drops a held declaration that a held one written after it covers (laying it first would change
/// nothing), and lets a promoted one go back to the plain declarations when what it overlapped went.
fn settle_held(entries: &mut Vec<Entry>) {
    let covered: Vec<bool> = (0..entries.len())
        .map(|index| {
            let entry = &entries[index];
            entry.held.is_some()
                && entry.key_id.is_some_and(|id| {
                    entries[index + 1..].iter().any(|later| {
                        later.held.is_some()
                            && later.key_id.is_some_and(|other| other != id && covers::covered_by(other).contains(&id))
                    })
                })
        })
        .collect();
    let mut covered = covered.into_iter();
    entries.retain(|_| !covered.next().expect("one flag for each entry"));
    let mut laid: Vec<KeyId> = Vec::new();
    for entry in entries.iter_mut().filter(|entry| entry.held.is_some()) {
        let id = entry.key_id;
        if entry.promoted && !id.is_some_and(|id| laid.iter().any(|&held| covers::overlaps(held, id))) {
            entry.held = None;
            entry.promoted = false;
        } else if let Some(id) = id {
            laid.push(id);
        }
    }
}

/// The text of a plain declaration that is valid, for a property written as `declaration.key`: a
/// string as it is, a number as React DOM writes it.
fn valid_text(declaration: &Declaration) -> Option<String> {
    let text = if declaration.value.starts_with('"') {
        serde_json::from_str(&declaration.value).ok()?
    } else {
        number_text(&declaration.key, &declaration.value)?
    };
    let parsed = parse_declaration(&declaration.key, &text)?;
    matches!(without_invalid_values(&parsed), Cow::Borrowed(_)).then_some(text)
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

/// The `@container` blocks of `text`. A block whose query or style does not parse is dropped, and
/// the rest stay, as the lenient parse of a style without a `var()` does.
fn parse_blocks(text: &str) -> crate::layout::container::ContainerRules {
    let blocks = serde_json::from_str::<Declarations>(text).map(|declarations| declarations.0).unwrap_or_default();
    crate::layout::container::ContainerRules::from_blocks(blocks.into_iter().filter_map(|block| {
        match parse_object(&block.value) {
            Ok(style) => Some((block.key, style)),
            Err(error) => {
                log::warn!("Dropped style declaration @container.{}: {error}", block.key);
                None
            }
        }
    }))
}

fn state_slot<'a>(style: &'a mut StyleDesc, key: &str) -> Option<&'a mut Option<Box<StyleDesc>>> {
    Some(match key {
        "hover" => &mut style.hover,
        "active" => &mut style.active,
        "focus" => &mut style.focus,
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
/// `over` that covers it; a held declaration of `over` is read after, so it wins by its place. What
/// `over` sets that a surviving declaration of `base` would overwrite is kept from it.
pub(crate) fn merge(base: &StyleDesc, over: &StyleDesc) -> Option<Arc<[VarDeclaration]>> {
    let Some(held) = &base.var_declarations else {
        return over.var_declarations.clone();
    };
    if is_no_layer(over) {
        return base.var_declarations.clone();
    }
    let after = over.var_declarations.as_deref().unwrap_or_default();
    let mut changed = !after.is_empty();
    let mut merged: Vec<VarDeclaration> = Vec::with_capacity(held.len() + after.len());
    for declaration in held.iter() {
        let Some(id) = covers::key_id(&declaration.key) else {
            if sets_property(over, &declaration.key) {
                changed = true;
            } else {
                merged.push(declaration.clone());
            }
            continue;
        };
        if covers::is_set(over, id) || covers::is_covered_in(over, id) {
            changed = true;
            continue;
        }
        let newly_kept: Vec<KeyId> = covers::overlapping(id)
            .iter()
            .copied()
            .filter(|other| covers::is_set(over, *other) && !declaration.kept.contains(other))
            .collect();
        if newly_kept.is_empty() {
            merged.push(declaration.clone());
        } else {
            changed = true;
            let kept = declaration.kept.iter().copied().chain(newly_kept).collect();
            merged.push(VarDeclaration { kept, ..declaration.clone() });
        }
    }
    if !changed {
        return base.var_declarations.clone();
    }
    merged.extend(after.iter().cloned());
    (!merged.is_empty()).then(|| merged.into())
}

/// Whether `style` has a `var()` that the custom properties of its element substitute, in a
/// transform text or a held declaration, or in a focus style, which is laid over it when it is built.
pub(crate) fn reads_vars(style: &StyleDesc) -> bool {
    macro_rules! any_variant {
        ($($field:ident),+) => { false $(|| style.$field.as_deref().is_some_and(reads_vars))+ };
    }
    style.var_declarations.is_some()
        || crate::css::transform::reads_vars(style)
        || crate::focus::focus_variant_fields!(any_variant)
}

/// Whether `style` holds a declaration of a property whose name starts with `family` (`transition`,
/// `animation`), which is not a field of it until it is resolved: the style may still declare what
/// that family does.
pub(crate) fn holds_family(style: &StyleDesc, family: &str) -> bool {
    style.var_declarations.as_deref().is_some_and(|held| held.iter().any(|declaration| declaration.key.starts_with(family)))
}

/// What element `id` computes to for its `var()`: the custom properties it computes to below
/// `parent` (the focus variants that apply to it included) and `style` with them substituted,
/// `None` when it holds no `var()`.
pub(crate) fn substitute_for_element(
    focus_styles: &crate::focus::FocusStyles,
    focusable: bool,
    id: u64,
    style: Option<&StyleDesc>,
    parent: &CustomProperties,
) -> (Option<StyleDesc>, CustomProperties) {
    let custom = match style {
        Some(style) => focus_styles.custom_of(id, style, focusable, parent),
        None => parent.clone(),
    };
    let substituted = style.and_then(|style| resolve(style, &custom));
    (substituted, custom)
}

/// `style` with every `var()` in it substituted by what `custom`, the custom properties its element
/// computes to, says, so that everything that reads the style (the build, the readers of the
/// transform, stacking, the containing block, painting) sees the same values. `None` when there
/// is none.
///
/// A transform text that cannot be resolved is the initial value of its property: `none`, and
/// `50% 50%` for an origin. The focus styles are laid over the element when it is built, so they
/// are substituted too, against the same `custom`: the caller puts the custom properties of the
/// variants that apply in it. The pointer states are folded into the style before this runs.
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
    // The custom properties of a focus variant that applies are already in `custom`
    // (`FocusStyles::custom_of`), as CSS has them for the whole element.
    macro_rules! resolve_variants {
        ($($field:ident),+) => {$(
            if let Some(variant) = style.$field.as_mut() {
                resolve_in(variant, custom);
            }
        )+};
    }
    crate::focus::focus_variant_fields!(resolve_variants);
}

/// The held declarations laid over `style`, one after the other.
fn lay_declarations(style: &mut StyleDesc, held: &[VarDeclaration], custom: &CustomProperties) {
    // What a declaration clobbers but a plain declaration written after it keeps.
    let plain = held.iter().any(|declaration| !declaration.kept.is_empty()).then(|| style.clone());
    for declaration in held {
        let key_id = covers::key_id(&declaration.key);
        let parsed = custom_properties::substitute(&declaration.text, custom)
            .and_then(|text| parse_declaration(&declaration.key, text.trim()));
        match parsed {
            Some(parsed) => {
                *style = match &plain {
                    Some(plain) if !declaration.kept.is_empty() => {
                        // Laid under what the layer above set, as the layers fold for plain values:
                        // that is what pushes a held all-sides border value down to the sides a
                        // side shorthand of the layer leaves.
                        let mut beneath = style.clone();
                        covers::clear(&mut beneath, &declaration.kept);
                        let mut above = StyleDesc::default();
                        // The longhands a kept shorthand covers are the layer's own, written after
                        // it (a longhand written before it is gone from `plain`): laid over the
                        // shorthand they are what the layer shows, which `laid_over` would drop
                        // from `beneath`'s copy of them otherwise.
                        covers::restore(&mut above, plain, &covers::with_covered(&declaration.kept));
                        laid_over(&laid_over(&beneath, &parsed), &above)
                    }
                    _ => laid_over(style, &parsed),
                };
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
    let alone = |value: &str| format!("{{{}:{}}}", json_string(key), value);
    let parsed = parse_style(alone(&json_string(text)).as_bytes())
        .ok()
        // The property's value is a `<number>` (`opacity`, `zIndex`, ...): the text is its text. For
        // any other property a bare number is not a value, as in CSS.
        .or_else(|| {
            let number = text.parse::<f64>().ok().filter(|number| number.is_finite() && is_unitless(key))?;
            parse_style(alone(&number.to_string()).as_bytes()).ok()
        })
        .map(Arc::new);
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

    fn hovered(json: &str, entries: &[(&str, &str)]) -> StyleDesc {
        let folded = crate::events::state_styles::resolve_state_styles(&style(json), true, false);
        resolve(&folded, &custom(entries)).unwrap_or(folded)
    }

    #[test]
    fn a_longhand_of_a_state_style_beats_a_held_shorthand_it_covers() {
        let bordered = hovered(
            r#"{"border":"1px solid var(--line)","hover":{"borderColor":"red"}}"#,
            &[("--line", "blue")],
        );
        assert!(bordered.border.as_deref().is_some_and(|border| border.contains("blue")));
        assert_eq!(bordered.border_color.as_deref(), Some("red"));

        let painted = hovered(
            r#"{"background":"var(--bg)","hover":{"backgroundColor":"blue"}}"#,
            &[("--bg", "red")],
        );
        assert_eq!(painted.background_color.as_deref(), Some("blue"));
        assert!(painted.background.is_some());

        let at_rest = {
            let folded = crate::events::state_styles::resolve_state_styles(
                &style(r#"{"border":"1px solid var(--line)","hover":{"borderColor":"red"}}"#),
                false,
                false,
            );
            resolve(&folded, &custom(&[("--line", "blue")])).unwrap()
        };
        assert_eq!(at_rest.border_color, None);
    }

    #[test]
    fn a_longhand_of_the_layer_above_beats_a_held_shorthand_below() {
        let universal = style(r#"{"borderColor":"var(--x)"}"#);
        let own = style(r#"{"borderTopColor":"red"}"#);
        let layered = crate::universal_style::layer_under(&universal, &own);
        let layered = resolve(&layered, &custom(&[("--x", "blue")])).unwrap();
        assert_eq!(layered.border_top_color.as_deref(), Some("red"));
        assert_eq!(layered.border_color.as_deref(), Some("blue"));

        let base = style(r#"{"padding":"var(--p)"}"#);
        let block = style(r#"{"paddingTop":3}"#);
        let folded = crate::universal_style::layer_under(&base, &block);
        let folded = resolve(&folded, &custom(&[("--p", "9px")])).unwrap();
        assert_eq!(folded.padding_top, style(r#"{"paddingTop":3}"#).padding_top);
        assert!(folded.padding.is_some());
    }

    #[test]
    fn what_a_layer_sets_is_kept_from_a_held_declaration_only_once() {
        let base = style(r#"{"padding":"var(--p)"}"#);
        let over = style(r#"{"paddingTop":3}"#);
        let merged = merge(&base, &over).unwrap();
        assert_eq!(merged.len(), 1);
        let again = merge(&StyleDesc { var_declarations: Some(merged.clone()), ..base.clone() }, &over).unwrap();
        assert_eq!(again[0].kept, merged[0].kept);
        assert!(Arc::ptr_eq(&merge(&base, &StyleDesc::default()).unwrap(), base.var_declarations.as_ref().unwrap()));
    }

    #[test]
    fn a_plain_border_color_written_after_a_held_side_shorthand_gives_four_sides() {
        let sides = resolved(r#"{"borderTop":"var(--t)","borderColor":"red"}"#, &[("--t", "1px solid blue")]);
        let twin = style(r#"{"borderTop":"1px solid blue","borderColor":"red"}"#);
        assert_eq!(sides.border_top, twin.border_top);
        assert_eq!(sides.border_color, twin.border_color);
        assert_eq!(
            [&sides.border_right_color, &sides.border_bottom_color, &sides.border_left_color],
            [&twin.border_right_color, &twin.border_bottom_color, &twin.border_left_color]
        );

        let before = resolved(r#"{"borderColor":"red","borderTop":"var(--t)"}"#, &[("--t", "1px solid blue")]);
        assert_eq!(before.border_top.as_deref(), Some("1px solid blue"));
        assert_eq!(before.border_color, None);
        assert_eq!(before.border_right_color.as_deref(), Some("red"));
    }

    #[test]
    fn a_number_resolves_for_a_property_that_wants_one() {
        let numbers = resolved(
            r#"{"opacity":"var(--o)","zIndex":"var(--z)","flexGrow":"var(--g)","flexShrink":"var(--s)","order":"var(--n)","lineClamp":"var(--c)"}"#,
            &[("--o", "0.5"), ("--z", "3"), ("--g", "2"), ("--s", "0"), ("--n", "-1"), ("--c", "4")],
        );
        assert_eq!(numbers.opacity, Some(0.5));
        assert_eq!(numbers.z_index, Some(3.0));
        assert_eq!(numbers.flex_grow, Some(2.0));
        assert_eq!(numbers.flex_shrink, Some(0.0));
        assert_eq!(numbers.order, Some(-1.0));
        assert_eq!(numbers.line_clamp, Some(4.0));
        let wrong = resolved(r#"{"opacity":"var(--o)"}"#, &[("--o", "half")]);
        assert_eq!(wrong.opacity, None);
        let infinite = resolved(r#"{"opacity":"var(--o)"}"#, &[("--o", "inf")]);
        assert_eq!(infinite.opacity, None);
    }

    #[test]
    fn a_bare_number_is_not_a_length() {
        for json in [r#"{"padding":"var(--n)"}"#, r#"{"gap":"var(--n)"}"#] {
            let dropped = resolved(json, &[("--n", "8")]);
            assert_eq!(dropped.padding, None, "{json}");
            assert_eq!(dropped.gap, None, "{json}");
        }
        assert_eq!(style(r#"{"padding":"8"}"#).padding, None);
        let zero = resolved(r#"{"padding":"var(--n)"}"#, &[("--n", "0")]);
        assert_eq!(zero.padding, style(r#"{"padding":"0"}"#).padding);
        assert!(zero.padding.is_some());
    }

    #[test]
    fn a_container_block_with_a_bad_query_is_dropped_and_the_rest_stay() {
        let blocks = style(
            r#"{"width":10,"@container":{"not a query":{"width":"var(--w)"},"(min-width: 10px)":{"width":"var(--w)"}}}"#,
        );
        let rules = serde_json::to_value(blocks.container_rules.as_ref().expect("the good block stays")).unwrap();
        let queries: Vec<&String> = rules.as_object().unwrap().keys().collect();
        assert_eq!(queries, ["(min-width: 10px)"]);
        assert!(blocks.width.is_some());
    }

    #[test]
    fn every_focus_variant_resolves() {
        let focused = resolved(
            r#"{"focusVisible":{"width":"var(--w)"},"focusWithin":{"height":"var(--w)"},"hasFocusVisible":{"opacity":"var(--o)"}}"#,
            &[("--w", "5px"), ("--o", "0.5")],
        );
        assert_eq!(focused.focus_visible.as_ref().unwrap().width, style(r#"{"width":"5px"}"#).width);
        assert_eq!(focused.focus_within.as_ref().unwrap().height, style(r#"{"height":"5px"}"#).height);
        assert_eq!(focused.has_focus_visible.as_ref().unwrap().opacity, Some(0.5));
        assert!(!focused.holds_var_declarations());
    }

    #[test]
    fn a_focus_variant_reads_the_custom_properties_it_is_given() {
        let focused = resolved(
            r#"{"focusVisible":{"width":"var(--w)","height":"var(--h)"}}"#,
            &[("--w", "70px"), ("--h", "5px")],
        );
        let variant = focused.focus_visible.as_ref().unwrap();
        assert_eq!(variant.width, style(r#"{"width":"70px"}"#).width);
        assert_eq!(variant.height, style(r#"{"height":"5px"}"#).height);
    }

    #[test]
    fn a_property_is_read_by_the_name_a_style_object_writes() {
        use crate::events::state_styles::sets_property;
        let set = style(r#"{"width":10,"borderTopLeftRadius":3,"fontVariantNumeric":"tabular-nums"}"#);
        assert!(sets_property(&set, "width"));
        assert!(sets_property(&set, "borderTopLeftRadius"));
        assert!(sets_property(&set, "fontVariantNumeric"));
        assert!(!sets_property(&set, "height"));
        assert!(!sets_property(&set, "notAProperty"));
    }

    #[test]
    fn a_held_property_outside_the_covers_table_is_overridden_by_a_layer_that_sets_it() {
        let base = style(r#"{"opacity":"var(--o)","width":"var(--w)"}"#);
        let merged = merge(&base, &style(r#"{"opacity":0.5}"#)).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].key, "width");
    }

    /// `with_var` resolved, against the same style with the values written in.
    fn same_as_literal(with_var: &str, literal: &str, entries: &[(&str, &str)]) {
        let held = resolved(with_var, entries);
        let twin = style(literal);
        macro_rules! same {
            ($($field:ident),+) => {$(assert_eq!(held.$field, twin.$field, "{with_var}: {}", stringify!($field));)+};
        }
        same!(
            border, border_block, border_inline, border_top, border_right, border_bottom, border_left, border_width,
            border_color, border_style, border_top_width, border_right_width, border_bottom_width, border_left_width,
            border_top_color, border_right_color, border_bottom_color, border_left_color, border_top_style,
            border_right_style, border_bottom_style, border_left_style, padding, padding_top, padding_right,
            padding_bottom, padding_left
        );
    }

    #[test]
    fn a_side_shorthand_written_after_a_held_all_sides_border_value_splits_it() {
        let entries = [("--w", "4px"), ("--n", "none"), ("--line", "red")];
        same_as_literal(
            r#"{"borderWidth":"var(--w)","borderStyle":"solid","borderTop":"1px solid"}"#,
            r#"{"borderWidth":"4px","borderStyle":"solid","borderTop":"1px solid"}"#,
            &entries,
        );
        same_as_literal(
            r#"{"borderStyle":"var(--n)","borderWidth":"2px","borderTop":"1px solid"}"#,
            r#"{"borderStyle":"none","borderWidth":"2px","borderTop":"1px solid"}"#,
            &entries,
        );
        same_as_literal(
            r#"{"borderWidth":"var(--w)","borderStyle":"solid","borderBlock":"1px solid"}"#,
            r#"{"borderWidth":"4px","borderStyle":"solid","borderBlock":"1px solid"}"#,
            &entries,
        );
        same_as_literal(
            r#"{"borderWidth":"var(--w)","borderStyle":"solid","borderInline":"1px solid"}"#,
            r#"{"borderWidth":"4px","borderStyle":"solid","borderInline":"1px solid"}"#,
            &entries,
        );
        same_as_literal(
            r##"{"borderStyle":"solid","borderColor":"var(--line)","borderBottom":"10px solid #00ff00"}"##,
            r##"{"borderStyle":"solid","borderColor":"red","borderBottom":"10px solid #00ff00"}"##,
            &entries,
        );
    }

    #[test]
    fn a_plain_declaration_overlapping_a_held_one_is_held_after_it() {
        let held = style(r#"{"borderWidth":"var(--w)","borderStyle":"solid","borderTop":"1px solid","opacity":0.5}"#);
        let keys: Vec<&str> = held.var_declarations.as_ref().unwrap().iter().map(|held| held.key.as_str()).collect();
        assert_eq!(keys, ["borderWidth", "borderTop"]);
        assert!(held.border_style.is_some());
        assert_eq!(held.border_top, None);
        assert_eq!(held.opacity, Some(0.5));
        assert!(held.var_declarations.as_ref().unwrap().iter().all(|held| held.kept.is_empty()));
    }

    #[test]
    fn an_invalid_plain_declaration_overlapping_a_held_one_is_dropped_not_held() {
        let held = style(r#"{"paddingTop":"var(--p)","padding":"1px bogus"}"#);
        assert_eq!(held.var_declarations.as_deref().map(<[_]>::len), Some(1));
        assert_eq!(held.padding, None);
    }

    #[test]
    fn a_plain_declaration_that_overlaps_nothing_held_stays_plain() {
        let held = style(r#"{"paddingTop":"var(--p)","borderTop":"1px solid","paddingBottom":3}"#);
        assert_eq!(held.var_declarations.as_deref().map(<[_]>::len), Some(1));
        assert!(held.border_top.is_some() && held.padding_bottom.is_some());
    }

    #[test]
    fn a_plain_declaration_held_for_a_held_one_that_went_is_plain_again() {
        let held = style(r#"{"paddingTop":"var(--p)","paddingLeft":3,"padding":8}"#);
        assert_eq!(held.var_declarations, None);
        assert!(held.padding.is_some());
        assert_eq!(held.padding_left, None);
    }

    #[test]
    fn a_held_longhand_survives_a_later_shorthand_that_is_invalid() {
        for (with_var, literal) in [
            (r#"{"paddingTop":"var(--p)","padding":"1px bogus"}"#, r#"{"paddingTop":"6px","padding":"1px bogus"}"#),
            (
                r#"{"borderStyle":"solid","borderTopWidth":"var(--w)","border":"1px wobbly 2px 3px"}"#,
                r#"{"borderStyle":"solid","borderTopWidth":"4px","border":"1px wobbly 2px 3px"}"#,
            ),
        ] {
            let held = resolved(with_var, &[("--p", "6px"), ("--w", "4px")]);
            let twin = style(literal);
            assert!(held.padding_top.is_some() || held.border_top_width.is_some(), "{with_var}");
            assert_eq!(held.padding_top, twin.padding_top, "{with_var}");
            assert_eq!(held.border_top_width, twin.border_top_width, "{with_var}");
        }
    }

    #[test]
    fn a_held_longhand_survives_an_invalid_shorthand_of_a_state_style() {
        let held = hovered(r#"{"paddingTop":"var(--p)","hover":{"padding":"1px bogus"}}"#, &[("--p", "6px")]);
        assert_eq!(held.padding_top, style(r#"{"paddingTop":"6px"}"#).padding_top);
        assert!(held.padding_top.is_some());
    }

    #[test]
    fn a_side_shorthand_of_the_layer_above_splits_a_held_all_sides_border_value_below() {
        for over in [r#"{"borderTop":"1px solid"}"#, r#"{"borderInline":"1px solid"}"#] {
            let held = hovered(&format!(r#"{{"borderWidth":"var(--w)","borderStyle":"solid","hover":{over}}}"#), &[("--w", "4px")]);
            let literal = hovered(&format!(r#"{{"borderWidth":"4px","borderStyle":"solid","hover":{over}}}"#), &[]);
            macro_rules! same {
                ($($field:ident),+) => {$(assert_eq!(held.$field, literal.$field, "{over}: {}", stringify!($field));)+};
            }
            same!(
                border_width, border_style, border_top, border_inline, border_top_width, border_right_width,
                border_bottom_width, border_left_width, border_top_style, border_right_style, border_bottom_style,
                border_left_style
            );
            assert!(held.border_bottom_width.is_some(), "{over}");
        }
    }

    #[test]
    fn a_longhand_written_after_a_side_shorthand_of_the_layer_above_stays_over_a_held_all_sides_border_value() {
        let cases = [
            (
                r##"{"borderColor":"var(--c)","borderStyle":"solid","borderWidth":1"##,
                r##"{"borderColor":"#ff0000","borderStyle":"solid","borderWidth":1"##,
                r#""borderTop":"2px solid","borderTopWidth":"5px""#,
            ),
            (
                r#"{"borderWidth":3,"borderStyle":"var(--s)""#,
                r#"{"borderWidth":3,"borderStyle":"solid""#,
                r#""borderInline":"2px solid","borderLeftWidth":"9px""#,
            ),
        ];
        for (held, literal, over) in cases {
            let held = hovered(&format!(r#"{held},"hover":{{{over}}}}}"#), &[("--c", "#ff0000"), ("--s", "solid")]);
            let literal = hovered(&format!(r#"{literal},"hover":{{{over}}}}}"#), &[]);
            macro_rules! same {
                ($($field:ident),+) => {$(assert_eq!(held.$field, literal.$field, "{over}: {}", stringify!($field));)+};
            }
            same!(
                border_top, border_inline, border_top_width, border_left_width, border_right_width,
                border_bottom_width, border_top_style, border_left_style, border_top_color
            );
            assert!(held.border_top_width.is_some() || held.border_left_width.is_some(), "{over}");
        }
    }

    #[test]
    fn a_longhand_after_a_side_shorthand_of_the_layer_above_survives_the_universal_layering() {
        let universal = style(r#"{"borderWidth":"var(--w)","borderStyle":"solid"}"#);
        let own = style(r#"{"borderLeft":"2px solid","borderLeftWidth":"9px"}"#);
        let layered = crate::universal_style::layer_under(&universal, &own);
        let layered = resolve(&layered, &custom(&[("--w", "4px")])).unwrap();
        let literal = crate::universal_style::layer_under(&style(r#"{"borderWidth":"4px","borderStyle":"solid"}"#), &own);
        assert_eq!(layered.border_left_width, literal.border_left_width);
        assert!(layered.border_left_width.is_some());
        assert_eq!(layered.border_top_width, literal.border_top_width);
    }

    #[test]
    fn a_family_of_held_properties_is_found_by_prefix() {
        let held = style(r#"{"transitionDuration":"var(--d)","width":"var(--w)"}"#);
        assert!(holds_family(&held, "transition"));
        assert!(!holds_family(&held, "animation"));
    }
}
