//! CSS `font-family` is a list, and a browser draws each glyph in the first family of it that is installed and has the
//! glyph. GPUI takes one family and a list of fallback families: the family is the first installed one, the fallbacks are
//! the installed ones after it, which GPUI's platform text system consults glyph by glyph (a CoreText cascade list on
//! macOS). A family that is not installed is skipped, so a web stack such as
//! `-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif` draws in the system font and falls back to the
//! families after it. A list in which nothing is installed keeps its first name, which GPUI answers with its own
//! fallback stack (on a stock Mac Helvetica; `.ZedSans` and `.ZedMono` when an app registered IBM Plex Sans or Lilex).
//!
//! [`Fonts`] is one per App (a GPUI global): it holds what that App's text system has installed and the lists resolved
//! against it, and starts over when fonts are added.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use gpui::{font, App, FontFallbacks, FontId, Global, SharedString, TextSystem};

/// A `font-family` list as GPUI is given it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Resolved {
    pub(crate) family: SharedString,
    pub(crate) fallbacks: FontFallbacks,
}

/// What a resolution depended on: a text system with other fonts installed resolves a list differently, so anything
/// kept from a resolution is kept per stamp. It names the families the text system lists, not the App or the number of
/// times fonts were added, so two Apps with the same fonts share what is kept.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Stamp(u64);

#[derive(Clone)]
pub(crate) struct Fonts(Rc<Shared>);

impl Global for Fonts {}

struct Shared {
    text_system: Arc<TextSystem>,
    /// The family names the text system lists: the platform's own and the ones fonts were added under.
    families: Box<dyn Fn() -> Vec<String>>,
    /// The stamp of a generation, read once: listing the families asks the platform.
    stamp: Cell<Option<(u64, Stamp)>>,
    state: RefCell<Option<State>>,
}

/// What one generation of the text system says. Fonts added later make a family that did not resolve before
/// resolve now, so all of it is dropped when the generation moves.
struct State {
    generation: u64,
    /// The face GPUI answers a family it cannot load with, and the family that face was loaded as.
    fallback_face: FontId,
    fallback_family: String,
    resolved: HashMap<String, Resolved>,
}

/// The families `text_system` lists. Asking CoreText for them takes ~70 ms, so a text system that no font was added to
/// (every App's first generation) shares one answer for the process instead of asking again per App: each new App
/// would otherwise spend that on its first frame, which a test's animation clock counts as elapsed time.
fn installed_families(text_system: &TextSystem) -> Vec<String> {
    static PLATFORM: OnceLock<Vec<String>> = OnceLock::new();
    if text_system.font_generation() == 0 {
        return PLATFORM.get_or_init(|| text_system.all_font_names()).clone();
    }
    text_system.all_font_names()
}

impl Fonts {
    /// The fonts of `cx`'s App, made on first use.
    pub(crate) fn of(cx: &mut App) -> Fonts {
        if let Some(fonts) = cx.try_global::<Fonts>() {
            return fonts.clone();
        }
        let text_system = cx.text_system().clone();
        let listed = text_system.clone();
        let fonts = Fonts::new(text_system, Box::new(move || installed_families(&listed)));
        cx.set_global(fonts.clone());
        fonts
    }

    /// Lists the installed families now, at window creation, so the first frame does not: that frame's clock is read
    /// before it builds a style, and a test's animation would count the listing as elapsed time.
    pub(crate) fn warm(cx: &mut App) {
        Fonts::of(cx).stamp();
    }

    fn new(text_system: Arc<TextSystem>, families: Box<dyn Fn() -> Vec<String>>) -> Fonts {
        Fonts(Rc::new(Shared { text_system, families, stamp: Cell::new(None), state: RefCell::new(None) }))
    }

    #[cfg(test)]
    pub(crate) fn for_tests() -> Fonts {
        Fonts::for_tests_with(&[])
    }

    /// A text system that lists `families` besides what a bare one does.
    #[cfg(test)]
    pub(crate) fn for_tests_with(families: &[&str]) -> Fonts {
        let families: Vec<String> = families.iter().map(|family| family.to_string()).collect();
        Fonts::new(Arc::new(TextSystem::new(Arc::new(gpui::NoopTextSystem::new()))), Box::new(move || families.clone()))
    }

