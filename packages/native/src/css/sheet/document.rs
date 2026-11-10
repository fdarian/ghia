//! The style state of one document: its sheets, the index over their rules, and what has to be
//! matched again.
//!
//! Every hook the tree calls is guarded by [`StyleSheets::enabled`], which is false until a
//! `<style>` element or a constructed sheet exists, so a document without sheets pays a branch.
//! Marks collect while a batch applies and the tree flushes them once at its end (see
//! `css::sheet::tree`).

use std::cell::RefCell;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::retained_tree::StyleTable;
use crate::style::StyleDesc;

use super::atoms::{Atom, Atoms};
use super::cascade::{merge, MatchedInterner, MatchedRules};
use super::index::RuleIndex;
use super::layers::Layers;
use super::parser::parse_sheet;

/// What an element has for the matcher, kept on the element while sheets exist.
#[derive(Default)]
pub struct ElementCss {
    pub tag: Option<Atom>,
    pub id: Option<Atom>,
    pub classes: Vec<Atom>,
    /// `None` for an element no rule matches, and for one that is not in the document.
    pub matched: Option<Arc<MatchedRules>>,
}

impl ElementCss {
    pub fn is_empty(&self) -> bool {
        self.tag.is_none() && self.id.is_none() && self.classes.is_empty() && self.matched.is_none()
    }
}

/// What to match again for an element.
#[derive(Clone, Copy, Default)]
pub struct Mark {
    /// Everything below the element.
    pub subtree: bool,
    /// The siblings after it, with everything below them.
    pub following: bool,
}

pub struct StyleSheets {
    /// A hook does nothing while this is false.
    pub(crate) enabled: bool,
    /// Whether every element's `ElementCss` atoms are current. False until the first flush after
    /// the sheets appear, which computes them for the elements that existed before.
    pub(crate) atoms_fresh: bool,
    pub(crate) sources_dirty: bool,
    pub(crate) mark_all: bool,
    pub(crate) pending: Vec<(u64, Mark)>,
    pub(crate) atoms: Atoms,
    pub(crate) style: Atom,
    /// Every `<style>` element, connected or not.
    pub(crate) style_elements: FxHashSet<u64>,
    pub(crate) constructed: FxHashMap<u64, String>,
    pub(crate) adopted: Vec<u64>,
    /// The texts the index was built from, in cascade order.
    pub(crate) loaded: Vec<String>,
    pub(crate) index: RuleIndex,
    pub(crate) interner: MatchedInterner,
    /// The text `[style]` selectors read, per own style, kept while the style is.
    style_texts: RefCell<FxHashMap<usize, (Arc<StyleDesc>, Arc<str>)>>,
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
            atoms,
            style,
            style_elements: FxHashSet::default(),
            constructed: FxHashMap::default(),
            adopted: Vec::new(),
            loaded: Vec::new(),
            index: RuleIndex::default(),
            interner: MatchedInterner::default(),
            style_texts: RefCell::default(),
        }
    }
}

impl StyleSheets {
    pub(crate) fn has_work(&self) -> bool {
        self.enabled && (self.sources_dirty || self.mark_all || !self.atoms_fresh || !self.pending.is_empty())
    }

    pub(crate) fn mark(&mut self, id: u64, subtree: bool, following: bool) {
        self.pending.push((id, Mark { subtree, following }));
    }

    /// Whether a change of the attribute `name` can change what a selector matches.
    pub(crate) fn reads_attribute(&self, name: &str) -> bool {
        let features = &self.index.features;
        match name {
            "class" if features.classes => true,
            "id" if features.ids => true,
            _ => self.atoms.get(name).is_some_and(|atom| features.attributes.contains(&atom)),
        }
    }

    /// Whether the selectors read the style attribute.
    pub(crate) fn reads_style(&self) -> bool {
        self.index.features.attributes.contains(&self.style)
    }

    /// The sheets the document has now, one text each: the connected `<style>` elements' (given in
    /// tree order by the caller), then the adopted constructed sheets.
    pub(crate) fn texts_with(&self, style_elements: Vec<String>) -> Vec<String> {
        let mut texts = style_elements;
        texts.extend(self.adopted.iter().filter_map(|sheet| self.constructed.get(sheet).cloned()));
        texts
    }

    /// Parses `texts` as the document's sheets and indexes their rules. Layers are declared in
    /// parse order across the whole document, so every sheet is parsed again when any changes.
    pub(crate) fn load(&mut self, texts: Vec<String>) {
        let mut layers = Layers::default();
        let mut sheets = Vec::with_capacity(texts.len());
        for text in &texts {
            let sheet = parse_sheet(text, &mut self.atoms, &mut layers);
            for skipped in &sheet.unsupported {
                log::warn!("Stylesheet: not supported, skipped: {skipped}");
            }
            sheets.push(sheet);
        }
        self.index = RuleIndex::build(sheets, &layers.order());
        self.interner = MatchedInterner::default();
        self.loaded = texts;
    }

    /// The style of an element that matched `matched` and declared `own`. Run once per pair: the
    /// result is kept in `styles.cascaded`. A merge that does not parse leaves the element its own
    /// style alone, as CSS ignores a declaration it cannot read.
    pub(crate) fn cascaded(
        &self,
        styles: &mut StyleTable,
        matched: &Arc<MatchedRules>,
        own: Option<&Arc<StyleDesc>>,
    ) -> Option<Arc<StyleDesc>> {
        if let Some(hit) = styles.cascaded.get(matched, own) {
            return hit;
        }
        crate::perf_counters::cascade_computed();
        let declarations = match own {
            Some(own) => {
                let raw = styles.raw_of(own).expect("an own style comes from StyleTable::intern");
                serde_json::from_slice::<crate::css::lenient::Declarations>(&raw)
                    .expect("an interned style is a JSON object")
                    .0
            }
            None => Vec::new(),
        };
        let text = merge(&self.index, matched, &declarations);
        let style = match styles.intern(text.as_bytes()) {
            Ok(style) => Some(style),
            Err(error) => {
                log::warn!("Stylesheet declarations dropped, the merged style does not parse: {error}");
                own.cloned()
            }
        };
        styles.cascaded.insert(matched, own, style.clone());
        style
    }

    pub(crate) fn style_text(&self, own: &Arc<StyleDesc>, raw: &[u8]) -> Arc<str> {
        let key = Arc::as_ptr(own) as usize;
        if let Some((_, text)) = self.style_texts.borrow().get(&key) {
            return text.clone();
        }
        let text: Arc<str> = style_attribute_text(raw).into();
        self.style_texts.borrow_mut().insert(key, (own.clone(), text.clone()));
        text
    }

    /// Forget the `[style]` texts of own styles no element holds any more.
    pub(crate) fn release_unused(&mut self) {
        self.style_texts.get_mut().retain(|_, (own, _)| Arc::strong_count(own) > 2);
    }
}

/// `kebab-key: value;` per declaration, as the `style` attribute of an element that was given
/// the style would read.
fn style_attribute_text(raw: &[u8]) -> String {
    let declarations = serde_json::from_slice::<crate::css::lenient::Declarations>(raw)
        .expect("an interned style is a JSON object");
    let mut text = String::new();
    for declaration in declarations.0 {
        let value = if declaration.value.starts_with('"') {
            serde_json::from_str::<String>(&declaration.value).expect("a JSON string value")
        } else {
            declaration.value
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
