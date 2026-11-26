//! The pointer and focus states a selector reads outside its subject: `.card:hover .title`,
//! `.group:hover > .x`, `.peer:focus ~ .y`, `.menu:focus-within .item`, `li:hover + li`.
//!
//! A state in the subject compiles into a style block (`states.rs`) and costs the sheets nothing
//! while the pointer moves. A state in any other compound decides which rules match another
//! element, so it is a live match: the tree keeps the elements each state holds ([`LiveStates`]),
//! the matcher reads them (`ElementView::live_state`), and a change marks the elements the
//! selectors that read the state reach ([`LiveStateReach`], from the same walk that finds where a
//! class is read) so they are matched again by the next flush.
//!
//! The tree holds nothing while no rule reads a live state: [`LiveStateReach::is_empty`] is the one
//! check a change of the pointer or the focus pays, and the bits are dropped when the last such rule
//! goes.

use rustc_hash::FxHashMap;

use super::invalidation::Reach;
use super::states::State;

/// Where each state is read live, by the selectors of a document: empty for a state no selector
/// reads outside its subject.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct LiveStateReach([Reach; State::COUNT]);

impl LiveStateReach {
    pub(super) fn read(&mut self, state: State, reach: Reach) {
        self.0[state.index()] |= reach;
    }

    /// Whether no selector reads any state live.
    pub fn is_empty(&self) -> bool {
        self.0.iter().all(|reach| reach.is_empty())
    }

    pub fn state(&self, state: State) -> Reach {
        self.0[state.index()]
    }
}

/// What the pointer or the focus holds, as the window reports it: each chain starts at the element
/// itself and goes up through its ancestors, as the events do. A half left out is not reported
/// and keeps what it held, since the pointer moves with no frame and the focus is read by one.
#[derive(Clone, Copy, Default, Debug)]
pub struct LiveInputs<'a> {
    /// The hover target and the press target, each with its ancestors.
    pub pointer: Option<PointerChains<'a>>,
    pub focus: Option<FocusChain<'a>>,
}

#[derive(Clone, Copy, Debug)]
pub struct PointerChains<'a> {
    pub hover: &'a [u64],
    pub active: &'a [u64],
}

#[derive(Clone, Copy, Debug)]
pub struct FocusChain<'a> {
    /// The focused element and its ancestors, which match `:focus-within`.
    pub within: &'a [u64],
    /// The element that matches `:focus-visible`.
    pub visible: Option<u64>,
}

impl<'a> LiveInputs<'a> {
    pub fn pointer(hover: &'a [u64], active: &'a [u64]) -> Self {
        LiveInputs { pointer: Some(PointerChains { hover, active }), focus: None }
    }

    pub fn focus(within: &'a [u64], visible: Option<u64>) -> Self {
        LiveInputs { pointer: None, focus: Some(FocusChain { within, visible }) }
    }

    fn of(&self, state: State) -> Option<&[u64]> {
        Some(match state {
            State::Hover => self.pointer.as_ref()?.hover,
            State::Active => self.pointer.as_ref()?.active,
            State::FocusWithin => self.focus.as_ref()?.within,
            State::Focus => self.focus.as_ref()?.within.first().map_or(&[], std::slice::from_ref),
            State::FocusVisible => self.focus.as_ref()?.visible.as_slice(),
        })
    }
}

const STATES: [State; State::COUNT] = [State::Hover, State::Active, State::Focus, State::FocusWithin, State::FocusVisible];

/// The elements each state holds, as the matcher last read them.
#[derive(Default)]
pub struct LiveStates {
    /// One bit per state, by `State::index`, for each element in some state.
    bits: FxHashMap<u64, u8>,
    held: [Vec<u64>; State::COUNT],
}

impl LiveStates {
    pub(crate) fn has(&self, id: u64, state: State) -> bool {
        self.bits.get(&id).is_some_and(|bits| bits & (1 << state.index()) != 0)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.bits.is_empty()
    }

    pub(crate) fn clear(&mut self) {
        self.bits.clear();
        self.held.iter_mut().for_each(Vec::clear);
    }

    /// Takes `inputs` as what each state holds now, and gives the elements that entered or left each
    /// state that is `read` somewhere. A state nothing reads is not kept.
    pub(super) fn update(&mut self, inputs: &LiveInputs<'_>, read: &LiveStateReach) -> Vec<(u64, Reach)> {
        let mut changed = Vec::new();
        for state in STATES {
            let reach = read.state(state);
            let Some(now) = inputs.of(state) else {
                continue;
            };
            let held = &mut self.held[state.index()];
            if reach.is_empty() || held.as_slice() == now {
                if reach.is_empty() && !held.is_empty() {
                    self.drop_state(state);
                }
                continue;
            }
            let bit = 1u8 << state.index();
            for left in held.iter().filter(|id| !now.contains(id)) {
                if let Some(bits) = self.bits.get_mut(left) {
                    *bits &= !bit;
                    if *bits == 0 {
                        self.bits.remove(left);
                    }
                }
                changed.push((*left, reach));
            }
            for entered in now.iter().filter(|id| !held.contains(id)) {
                *self.bits.entry(*entered).or_default() |= bit;
                changed.push((*entered, reach));
            }
            *held = now.to_vec();
        }
        changed
    }

    fn drop_state(&mut self, state: State) {
        let bit = 1u8 << state.index();
        for id in std::mem::take(&mut self.held[state.index()]) {
            if let Some(bits) = self.bits.get_mut(&id) {
                *bits &= !bit;
                if *bits == 0 {
                    self.bits.remove(&id);
                }
            }
        }
    }
}
