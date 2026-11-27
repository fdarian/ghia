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
use super::conditions::Conditions;
use super::invalidation::Invalidation;
use super::layers::{LayerId, LayerOrder};
use super::matching::{matches, ElementView};
use super::pseudo::Pseudo;
use super::selector::{AttrName, ComplexSelector, Simple, Specificity};
use super::states::{Applies, RuleMatch};

/// What a rule says, which does not depend on where it stands in a document: shared by the parse
/// cache and every index built from it.
pub struct RuleBody {
    /// Without the selectors that name a pseudo-element other than `::before` and `::after`, and
    /// never empty.
    pub selectors: Vec<(ComplexSelector, Specificity)>,
    pub normal: Vec<Declaration>,
    pub important: Vec<Declaration>,
}

/// A rule in the order of a document's cascade, with the layer it was written in.
#[derive(Clone)]
pub struct DocRule {
    pub body: Arc<RuleBody>,
    pub layer: Option<LayerId>,
    /// The media queries the rule stands under. A rule whose conditions do not hold is left out
    /// before the index is built, so [`RuleIndex::build`] takes the rules that apply.
    pub conditions: Option<Arc<Conditions>>,
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

/// The rules of one target (an element, or one of its generated boxes) by the feature of the
/// subject compound each is filed under.
#[derive(Default)]
struct Buckets {
    by_id: FxHashMap<Atom, Vec<Entry>>,
    by_class: FxHashMap<Atom, Vec<Entry>>,
    by_attribute: FxHashMap<AttrName, Vec<Entry>>,
    by_tag: FxHashMap<Atom, Vec<Entry>>,
    universal: Vec<Entry>,
}

impl Buckets {
    fn add(&mut self, selector: &ComplexSelector, entry: Entry) {
        match bucket_simple(&selector.compounds[0].simples) {
            Some(Simple::Id(id)) => self.by_id.entry(*id).or_default().push(entry),
            Some(Simple::Class(class)) => self.by_class.entry(*class).or_default().push(entry),
            Some(Simple::Attr(attr)) => self.by_attribute.entry(attr.name).or_default().push(entry),
            Some(Simple::Tag(tag)) => {
                // An HTML element looks its tag up lower-cased and an SVG one as given.
                self.by_tag.entry(tag.lower).or_default().push(entry);
                if tag.written != tag.lower {
                    self.by_tag.entry(tag.written).or_default().push(entry);
                }
            }
            _ => self.universal.push(entry),
        }
    }

    fn is_empty(&self) -> bool {
        self.by_id.is_empty()
            && self.by_class.is_empty()
            && self.by_attribute.is_empty()
            && self.by_tag.is_empty()
            && self.universal.is_empty()
    }

    fn may_match(&self, id: Option<Atom>, classes: &[Atom]) -> bool {
        id.is_some()
            || !classes.is_empty()
            || !self.by_attribute.is_empty()
            || !self.by_tag.is_empty()
            || !self.universal.is_empty()
    }
}

/// What a match of the rules is for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Element,
    /// Every rule that styles the generated box, `content` or not.
    Box(Pseudo),
    /// The rules for the generated box that declare `content`: the ones that decide it has any.
    /// An element none of them matches has no box to build, so the rest are not matched for it
    /// (a universal `*, ::before, ::after { ... }` without `content` costs the elements nothing).
    Content(Pseudo),
}

impl Target {
    /// What tells a match for one target from a match for another in the sharing memo.
    pub(super) fn key(self) -> u8 {
        match self {
            Target::Element => 0,
            Target::Box(pseudo) => 1 + pseudo.index() as u8,
            Target::Content(pseudo) => 3 + pseudo.index() as u8,
        }
    }
}

