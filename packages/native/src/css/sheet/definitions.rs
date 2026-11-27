//! The at-rules that define something by name (`@keyframes`, `@property`) and how a document
//! settles on one definition per name.
//!
//! Like a style rule, a definition stands in a layer and under `@media` conditions. Unlike one it
//! does not cascade by property: for a name the last definition wins (CSS Animations 1 for
//! `@keyframes`, CSS Properties and Values for `@property`), and cascade layers order them before
//! their position does (CSS Cascade 5, cascade layers: the rule in the layer that ranks highest
//! wins, unlayered above every layer, and among the rules of one layer the later one). A
//! definition whose conditions do not hold is not there at all, and does not hide an earlier one.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::css::media_query::MediaEnvironment;

use super::conditions::{self, Conditions};
use super::layers::{LayerId, LayerOrder};

/// One definition with where it was written. `L` is the kind of layer id: the document's, or
/// (`parse_cache`) one of the tree a single rule was parsed against.
pub struct Defined<T, L = LayerId> {
    pub body: Arc<T>,
    pub layer: Option<L>,
    pub conditions: Option<Arc<Conditions>>,
}

impl<T, L: Copy> Clone for Defined<T, L> {
    fn clone(&self) -> Self {
        Defined { body: self.body.clone(), layer: self.layer, conditions: self.conditions.clone() }
    }
}

/// The definitions that stand in `environment`, one for each name, ordered by name. `defined` is in
/// the order of the cascade, and `name_of` is what the definitions are told apart by.
pub(super) fn winners<'a, T>(
    defined: &'a [Defined<T>],
    environment: Option<&MediaEnvironment>,
    layers: &LayerOrder,
    name_of: impl Fn(&T) -> &str,
) -> Vec<&'a Arc<T>> {
    let mut best: FxHashMap<&str, (u32, usize)> = FxHashMap::default();
    for (position, definition) in defined.iter().enumerate() {
        if !conditions::holds(definition.conditions.as_ref(), environment) {
            continue;
        }
        let rank = layers.rank(definition.layer);
        let slot = best.entry(name_of(&definition.body)).or_insert((rank, position));
        // `>=`: at one rank the later rule wins.
        if rank >= slot.0 {
            *slot = (rank, position);
        }
    }
    let mut chosen: Vec<(&str, usize)> = best.into_iter().map(|(name, (_, position))| (name, position)).collect();
    chosen.sort_unstable();
    chosen.into_iter().map(|(_, position)| &defined[position].body).collect()
}
