//! The rules of every sheet of a document, bucketed so an element is tried against few of them.
//!
//! Each selector of a rule goes in one bucket, keyed by the most selective thing its subject
//! compound requires: an id, else a class, else an attribute name, else a tag, else none (the
//! universal list). An element's candidates are the buckets of its id, its classes, its tag and
//! every attribute name a selector reads, plus the universal list. Matching then runs the whole
//! selector on each candidate.

use std::ops::Deref;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use crate::css::lenient::Declaration;

use super::atoms::Atom;
use super::invalidation::Invalidation;
use super::layers::{LayerId, LayerOrder};
use super::matching::{matches, ElementView};
use super::selector::{AttrName, ComplexSelector, Simple, Specificity};
use super::states::{Applies, RuleMatch};

/// What a rule says, which does not depend on where it stands in a document: shared by the parse
/// cache and every index built from it.
pub struct RuleBody {
    /// Without the selectors that name a pseudo-element, and never empty.
    pub selectors: Vec<(ComplexSelector, Specificity)>,
    pub normal: Vec<Declaration>,
    pub important: Vec<Declaration>,
}

/// A rule in the order of a document's cascade, with the layer it was written in.
#[derive(Clone)]
pub struct DocRule {
    pub body: Arc<RuleBody>,
    pub layer: Option<LayerId>,
}

pub struct IndexedRule {
    body: Arc<RuleBody>,
    /// Where the rule's layer ranks for normal declarations: higher wins.
    layer_rank: u32,
}

impl IndexedRule {
    pub(super) fn layer_rank(&self) -> u32 {
        self.layer_rank
    }
}

impl Deref for IndexedRule {
    type Target = RuleBody;

    fn deref(&self) -> &RuleBody {
        &self.body
    }
}

#[derive(Clone, Copy)]
struct Entry {
    rule: u32,
    selector: u32,
    /// Whether the selector reads nothing of an element but its type, id, classes and attributes
    /// (not `style`): one compound, no `:root`, and the same of every argument of `:is()`,
    /// `:where()` and `:not()`. What it matches is then the same for elements that look alike
    /// (`share.rs`).
    self_contained: bool,
}

#[derive(Default)]
pub struct RuleIndex {
    pub rules: Vec<IndexedRule>,
    by_id: FxHashMap<Atom, Vec<Entry>>,
    by_class: FxHashMap<Atom, Vec<Entry>>,
    by_attribute: FxHashMap<AttrName, Vec<Entry>>,
    by_tag: FxHashMap<Atom, Vec<Entry>>,
    universal: Vec<Entry>,
    unlayered_rank: u32,
    pub invalidation: Invalidation,
    /// Whether any selector is self-contained: otherwise nothing is shared and the memo is skipped.
    shares: bool,
    /// The attribute names any selector mentions, as an HTML element and as an SVG element
    /// reads them. Which buckets an element is a candidate in depends on whether it has them,
    /// and what a self-contained selector matches on their values.
    html_attributes: Vec<Atom>,
    svg_attributes: Vec<Atom>,
}

impl RuleIndex {
    /// Rules are numbered in cascade source order.
    pub fn build(rules: &[DocRule], layers: &LayerOrder, style: Atom) -> RuleIndex {
        let mut index = RuleIndex { unlayered_rank: layers.unlayered(), ..RuleIndex::default() };
        index.rules.reserve(rules.len());
        let mut self_contained_lists: FxHashMap<usize, bool> = FxHashMap::default();
        let mut attributes = Attributes::default();
        for rule in rules {
            let number = u32::try_from(index.rules.len()).expect("fewer than 2^32 rules");
            for (position, (selector, _)) in rule.body.selectors.iter().enumerate() {
                index.invalidation.read(selector);
                attributes.read(selector);
                let self_contained = is_self_contained(selector, style, &mut self_contained_lists);
                index.shares |= self_contained;
                let entry = Entry { rule: number, selector: position as u32, self_contained };
                index.bucket(selector, entry);
            }
            index.rules.push(IndexedRule { body: rule.body.clone(), layer_rank: layers.rank(rule.layer) });
        }
        index.html_attributes = attributes.html.into_iter().collect();
        index.svg_attributes = attributes.svg.into_iter().collect();
        index.html_attributes.sort();
        index.svg_attributes.sort();
        index
    }

    pub(super) fn unlayered_rank(&self) -> u32 {
        self.unlayered_rank
    }

    pub(super) fn shares(&self) -> bool {
        self.shares
    }

