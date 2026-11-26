//! The style state of one document: its sheets, the index over their rules, and what has to be
//! matched again.
//!
//! Every hook the tree calls is guarded by [`StyleSheets::enabled`], which is false until a
//! `<style>` element or a constructed sheet exists, so a document without sheets pays a branch.
//! Marks collect while a batch applies and the tree flushes them once at its end (see
//! `css::sheet::tree`).

use std::cell::RefCell;
use std::sync::{Arc, Weak};

use rustc_hash::{FxHashMap, FxHashSet};

use crate::css::media_query::MediaEnvironment;
use crate::css::registered_properties::Registered;
use crate::retained_tree::{InternedStyle, StyleTable};
use crate::style::StyleDesc;

use super::atoms::{Atom, Atoms};
use super::cascade::{merge, MatchedInterner, MatchedRules};
use super::conditions::{self, Watched};
use super::definitions::winners;
use super::index::{DocRule, RuleIndex};
use super::invalidation::Reach;
use super::keyframes::SheetKeyframes;
use super::layers::Layers;
use super::live_states::LiveStates;
use super::parse_cache::{ParseCache, ParsedRule};
use super::positions::PendingRanges;
use super::pseudo::{PseudoMatches, PseudoState};
use super::reload::Reload;
use super::states::LoggedFolds;
use super::validate::Validator;
use crate::css::lenient::number_text;

/// How many distinct skipped rules are logged before the rest are summed up in one warning.
pub(super) const SKIP_LOG_LIMIT: usize = 1024;

/// The class atoms of one element: a few sit inline.
pub type ClassAtoms = smallvec::SmallVec<[Atom; 4]>;

/// What an element has for the matcher, kept on the element while sheets exist.
#[derive(Default)]
pub struct ElementCss {
    pub id: Option<Atom>,
    pub classes: ClassAtoms,
    /// `None` for an element no rule matches, and for one that is not in the document.
    pub matched: Option<Arc<MatchedRules>>,
    /// The rules that match its `::before` and `::after`, `None` when neither has one.
    pub pseudo: Option<Arc<PseudoMatches>>,
}

impl ElementCss {
    pub fn is_empty(&self) -> bool {
        self.id.is_none() && self.classes.is_empty() && self.matched.is_none() && self.pseudo.is_none()
    }
}

pub struct StyleSheets {
    /// A hook does nothing while this is false.
    pub(crate) enabled: bool,
    /// Whether every element's `ElementCss` atoms are current. False until the first flush after
    /// the sheets appear, which computes them for the elements that existed before.
    pub(crate) atoms_fresh: bool,
    pub(crate) sources_dirty: bool,
    pub(crate) mark_all: bool,
    /// Elements to match again, each with the places around it a change reaches.
    pub(crate) pending: Vec<(u64, Reach)>,
    /// Runs of siblings the structural pseudo-classes read, which the flush turns into marks.
    pub(crate) ranges: PendingRanges,
    pub(crate) atoms: Atoms,
    pub(crate) style: Atom,
    /// Every `<style>` element, connected or not.
    pub(crate) style_elements: FxHashSet<u64>,
    pub(crate) constructed: FxHashMap<u64, String>,
    pub(crate) adopted: Vec<u64>,
    pub(crate) index: RuleIndex,
    /// The elements the pointer and the focus hold, for the selectors that read a state outside
    /// their subject. Empty while no rule does.
    pub(crate) live: LiveStates,
    /// What the window reports to the media queries of the rules, `None` until it has. It is the
    /// window's and not the sheets', so it outlives them (`wind_down` keeps it).
    pub(crate) media: Option<MediaEnvironment>,
    /// The media queries the loaded rules stand under, with the answers the index was built on.
    watched: Watched,
    /// A media query answers differently than the index was built on: the sheets are loaded again
    /// even when their text is unchanged, and the elements are matched again, since the old
    /// numbering of the rules says nothing about the new index.
    pub(crate) media_flipped: bool,
    /// The sets of keyframes the loaded sheets define, which the animation engine reads.
    pub(crate) keyframes: Arc<SheetKeyframes>,
    /// What the loaded sheets register with `@property`.
    pub(crate) registered: Option<Arc<Registered>>,
    /// A load changed the keyframes or the registrations: what a build reads that is not an element's
    /// style changed, and the tree has to draw again (`take_document_changed`).
    document_changed: bool,
    /// The top-level rules `index` was built from, when every source was cut into them.
    loaded_units: Option<Vec<Arc<ParsedRule>>>,
    pub(crate) interner: MatchedInterner,
    /// What is shared between the elements that match the same rules for their generated boxes.
    pub(super) pseudo: PseudoState,
    validator: Validator,
    parse_cache: ParseCache,
    /// The skipped rules already logged, kept across reloads (every sheet is parsed again when
    /// one changes) so each is logged once.
    logged_skips: FxHashSet<String>,
    /// The fold-order disagreements already logged, kept across reloads like `logged_skips`.
    logged_folds: LoggedFolds,
    /// Whether the summary warning for the skips past `SKIP_LOG_LIMIT` was logged.
    skip_log_capped: bool,
    /// How many warnings `logged_skips` let through, for the tests.
    #[cfg(test)]
    pub(crate) skip_warnings: usize,
    /// The text `[style]` selectors read, per own style, kept while an element has the style. Weak
    /// so the text does not count as an element holding it, and the allocation stays reserved
    /// so the address it is keyed by cannot be reused.
    style_texts: RefCell<FxHashMap<usize, (Weak<StyleDesc>, Arc<str>)>>,
}

