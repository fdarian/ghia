//! `::before` and `::after`: the generated boxes a sheet styles, matched and cascaded, not drawn.
//!
//! A selector that ends in `::before` or `::after` matches its *originating element*, the one the
//! compounds before the pseudo-element describe, and the rule styles the box that element would
//! have. The rule index files it under its own target (`RuleIndex::pseudos`), so matching an
//! element reads none of them, and the flush asks each marked element for its two boxes after it
//! has matched the element (`flush_pseudos` in `tree.rs`). What a pseudo-element selector reads of
//! the tree is read by the invalidation as for any selector, so everything that matches an element
//! again matches its boxes again.
//!
//! The cascade is the element's without the own style: the matched rules in order, normal then
//! `!important`, merged into the JSON text of a style and interned (`StyleSheets::cascaded`). A
//! box has no inline style, and no user agent or universal layer under it. A rule under a state of
//! the subject (`.btn:hover::before`) puts its declarations in the state block of the style, the
//! way an element's rule does, and is folded with the state of the originating element by whoever
//! draws or reads the box.
//!
//! What the matching gives an element is one [`PseudoMatches`], shared by the elements whose two
//! boxes match the same rules. The cascaded style of a box does not depend on the element, so it
//! is kept in the shared value; what does (the attributes `content: attr()` reads) is read when a
//! box is asked for ([`PseudoStyle::generate`]), so it is current, and a change to such an
//! attribute marks the element (`RetainedTree::pseudo_attribute_changed`).
//!
//! Inheritance is not here: a style holds what a rule declared, and the box inherits from its
//! originating element when it is built or read, as an element inherits from its parent.

use std::sync::{Arc, Weak};

use rustc_hash::{FxHashMap, FxHashSet};

use crate::css::content::{Computed, ComputedItem, Content};
use crate::retained_tree::{RetainedElement, RetainedTree, StyleTable};
use crate::style::StyleDesc;

use super::cascade::MatchedRules;
use super::document::{StyleSheets, SKIP_LOG_LIMIT};
use super::index::RuleBody;
use super::share::Found;

/// The generated boxes of an element that a rule can style.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub enum Pseudo {
    Before,
    After,
}

impl Pseudo {
    pub const BOTH: [Pseudo; 2] = [Pseudo::Before, Pseudo::After];