#[derive(Default)]
pub struct RuleIndex {
    pub rules: Vec<IndexedRule>,
    /// The selectors of the rules that style an element.
    elements: Buckets,
    /// The selectors that end in `::before` and in `::after`, filed by their originating element.
    pseudos: [Buckets; 2],
    /// The selectors of `pseudos` whose rule declares `content`, in the same order.
    content_pseudos: [Buckets; 2],
    /// Whether a box has a rule that declares no `content`, which the match of the box adds to the
    /// ones that do.
    extra_pseudos: [bool; 2],
    unlayered_rank: u32,
    pub invalidation: Invalidation,
    /// Whether any selector is self-contained: otherwise nothing is shared and the memo is skipped.
    shares: bool,
    /// The attribute names any selector mentions, as an HTML element and as an SVG element
    /// reads them. Which buckets an element is a candidate in depends on whether it has them,
    /// and what a self-contained selector matches on their values.
    html_attributes: Vec<Atom>,
    svg_attributes: Vec<Atom>,
    /// The attribute names a `content: attr()` of a rule for a generated box reads, lower-cased:
    /// the box shows the attribute of its element, so a change of one is a change of the box.
    pub content_attributes: FxHashSet<String>,
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
            let declares_content = rule.body.normal.iter().chain(&rule.body.important).any(|declaration| declaration.key == "content");
            for (position, (selector, _)) in rule.body.selectors.iter().enumerate() {
                index.invalidation.read(selector);
                attributes.read(selector);
                let self_contained = is_self_contained(selector, style, &mut self_contained_lists);
                index.shares |= self_contained;
                let entry = Entry { rule: number, selector: position as u32, self_contained };
                index.buckets_mut(selector.pseudo.map_or(Target::Element, Target::Box)).add(selector, entry);
                if let Some(pseudo) = selector.pseudo {
                    if declares_content {
                        index.content_pseudos[pseudo.index()].add(selector, entry);
                    } else {
                        index.extra_pseudos[pseudo.index()] = true;
                    }
                }
            }
            if rule.body.selectors.iter().any(|(selector, _)| selector.pseudo.is_some()) {
                super::pseudo::read_content_attributes(&rule.body, &mut index.content_attributes);
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

    fn buckets(&self, target: Target) -> &Buckets {
        match target {
            Target::Element => &self.elements,
            Target::Box(pseudo) => &self.pseudos[pseudo.index()],
            Target::Content(pseudo) => &self.content_pseudos[pseudo.index()],
        }
    }

    fn buckets_mut(&mut self, target: Target) -> &mut Buckets {
        match target {
            Target::Element => &mut self.elements,
            Target::Box(pseudo) => &mut self.pseudos[pseudo.index()],
            Target::Content(_) => unreachable!("the rules for a box that have content are filed along with the others"),
        }
    }

    /// Whether any rule styles the generated box `pseudo`.
    pub fn has_rules_for(&self, pseudo: Pseudo) -> bool {
        !self.pseudos[pseudo.index()].is_empty()
    }

    /// Whether any rule for the generated box `pseudo` declares `content`: without one no element
    /// has the box.
    pub fn has_content_rules_for(&self, pseudo: Pseudo) -> bool {
        !self.content_pseudos[pseudo.index()].is_empty()
    }

    /// Whether any rule for a generated box declares `content`.
    pub fn has_content_rules(&self) -> bool {
        Pseudo::BOTH.into_iter().any(|pseudo| self.has_content_rules_for(pseudo))
    }

    /// Whether the box `pseudo` has rules that do not declare `content`, which style a box a rule
    /// that does has made.
    pub fn has_rules_without_content_for(&self, pseudo: Pseudo) -> bool {
        self.extra_pseudos[pseudo.index()]
    }

    /// Whether any rule can match an element with this id and these classes: not when every rule
    /// is keyed by an id or a class and the element has neither. `target` is the element, or one
    /// of its generated boxes.
    pub fn may_match(&self, id: Option<Atom>, classes: &[Atom], target: Target) -> bool {
        self.buckets(target).may_match(id, classes)
    }

    /// The rules that match `element` with the specificity of the most specific selector of each
    /// that does, in cascade order for normal declarations: layer, then specificity, then source.
    ///
    /// `target` is what the rules style: the element, or one of its generated boxes, whose rules are
    /// matched against `element`, the box's originating element.
    pub fn matching<E: ElementView>(
        &self,
        element: &E,
        id: Option<Atom>,
        classes: &[Atom],
        target: Target,
    ) -> Vec<RuleMatch> {
        self.matching_in_full(element, id, classes, target).0
    }

    /// [`Self::matching`], and whether every selector it tried is self-contained, which makes the
    /// answer the same for any element that has the same type, id, classes and attributes.
    pub(super) fn matching_in_full<E: ElementView>(
        &self,
        element: &E,
        id: Option<Atom>,
        classes: &[Atom],
        target: Target,
    ) -> (Vec<RuleMatch>, bool) {
        super::share::count_full_match();
        let buckets = self.buckets(target);
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
        if let Some(bucket) = id.and_then(|id| buckets.by_id.get(&id)) {
            visit(bucket);
        }
        for class in classes {
            if let Some(bucket) = buckets.by_class.get(class) {
                visit(bucket);
            }
        }
        for (attribute, bucket) in &buckets.by_attribute {
            if element.attr(*attribute).is_some() {
                visit(bucket);
            }
        }
        if !buckets.by_tag.is_empty() {
            if let Some(bucket) = element.tag().and_then(|tag| buckets.by_tag.get(&tag)) {
                visit(bucket);
            }
        }
        visit(&buckets.universal);
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

/// The simple selector of a subject compound that a rule is filed under, by what is likely to be the
/// rarest: an id, a class, an attribute, a tag. `None` for a subject that has none of them.
pub(super) fn bucket_simple(subject: &[Simple]) -> Option<&Simple> {
    let first = |is: fn(&Simple) -> bool| subject.iter().find(|simple| is(simple));
    first(|simple| matches!(simple, Simple::Id(_)))
        .or_else(|| first(|simple| matches!(simple, Simple::Class(_))))
        .or_else(|| first(|simple| matches!(simple, Simple::Attr(_))))
        .or_else(|| first(|simple| matches!(simple, Simple::Tag(_))))
}

/// Whether `selector` reads nothing of an element but its type, id, classes and attributes other
/// than `style`. `lists` remembers the answer for each `:is()` list a nested rule shares, so a
/// `&` nested deep is asked once and not once per level.
fn is_self_contained(selector: &ComplexSelector, style: Atom, lists: &mut FxHashMap<usize, bool>) -> bool {
    selector.compounds.len() == 1
        && selector.compounds[0].simples.iter().all(|simple| match simple {
            Simple::Tag(_) | Simple::Class(_) | Simple::Id(_) | Simple::Host | Simple::PseudoElement | Simple::State(_) => true,
            Simple::Attr(attr) => attr.name.lower != style && attr.name.written != style,
            Simple::Root | Simple::TreeState(_) | Simple::Position(_) | Simple::Has(_) => false,
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
                    | Simple::TreeState(_)
                    | Simple::Position(_)
                    | Simple::Has(_) => {}
                }
            }
        }
    }
}
