//! Whether skipping pays on this page. A frame that skips a root pays for it: the start of the
//! build is kept for gpui to build the root late, gpui records every root it builds, and a root
//! gpui cannot replay (it moved, or its surroundings did) is then built late, which costs more
//! than building it in the frame. A pan moves every root, so the frame replays a tenth of what it
//! skips and pays the rest: on the timeline page (3259 clips, culling on) 21.5 ms against 14.2
//! with retention off.
//!
//! The gate judges the frame before from what gpui counted of it, in element builds, and while
//! skipping loses it narrows retention to a sample of the roots (one in [`SAMPLE`], by id): only
//! those are recorded and skipped, so the page pays a sixteenth of the cost, and what the sample
//! does says whether the page is one a replay pays on again. The roots outside the sample have no
//! recording when the gate opens, and are built in the first frame after, which records them.

/// What gpui counted of retained subtrees since the window was made.
#[derive(Clone, Copy, Default)]
pub(crate) struct Tally {
    pub replays: u64,
    pub lazy_builds: u64,
}

impl Tally {
    pub(crate) fn of(counters: &gpui::RetainedCounters) -> Self {
        Self { replays: counters.replays, lazy_builds: counters.lazy_builds }
    }
}

/// About this many roots are skipped and recorded while the gate is closed.
const SAMPLE_ROOTS: u64 = 6;
/// What replaying a root costs, in builds of an element: about 3.4 µs against 7 µs.
const REPLAY_COST: f64 = 0.5;
/// What a root built late costs over building it in the frame, in builds of its elements.
const LATE_EXTRA: f64 = 0.2;
/// What a root built late costs besides, in builds of an element: the start of its build that the
/// skip kept and the closure that builds it.
const LATE_FIXED: f64 = 2.0;
/// A closed gate opens when replays win by this many times what late builds cost, so a page near
/// the break-even does not flap.
const OPEN_MARGIN: f64 = 2.0;

/// What a judgement did to the gate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Change {
    None,
    Closed,
    Opened,
}

pub(crate) struct Gate {
    /// `GPUIX_RETAIN_GATE_OFF` never closes it, to time a run without it.
    enabled: bool,
    before: Tally,
    /// Roots and the elements in them, as the last first pass found them.
    roots: u64,
    elements: u64,
    closed: bool,
    /// One root in this many is in the sample: set when the gate closes, and kept after it opens
    /// to tell which roots were recorded meanwhile.
    modulus: u64,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            enabled: std::env::var_os("GPUIX_RETAIN_GATE_OFF").is_none(),
            before: Tally::default(),
            roots: 0,
            elements: 0,
            closed: false,
            modulus: 1,
        }
    }
}

impl Gate {
    /// Whether the frame skips and records the root `id`.
    pub(crate) fn samples(&self, id: u64) -> bool {
        !self.closed || self.sampled(id)
    }

    /// Whether the root `id` is in the sample of the last closed gate.
    pub(crate) fn sampled(&self, id: u64) -> bool {
        id % self.modulus == 0
    }

    /// Opens the gate. The counters it read stay: they only ever grow.
    pub(crate) fn forget(&mut self) {
        self.closed = false;
    }

    /// Takes what the first pass of a frame found to be roots.
    pub(crate) fn note_roots(&mut self, roots: usize, elements: usize) {
        self.roots = roots as u64;
        self.elements = elements as u64;
    }

    /// Judges the frame before from the counters now. `judges` is false where skipping is not the
    /// frame's to decide (a verified run replays every root, since it is replay it checks).
    pub(crate) fn learn(&mut self, now: Tally, judges: bool) -> Change {
        let replays = now.replays - self.before.replays;
        let late = now.lazy_builds - self.before.lazy_builds;
        self.before = now;
        let was = self.closed;
        if !judges || !self.enabled || replays + late == 0 {
            self.closed = false;
        } else {
            let per_root = (self.elements as f64 / self.roots.max(1) as f64).max(1.0);
            let saved = replays as f64 * (per_root - REPLAY_COST).max(0.0);
            let cost = late as f64 * (per_root * LATE_EXTRA + LATE_FIXED);
            self.closed = if was { saved < cost * OPEN_MARGIN } else { saved < cost };
        }
        match (was, self.closed) {
            (false, true) => {
                self.modulus = (self.roots / SAMPLE_ROOTS).max(1);
                Change::Closed
            }
            (true, false) => Change::Opened,
            _ => Change::None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tally(replays: u64, lazy_builds: u64) -> Tally {
        Tally { replays, lazy_builds }
    }

    fn gate_over(roots: usize, elements: usize) -> Gate {
        let mut gate = Gate::default();
        gate.note_roots(roots, elements);
        gate
    }

    #[test]
    fn a_frame_that_replays_little_and_builds_late_closes_the_gate() {
        // The timeline pan: 101 replays, 304 late builds, a root of 1.25 elements.
        let mut gate = gate_over(675, 845);
        assert_eq!(gate.learn(tally(101, 304), true), Change::Closed);
        assert!(!gate.samples(1) && gate.samples(112), "675 roots, one in 112");
    }

    #[test]
    fn a_frame_that_replays_well_leaves_it_open() {
        let mut gate = gate_over(100, 4000);
        assert_eq!(gate.learn(tally(95, 5), true), Change::None);
        assert_eq!(gate.learn(tally(195, 10), true), Change::None);
        assert!(gate.samples(1));
    }

    #[test]
    fn big_roots_pay_for_a_few_late_builds() {
        let mut gate = gate_over(100, 5000);
        assert_eq!(gate.learn(tally(10, 30), true), Change::None, "10 replays of 50 elements save more than 30 late builds cost");
    }

    #[test]
    fn a_closed_gate_reads_its_sample_and_opens_when_replays_win() {
        let mut gate = gate_over(675, 845);
        gate.learn(tally(101, 304), true);
        // The page still moves: the sample is built late again.
        assert_eq!(gate.learn(tally(113, 342), true), Change::None);
        assert!(!gate.samples(1));
        // The page stopped: the sample is replayed.
        assert_eq!(gate.learn(tally(193, 344), true), Change::Opened);
        assert!(gate.samples(1));
    }

    #[test]
    fn between_the_break_even_and_the_margin_a_gate_stays_as_it_was() {
        // Roots of one element: 50 replays save 25 builds and 10 late builds cost 22, which is a
        // win, but not by the margin a closed gate asks.
        let mut open = gate_over(100, 100);
        assert_eq!(open.learn(tally(50, 10), true), Change::None);

        let mut closed = gate_over(100, 100);
        assert_eq!(closed.learn(tally(1, 100), true), Change::Closed);
        assert_eq!(closed.learn(tally(51, 110), true), Change::None);
        assert!(!closed.samples(1));
    }

    #[test]
    fn a_frame_with_nothing_to_judge_opens_it() {
        let mut gate = gate_over(675, 845);
        gate.learn(tally(101, 304), true);
        assert_eq!(gate.learn(tally(101, 304), true), Change::Opened);
    }

    #[test]
    fn a_run_that_does_not_judge_never_closes_it() {
        let mut gate = gate_over(675, 845);
        assert_eq!(gate.learn(tally(101, 304), false), Change::None);
        assert!(gate.samples(1));
    }

    #[test]
    fn forgetting_opens_it() {
        let mut gate = gate_over(675, 845);
        gate.learn(tally(101, 304), true);
        gate.forget();
        assert!(gate.samples(1));
    }
}
