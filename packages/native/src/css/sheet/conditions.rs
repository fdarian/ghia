//! The `@media` conditions a rule stands under, and what a change of the window does to them.
//!
//! A rule keeps the media queries of every `@media` that encloses it (at the top level, in an
//! `@layer`, in another `@media` or `@supports`, or around the declarations of a style rule it is
//! nested in), and applies only while all of them match. Which rules apply is decided when the
//! index is built, not when an element is matched: a rule whose conditions do not hold is not
//! indexed, so matching, the matched sets and the cascade cache never see it. A change of the
//! window that flips a query builds the index again (`StyleSheets::set_media_environment`).

use std::sync::Arc;

use rustc_hash::FxHashSet;

use crate::css::media_query::{MediaEnvironment, MediaQueryList};


/// The media queries that all have to match for a rule to apply, the outermost first.
pub struct Conditions {
    lists: Vec<Arc<MediaQueryList>>,
}

impl Conditions {
    /// The conditions of a rule inside an `@media` of `list`, which is inside `outer`.
    pub(super) fn within(outer: Option<&Arc<Conditions>>, list: Arc<MediaQueryList>) -> Arc<Conditions> {
        let mut lists = outer.map(|outer| outer.lists.clone()).unwrap_or_default();
        lists.push(list);
        Arc::new(Conditions { lists })
    }

    #[cfg(test)]
    pub(super) fn texts(&self) -> Vec<&str> {
        self.lists.iter().map(|list| list.text()).collect()
    }

    fn holds(&self, environment: &MediaEnvironment) -> bool {
        self.lists.iter().all(|list| list.matches(environment))
    }
}

/// Whether a rule with `conditions` applies. Before the window has reported its environment no
/// media query holds: there is nothing to evaluate it against.
pub(super) fn holds(conditions: Option<&Arc<Conditions>>, environment: Option<&MediaEnvironment>) -> bool {
    match conditions {
        None => true,
        Some(conditions) => environment.is_some_and(|environment| conditions.holds(environment)),
    }
}

/// Each distinct media query the loaded rules stand under, with the answer the index was built on.
#[derive(Default)]
pub(super) struct Watched {
    queries: Vec<(Arc<MediaQueryList>, bool)>,
}

impl Watched {
    /// `all` is the conditions of every rule and definition of the loaded sheets.
    pub(super) fn of<'a>(all: impl Iterator<Item = &'a Option<Arc<Conditions>>>, environment: Option<&MediaEnvironment>) -> Watched {
        let mut seen: FxHashSet<&str> = FxHashSet::default();
        let mut queries = Vec::new();
        for conditions in all {
            let Some(conditions) = conditions else {
                continue;
            };
            for list in &conditions.lists {
                if seen.insert(list.text()) {
                    queries.push((list.clone(), environment.is_some_and(|environment| list.matches(environment))));
                }
            }
        }
        Watched { queries }
    }

    /// Evaluates each query against `environment` again, and says whether one answers differently
    /// than the index was built on. Not every flip changes which rules apply (a rule under two
    /// queries needs both), but the rules are indexed again either way, which costs one pass over
    /// them and no parse.
    pub(super) fn update(&mut self, environment: &MediaEnvironment) -> bool {
        let mut flipped = false;
        for (list, held) in &mut self.queries {
            let now = list.matches(environment);
            flipped |= now != *held;
            *held = now;
        }
        flipped
    }

    pub(super) fn is_empty(&self) -> bool {
        self.queries.is_empty()
    }
}
