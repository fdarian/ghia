//! CSS `font-family` is a list, and the first family that is installed is the one drawn. GPUI takes one family name and
//! falls back to its own stack (a bundled sans) when that name is not installed, so a web stack such as
//! `-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif` would draw in the bundled face, which has no bold.
//! [`resolve`] turns the list into the one family GPUI is given.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use gpui::{font, SharedString, TextSystem};

static TEXT_SYSTEM: OnceLock<Arc<TextSystem>> = OnceLock::new();
static RESOLVED: Mutex<Option<Resolved>> = Mutex::new(None);

struct Resolved {
    generation: u64,
    families: HashMap<String, SharedString>,
}

/// The text system every window shares, set from a render. A style is applied only while a window renders, never before.
pub(crate) fn install(text_system: &Arc<TextSystem>) {
    TEXT_SYSTEM.get_or_init(|| text_system.clone());
}

/// The family of a `font-family` list as GPUI loads it: the first family of the list that is installed, with a generic
/// family or a system UI keyword mapped to what Chrome uses for it on macOS. A list nothing in resolves is passed on as written.
pub(crate) fn resolve(list: &str) -> SharedString {
    if !is_list(list) {
        return SharedString::from(list.to_owned());
    }
    let Some(text_system) = TEXT_SYSTEM.get() else {
        return SharedString::from(list.to_owned());
    };
    let generation = text_system.font_generation();
    let mut guard = RESOLVED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let resolved = guard.get_or_insert_with(|| Resolved { generation, families: HashMap::new() });
    // A font added later can make a family that did not resolve before resolve now.
    if resolved.generation != generation {
        resolved.generation = generation;
        resolved.families.clear();
    }
    if let Some(family) = resolved.families.get(list) {
        return family.clone();
    }
    let family = pick(list, |name| installed(text_system, name));
    resolved.families.insert(list.to_owned(), family.clone());
    family
}

/// A single plain family name is what GPUI already takes, and stays untouched.
fn is_list(value: &str) -> bool {
    value.contains(',') || value.contains('"') || value.contains('\'') || generic(value.trim()).is_some()
}

fn pick(list: &str, installed: impl Fn(&str) -> bool) -> SharedString {
    let names = names(list);
    for name in &names {
        let candidate = generic(name).unwrap_or(name);
        if installed(candidate) {
            return SharedString::from(candidate.to_owned());
        }
    }
    match names.first() {
        Some(first) => SharedString::from((*first).to_owned()),
        None => SharedString::from(list.to_owned()),
    }
}

/// The family names of a list, without their quotes.
fn names(list: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut quote = None;
    let mut start = 0;
    for (index, ch) in list.char_indices() {
        match (quote, ch) {
            (None, '"' | '\'') => quote = Some(ch),
            (Some(open), _) if open == ch => quote = None,
            (None, ',') => {
                names.push(&list[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    names.push(&list[start..]);
    names
        .into_iter()
        .map(|name| name.trim().trim_matches(|ch| ch == '"' || ch == '\'').trim())
        .filter(|name| !name.is_empty())
        .collect()
}

/// What Chrome draws a generic family or a system UI keyword in on macOS.
fn generic(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "system-ui" | "-apple-system" | "blinkmacsystemfont" | "ui-sans-serif" => Some(".SystemUIFont"),
        "sans-serif" => Some("Helvetica"),
        "serif" | "ui-serif" => Some("Times"),
        "monospace" | "ui-monospace" => Some("Menlo"),
        _ => None,
    }
}

/// GPUI answers a family it cannot load with the first of its fallbacks, so a family is installed when it resolves to
/// something else than a family that does not exist does. (A family that is the fallback face itself reads as not installed.)
fn installed(text_system: &TextSystem, name: &str) -> bool {
    let missing = text_system.resolve_font(&font("\u{0}no such family"));
    text_system.resolve_font(&font(SharedString::from(name.to_owned()))) != missing
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picked(list: &str, installed: &[&str]) -> String {
        pick(list, |name| installed.contains(&name)).to_string()
    }

    #[test]
    fn a_single_plain_name_is_not_a_list() {
        assert!(!is_list("Helvetica Neue"));
        assert!(!is_list("Inter Variable"));
        assert!(is_list("Inter, sans-serif"));
        assert!(is_list("'Helvetica Neue'"));
        assert!(is_list("monospace"));
    }

    #[test]
    fn names_split_outside_quotes_and_lose_their_quotes() {
        assert_eq!(names("a, 'B, c', \"D e\" ,f"), vec!["a", "B, c", "D e", "f"]);
        assert_eq!(names("  "), Vec::<&str>::new());
    }

    #[test]
    fn the_first_installed_family_wins() {
        let stack = "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
        assert_eq!(picked(stack, &[".SystemUIFont", "Helvetica Neue"]), ".SystemUIFont");
        assert_eq!(picked("'Segoe UI', Roboto, 'Helvetica Neue'", &["Helvetica Neue"]), "Helvetica Neue");
        assert_eq!(picked("Inter, sans-serif", &["Helvetica"]), "Helvetica");
    }

    #[test]
    fn generic_families_map_to_what_chrome_uses_on_macos() {
        assert_eq!(picked("monospace", &["Menlo"]), "Menlo");
        assert_eq!(picked("serif", &["Times"]), "Times");
        assert_eq!(picked("ui-monospace, monospace", &["Menlo"]), "Menlo");
    }

    #[test]
    fn a_list_with_nothing_installed_keeps_its_first_family() {
        assert_eq!(picked("'Segoe UI', Roboto", &[]), "Segoe UI");
    }
}