impl Default for StyleSheets {
    fn default() -> Self {
        let mut atoms = Atoms::default();
        let style = atoms.intern("style");
        StyleSheets {
            enabled: false,
            atoms_fresh: false,
            sources_dirty: false,
            mark_all: false,
            pending: Vec::new(),
            ranges: PendingRanges::default(),
            atoms,
            style,
            style_elements: FxHashSet::default(),
            constructed: FxHashMap::default(),
            adopted: Vec::new(),
            index: RuleIndex::default(),
            live: LiveStates::default(),
            media: None,
            watched: Watched::default(),
            media_flipped: false,
            keyframes: Arc::default(),
            registered: None,
            document_changed: false,
            loaded_units: None,
            interner: MatchedInterner::default(),
            pseudo: PseudoState::default(),
            validator: Validator::default(),
            parse_cache: ParseCache::default(),
            logged_skips: FxHashSet::default(),
            skip_log_capped: false,
            logged_folds: LoggedFolds::default(),
            #[cfg(test)]
            skip_warnings: 0,
            style_texts: RefCell::default(),
        }
    }
}

impl StyleSheets {
    /// The texts the index was built from, in cascade order.
    pub(crate) fn loaded(&self) -> &[String] {
        self.parse_cache.texts()
    }

    pub(crate) fn has_work(&self) -> bool {
        self.enabled && (self.sources_dirty || self.mark_all || !self.atoms_fresh || !self.pending.is_empty() || !self.ranges.is_empty())
    }

    pub(crate) fn mark(&mut self, id: u64, reach: Reach) {
        if reach.is_empty() || self.pending.last().is_some_and(|(last, held)| *last == id && held.contains(reach)) {
            return;
        }
        self.pending.push((id, reach));
    }

    /// Where a change of the attribute `name` can change what a selector matches.
    pub(crate) fn attribute_reach(&self, name: &str) -> Reach {
        self.atoms
            .get(name)
            .and_then(|atom| self.index.invalidation.attributes.get(&atom))
            .copied()
            .unwrap_or_default()
    }

    /// Where the classes that are in one list and not the other can be read.
    pub(crate) fn class_reach(&self, before: &[Atom], after: &[Atom]) -> Reach {
        let classes = &self.index.invalidation.classes;
        let mut reach = self.attribute_reach("class");
        if classes.is_empty() {
            return reach;
        }
        for class in before.iter().filter(|class| !after.contains(class)) {
            reach |= classes.get(class).copied().unwrap_or_default();
        }
        for class in after.iter().filter(|class| !before.contains(class)) {
            reach |= classes.get(class).copied().unwrap_or_default();
        }
        reach
    }