    /// The pseudo-element a selector names, `before` or `after` in lower case, which the legacy
    /// single-colon form also writes. Any other name is one this engine has no box for.
    pub fn named(name: &str) -> Option<Pseudo> {
        match name {
            "before" => Some(Pseudo::Before),
            "after" => Some(Pseudo::After),
            _ => None,
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

/// The rules a box matched, and the style they cascade to.
pub struct PseudoSide {
    matched: Arc<MatchedRules>,
    /// What the rules declare for the box, the blocks of its states included.
    pub style: Arc<StyleDesc>,
}

impl PseudoSide {
    /// Whether the box has content in some state: in the style, or in the block of a state.
    fn may_generate(&self) -> bool {
        declared_content(&self.style).any(|content| matches!(content, Content::Items(_)))
    }
}

/// The `content` of a style and of the blocks of its states.
fn declared_content(style: &StyleDesc) -> impl Iterator<Item = &Content> {
    std::iter::once(style)
        .chain(crate::css::var_substitution::state_blocks(style).into_iter().filter_map(|(_, block)| block))
        .filter_map(|style| style.content.as_ref())
}

/// The two boxes of an element, `None` for one no rule matched.
pub struct PseudoMatches {
    sides: [Option<PseudoSide>; 2],
    /// The attribute names the `content` of the boxes reads, lower-cased.
    attributes: Vec<String>,
}

impl PseudoMatches {
    pub fn side(&self, pseudo: Pseudo) -> Option<&PseudoSide> {
        self.sides[pseudo.index()].as_ref()
    }

    pub(super) fn lists(&self) -> impl Iterator<Item = &Arc<MatchedRules>> {
        self.sides.iter().flatten().map(|side| &side.matched)
    }

    /// Whether a box of the element can have content.
    fn may_generate(&self) -> bool {
        self.sides.iter().flatten().any(PseudoSide::may_generate)
    }

    /// Whether the content of a box reads the attribute `lower_name`.
    fn reads_attribute(&self, lower_name: &str) -> bool {
        self.attributes.iter().any(|name| name == lower_name)
    }
}

/// A box that exists: the style it has and the content it holds. What the build of the box reads;
/// the tests are its only reader until then.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, PartialEq)]
pub struct PseudoStyle {
    pub style: Arc<StyleDesc>,
    /// Never empty: a box with no content is not generated.
    pub content: Vec<ComputedItem>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl PseudoStyle {
    /// The box `style` makes for `element`, `None` when its computed `content` is `normal` or
    /// `none` or its `display` is `none`. `style` is the cascaded style of the box with the blocks
    /// of the states that apply folded into it, so a box that only has content while hovered is
    /// asked about with that state's style.
    pub fn generate(style: &Arc<StyleDesc>, element: &RetainedElement) -> Option<PseudoStyle> {
        if style.display.as_deref() == Some("none") {
            return None;
        }
        let computed = style.content.as_ref()?.compute(|name| element.attribute(name).map(|value| value.into_owned()));
        match computed {
            Computed::Items(content) => Some(PseudoStyle { style: style.clone(), content }),
            Computed::Normal | Computed::None => None,
        }
    }
}

impl RetainedElement {
    /// The style the rules declare for the box, whether or not it has content: what
    /// `getComputedStyle` reads. `None` when no rule matched the box.
    pub(crate) fn pseudo_style(&self, pseudo: Pseudo) -> Option<&Arc<StyleDesc>> {
        self.pseudo_matches()?.side(pseudo).map(|side| &side.style)
    }

    /// The style of the box when it can have content in some state, the one a build folds the
    /// element's states into before [`PseudoStyle::generate`].
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn pseudo_candidate(&self, pseudo: Pseudo) -> Option<&Arc<StyleDesc>> {
        self.pseudo_matches()?.side(pseudo).filter(|side| side.may_generate()).map(|side| &side.style)
    }

    /// The box of the element as the rules declare it, with no state applied.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn pseudo_box(&self, pseudo: Pseudo) -> Option<PseudoStyle> {
        PseudoStyle::generate(self.pseudo_style(pseudo)?, self)
    }
}

/// The matching of the boxes of the elements, and what the sheets keep to share it.
#[derive(Default)]
pub(super) struct PseudoState {
    /// By the lists a pair of boxes matched, which `PseudoMatches` holds, so no address is reused
    /// while an entry lives.
    interned: FxHashMap<(usize, usize), Weak<PseudoMatches>>,
    pruned_at: usize,
    /// The content items that are not drawn, already logged.
    logged: FxHashSet<String>,
}

fn address(list: &Option<Arc<MatchedRules>>) -> usize {
    list.as_ref().map_or(0, |list| Arc::as_ptr(list) as usize)
}

impl StyleSheets {
    /// The value for the two lists the boxes of an element matched, `None` when neither matched.
    pub(super) fn pseudo_matches(
        &mut self,
        styles: &mut StyleTable,
        lists: [Option<Arc<MatchedRules>>; 2],
    ) -> Option<Arc<PseudoMatches>> {
        let key = (address(&lists[0]), address(&lists[1]));
        if key == (0, 0) {
            return None;
        }
        if let Some(live) = self.pseudo.interned.get(&key).and_then(Weak::upgrade) {
            return Some(live);
        }
        if self.pseudo.interned.len() >= self.pseudo.pruned_at.saturating_mul(2).max(64) {
            self.pseudo.interned.retain(|_, held| held.strong_count() > 0);
            self.pseudo.pruned_at = self.pseudo.interned.len();
        }
        let sides = lists.map(|list| {
            list.map(|matched| {
                let style = self.cascaded(styles, &matched, None).unwrap_or_default();
                PseudoSide { matched, style }
            })
        });
        let mut attributes: Vec<String> = Vec::new();
        for side in sides.iter().flatten() {
            for content in declared_content(&side.style) {
                for name in content.attributes() {
                    let name = name.to_ascii_lowercase();
                    if !attributes.contains(&name) {
                        attributes.push(name);
                    }
                }
                for item in content.unsupported() {
                    self.warn_content_item(item);
                }
            }
        }
        let built = Arc::new(PseudoMatches { sides, attributes });
        self.pseudo.interned.insert(key, Arc::downgrade(&built));
        Some(built)
    }

    /// `boxes` with the lists that `replaced` replaces swapped in: the same rules in the same order,
    /// so the same styles, under their new numbers.
    pub(super) fn renumbered_pseudos(
        &mut self,
        boxes: &PseudoMatches,
        replaced: &FxHashMap<usize, Option<Arc<MatchedRules>>>,
    ) -> Arc<PseudoMatches> {
        let swapped = |side: &Option<PseudoSide>| -> Option<Arc<MatchedRules>> {
            let side = side.as_ref()?;
            let new = replaced.get(&(Arc::as_ptr(&side.matched) as usize)).and_then(Option::as_ref);
            Some(new.unwrap_or(&side.matched).clone())
        };
        let lists = [swapped(&boxes.sides[0]), swapped(&boxes.sides[1])];
        let key = (address(&lists[0]), address(&lists[1]));
        if let Some(live) = self.pseudo.interned.get(&key).and_then(Weak::upgrade) {
            return live;
        }
        let [before, after] = lists;
        let renumbered = |list: Option<Arc<MatchedRules>>, side: &Option<PseudoSide>| {
            Some(PseudoSide { matched: list?, style: side.as_ref()?.style.clone() })
        };
        let built = Arc::new(PseudoMatches {
            sides: [renumbered(before, &boxes.sides[0]), renumbered(after, &boxes.sides[1])],
            attributes: boxes.attributes.clone(),
        });
        self.pseudo.interned.insert(key, Arc::downgrade(&built));
        built
    }

    fn warn_content_item(&mut self, item: &str) {
        if self.pseudo.logged.contains(item) || self.pseudo.logged.len() >= SKIP_LOG_LIMIT {
            return;
        }
        log::warn!("Stylesheet: content item not drawn: {item}");
        self.pseudo.logged.insert(item.to_owned());
    }

    pub(super) fn wind_down_pseudos(&mut self) {
        self.pseudo = PseudoState::default();
    }
}

/// The attribute names the `content` declarations of a rule read, added to `names` lower-cased.
pub(super) fn read_content_attributes(body: &RuleBody, names: &mut FxHashSet<String>) {
    for declaration in body.normal.iter().chain(&body.important).filter(|declaration| declaration.key == "content") {
        let Ok(text) = serde_json::from_str::<String>(&declaration.value) else {
            continue;
        };
        if let Some(content) = Content::parse(&text) {
            names.extend(content.attributes().map(str::to_ascii_lowercase));
        }
    }
}

impl RetainedTree {
    /// The boxes of the elements the flush matched, with the matching of each: `found` has the
    /// match of the `before` and the `after` of an element. Returns the changes to apply.
    pub(super) fn pseudo_changes(
        &mut self,
        found: Vec<(u64, [Found; 2])>,
        mut intern: impl FnMut(&mut StyleSheets, Found) -> Option<Arc<MatchedRules>>,
    ) -> Vec<(u64, Option<Arc<PseudoMatches>>)> {
        let mut changes = Vec::new();
        for (id, pair) in found {
            let lists = pair.map(|found| intern(&mut self.sheets, found));
            let old = self.elements.get(&id).and_then(|element| element.pseudo_matches());
            let held = |pseudo: Pseudo| old.and_then(|old| old.side(pseudo)).map(|side| &side.matched);
            let same = Pseudo::BOTH.into_iter().all(|pseudo| match (held(pseudo), &lists[pseudo.index()]) {
                (None, None) => true,
                (Some(old), Some(new)) => Arc::ptr_eq(old, new),
                _ => false,
            });
            if same {
                continue;
            }
            let new = self.sheets.pseudo_matches(&mut self.styles, lists);
            changes.push((id, new));
        }
        changes
    }

    /// Gives the elements their boxes, and makes the boxes they draw (`layout::generated`): a
    /// rule for a box that sets no `content` changes nothing to draw.
    pub(super) fn apply_pseudo(&mut self, changes: Vec<(u64, Option<Arc<PseudoMatches>>)>) {
        for (id, new) in changes {
            let Some(element) = self.elements.get_mut(&id) else {
                continue;
            };
            element.set_pseudo_matches(new);
            self.sync_generated(id);
        }
    }

    /// The attribute `lower_name` of `id` changed: a box whose `content` reads it shows another text.
    pub(super) fn pseudo_attribute_changed(&mut self, id: u64, lower_name: &str) {
        if !self.sheets.index.content_attributes.contains(lower_name) {
            return;
        }
        let reads = self
            .elements
            .get(&id)
            .and_then(|element| element.pseudo_matches())
            .is_some_and(|matches| matches.reads_attribute(lower_name));
        if reads {
            self.sync_generated(id);
        }
    }
}
