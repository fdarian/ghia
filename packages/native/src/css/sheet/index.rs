//! The rules of every sheet of a document, bucketed so an element is tried against few of them.
//!
//! Each selector of a rule goes in one bucket, keyed by the most selective thing its subject
//! compound requires: an id, else a class, else an attribute name, else a tag, else none (the
//! universal list). An element's candidates are the buckets of its id, its classes, its tag and
//! every attribute name a selector reads, plus the universal list. Matching then runs the whole
//! selector on each candidate.

use rustc_hash::FxHashMap;

use crate::css::lenient::Declaration;

use super::atoms::Atom;
use super::invalidation::Invalidation;
use super::layers::LayerOrder;
use super::matching::{matches, ElementView};
use super::selector::{ComplexSelector, Simple, Specificity};
use super::StyleSheet;

pub struct IndexedRule {
    pub selectors: Vec<(ComplexSelector, Specificity)>,
    pub normal: Vec<Declaration>,
    pub important: Vec<Declaration>,
    /// Where the rule's layer ranks for normal declarations: higher wins.
    layer_rank: u32,
}

#[derive(Clone, Copy)]
struct Entry {
    rule: u32,
    selector: u32,
}

#[derive(Default)]
pub struct RuleIndex {
    pub rules: Vec<IndexedRule>,
    by_id: FxHashMap<Atom, Vec<Entry>>,
    by_class: FxHashMap<Atom, Vec<Entry>>,
    by_attribute: FxHashMap<Atom, Vec<Entry>>,
    by_tag: FxHashMap<Atom, Vec<Entry>>,
    universal: Vec<Entry>,
    unlayered_rank: u32,
    pub invalidation: Invalidation,
}

impl RuleIndex {
    /// Rules are numbered in cascade source order: sheet by sheet, each in its own order.
    pub fn build(sheets: Vec<StyleSheet>, layers: &LayerOrder) -> RuleIndex {
        let mut index = RuleIndex { unlayered_rank: layers.unlayered(), ..RuleIndex::default() };
        for mut sheet in sheets {
            sheet.rules.sort_by_key(|rule| rule.order);
            for rule in sheet.rules {
                let selectors: Vec<_> =
                    rule.selectors.into_iter().filter(|(selector, _)| !selector.has_pseudo_element()).collect();
                if selectors.is_empty() {
                    continue;
                }
                let number = u32::try_from(index.rules.len()).expect("fewer than 2^32 rules");
                for (position, (selector, _)) in selectors.iter().enumerate() {
                    index.invalidation.read(selector);
                    let entry = Entry { rule: number, selector: position as u32 };
                    index.bucket(selector, entry);
                }
                index.rules.push(IndexedRule {
                    selectors,
                    normal: rule.normal,
                    important: rule.important,
                    layer_rank: layers.rank(rule.layer),
                });
            }
        }
        index
    }

    fn bucket(&mut self, selector: &ComplexSelector, entry: Entry) {
        let subject = &selector.compounds[0].simples;
        if let Some(id) = subject.iter().find_map(|simple| if let Simple::Id(id) = simple { Some(*id) } else { None }) {
            self.by_id.entry(id).or_default().push(entry);
        } else if let Some(class) =
            subject.iter().find_map(|simple| if let Simple::Class(class) = simple { Some(*class) } else { None })
        {
            self.by_class.entry(class).or_default().push(entry);
        } else if let Some(attribute) =
            subject.iter().find_map(|simple| if let Simple::Attr(attr) = simple { Some(attr.name) } else { None })
        {
            self.by_attribute.entry(attribute).or_default().push(entry);
        } else if let Some(tag) =
            subject.iter().find_map(|simple| if let Simple::Tag(tag) = simple { Some(*tag) } else { None })
        {
            self.by_tag.entry(tag).or_default().push(entry);
        } else {
            self.universal.push(entry);
        }
    }

    /// The rules that match `element` with the specificity of the most specific selector of each
    /// that does, in cascade order for normal declarations: layer, then specificity, then source.
    pub fn matching<E: ElementView>(
        &self,
        element: &E,
        id: Option<Atom>,
        classes: &[Atom],
    ) -> Vec<(u32, Specificity)> {
        let mut found: Vec<(u32, Specificity)> = Vec::new();
        let mut visit = |bucket: &[Entry]| {
            for entry in bucket {
                let (selector, specificity) = &self.rules[entry.rule as usize].selectors[entry.selector as usize];
                if !matches(selector, element) {
                    continue;
                }
                match found.iter_mut().find(|(rule, _)| *rule == entry.rule) {
                    Some(existing) => existing.1 = existing.1.max(*specificity),
                    None => found.push((entry.rule, *specificity)),
                }
            }
        };
        if let Some(bucket) = id.and_then(|id| self.by_id.get(&id)) {
            visit(bucket);
        }
        for class in classes {
            if let Some(bucket) = self.by_class.get(class) {
                visit(bucket);
            }
        }
        for (attribute, bucket) in &self.by_attribute {
            if element.attr(*attribute).is_some() {
                visit(bucket);
            }
        }
        if !self.by_tag.is_empty() {
            if let Some(bucket) = element.tag().and_then(|tag| self.by_tag.get(&tag)) {
                visit(bucket);
            }
        }
        visit(&self.universal);
        found.sort_by_key(|(rule, specificity)| (self.rules[*rule as usize].layer_rank, *specificity, *rule));
        found
    }

    /// The rules among `rules` that have `!important` declarations, in the order those apply:
    /// layers compare the other way round, so the first layer wins and unlayered styles lose.
    pub fn important_order(&self, rules: &[(u32, Specificity)]) -> Vec<u32> {
        let mut important: Vec<(u32, Specificity)> = rules
            .iter()
            .copied()
            .filter(|(rule, _)| !self.rules[*rule as usize].important.is_empty())
            .collect();
        important.sort_by_key(|(rule, specificity)| {
            (self.unlayered_rank - self.rules[*rule as usize].layer_rank, *specificity, *rule)
        });
        important.into_iter().map(|(rule, _)| rule).collect()
    }
}