    pub(crate) fn id_reach(&self, before: Option<Atom>, after: Option<Atom>) -> Reach {
        let mut reach = self.attribute_reach("id");
        if before != after {
            let ids = &self.index.invalidation.ids;
            for id in before.iter().chain(after.iter()) {
                reach |= ids.get(id).copied().unwrap_or_default();
            }
        }
        reach
    }

    /// Where a change of an own style can be read: only a `[style]` selector can tell.
    pub(crate) fn style_reach(&self) -> Reach {
        self.index.invalidation.attributes.get(&self.style).copied().unwrap_or_default()
    }

    /// Whether any selector reads an own style, which is what keeps the texts of own styles.
    pub(crate) fn reads_style(&self) -> bool {
        !self.style_reach().is_empty()
    }

    /// The sheets the document has now, one text each: the connected `<style>` elements' (given in
    /// tree order by the caller), then the adopted constructed sheets.
    pub(crate) fn texts_with(&self, style_elements: Vec<String>) -> Vec<String> {
        let mut texts = style_elements;
        texts.extend(self.adopted.iter().filter_map(|sheet| self.constructed.get(sheet).cloned()));
        texts
    }

    /// Parses `texts` as the document's sheets and indexes their rules. Layers are declared in
    /// parse order across the whole document, so every sheet is assembled again when any
    /// changes; the rules whose text is unchanged come from the parse cache.
    ///
    /// What the elements hold (`matched`, the interner) is numbered by the index just replaced, and
    /// is the caller's to bring to the new one: by the returned [`Reload`] when it can, else by
    /// matching every element again.
    pub(super) fn load(&mut self, texts: Vec<String>) -> Option<Reload> {
        let mut layers = Layers::default();
        let assembled = self.parse_cache.parse(texts, &mut self.atoms, &mut layers, &mut self.validator);
        for skipped in assembled.unsupported {
            self.warn_skipped(skipped);
        }
        let environment_flipped = std::mem::take(&mut self.media_flipped);
        self.watched = Watched::of(
            assembled
                .rules
                .iter()
                .map(|rule| &rule.conditions)
                .chain(assembled.keyframes.iter().map(|rule| &rule.conditions))
                .chain(assembled.properties.iter().map(|rule| &rule.conditions)),
            self.media.as_ref(),
        );
        let order = layers.order();
        self.settle_definitions(&assembled.keyframes, &assembled.properties, &order);
        let applying: Vec<DocRule> = if self.watched.is_empty() {
            assembled.rules
        } else {
            let environment = self.media.as_ref();
            assembled.rules.into_iter().filter(|rule| conditions::holds(rule.conditions.as_ref(), environment)).collect()
        };
        let index = RuleIndex::build(&applying, &order, self.style);
        let old_units = std::mem::replace(&mut self.loaded_units, assembled.units);
        let old_index = std::mem::replace(&mut self.index, index);
        match (old_units, &self.loaded_units) {
            (Some(old), Some(new)) if !environment_flipped => Reload::between(&old, new, &old_index, &self.index, self.media.as_ref()),
            _ => None,
        }
    }

    /// Settles the `@keyframes` and `@property` rules of a load on one definition for each name.
    fn settle_definitions(
        &mut self,
        keyframes: &[super::definitions::Defined<super::keyframes::KeyframesRule>],
        properties: &[super::definitions::Defined<crate::css::registered_properties::Registration>],
        order: &super::layers::LayerOrder,
    ) {
        let environment = self.media.as_ref();
        let chosen = winners(keyframes, environment, order, |rule| &rule.name);
        if let Some(replaced) = SheetKeyframes::replaced_by(&self.keyframes, chosen) {
            self.keyframes = replaced;
            self.document_changed = true;
        }
        let chosen = winners(properties, environment, order, |registration| &registration.name);
        let registered = Registered::new(chosen.into_iter().map(|registration| (**registration).clone()).collect()).map(Arc::new);
        let unchanged = match (&self.registered, &registered) {
            (None, None) => true,
            (Some(held), Some(new)) => **held == **new,
            _ => false,
        };
        if !unchanged {
            self.registered = registered;
            self.document_changed = true;
        }
    }