    pub(crate) fn stamp(&self) -> Stamp {
        let generation = self.0.text_system.font_generation();
        if let Some((read_at, stamp)) = self.0.stamp.get() {
            if read_at == generation {
                return stamp;
            }
        }
        let mut families = (self.0.families)();
        families.sort_unstable();
        families.dedup();
        let mut hasher = rustc_hash::FxHasher::default();
        families.hash(&mut hasher);
        let stamp = Stamp(hasher.finish());
        self.0.stamp.set(Some((generation, stamp)));
        stamp
    }

    /// The family and fallbacks of a `font-family` list.
    pub(crate) fn resolve(&self, list: &str) -> Resolved {
        if !needs_resolution(list) {
            return Resolved { family: SharedString::from(list.to_owned()), fallbacks: no_fallbacks() };
        }
        let text_system = &self.0.text_system;
        let generation = text_system.font_generation();
        let mut slot = self.0.state.borrow_mut();
        if slot.as_ref().is_none_or(|state| state.generation != generation) {
            *slot = Some(State::read(text_system, generation));
        }
        let state = slot.as_mut().expect("the state is read above");
        if let Some(resolved) = state.resolved.get(list) {
            return resolved.clone();
        }
        let resolved = pick(list, |name| state.installed(text_system, name));
        state.resolved.insert(list.to_owned(), resolved.clone());
        resolved
    }
}

impl State {
    fn read(text_system: &TextSystem, generation: u64) -> State {
        let fallback_face = text_system.resolve_font(&font(MISSING));
        let fallback_family = text_system
            .get_font_for_id(fallback_face)
            .map(|face| face.family.to_string())
            .unwrap_or_default();
        State { generation, fallback_face, fallback_family, resolved: HashMap::new() }
    }

    /// `TextSystem::all_font_names` cannot say: it lists the names of GPUI's own fallback stack (Segoe UI, Ubuntu,
    /// Arial and the rest) whether or not the system has them, and leaves out families the platform loads by an older
    /// name (`Times`). Asking the text system to load the family says: a family that is not installed resolves to the
    /// fallback face, so it is installed when it resolves to another face, or is that face's own family (Helvetica on a
    /// stock Mac, `.ZedSans` when an app registered IBM Plex Sans).
    fn installed(&self, text_system: &TextSystem, name: &str) -> bool {
        let resolves_to_fallback = text_system.resolve_font(&font(SharedString::from(name.to_owned()))) == self.fallback_face;
        is_installed(resolves_to_fallback, self.fallback_family.eq_ignore_ascii_case(name))
    }
}

/// A family no system has, which GPUI answers with the first face of its fallback stack.
const MISSING: &str = "\u{0}no such family";

fn is_installed(resolves_to_fallback: bool, is_fallback_family: bool) -> bool {
    !resolves_to_fallback || is_fallback_family
}

fn no_fallbacks() -> FontFallbacks {
    FontFallbacks::from_fonts(Vec::new())
}

/// A single plain family name is what GPUI already takes, and stays untouched.
fn needs_resolution(value: &str) -> bool {
    value.contains([',', '"', '\'', '\\'])
        || value.split_whitespace().count() != value.split(' ').count()
        || value != value.trim()
        || generic(value).is_some()
}

fn pick(list: &str, installed: impl Fn(&str) -> bool) -> Resolved {
    let names = names(list);
    let mut found: Vec<&str> = Vec::new();
    for name in &names {
        let candidate = if name.keyword { generic(&name.text).unwrap_or(&name.text) } else { &name.text };
        if installed(candidate) && !found.iter().any(|known| known.eq_ignore_ascii_case(candidate)) {
            found.push(candidate);
        }
    }
    let Some((family, rest)) = found.split_first() else {
        return match names.first() {
            Some(first) => Resolved { family: SharedString::from(first.text.clone()), fallbacks: no_fallbacks() },
            None => Resolved { family: SharedString::from(list.to_owned()), fallbacks: no_fallbacks() },
        };
    };
    Resolved {
        family: SharedString::from((*family).to_owned()),
        // The cascade list is made of what CoreText loads by family name; GPUI maps `.SystemUIFont` to the system face
        // for the family it loads but does not for these.
        fallbacks: FontFallbacks::from_fonts(
            rest.iter().map(|name| gpui::font_name_with_fallbacks(name, ".AppleSystemUIFont").to_owned()).collect(),
        ),
    }
}

#[derive(Debug, PartialEq)]
struct Name {
    text: String,
    /// Unquoted, so `serif` is the generic family and not a family called serif.
    keyword: bool,
}

