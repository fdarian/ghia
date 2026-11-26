//! CSS custom properties: the `--name` keys of a style object.
//!
//! A declaration is kept as the text CSS computes it to for an unregistered property: comments
//! removed, the ends trimmed, a trailing `!important` dropped. The text inside is not touched, so
//! two values are equal when their text is, which is how `style(--x: v)` compares them in a browser.
//!
//! They inherit, except a registered property (`@property`) that says otherwise
//! (`registered_properties`). [`CustomProperties::descend`] lays an element's declarations over its
//! parent's computed map, substituting the `var()` in a value where it is declared. Two things read them:
//! `style()` container queries, and [`substitute`], which puts them into the text of a value:
//! the transform properties keep it in their field, and every other property holds its declaration
//! until it is built (`css::var_substitution`).

use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

use super::registered_properties::Registered;

/// What an element computes its custom properties to. The map holds the values of the properties
/// that have one, the initial value of a registered property included: it is put there where the
/// document's registrations enter the tree (`CustomProperties::with_registered`).
#[derive(Debug, Clone, Default)]
pub struct CustomProperties {
    values: Arc<BTreeMap<String, String>>,
    /// The registrations of the document, handed down with the values.
    registered: Option<Arc<Registered>>,
    /// Some property that does not inherit has a value other than its initial one here, which the
    /// next element has to reset. False for nearly every element, so the reset costs nothing.
    sets_non_inherited: bool,
}

impl PartialEq for CustomProperties {
    fn eq(&self, other: &Self) -> bool {
        self.values == other.values
    }
}

/// Whether `name` is a custom property name: `--` and at least one more character, and a CSS
/// identifier after it.
pub(crate) fn is_name(name: &str) -> bool {
    name.strip_prefix("--").is_some_and(|rest| {
        !rest.is_empty() && rest.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || !c.is_ascii())
    })
}

/// The text of a declared value as CSS computes it: comments removed, trimmed, without a trailing
/// `!important`.
pub(crate) fn normalise(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("/*") {
        stripped.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => {
                rest = "";
                break;
            }
        }
    }
    stripped.push_str(rest);
    let trimmed = stripped.trim();
    let without_important = trimmed
        .rsplit_once('!')
        .filter(|(_, keyword)| keyword.trim().eq_ignore_ascii_case("important"))
        .map_or(trimmed, |(value, _)| value);
    without_important.trim().to_owned()
}

/// `initial` makes the property guaranteed-invalid, which is the same as not declaring it.
pub(crate) fn is_initial(value: &str) -> bool {
    value.eq_ignore_ascii_case("initial")
}

/// `revert` and `revert-layer` count: the user agent style has no value for a custom property, so
/// a custom property rolled back is not set, which is what `unset` leaves of one that inherits.
fn is_inherit(value: &str) -> bool {
    ["inherit", "unset", "revert", "revert-layer"].iter().any(|keyword| value.eq_ignore_ascii_case(keyword))
}

/// Which retained elements read the custom properties they inherit (see `retain::Record::reads_custom`):
/// a build notes a read, and an element that is built read if the count moved while it was.
pub(crate) mod reads {
    use std::cell::Cell;

    thread_local! {
        static READS: Cell<u64> = const { Cell::new(0) };
    }

    pub(crate) fn note() {
        READS.set(READS.get() + 1);
    }

    pub(crate) fn count() -> u64 {
        READS.get()
    }
}

/// Whether `text` has a `var()` in it.
pub(crate) fn has_var(text: &str) -> bool {
    find_var(text).is_some()
}

/// The byte index of the next `var(`, as a function and not the end of another name.
fn find_var(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || !byte.is_ascii();
    (0..bytes.len().saturating_sub(3)).find(|&at| {
        bytes[at..at + 4].eq_ignore_ascii_case(b"var(") && (at == 0 || !is_ident(bytes[at - 1]))
    })
}

