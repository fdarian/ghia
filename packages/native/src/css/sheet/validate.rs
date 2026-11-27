//! Which declarations of a sheet take part in the cascade.
//!
//! CSS ignores a declaration it cannot read, so `right: bogus !important` must not remove an
//! inline `right`. The cascade works on declarations before any style is parsed, so each one is
//! judged once, when its sheet is loaded, by the check `StyleTable::intern` runs on a style.

use std::borrow::Cow;

use rustc_hash::FxHashMap;

use crate::color::{ColorContext, Scheme};
use crate::css::lenient::{object_text, Declaration};
use crate::css::var_substitution::mentions_var;
use crate::events::state_styles::without_invalid_values;
use crate::retained_tree::parse_style;
use crate::style::StyleDesc;

use super::initial;
use super::wide_keyword::is_css_wide;
use super::Rule;

/// How many verdicts are remembered before the memory starts over.
const VERDICT_LIMIT: usize = 4096;

#[derive(Default)]
pub struct Validator {
    /// Keyed by the declaration alone as the style prop's JSON, so a declaration that several
    /// rules repeat is parsed once, and again only after a sheet change if it was forgotten.
    verdicts: FxHashMap<String, Verdict>,
}

struct Verdict {
    accepted: bool,
    /// A rejection is logged once, by the first rule's declaration that meets it: an `@supports` that asked
    /// first did not log it, so a later declaration that is rejected still has to.
    logged: bool,
}

impl Validator {
    /// Drops the declarations the style parser does not accept from `rules`, and the rules left
    /// with none.
    pub fn filter(&mut self, rules: &mut Vec<Rule>) {
        for rule in rules.iter_mut() {
            rule.normal = self.judge_all(std::mem::take(&mut rule.normal));
            rule.important = self.judge_all(std::mem::take(&mut rule.important));
        }
        rules.retain(|rule| !rule.normal.is_empty() || !rule.important.is_empty());
    }

    /// The declarations of an element's own style that may take part in the cascade. An inline
    /// value that is `null` or `""` is no value in React DOM, and one the style parser rejects is
    /// ignored by CSS, so neither may take back what a sheet declared. A nested object (a state
    /// style) is not a declaration of a property and passes.
    pub fn filter_own(&mut self, own: Vec<Declaration>) -> Vec<Declaration> {
        own.into_iter()
            .filter_map(|declaration| match declaration.value.as_str() {
                "null" | "\"\"" => None,
                value if value.starts_with('{') || value.starts_with('[') => Some(declaration),
                _ => self.judge(declaration),
            })
            .collect()
    }

    /// The declarations of `declarations` that CSS would keep: the check a rule's declarations
    /// go through, for the ones a rule does not hold itself (a keyframe's).
    pub(super) fn keep(&mut self, declarations: Vec<Declaration>) -> Vec<Declaration> {
        self.judge_all(declarations)
    }

    fn judge_all(&mut self, declarations: Vec<Declaration>) -> Vec<Declaration> {
        declarations.into_iter().filter_map(|declaration| self.judge(declaration)).collect()
    }

    /// The declaration as the cascade takes it, or `None` when CSS would ignore it. A keyword that
    /// is the property's initial value and that the style parser has no form for becomes `initial`.
    fn judge(&mut self, declaration: Declaration) -> Option<Declaration> {
        if self.accepts(&declaration) {
            return Some(declaration);
        }
        initial::is_initial_keyword(&declaration).then(|| Declaration { key: declaration.key, value: "\"initial\"".to_owned() })
    }

    /// Whether `@supports (key: value)` holds: the check a declaration of a rule goes through, and
    /// the same keyword that `judge` takes for the initial value. A rule's declaration that fails
    /// is logged; this one is a question, not a mistake.
    pub fn supports(&mut self, declaration: &Declaration) -> bool {
        self.check(declaration, false) || initial::is_initial_keyword(declaration)
    }

    fn accepts(&mut self, declaration: &Declaration) -> bool {
        self.check(declaration, true)
    }

    fn check(&mut self, declaration: &Declaration, log_rejection: bool) -> bool {
        // Custom properties take any value, a `var()` is only known at build time, and a CSS-wide
        // keyword is the cascade's own to apply.
        if declaration.key.starts_with("--") || mentions_var(declaration.value.as_bytes()) || is_css_wide(&declaration.value) {
            return true;
        }
        let alone = object_text(std::slice::from_ref(declaration));
        if let Some(verdict) = self.verdicts.get_mut(&alone) {
            if log_rejection && !verdict.accepted && !verdict.logged {
                verdict.logged = true;
                warn_ignored(declaration);
            }
            return verdict.accepted;
        }
        // A key the style does not know parses and sets nothing, which CSS also ignores.
        let accepted = parse_style(alone.as_bytes()).is_ok_and(|style| style != StyleDesc::default() && is_valid(&style));
        let logged = log_rejection && !accepted;
        if logged {
            warn_ignored(declaration);
        }
        if self.verdicts.len() >= VERDICT_LIMIT {
            self.verdicts.clear();
        }
        self.verdicts.insert(alone, Verdict { accepted, logged });
        accepted
    }
}

fn warn_ignored(declaration: &Declaration) {
    if !initial::is_initial_keyword(declaration) {
        log::warn!("Stylesheet: declaration ignored, not a valid {}: {}", declaration.key, declaration.value);
    }
}

/// Whether CSS would keep the declaration the style was parsed from: no value of it is one the
/// style drops as invalid when a state style layers over its base, and a colour resolves, which
/// the style parser does not check for the properties below.
fn is_valid(style: &StyleDesc) -> bool {
    if !matches!(without_invalid_values(style), Cow::Borrowed(_)) {
        return false;
    }
    let colors = ColorContext::root(Scheme::Light);
    [&style.color, &style.outline_color, &style.text_decoration_color]
        .into_iter()
        .all(|color| color.as_deref().is_none_or(|text| colors.resolve(text).is_some()))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    thread_local! {
        static LOGGED: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// Records, for the thread that logs, what the `log` macros are given.
    struct Capture;

    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }

        fn log(&self, record: &log::Record) {
            LOGGED.with(|logged| logged.borrow_mut().push(record.args().to_string()));
        }

        fn flush(&self) {}
    }

    fn logged_while(run: impl FnOnce()) -> Vec<String> {
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            log::set_logger(&Capture).expect("no other test installs a logger");
            log::set_max_level(log::LevelFilter::Warn);
        });
        LOGGED.with(|logged| logged.borrow_mut().clear());
        run();
        LOGGED.with(|logged| logged.borrow().clone())
    }

    fn invalid_color() -> Declaration {
        Declaration { key: "color".to_owned(), value: "\"notacolor\"".to_owned() }
    }

    #[test]
    fn a_rejected_declaration_is_logged_once_even_after_an_at_supports_asked_about_it() {
        let mut validator = Validator::default();
        let declaration = invalid_color();
        let asked = logged_while(|| assert!(!validator.supports(&declaration)));
        assert!(asked.is_empty(), "a question is not a mistake: {asked:?}");
        let used = logged_while(|| assert!(!validator.accepts(&declaration)));
        assert_eq!(used.len(), 1, "{used:?}");
        let again = logged_while(|| assert!(!validator.accepts(&declaration)));
        assert!(again.is_empty(), "{again:?}");
    }
}