/// The family names of a list: quotes removed, escapes resolved, whitespace between the words of an unquoted name
/// collapsed to one space (CSS joins them so), and empty entries dropped.
fn names(list: &str) -> Vec<Name> {
    let mut names = Vec::new();
    let mut chars = list.chars().peekable();
    loop {
        while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
            chars.next();
        }
        let quote = chars.next_if(|ch| matches!(ch, '"' | '\''));
        let mut text = String::new();
        let mut pending_space = false;
        while let Some(ch) = chars.next() {
            match (quote, ch) {
                (Some(open), _) if open == ch => break,
                (None, ',') => break,
                (_, '\\') => {
                    if pending_space && !text.is_empty() {
                        text.push(' ');
                    }
                    pending_space = false;
                    text.push(escaped(&mut chars));
                }
                (None, _) if ch.is_whitespace() => pending_space = true,
                _ => {
                    if pending_space && !text.is_empty() {
                        text.push(' ');
                    }
                    pending_space = false;
                    text.push(ch);
                }
            }
        }
        if quote.is_some() {
            // The rest of the entry after the closing quote, up to the comma, is not part of the name.
            for ch in chars.by_ref() {
                if ch == ',' {
                    break;
                }
            }
        }
        if !text.is_empty() {
            names.push(Name { text, keyword: quote.is_none() });
        }
        if chars.peek().is_none() {
            return names;
        }
    }
}

/// The character after a backslash: up to six hex digits are a code point (and one whitespace after them is part of the
/// escape), anything else stands for itself.
fn escaped(chars: &mut std::iter::Peekable<std::str::Chars>) -> char {
    let mut code = String::new();
    while code.len() < 6 {
        match chars.next_if(|ch| ch.is_ascii_hexdigit()) {
            Some(digit) => code.push(digit),
            None => break,
        }
    }
    if code.is_empty() {
        return chars.next().unwrap_or('\u{FFFD}');
    }
    chars.next_if(|ch| ch.is_whitespace());
    u32::from_str_radix(&code, 16).ok().filter(|code| *code != 0).and_then(char::from_u32).unwrap_or('\u{FFFD}')
}