    /// Whether a load changed what the sheets define by name since this was last asked.
    pub(crate) fn take_document_changed(&mut self) -> bool {
        std::mem::take(&mut self.document_changed)
    }

    /// Tells the sheets what the window reports to media queries. Returns whether a query the
    /// loaded rules stand under now answers differently, which marks the sheets to be loaded again
    /// (a flush does it): the rules that apply changed. A change that flips nothing costs one
    /// evaluation of each distinct query, which is what a window drag pays.
    pub(crate) fn set_media_environment(&mut self, environment: MediaEnvironment) -> bool {
        if self.media == Some(environment) {
            return false;
        }
        self.media = Some(environment);
        if !self.watched.update(&environment) {
            return false;
        }
        self.media_flipped = true;
        self.sources_dirty = true;
        true
    }

    fn warn_skipped(&mut self, skipped: String) {
        if self.logged_skips.contains(&skipped) {
            return;
        }
        // CSS-in-JS writes a new `.css-xxx:hover` per component, so the set would grow for as
        // long as the app runs.
        if self.logged_skips.len() >= SKIP_LOG_LIMIT {
            if !self.skip_log_capped {
                self.skip_log_capped = true;
                log::warn!("Stylesheet: further skipped rules not logged");
                #[cfg(test)]
                {
                    self.skip_warnings += 1;
                }
            }
            return;
        }
        log::warn!("Stylesheet: not supported, skipped: {skipped}");
        #[cfg(test)]
        {
            self.skip_warnings += 1;
        }
        self.logged_skips.insert(skipped);
    }

    /// The style of an element that matched `matched` and declared `own`. Run once per pair: the
    /// result is kept in `styles.cascaded`. A merge that does not parse leaves the element its own
    /// style alone, as CSS ignores a declaration it cannot read.
    pub(crate) fn cascaded(
        &mut self,
        styles: &mut StyleTable,
        matched: &Arc<MatchedRules>,
        own: Option<&InternedStyle>,
    ) -> Option<Arc<StyleDesc>> {
        let own_arc = own.map(InternedStyle::arc);
        if let Some(hit) = styles.cascaded.get(matched, own_arc) {
            return hit;
        }
        crate::perf_counters::cascade_computed();
        let (declarations, important) = match own {
            Some(own) => {
                let raw = styles.raw_of(own);
                let own = serde_json::from_slice::<crate::css::lenient::Declarations>(&raw)
                    .expect("an interned style is a JSON object")
                    .0;
                let (normal, important) = crate::css::inline_important::split(own);
                (self.validator.filter_own(normal), self.validator.filter_own(important))
            }
            None => (Vec::new(), Vec::new()),
        };
        let text = merge(&self.index, matched, &declarations, &important, &mut self.logged_folds);
        let style = match styles.intern(text.as_bytes()) {
            Ok(style) => Some(style.into_arc()),
            Err(error) => {
                log::warn!("Stylesheet declarations dropped, the merged style does not parse: {error}");
                own.cloned().map(InternedStyle::into_arc)
            }
        };
        styles.cascaded.insert(matched, own_arc, style.clone());
        style
    }

    pub(crate) fn style_text(&self, own: &InternedStyle, raw: &[u8]) -> Arc<str> {
        let key = Arc::as_ptr(own.arc()) as usize;
        if let Some((_, text)) = self.style_texts.borrow().get(&key) {
            return text.clone();
        }
        let text: Arc<str> = style_attribute_text(raw).into();
        self.style_texts.borrow_mut().insert(key, (Arc::downgrade(own.arc()), text.clone()));
        text
    }

