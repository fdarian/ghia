//! A change of a windowed virtual list's `itemCount`, made on the list state the list already has.
//!
//! A state that is rebuilt forgets every measured row, so the rows in view and the overdraw are
//! measured and laid out again though nothing in them changed. A count that shrinks only has to
//! drop the rows at the tail, which gpui does in O(log n) and which keeps the heights, the scroll
//! anchor and the focus handles of the rows that stay.
//!
//! A count that grows cannot be spliced in yet: gpui gives a spliced-in row no height hint, so
//! the new tail would count 0 px in the scroll length instead of `estimatedItemHeight`, and the
//! one call that hints rows (`with_uniform_item_height`) walks every row and turns the measured
//! ones back into unmeasured. A grow rebuilds the state, as every count change did.

use std::ops::Range;

pub(crate) enum CountChange {
    /// The rows at the tail are removed; the rest of the state stays.
    Shrink(Range<usize>),
    Rebuild,
}

/// How a state of `old_count` items becomes one of `new_count`, the counts being unequal.
pub(crate) fn plan(old_count: usize, new_count: usize) -> CountChange {
    debug_assert_ne!(old_count, new_count);
    if new_count < old_count {
        CountChange::Shrink(new_count..old_count)
    } else {
        CountChange::Rebuild
    }
}

pub(crate) fn remove_tail(state: &gpui::ListState, range: Range<usize>) {
    crate::perf_counters::list_items_spliced(range.len() as u64);
    state.splice(range, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_smaller_count_removes_the_tail() {
        match plan(10_000, 9_999) {
            CountChange::Shrink(range) => assert_eq!(range, 9_999..10_000),
            CountChange::Rebuild => panic!("a shrink is spliced"),
        }
        match plan(10, 0) {
            CountChange::Shrink(range) => assert_eq!(range, 0..10),
            CountChange::Rebuild => panic!("a shrink to nothing is spliced"),
        }
    }

    #[test]
    fn the_range_is_as_long_as_the_drop_and_not_the_count() {
        for count in [1_000usize, 100_000] {
            match plan(count, count - 3) {
                CountChange::Shrink(range) => assert_eq!(range.len(), 3),
                CountChange::Rebuild => panic!("a shrink is spliced"),
            }
        }
    }

    #[test]
    fn a_larger_count_rebuilds() {
        assert!(matches!(plan(9_999, 10_000), CountChange::Rebuild));
    }
}