/// `text` with each `var(--name)` and `var(--name, fallback)` replaced by the value `custom`
/// computes for the name, or by the fallback (which may hold `var()` itself) when it computes to
/// none. `None` when one cannot be resolved: a name that is missing without a fallback, or a
/// malformed call. CSS makes the declaration invalid at computed-value time then.
///
/// `custom` is the computed map of the element reading: the values in it hold no `var()` any
/// more, [`CustomProperties::descend`] substituted them where they were declared.
pub(crate) fn substitute<'a>(text: &'a str, custom: &CustomProperties) -> Option<Cow<'a, str>> {
    if !has_var(text) {
        return Some(Cow::Borrowed(text));
    }
    expand(text, &mut |name| custom.get(name).map(str::to_owned)).map(Cow::Owned)
}

fn expand(text: &str, lookup: &mut dyn FnMut(&str) -> Option<String>) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = find_var(rest) {
        out.push_str(&rest[..start]);
        let after = &rest[start + 4..];
        let close = closing_paren(after)?;
        let (name, fallback) = split_call(&after[..close]);
        if !is_name(name) {
            return None;
        }
        let replacement = match (lookup(name), fallback) {
            (Some(value), _) => value,
            (None, Some(fallback)) => expand(fallback, lookup)?,
            (None, None) => return None,
        };
        // Spaces keep what the call stood for apart from the tokens around it, as tokens are.
        out.push(' ');
        out.push_str(&replacement);
        out.push(' ');
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// The name and the fallback of the arguments of a `var()` call.
fn split_call(arguments: &str) -> (&str, Option<&str>) {
    match arguments.find(',') {
        Some(comma) => (arguments[..comma].trim(), Some(arguments[comma + 1..].trim())),
        None => (arguments.trim(), None),
    }
}

/// The names `text` refers to with `var()`, those in a fallback included.
fn referenced_names(text: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = find_var(rest) {
        let after = &rest[start + 4..];
        let Some(close) = closing_paren(after) else {
            break;
        };
        names.push(split_call(&after[..close]).0);
        rest = after;
    }
    names
}

/// The custom properties declared on one element that are computed from it: a name whose value
/// holds a `var()`, as written. Its own declarations shadow what it inherits.
type Pending<'a> = BTreeMap<&'a str, &'a str>;

/// The names of `pending` that refer to themselves through each other. All of a cycle is invalid
/// at computed-value time, whatever fallbacks it has.
fn cyclic_names<'a>(pending: &Pending<'a>) -> HashSet<&'a str> {
    fn reaches(from: &str, target: &str, pending: &Pending, seen: &mut HashSet<String>) -> bool {
        referenced_names(pending[from])
            .into_iter()
            .filter(|name| pending.contains_key(name))
            .any(|next| next == target || (seen.insert(next.to_owned()) && reaches(next, target, pending, seen)))
    }
    pending.keys().copied().filter(|name| reaches(name, name, pending, &mut HashSet::new())).collect()
}

/// The computed value of a pending name: the text with its `var()` expanded, against the other
/// pending names of the element first and what it inherits after. `None` makes the property
/// guaranteed-invalid.
fn compute_pending(
    name: &str,
    pending: &Pending,
    cyclic: &HashSet<&str>,
    inherited: &BTreeMap<String, String>,
    done: &mut BTreeMap<String, Option<String>>,
) -> Option<String> {
    if cyclic.contains(name) {
        return None;
    }
    if let Some(value) = done.get(name) {
        return value.clone();
    }
    let value = expand(pending[name], &mut |reference| match pending.contains_key(reference) {
        true => compute_pending(reference, pending, cyclic, inherited, done),
        false => inherited.get(reference).cloned(),
    })
    .map(|expanded| expanded.trim().to_owned());
    done.insert(name.to_owned(), value.clone());
    value
}