    /// Frees what only sheets use: the indexed rules, the interned names and matched sets, and
    /// the `[style]` texts. The sources (`style_elements`, `constructed`) stay: they are the
    /// document's, and the caller decides when none is left.
    pub(crate) fn wind_down(&mut self) {
        self.enabled = false;
        self.atoms_fresh = false;
        self.loaded_units = None;
        // Its rules hold atoms of the interner replaced below.
        self.parse_cache.clear();
        self.watched = Watched::default();
        self.media_flipped = false;
        self.logged_skips.clear();
        self.logged_folds.clear();
        self.skip_log_capped = false;
        self.index = Default::default();
        self.live.clear();
        self.interner = Default::default();
        self.wind_down_pseudos();
        self.atoms = Atoms::default();
        self.style = self.atoms.intern("style");
        self.style_texts.get_mut().clear();
    }

    #[cfg(test)]
    pub(crate) fn fold_warnings(&self) -> usize {
        self.logged_folds.warnings
    }

    #[cfg(test)]
    pub(crate) fn style_text_count(&self) -> usize {
        self.style_texts.borrow().len()
    }

    /// Forget the `[style]` texts of own styles no element holds any more.
    pub(crate) fn release_unused(&mut self) {
        self.style_texts.get_mut().retain(|_, (own, _)| own.strong_count() > 1);
    }
}

/// `kebab-key: value;` per declaration, as the `style` attribute of an element that was given
/// the style would read. A key whose value is no string or number (a state block such as `hover`,
/// `"@container"`, a switch) is not one declaration and is left out, as `serializeStyle` does in JS.
fn style_attribute_text(raw: &[u8]) -> String {
    let declarations = serde_json::from_slice::<crate::css::lenient::Declarations>(raw)
        .expect("an interned style is a JSON object");
    let mut text = String::new();
    for declaration in declarations.0 {
        // Keys of a style that are not CSS properties and can hold a string or a number: `STYLE_PROPERTIES`
        // in JS leaves them out too. The other non-CSS keys (state blocks, switches) are objects or booleans.
        if matches!(declaration.key.as_str(), "gridColumnMin" | "gridRowMin" | "group") {
            continue;
        }
        // As the DOM reads `style.cssText`: no value, no declaration, and a number has its unit.
        let value = match declaration.value.as_str() {
            "null" | "\"\"" => continue,
            value if !value.starts_with('"') && !value.starts_with(|c: char| c == '-' || c.is_ascii_digit()) => continue,
            value if value.starts_with('"') => serde_json::from_str::<String>(value).expect("a JSON string value"),
            // A custom property takes its number as written, as React DOM sets it.
            value if declaration.key.starts_with("--") => value.to_owned(),
            value => number_text(&declaration.key, value).unwrap_or_else(|| value.to_owned()),
        };
        text.push_str(&kebab_case(&declaration.key));
        text.push_str(": ");
        text.push_str(&value);
        text.push_str("; ");
    }
    text.truncate(text.trim_end().len());
    text
}

fn kebab_case(key: &str) -> String {
    if key.starts_with("--") {
        return key.to_owned();
    }
    let mut kebab = String::with_capacity(key.len() + 4);
    // React writes `-ms-` as `ms`, with no capital.
    if key.starts_with("ms") && key[2..].starts_with(|c: char| c.is_ascii_uppercase()) {
        kebab.push('-');
    }
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            kebab.push('-');
            kebab.push(c.to_ascii_lowercase());
        } else {
            kebab.push(c);
        }
    }
    kebab
}

#[cfg(test)]
mod tests {
    use super::style_attribute_text;

    #[test]
    fn a_number_rotate_is_written_in_degrees_and_a_number_length_in_px() {
        let text = style_attribute_text(br#"{"width":10,"rotate":45,"skewX":-3.5,"opacity":0.5,"top":0}"#);
        assert_eq!(text, "width: 10px; rotate: 45deg; skew-x: -3.5deg; opacity: 0.5; top: 0;");
    }

    #[test]
    fn a_state_block_a_query_a_switch_and_a_group_name_are_not_declarations() {
        let text = style_attribute_text(
            br#"{"width":10,"hover":{"opacity":0.5},"@container":{"(min-width: 10px)":{"top":1}},"keyboardFocusDim":true,"gridColumnMin":"zero","gridRowMin":2,"group":"card","color":"red"}"#,
        );
        assert_eq!(text, "width: 10px; color: red;");
    }
}
