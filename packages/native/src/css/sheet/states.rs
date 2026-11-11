//! Pointer and focus states in a stylesheet.
//!
//! `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` are not tree state: the
//! pointer and the focus live in the view, and an element already has a way to style them, the
//! `hover`, `active`, `focus`, `focusVisible` and `focusWithin` blocks of its style. A rule under
//! one of these compiles into that block instead of being matched against the live state, so a
//! match does not depend on where the pointer is, style sharing stays valid, and the fold, the
//! paint-only path and retention treat the block as they treat an inline one.
//!
//! The matcher reads such a pseudo-class in the subject compound as true, and the selector
//! carries it as its [`ComplexSelector::condition`]: the rule matches the element under that
//! condition. The cascade then decides, per property, what is the base value and what is the
//! block's: from the highest precedence down, the values under a condition count until the first
//! one with none, which is the base value, and lower ones are shadowed by it.

use rustc_hash::FxHashSet;

use crate::css::covers;
use crate::css::lenient::{Declaration, Declarations};

use super::cascade::{apply, MatchedRules};
use super::declarations::render_declarations;
use super::index::RuleIndex;
use super::selector::{Compound, Simple, Specificity};

/// A state of the pointer or the focus that a rule can be under. Declared in the order the
/// states fold over an element (`resolve_pointer_states`, then `FocusStyles::applying`): a later
/// one wins a property both set.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub enum State {
    Hover,
    Active,
    Focus,
    FocusWithin,
    FocusVisible,
}

impl State {
    /// The key of the style block that holds what applies in this state.
    pub fn block_key(self) -> &'static str {
        match self {
            State::Hover => "hover",
            State::Active => "active",
            State::Focus => "focus",
            State::FocusWithin => "focusWithin",
            State::FocusVisible => "focusVisible",
        }
    }

    fn of_block_key(key: &str) -> Option<State> {
        [State::Hover, State::Active, State::Focus, State::FocusWithin, State::FocusVisible]
            .into_iter()
            .find(|state| state.block_key() == key)
    }

    fn name(self) -> &'static str {
        match self {
            State::Hover => ":hover",
            State::Active => ":active",
            State::Focus => ":focus",
            State::FocusWithin => ":focus-within",
            State::FocusVisible => ":focus-visible",
        }
    }
}

/// What a selector can be under a state in this engine, and was not.
#[derive(Debug, PartialEq)]
pub(super) struct Unsupported;

/// The state the subject of a selector needs, or `Unsupported` when the selector reads one the
/// engine cannot compile into a style block: a state in a compound that is not the subject
/// (`.card:hover .title`), two different states in one compound (`:hover:focus`), a state inside
/// `:not()`, and a `:is()` or `:where()` whose arguments are not all under the same one.
pub(super) fn condition_of(compounds: &[Compound]) -> Result<Option<State>, Unsupported> {
    let mut condition = None;
    for (position, compound) in compounds.iter().enumerate() {
        for simple in &compound.simples {
            let found = match simple {
                Simple::State(state) => Some(*state),
                Simple::Is(list) => shared_condition(list.iter().map(|selector| selector.condition))?,
                Simple::Where(list) => shared_condition(list.iter().map(|selector| selector.condition))?,
                Simple::Not(list) => {
                    if list.iter().any(|selector| selector.condition.is_some()) {
                        return Err(Unsupported);
                    }
                    None
                }
                _ => None,
            };
            let Some(found) = found else {
                continue;
            };
            if position != 0 || condition.is_some_and(|known| known != found) {
                return Err(Unsupported);
            }
            condition = Some(found);
        }
    }
    Ok(condition)
}

/// The condition every argument of a functional pseudo-class has, `None` when none has one.
fn shared_condition(mut conditions: impl Iterator<Item = Option<State>>) -> Result<Option<State>, Unsupported> {
    let Some(first) = conditions.next() else {
        return Ok(None);
    };
    if conditions.all(|next| next == first) {
        Ok(first)
    } else {
        Err(Unsupported)
    }
}

/// A rule that matched an element, with the specificity of the most specific selector of it that
/// matched under this condition. One rule can match under several (`.a, .b:hover`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct RuleMatch {
    pub rule: u32,
    pub specificity: Specificity,
    pub condition: Option<State>,
}

/// A rule of [`MatchedRules`], and the state its declarations apply under.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Applies {
    pub rule: u32,
    pub condition: Option<State>,
}

/// A declaration under a state, and where it stands in the cascade: a higher position wins.
struct Conditional {
    state: State,
    declaration: Declaration,
    position: u32,
}