    /// The attribute names `shared_key` has to hold the values of for an element of this kind.
    pub(super) fn shared_attributes(&self, is_svg: bool) -> &[Atom] {
        if is_svg {
            &self.svg_attributes
        } else {
            &self.html_attributes
        }
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
            // An HTML element looks its tag up lower-cased and an SVG one as given.
            self.by_tag.entry(tag.lower).or_default().push(entry);
            if tag.written != tag.lower {
                self.by_tag.entry(tag.written).or_default().push(entry);
            }
        } else {
            self.universal.push(entry);
        }
    }

    /// Whether any rule can match an element with this id and these classes: not when every rule
    /// is keyed by an id or a class and the element has neither.
    pub fn may_match(&self, id: Option<Atom>, classes: &[Atom]) -> bool {
        id.is_some()
            || !classes.is_empty()
            || !self.by_attribute.is_empty()
            || !self.by_tag.is_empty()
            || !self.universal.is_empty()
    }

    /// The rules that match `element` with the specificity of the most specific selector of each
    /// that does, in cascade order for normal declarations: layer, then specificity, then source.
    pub fn matching<E: ElementView>(
        &self,
        element: &E,
        id: Option<Atom>,
        classes: &[Atom],
    ) -> Vec<RuleMatch> {
        self.matching_in_full(element, id, classes).0
    }

    /// [`Self::matching`], and whether every selector it tried is self-contained, which makes the
    /// answer the same for any element that has the same type, id, classes and attributes.
    pub(super) fn matching_in_full<E: ElementView>(
        &self,
        element: &E,
        id: Option<Atom>,
        classes: &[Atom],
    ) -> (Vec<RuleMatch>, bool) {
        super::share::count_full_match();
        let mut found: Vec<RuleMatch> = Vec::new();
        let mut self_contained = true;
        let mut visit = |bucket: &[Entry]| {
            for entry in bucket {
                self_contained &= entry.self_contained;
                let (selector, specificity) = &self.rules[entry.rule as usize].selectors[entry.selector as usize];
                if !matches(selector, element) {
                    continue;
                }
                let condition = selector.condition;
                match found.iter_mut().find(|known| known.rule == entry.rule && known.condition == condition) {
                    Some(existing) => existing.specificity = existing.specificity.max(*specificity),
                    None => found.push(RuleMatch { rule: entry.rule, specificity: *specificity, condition }),
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
        found.sort_by_key(|found| {
            (self.rules[found.rule as usize].layer_rank, found.specificity, found.rule, found.condition)
        });
        (found, self_contained)
    }

    /// The rules among `rules` that have `!important` declarations, in the order those apply:
    /// layers compare the other way round, so the first layer wins and unlayered styles lose.
    pub fn important_order(&self, rules: &[RuleMatch]) -> Vec<Applies> {
        let mut important: Vec<RuleMatch> = rules
            .iter()
            .copied()
            .filter(|found| !self.rules[found.rule as usize].important.is_empty())
            .collect();
        important.sort_by_key(|found| {
            (self.unlayered_rank - self.rules[found.rule as usize].layer_rank, found.specificity, found.rule, found.condition)
        });
        important.into_iter().map(|found| Applies { rule: found.rule, condition: found.condition }).collect()
    }
}

/// Whether `selector` reads nothing of an element but its type, id, classes and attributes other
/// than `style`. `lists` remembers the answer for each `:is()` list a nested rule shares, so a
/// `&` nested deep is asked once and not once per level.
fn is_self_contained(selector: &ComplexSelector, style: Atom, lists: &mut FxHashMap<usize, bool>) -> bool {
    selector.compounds.len() == 1
        && selector.compounds[0].simples.iter().all(|simple| match simple {
            Simple::Tag(_) | Simple::Class(_) | Simple::Id(_) | Simple::Host | Simple::PseudoElement | Simple::State(_) => true,
            Simple::Attr(attr) => attr.name.lower != style && attr.name.written != style,
            Simple::Root | Simple::PopoverOpen => false,
            Simple::Is(list) => {
                let key = list.as_ptr() as usize;
                if let Some(known) = lists.get(&key) {
                    return *known;
                }
                let answer = list.iter().all(|inner| is_self_contained(inner, style, lists));
                lists.insert(key, answer);
                answer
            }
            Simple::Where(list) | Simple::Not(list) => list.iter().all(|inner| is_self_contained(inner, style, lists)),
        })
}

/// The attribute names read anywhere in the selectors, in any compound and any argument.
#[derive(Default)]
struct Attributes {
    html: FxHashSet<Atom>,
    svg: FxHashSet<Atom>,
    lists: FxHashSet<usize>,
}

impl Attributes {
    fn read(&mut self, selector: &ComplexSelector) {
        for compound in &selector.compounds {
            for simple in &compound.simples {
                match simple {
                    Simple::Attr(attr) => {
                        self.html.insert(attr.name.lower);
                        self.svg.insert(attr.name.written);
                    }
                    Simple::Is(list) => {
                        if self.lists.insert(list.as_ptr() as usize) {
                            for inner in list.iter() {
                                self.read(inner);
                            }
                        }
                    }
                    Simple::Where(list) | Simple::Not(list) => {
                        for inner in list {
                            self.read(inner);
                        }
                    }
                    Simple::Tag(_)
                    | Simple::Class(_)
                    | Simple::Id(_)
                    | Simple::Root
                    | Simple::Host
                    | Simple::PseudoElement
                    | Simple::State(_)
                    | Simple::PopoverOpen => {}
                }
            }
        }
    }
}