/// What Chrome draws a generic family or a system UI keyword in on macOS. The generic families are Chrome's default
/// font preferences for macOS, `chrome/app/resources/locale_settings_mac.grd` (IDS_SERIF_FONT_FAMILY `Times`,
/// IDS_SANS_SERIF_FONT_FAMILY `Helvetica`, IDS_FIXED_FONT_FAMILY `Menlo`, IDS_CURSIVE_FONT_FAMILY `Apple Chancery`,
/// IDS_FANTASY_FONT_FAMILY `Papyrus`, IDS_MATH_FONT_FAMILY `STIX Two Math`); `system-ui` is
/// `FontCache::MatchSystemUIFont` and `-apple-system` / `BlinkMacSystemFont` its legacy names
/// (`font_cache_mac.mm`). Blink has no `ui-serif`, `ui-sans-serif`, `ui-monospace`, `ui-rounded` or `emoji` keyword, so
/// Chrome reads them as family names that nothing has, and so does this.
fn generic(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "system-ui" | "-apple-system" | "blinkmacsystemfont" => Some(".SystemUIFont"),
        "sans-serif" => Some("Helvetica"),
        "serif" | "-webkit-body" => Some("Times"),
        "monospace" => Some("Menlo"),
        "cursive" => Some("Apple Chancery"),
        "fantasy" => Some("Papyrus"),
        "math" => Some("STIX Two Math"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(list: &str, installed: &[&str]) -> (String, Vec<String>) {
        let resolved = pick(list, |name| installed.contains(&name));
        (resolved.family.to_string(), resolved.fallbacks.fallback_list().to_vec())
    }

    fn texts(list: &str) -> Vec<String> {
        names(list).into_iter().map(|name| name.text).collect()
    }

    #[test]
    fn a_single_plain_name_needs_no_resolution() {
        assert!(!needs_resolution("Helvetica Neue"));
        assert!(!needs_resolution("Inter Variable"));
        assert!(needs_resolution("Inter, sans-serif"));
        assert!(needs_resolution("'Helvetica Neue'"));
        assert!(needs_resolution("monospace"));
        assert!(needs_resolution("SANS-SERIF"));
        assert!(needs_resolution("Helvetica  Neue"));
        assert!(needs_resolution("Helvetica\\ Neue"));
    }

    #[test]
    fn names_split_outside_quotes_and_lose_their_quotes() {
        assert_eq!(texts("a, 'B, c', \"D e\" ,f"), vec!["a", "B, c", "D e", "f"]);
        assert!(names("  ").is_empty());
        assert!(names("a,,b,").len() == 2);
    }

    #[test]
    fn whitespace_runs_in_an_unquoted_name_collapse_but_not_in_a_quoted_one() {
        assert_eq!(texts("  Helvetica \t  Neue , \"Helvetica   Neue\""), vec!["Helvetica Neue", "Helvetica   Neue"]);
    }

    #[test]
    fn backslash_escapes_are_resolved_in_quoted_and_unquoted_names() {
        assert_eq!(texts(r#""Say \"hi\"", 'It\'s', Foo\,Bar, Hel\76 etica"#), vec![r#"Say "hi""#, "It's", "Foo,Bar", "Helvetica"]);
        assert_eq!(texts(r"Helvetica\ Neue"), vec!["Helvetica Neue"]);
        assert_eq!(texts(r#""\48 elvetica""#), vec!["Helvetica"]);
    }

    #[test]
    fn a_quoted_generic_is_a_family_name_and_not_the_keyword() {
        let names = names("\"serif\", serif, SERIF");
        assert_eq!(names.iter().map(|name| name.keyword).collect::<Vec<_>>(), vec![false, true, true]);
        // Only `Times` is installed: the quoted name finds no family of that name.
        assert_eq!(picked("\"serif\", serif", &["Times"]).0, "Times");
        assert_eq!(picked("\"serif\", 'sans-serif'", &["Times", "Helvetica"]), ("serif".to_owned(), vec![]));
    }

    #[test]
    fn the_first_installed_family_draws_and_the_rest_are_its_fallbacks() {
        let stack = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
        assert_eq!(
            picked(stack, &[".SystemUIFont", "Helvetica Neue", "Helvetica"]),
            (".SystemUIFont".to_owned(), vec!["Helvetica Neue".to_owned(), "Helvetica".to_owned()])
        );
        assert_eq!(
            picked("'Segoe UI', Roboto, 'Helvetica Neue'", &["Helvetica Neue"]),
            ("Helvetica Neue".to_owned(), vec![])
        );
        assert_eq!(picked("Inter, sans-serif", &["Helvetica"]), ("Helvetica".to_owned(), vec![]));
    }

    #[test]
    fn the_system_font_is_a_fallback_under_the_name_the_platform_loads_it_by() {
        assert_eq!(
            picked("Menlo, system-ui", &["Menlo", ".SystemUIFont"]),
            ("Menlo".to_owned(), vec![".AppleSystemUIFont".to_owned()])
        );
    }

    #[test]
    fn a_family_named_twice_is_a_fallback_once() {
        assert_eq!(
            picked("Menlo, monospace, helvetica, Helvetica", &["Menlo", "Helvetica", "helvetica"]),
            ("Menlo".to_owned(), vec!["helvetica".to_owned()])
        );
    }

    #[test]
    fn generic_families_map_to_what_chrome_uses_on_macos() {
        assert_eq!(picked("monospace", &["Menlo"]).0, "Menlo");
        assert_eq!(picked("serif", &["Times"]).0, "Times");
        assert_eq!(picked("Cursive", &["Apple Chancery"]).0, "Apple Chancery");
        assert_eq!(picked("fantasy", &["Papyrus"]).0, "Papyrus");
        assert_eq!(picked("math", &["STIX Two Math"]).0, "STIX Two Math");
        assert_eq!(picked("ui-monospace, monospace", &["Menlo"]).0, "Menlo");
    }

    #[test]
    fn a_list_with_nothing_installed_keeps_its_first_family() {
        assert_eq!(picked("'Segoe UI', Roboto", &[]), ("Segoe UI".to_owned(), vec![]));
    }

    #[test]
    fn a_family_that_resolves_to_the_fallback_face_is_installed_only_as_that_face() {
        assert!(is_installed(false, false));
        // Segoe UI on a Mac: GPUI's stack names it, and it resolves to the face behind Helvetica.
        assert!(!is_installed(true, false));
        // Helvetica on a Mac: the face the stack ends in.
        assert!(is_installed(true, true));
    }
}