/// What the cascade has gathered so far, in ascending precedence.
#[derive(Default)]
struct Gathered {
    base: Vec<Declaration>,
    /// The unconditional declarations with their positions: each shadows the lower conditional
    /// declarations of the property it sets.
    unconditional: Vec<(String, u32)>,
    conditional: Vec<Conditional>,
}

impl Gathered {
    fn push(&mut self, condition: Option<State>, declaration: &Declaration, position: u32) {
        match condition {
            None => {
                apply(&mut self.base, declaration);
                self.unconditional.push((declaration.key.clone(), position));
            }
            Some(state) => self.conditional.push(Conditional { state, declaration: declaration.clone(), position }),
        }
    }

    fn shadowed(&self, conditional: &Conditional) -> bool {
        let key = covers::key_id(&conditional.declaration.key);
        self.unconditional.iter().any(|(shadow, position)| {
            *position > conditional.position
                && (*shadow == conditional.declaration.key
                    || covers::key_id(shadow)
                        .zip(key)
                        .is_some_and(|(shorthand, covered)| covers::covered_by(shorthand).contains(&covered)))
        })
    }
}

/// [`super::cascade::merge`] for an element that matched a rule under a state: the style's own
/// block of a state a rule is under is one more layer of that cascade, at the position of the
/// inline style, and what survives of each state is written as the block of that state.
pub(super) fn merge(index: &RuleIndex, matched: &MatchedRules, own: &[Declaration], own_important: &[Declaration]) -> String {
    let touched: FxHashSet<State> = matched.normal.iter().filter_map(|applies| applies.condition).collect();
    let mut gathered = Gathered::default();
    let mut position = 0;
    for applies in &matched.normal {
        for declaration in &index.rules[applies.rule as usize].normal {
            gathered.push(applies.condition, declaration, position);
        }
        position += 1;
    }
    for declaration in own {
        match State::of_block_key(&declaration.key).filter(|state| touched.contains(state)) {
            Some(state) => {
                // `null` is no block, as it is with no sheet.
                if let Ok(block) = serde_json::from_str::<Declarations>(&declaration.value) {
                    for inner in &block.0 {
                        gathered.push(Some(state), inner, position);
                    }
                }
            }
            None => gathered.push(None, declaration, position),
        }
    }
    position += 1;
    for applies in &matched.important {
        for declaration in &index.rules[applies.rule as usize].important {
            gathered.push(applies.condition, declaration, position);
        }
        position += 1;
    }
    for declaration in own_important {
        gathered.push(None, declaration, position);
    }

    let mut blocks: Vec<Block> = Vec::new();
    for conditional in &gathered.conditional {
        if gathered.shadowed(conditional) {
            continue;
        }
        let slot = match blocks.iter().position(|block| block.state == conditional.state) {
            Some(slot) => slot,
            None => {
                blocks.push(Block { state: conditional.state, declarations: Vec::new(), positions: Vec::new() });
                blocks.len() - 1
            }
        };
        let block = &mut blocks[slot];
        apply(&mut block.declarations, &conditional.declaration);
        block.positions.retain(|(key, _)| *key != conditional.declaration.key);
        block.positions.push((conditional.declaration.key.clone(), conditional.position));
    }
    blocks.sort_by_key(|block| block.state);
    warn_when_fold_disagrees(&blocks);
    let mut list = gathered.base;
    for block in &blocks {
        if !block.declarations.is_empty() {
            list.push(Declaration { key: block.state.block_key().to_owned(), value: render_declarations(&block.declarations) });
        }
    }
    render_declarations(&list)
}

/// What survives of the declarations under one state, and the position each property won at.
struct Block {
    state: State,
    declarations: Vec<Declaration>,
    positions: Vec<(String, u32)>,
}

/// The blocks fold in a fixed order, so a property two of them set goes to the later state when
/// both apply. The cascade would give it to the one with the higher precedence, which can be the
/// earlier state.
fn warn_when_fold_disagrees(blocks: &[Block]) {
    for (earlier, block) in blocks.iter().enumerate() {
        for (key, position) in &block.positions {
            for later in &blocks[earlier + 1..] {
                if later.positions.iter().any(|(later_key, later_position)| later_key == key && later_position < position) {
                    log::warn!(
                        "Stylesheet: `{key}` is set under {} and {}, and while both apply {} wins, not the rule with the higher precedence",
                        block.state.name(),
                        later.state.name(),
                        later.state.name()
                    );
                }
            }
        }
    }
}