/// The index of the `)` that closes a call whose `(` was just before `text`.
fn closing_paren(text: &str) -> Option<usize> {
    let mut depth = 1usize;
    for (index, character) in text.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

impl CustomProperties {
    pub(crate) fn fingerprint(&self, fp: &mut crate::retain::Fingerprint) {
        for (name, value) in self.values.iter() {
            fp.str(name);
            fp.str(value);
        }
        // Registrations change what an element below computes without changing this map: a
        // property that stops inheriting.
        fp.word(self.registered.as_ref().map_or(0, |registered| registered.fingerprint()));
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub(crate) fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    /// Every property with its value, names in order, `--` included.
    pub(crate) fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values.iter().map(|(name, value)| (name.as_str(), value.as_str()))
    }

    /// The declarations of one style object, in written order, a later one winning. Values are
    /// normalised. An empty value declares nothing, as React DOM removes the property for it. `None`
    /// when there are none.
    pub(crate) fn declared(entries: impl IntoIterator<Item = (String, String)>) -> Option<Self> {
        let map: BTreeMap<String, String> = entries
            .into_iter()
            .map(|(name, value)| (name, normalise(&value)))
            .filter(|(_, value)| !value.is_empty())
            .collect();
        (!map.is_empty()).then(|| Self { values: Arc::new(map), ..Self::default() })
    }

    /// The custom properties at the top of a tree whose document registered `registered`: every
    /// registered property that has an initial value holds it.
    pub(crate) fn with_registered(registered: Option<Arc<Registered>>) -> Self {
        let Some(held) = &registered else {
            return Self::default();
        };
        let values: BTreeMap<String, String> =
            held.initial_values().map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
        Self { values: Arc::new(values), registered, sets_non_inherited: false }
    }

    /// What an element that declares no custom property computes to below `self`: what `self` has,
    /// except that a property that does not inherit goes back to its initial value.
    pub(crate) fn inherit(&self) -> Self {
        if !self.sets_non_inherited {
            return self.clone();
        }
        let mut computed = (*self.values).clone();
        self.reset_non_inherited(&mut computed);
        Self { values: Arc::new(computed), registered: self.registered.clone(), sets_non_inherited: false }
    }

    fn reset_non_inherited(&self, computed: &mut BTreeMap<String, String>) {
        let Some(registered) = &self.registered else {
            return;
        };
        for name in registered.non_inheriting() {
            match registered.initial_of(name) {
                Some(initial) => computed.insert(name.clone(), initial.to_owned()),
                None => computed.remove(name),
            };
        }
    }

    /// What an element computes to: `declared` laid over what it inherits (`self`). `inherit`
    /// and `unset` keep the inherited value, `initial` removes it. A value with a `var()` is
    /// substituted here, at the element that declares it, against this element's other
    /// declarations and what it inherits: its readers below get the text, not the call. One that
    /// cannot be (a name that is missing, a cycle) is guaranteed-invalid, which removes the
    /// property whatever it inherited.
    ///
    /// A registered property differs in three ways. One that does not inherit starts from its
    /// initial value and not from the parent's, unless the element says `inherit`. `initial`, and a
    /// value that cannot be computed, are its initial value and not nothing. And `unset` is the
    /// initial value for one that does not inherit.
    pub(crate) fn descend(&self, declared: &Self) -> Self {
        if declared.is_empty() {
            return self.inherit();
        }
        let registered = self.registered.as_deref();
        let mut computed = (*self.values).clone();
        if self.sets_non_inherited {
            self.reset_non_inherited(&mut computed);
        }
        let mut sets_non_inherited = false;
        let mut pending = Pending::new();
        for (name, value) in declared.values.iter() {
            let registration = registered.and_then(|registered| registered.get(name));
            sets_non_inherited |= registration.is_some_and(|registration| !registration.inherits);
            let initial = registration.and_then(|registration| registration.initial.as_deref());
            let inherits = registration.is_none_or(|registration| registration.inherits);
            if is_initial(value) {
                match initial {
                    Some(initial) => computed.insert(name.clone(), initial.to_owned()),
                    None => computed.remove(name),
                };
            } else if has_var(value) {
                computed.remove(name);
                pending.insert(name.as_str(), value.as_str());
            } else if is_inherit(value) {
                if inherits {
                    continue;
                }
                // `inherit` takes the parent's value; `unset` and the rest are the initial one.
                let parent = value.eq_ignore_ascii_case("inherit").then(|| self.values.get(name)).flatten();
                match parent.map(String::as_str).or(initial) {
                    Some(text) => computed.insert(name.clone(), text.to_owned()),
                    None => computed.remove(name),
                };
            } else {
                computed.insert(name.clone(), value.clone());
            }
        }
        if !pending.is_empty() {
            let cyclic = cyclic_names(&pending);
            let mut done = BTreeMap::new();
            for name in pending.keys() {
                compute_pending(name, &pending, &cyclic, &computed, &mut done);
            }
            computed.extend(done.into_iter().filter_map(|(name, value)| Some((name, value?))));
            // Invalid at computed-value time is the initial value of a registered property.
            if let Some(registered) = registered {
                for name in pending.keys() {
                    if let (false, Some(initial)) = (computed.contains_key(*name), registered.initial_of(name)) {
                        computed.insert((*name).to_owned(), initial.to_owned());
                    }
                }
            }
        }
        Self { values: Arc::new(computed), registered: self.registered.clone(), sets_non_inherited }
    }

    /// `over`'s declarations on top of `base`'s, keywords kept as written: a state style or an
    /// `@container` block over the style it applies to.
    pub(crate) fn layered(base: Option<&Self>, over: Option<&Self>) -> Option<Self> {
        match (base, over) {
            (Some(base), Some(over)) => {
                let mut map = (*base.values).clone();
                map.extend(over.values.iter().map(|(name, value)| (name.clone(), value.clone())));
                Some(Self { values: Arc::new(map), ..Self::default() })
            }
            (Some(only), None) | (None, Some(only)) => Some(only.clone()),
            (None, None) => None,
        }
    }
}

impl Serialize for CustomProperties {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.values.len()))?;
        for (name, value) in self.values.iter() {
            map.serialize_entry(name, value)?;
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(entries: &[(&str, &str)]) -> CustomProperties {
        CustomProperties::declared(entries.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())))
            .unwrap_or_default()
    }

    #[test]
    fn names_are_two_dashes_and_an_identifier() {
        assert!(is_name("--x"));
        assert!(is_name("--brand-color_2"));
        assert!(is_name("---"));
        assert!(!is_name("--"));
        assert!(!is_name("-x"));
        assert!(!is_name("x"));
        assert!(!is_name("--a b"));
        assert!(!is_name("--a:b"));
    }

    #[test]
    fn a_value_is_trimmed_without_comments_or_important() {
        assert_eq!(normalise("  dark  "), "dark");
        assert_eq!(normalise("1 /* c */"), "1");
        assert_eq!(normalise("a /* b */ c"), "a  c");
        assert_eq!(normalise("red !important"), "red");
        assert_eq!(normalise("red!IMPORTANT"), "red");
        assert_eq!(normalise("a   b"), "a   b", "the text inside is kept");
        assert_eq!(normalise("calc(1px+2px)"), "calc(1px+2px)");
        assert_eq!(normalise("1 /* open"), "1");
    }

    #[test]
    fn a_child_computes_its_declarations_over_the_parents_map() {
        let parent = CustomProperties::default().descend(&declared(&[("--a", "1"), ("--b", "2")]));
        assert_eq!((parent.get("--a"), parent.get("--b")), (Some("1"), Some("2")));
        let child = parent.descend(&declared(&[("--b", "3"), ("--c", "4")]));
        assert_eq!((child.get("--a"), child.get("--b"), child.get("--c")), (Some("1"), Some("3"), Some("4")));
        assert_eq!(parent.get("--b"), Some("2"), "the parent is untouched");
    }

    #[test]
    fn the_css_wide_keywords_inherit_or_reset() {
        let parent = declared(&[("--a", "1"), ("--b", "2")]);
        let child = parent.descend(&declared(&[("--a", "inherit"), ("--b", "initial")]));
        assert_eq!((child.get("--a"), child.get("--b")), (Some("1"), None));
        assert_eq!(parent.descend(&declared(&[("--a", "UNSET")])).get("--a"), Some("1"));
    }

    #[test]
    fn revert_and_revert_layer_keep_what_is_inherited_and_a_var_reads_its_fallback_otherwise() {
        let parent = computed(&[("--a", "1")]);
        for keyword in ["revert", "REVERT-LAYER"] {
            let child = parent.descend(&declared(&[("--a", keyword), ("--b", keyword)]));
            assert_eq!(child.get("--a"), Some("1"), "{keyword}");
            assert_eq!(substitute("var(--a, fb)", &child).as_deref().map(str::trim), Some("1"), "{keyword}");
            assert_eq!(substitute("var(--b, fb)", &child).as_deref().map(str::trim), Some("fb"), "{keyword}");
        }
    }

    #[test]
    fn a_layer_over_another_replaces_per_property_and_keeps_keywords() {
        let base = declared(&[("--a", "1"), ("--b", "2")]);
        let over = declared(&[("--b", "initial"), ("--c", "3")]);
        let layered = CustomProperties::layered(Some(&base), Some(&over)).unwrap();
        assert_eq!((layered.get("--a"), layered.get("--b"), layered.get("--c")), (Some("1"), Some("initial"), Some("3")));
        assert_eq!(CustomProperties::layered(None, None), None);
        assert_eq!(CustomProperties::layered(Some(&base), None), Some(base));
    }

    fn computed(entries: &[(&str, &str)]) -> CustomProperties {
        CustomProperties::default().descend(&declared(entries))
    }

    #[test]
    fn var_is_replaced_by_the_computed_value_or_its_fallback() {
        let custom = computed(&[("--p", "0.4"), ("--len", "calc(1px + 2px)"), ("--twice", "calc(var(--p) * 2)")]);
        let sub = |text: &str| substitute(text, &custom).map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "));
        assert_eq!(sub("translateX(calc(100% * var(--p)))").as_deref(), Some("translateX(calc(100% * 0.4 ))"));
        assert_eq!(sub("none").as_deref(), Some("none"));
        assert_eq!(sub("translate(var(--len), 0)").as_deref(), Some("translate( calc(1px + 2px) , 0)"));
        assert_eq!(sub("a var(--missing, 7px)").as_deref(), Some("a 7px"));
        assert_eq!(sub("a var(--missing,)").as_deref(), Some("a"));
        assert_eq!(sub("a var(--p, 7px)").as_deref(), Some("a 0.4"));
        assert_eq!(sub("a var(--missing, var(--p))").as_deref(), Some("a 0.4"));
        assert_eq!(sub("a var(--missing, var(--nope, 3px))").as_deref(), Some("a 3px"));
        assert_eq!(sub("a VAR( --p )").as_deref(), Some("a 0.4"));
        assert_eq!(sub("calc(var(--twice) + 1)").as_deref(), Some("calc( calc( 0.4 * 2) + 1)"));
        assert_eq!(sub("a var(--p) b var(--len)").as_deref(), Some("a 0.4 b calc(1px + 2px)"));
    }

    #[test]
    fn an_unresolvable_var_makes_the_whole_text_invalid() {
        let custom = computed(&[("--a", "var(--b)"), ("--b", "var(--a)"), ("--self", "var(--self)"), ("--ok", "1")]);
        for text in [
            "var(--missing)",
            "1 var(--ok) var(--missing)",
            "var(--a)",
            "var(--self)",
            "var(--ok",
            "var(ok)",
            "var()",
            "var(--missing, var(--also-missing))",
        ] {
            assert_eq!(substitute(text, &custom), None, "{text}");
        }
        assert_eq!(substitute("var(--self, 5px)", &custom).as_deref().map(str::trim), Some("5px"), "a cycle falls back");
    }

    #[test]
    fn a_value_with_var_is_computed_where_it_is_declared() {
        let parent = computed(&[("--a", "10px"), ("--b", "var(--a)")]);
        assert_eq!(parent.get("--b"), Some("10px"));
        let child = parent.descend(&declared(&[("--a", "50px")]));
        assert_eq!((child.get("--a"), child.get("--b")), (Some("50px"), Some("10px")), "--b stays what the parent computed");
        let sibling = parent.descend(&declared(&[("--a", "50px"), ("--c", "var(--a)"), ("--d", "var(--b)")]));
        assert_eq!((sibling.get("--c"), sibling.get("--d")), (Some("50px"), Some("10px")), "a declaration reads its own element's map");
    }

    #[test]
    fn declarations_of_one_element_read_each_other_in_any_order() {
        let map = computed(&[("--a", "var(--z)"), ("--m", "calc(var(--a) + 1px)"), ("--z", "2px")]);
        assert_eq!((map.get("--a"), map.get("--z")), (Some("2px"), Some("2px")));
        assert_eq!(map.get("--m").map(|text| text.split_whitespace().collect::<Vec<_>>().join(" ")).as_deref(), Some("calc( 2px + 1px)"));
    }

    #[test]
    fn a_missing_name_or_a_cycle_makes_the_property_guaranteed_invalid() {
        let parent = computed(&[("--x", "1px"), ("--y", "2px")]);
        let child = parent.descend(&declared(&[
            ("--x", "var(--missing)"),
            ("--y", "var(--missing, 3px)"),
            ("--a", "var(--b, 1px)"),
            ("--b", "var(--a)"),
            ("--self", "var(--self, 1px)"),
            ("--uses", "var(--a, 4px)"),
        ]));
        assert_eq!(child.get("--x"), None, "it does not fall back to what the parent computed");
        assert_eq!(child.get("--y").map(str::trim), Some("3px"));
        for cyclic in ["--a", "--b", "--self"] {
            assert_eq!(child.get(cyclic), None, "{cyclic}: a fallback does not save a cycle");
        }
        assert_eq!(child.get("--uses").map(str::trim), Some("4px"), "a reader of an invalid property falls back");
    }

    #[test]
    fn only_a_var_function_is_found() {
        assert!(has_var("calc(var(--a))"));
        assert!(!has_var("myvar(--a)"));
        assert!(!has_var("translateX(10px)"));
        assert!(!has_var("var"));
    }

    mod registered {
        use super::*;
        use crate::css::registered_properties::{Registered, Registration};

        fn registry(entries: &[(&str, &str, bool, Option<&str>)]) -> Option<Arc<Registered>> {
            let registrations = entries
                .iter()
                .map(|(name, syntax, inherits, initial)| {
                    Registration::new(name, Some(syntax), Some(if *inherits { "true" } else { "false" }), *initial).unwrap()
                })
                .collect();
            Registered::new(registrations).map(Arc::new)
        }

        fn at_root(entries: &[(&str, &str, bool, Option<&str>)]) -> CustomProperties {
            CustomProperties::with_registered(registry(entries))
        }

        #[test]
        fn an_initial_value_is_there_until_something_sets_the_property() {
            let root = at_root(&[("--a", "*", true, Some("0 0 #0000")), ("--none", "*", true, None)]);
            assert_eq!(root.get("--a"), Some("0 0 #0000"));
            assert_eq!(root.get("--none"), None);
            let child = root.descend(&declared(&[("--a", "1")]));
            assert_eq!(child.get("--a"), Some("1"));
            assert_eq!(child.descend(&declared(&[("--x", "2")])).get("--a"), Some("1"), "an inheriting property is handed down");
            assert_eq!(child.descend(&declared(&[("--a", "initial")])).get("--a"), Some("0 0 #0000"));
            assert_eq!(root.inherit().get("--a"), Some("0 0 #0000"));
        }

        #[test]
        fn a_property_that_does_not_inherit_goes_back_to_its_initial_value_below() {
            let root = at_root(&[("--a", "*", false, Some("0")), ("--b", "*", false, None), ("--c", "*", true, Some("c"))]);
            let set = root.descend(&declared(&[("--a", "5"), ("--b", "6"), ("--c", "7")]));
            assert_eq!((set.get("--a"), set.get("--b"), set.get("--c")), (Some("5"), Some("6"), Some("7")));
            let below = set.inherit();
            assert_eq!((below.get("--a"), below.get("--b"), below.get("--c")), (Some("0"), None, Some("7")));
            let below_declaring = set.descend(&declared(&[("--x", "1")]));
            assert_eq!((below_declaring.get("--a"), below_declaring.get("--b"), below_declaring.get("--c")), (Some("0"), None, Some("7")));
            // The reset is done once: what is below that holds nothing is as it was.
            assert!(!below.sets_non_inherited);
        }

        #[test]
        fn inherit_takes_the_parents_value_and_unset_is_the_initial_one_for_a_property_that_does_not_inherit() {
            let root = at_root(&[("--a", "*", false, Some("0"))]);
            let parent = root.descend(&declared(&[("--a", "5")]));
            assert_eq!(parent.descend(&declared(&[("--a", "inherit")])).get("--a"), Some("5"));
            assert_eq!(parent.descend(&declared(&[("--a", "unset")])).get("--a"), Some("0"));
            assert_eq!(parent.descend(&declared(&[("--a", "initial")])).get("--a"), Some("0"));
        }

        #[test]
        fn a_value_that_cannot_be_computed_is_the_initial_value_of_a_registered_property() {
            let root = at_root(&[("--a", "*", true, Some("fallback"))]);
            let invalid = root.descend(&declared(&[("--a", "var(--missing)"), ("--b", "var(--missing)")]));
            assert_eq!(invalid.get("--a"), Some("fallback"));
            assert_eq!(invalid.get("--b"), None);
            let valid = root.descend(&declared(&[("--x", "3"), ("--a", "var(--x)")]));
            assert_eq!(valid.get("--a"), Some("3"));
        }

        #[test]
        fn a_var_reads_the_initial_value_of_a_property_nothing_set() {
            let root = at_root(&[("--tw-shadow", "*", false, Some("0 0 #0000"))]);
            assert_eq!(substitute("var(--tw-shadow)", &root).as_deref(), Some(" 0 0 #0000 "));
            let set = root.descend(&declared(&[("--tw-shadow", "1px 1px red")]));
            assert_eq!(substitute("var(--tw-shadow)", &set.inherit()).as_deref(), Some(" 0 0 #0000 "));
        }

        #[test]
        fn the_registrations_are_in_the_fingerprint() {
            let hash = |custom: &CustomProperties| {
                let mut fp = crate::retain::Fingerprint::new();
                custom.fingerprint(&mut fp);
                fp.finish()
            };
            let none = CustomProperties::default();
            let inheriting = at_root(&[("--a", "*", true, None)]);
            let not = at_root(&[("--a", "*", false, None)]);
            assert_ne!(hash(&none), hash(&inheriting));
            assert_ne!(hash(&inheriting), hash(&not));
        }

        #[test]
        fn no_registrations_is_no_change() {
            assert_eq!(CustomProperties::with_registered(None), CustomProperties::default());
            let plain = CustomProperties::default().descend(&declared(&[("--a", "1")]));
            assert_eq!(plain.inherit(), plain);
        }
    }
}
