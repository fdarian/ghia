//! What a retained subtree writes into gpuix's own registries while it prepaints and paints, kept
//! so that a frame that replays the subtree writes it again (#37 step 5b).
//!
//! gpui replays the scene, hitboxes, listeners and accessibility nodes of a retained subtree, but
//! not what its listeners and canvases publish into the registries gpuix keeps outside the frame:
//! the painted boxes `getBoundingClientRect` reads, the selection and start regions, the inline
//! hit paragraphs, the painted text log, the measurements. Those registries are reset at the top
//! of every painted frame, so what a skipped subtree published last frame is gone this frame.
//!
//! A [`Tape`] is the list of those writes, per phase, as closures that hold what they write. The
//! [`Taped`] element around the root of a subtree sets the tape it records into while the subtree
//! prepaints and paints. Every registry write that a skipped subtree has to repeat goes through
//! [`record`], next to the write itself, so a registry that gains a writer in a paint listener
//! has one place to say so.
//!
//! The build is the other half. A subtree that is not built does not do what building it does
//! outside the frame (it marks its elements as measured, asks for the images its styles name):
//! those are [`BuildEffect`]s, kept by `retain` with the record of the subtree and applied when a
//! frame plans to skip it.

use std::any::Any;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gpui::{AnyElement, App, Bounds, Edges, Element, ElementId, GlobalElementId, InspectorElementId, LayoutId, Pixels, Point, Window, WindowId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Prepaint,
    Paint,
    /// A pass that lays out and does not paint: the writes of both phases that such a pass makes
    /// too, see [`write_in_layout`].
    Layout,
    /// A pass that lays out and does not paint puts back what a pass that only laid out wrote of
    /// a subtree it built: the layout tape of the subtree, whose prepaint and publications are all
    /// writes of such a pass.
    LayoutRecorded,
    /// [`Phase::Layout`] for a subtree that the stacking context around its parent paints (a
    /// hole): its prepaint was replayed with the parent's, so only the writes that paint makes in
    /// such a pass are left.
    LayoutPaint,
    /// What an element the subtree handed to the stacking context around it wrote while the context
    /// painted it, by the ordinal of the element counted from the first the subtree handed over. It
    /// is outside the paint of the subtree, though a replay of the subtree writes it again.
    Lifted(u32),
}

/// The registry a write goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Bounds,
    StartRegion,
    Painted,
    Text,
    Paragraph,
    /// `Measurements::by_element`, which lives across frames and is not reset by one: the replay
    /// of a subtree leaves it as the build wrote it, and only the tape keeps the write, to say
    /// what the build would have written ([`Tape::same_writes`], a verified frame).
    Measured,
}

#[derive(Clone, Copy, Default)]
struct Kinds(u8);

impl Kinds {
    fn with(self, kind: Kind) -> Self {
        Self(self.0 | 1 << kind as u8)
    }

    fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    fn has(self, kind: Kind) -> bool {
        self.0 & 1 << kind as u8 != 0
    }

    fn is_empty(self) -> bool {
        self.0 == 0
    }
}

/// A registry write that is kept, said in words and handed to the registry that reads it back.
/// A write that holds a position is read `offset` away from where it was recorded: a subtree
/// that a scroller moved is replayed where the scroll put it.
trait Replay {
    fn describe(&self, offset: Point<Pixels>) -> String;
    /// Whether a pass that only lays out makes the write too, from prepaint.
    fn in_layout(&self) -> bool;
    fn kind(&self) -> Kind;
    fn data(&self) -> &dyn Any;
}

struct Write<D> {
    data: D,
    describe: fn(&D, Point<Pixels>) -> String,
    in_layout: bool,
    kind: Kind,
}

impl<D: 'static> Replay for Write<D> {
    fn describe(&self, offset: Point<Pixels>) -> String {
        (self.describe)(&self.data, offset)
    }

    fn in_layout(&self) -> bool {
        self.in_layout
    }

    fn kind(&self) -> Kind {
        self.kind
    }

    fn data(&self) -> &dyn Any {
        &self.data
    }
}

type Effect = Rc<dyn Replay>;

#[derive(Clone)]
enum Entry {
    Write(Effect),
    /// The writes of another subtree, `by` away from where they were made: a subtree that was
    /// replayed or built inside this one while it recorded. They are held by reference, so that
    /// recording a replay costs the same however much the replayed subtree wrote.
    Nested(Rc<Entries>, Point<Pixels>),
}

thread_local! {
    /// The list each list that was nested in another was last nested in, and by how much: how a
    /// list is found to be put back by a replay of the lists around it, see [`Live::delta_of`].
    static PARENTS: RefCell<rustc_hash::FxHashMap<u64, (u64, Point<Pixels>)>> = RefCell::new(rustc_hash::FxHashMap::default());
    static SERIAL: Cell<u64> = const { Cell::new(1) };
    /// The serial of the list the write being made is recorded into, see [`owner`].
    static OWNER: Cell<u64> = const { Cell::new(0) };
}

/// The writes of one phase of one subtree, in the order they were made. Once it has been
/// recorded it is never changed: a later recording makes a list of its own, so a registry that
/// holds this one (a replay that has not been read yet) reads what the subtree wrote then.
pub(crate) struct Entries {
    /// Names this list for as long as it lives, for a registry to say which writes it holds
    /// without holding the list (see [`owner`]).
    serial: u64,
    list: Vec<Entry>,
    /// Of the writes in the list and in the lists nested in it.
    kinds: Kinds,
    layout_kinds: Kinds,
}

/// A list of its own with the writes of this one: what a recording does to a list that a replay
/// already holds, so that the replay is left as it was.
impl Clone for Entries {
    fn clone(&self) -> Self {
        let serial = next_serial() | (self.serial & LAID_OUT);
        for entry in &self.list {
            if let Entry::Nested(child, by) = entry {
                PARENTS.with(|parents| parents.borrow_mut().insert(child.serial, (serial, *by)));
            }
        }
        Self { serial, list: self.list.clone(), kinds: self.kinds, layout_kinds: self.layout_kinds }
    }
}

fn next_serial() -> u64 {
    SERIAL.replace(SERIAL.get() + 1)
}

/// Set in the serial of a list of a layout tape, for a registry that keeps the writes of replays
/// by list to tell them from the lists of a painted tape: a pass that builds a subtree and leaves
/// no tape of its own must not forget the box a painted tape holds, nor the reverse.
const LAID_OUT: u64 = 1 << 63;

/// Whether a list, by its serial, belongs to a layout tape.
pub(crate) fn is_laid_out(serial: u64) -> bool {
    serial & LAID_OUT != 0
}

impl Drop for Entries {
    fn drop(&mut self) {
        // The thread may be on its way out, with nothing left to forget.
        PARENTS.try_with(|parents| parents.borrow_mut().remove(&self.serial)).ok();
    }
}

impl Entries {
    /// Empties a list that nothing else holds, to be recorded into again, under a serial of its own
    /// when it was written into: the registries tag a write with the serial of the list it was
    /// recorded into, and a write of an earlier recording must not be taken for one of this.
    fn restart(&mut self, laid_out: bool) {
        if self.list.is_empty() && is_laid_out(self.serial) == laid_out {
            return;
        }
        PARENTS.try_with(|parents| parents.borrow_mut().remove(&self.serial)).ok();
        self.serial = next_serial() | if laid_out { LAID_OUT } else { 0 };
        self.list.clear();
        self.kinds = Kinds::default();
        self.layout_kinds = Kinds::default();
    }

    fn new(laid_out: bool) -> Rc<Self> {
        Rc::new(Self {
            serial: next_serial() | if laid_out { LAID_OUT } else { 0 },
            list: Vec::new(),
            kinds: Kinds::default(),
            layout_kinds: Kinds::default(),
        })
    }

    fn push_write(&mut self, effect: Effect) {
        self.kinds = self.kinds.with(effect.kind());
        if effect.in_layout() {
            self.layout_kinds = self.layout_kinds.with(effect.kind());
        }
        self.list.push(Entry::Write(effect));
    }

    fn push_nested(&mut self, child: Rc<Entries>, by: Point<Pixels>) {
        if child.list.is_empty() {
            return;
        }
        self.kinds = self.kinds.union(child.kinds);
        self.layout_kinds = self.layout_kinds.union(child.layout_kinds);
        PARENTS.with(|parents| parents.borrow_mut().insert(child.serial, (self.serial, by)));
        self.list.push(Entry::Nested(child, by));
    }

    /// Calls `visit` with every write, `offset` away from where it was made, in the order it was
    /// made. A pass that only lays out makes `layout_only` of them.
    fn walk(&self, offset: Point<Pixels>, layout_only: bool, visit: &mut dyn FnMut(&Effect, Point<Pixels>)) {
        for entry in &self.list {
            match entry {
                Entry::Write(effect) => {
                    if !layout_only || effect.in_layout() {
                        visit(effect, offset);
                    }
                }
                Entry::Nested(child, by) => {
                    if !layout_only || !child.layout_kinds.is_empty() {
                        child.walk(offset + *by, layout_only, visit);
                    }
                }
            }
        }
    }

    fn described(&self, phase: &str, delta: Point<Pixels>) -> String {
        let mut text = String::new();
        self.walk(delta, false, &mut |effect, offset| {
            text.push_str(&format!(
                "{phase}{} {}\n",
                if effect.in_layout() { "+layout" } else { "" },
                effect.describe(offset)
            ));
        });
        text
    }

    fn lines(&self) -> Vec<(bool, String)> {
        self.lines_by(|effect, offset| effect.describe(offset))
    }

    /// Whether the writes of the two lists are the same, the boxes, texts and start regions compared apart from the
    /// transforms around them, and the text layouts of this one `moved` further. A write is compared by what it holds:
    /// the words that [`Replay::describe`] says are for a write with no comparison of its own.
    fn same_apart_from_transforms(&self, other: &Entries, moved: Point<Pixels>) -> bool {
        let (mut mine, mut theirs) = (Vec::new(), Vec::new());
        self.collect(Point::default(), &mut mine);
        other.collect(Point::default(), &mut theirs);
        mine.len() == theirs.len()
            && mine.iter().zip(&theirs).all(|((left, left_offset), (right, right_offset))| {
                left.kind() == right.kind()
                    && left.in_layout() == right.in_layout()
                    && match left.kind() {
                        Kind::Bounds => crate::automation::same_bounds_apart_from_transform(left.data(), *left_offset, right.data(), *right_offset),
                        Kind::Text => crate::text::same_text_apart_from_transform(left.data(), moved, right.data(), Point::default()),
                        Kind::StartRegion => {
                            crate::text::same_start_region_apart_from_transform(left.data(), *left_offset, right.data(), *right_offset)
                        }
                        Kind::Painted => crate::text::same_painted_text(left.data(), right.data()),
                        Kind::Measured => crate::motion::same_measured_write(left.data(), right.data()),
                        Kind::Paragraph => left.describe(*left_offset) == right.describe(*right_offset),
                    }
            })
    }

    /// Every write in the order it was made, with how far from where it was made it is.
    fn collect<'a>(&'a self, offset: Point<Pixels>, writes: &mut Vec<(&'a dyn Replay, Point<Pixels>)>) {
        for entry in &self.list {
            match entry {
                Entry::Write(effect) => writes.push((effect.as_ref(), offset)),
                Entry::Nested(child, by) => child.collect(offset + *by, writes),
            }
        }
    }

    /// [`Self::lines`] said by words: what [`Self::same_apart_from_transforms`] compares, which a test holds it to.
    #[cfg(test)]
    fn lines_apart_from_transforms(&self, moved: Point<Pixels>) -> Vec<(bool, String)> {
        self.lines_by(|effect, offset| match effect.kind() {
            Kind::Bounds => crate::automation::describe_apart_from_transform(effect.data(), offset),
            Kind::Text => crate::text::describe_text_apart_from_transform(effect.data(), moved),
            Kind::StartRegion => crate::text::describe_start_region_apart_from_transform(effect.data(), offset),
            _ => effect.describe(offset),
        })
    }

    fn lines_by(&self, describe: impl Fn(&Effect, Point<Pixels>) -> String) -> Vec<(bool, String)> {
        let mut lines = Vec::new();
        self.walk(Point::default(), false, &mut |effect, offset| lines.push((effect.in_layout(), describe(effect, offset))));
        lines
    }
}

/// The writes of a replay that a registry has been told of and has not read, see [`publish`].
#[derive(Clone)]
pub(crate) struct Live {
    entries: Rc<Entries>,
    delta: Point<Pixels>,
    layout_only: bool,
}

impl Live {
    /// Whether the replay writes anything for the registry of `kind`.
    pub(crate) fn has(&self, kind: Kind) -> bool {
        if self.layout_only { self.entries.layout_kinds.has(kind) } else { self.entries.kinds.has(kind) }
    }

    /// Calls `read` with the data of every write to the registry of `kind`, and how far from
    /// where it was made it is made now, in the order it was made.
    pub(crate) fn each(&self, kind: Kind, mut read: impl FnMut(&dyn Any, Point<Pixels>)) {
        self.entries.walk(self.delta, self.layout_only, &mut |effect, offset| {
            if effect.kind() == kind {
                read(effect.data(), offset);
            }
        });
    }

    /// Notes the list that the replay puts back as live, with how far from where it was written
    /// it is, for [`owner`] to be looked up in with [`delta_of`].
    pub(crate) fn mark(&self, live: &mut rustc_hash::FxHashMap<u64, Point<Pixels>>) {
        live.insert(self.entries.serial, self.delta);
    }
}

/// How far from where it was written the list `owner` is put back, if a replay in `live` puts it
/// back: the replay of the list or of one that it was nested in, however deep.
pub(crate) fn delta_of(owner: u64, live: &rustc_hash::FxHashMap<u64, Point<Pixels>>) -> Option<Point<Pixels>> {
    PARENTS.with(|parents| {
        let parents = parents.borrow();
        let (mut list, mut offset) = (owner, Point::default());
        loop {
            if let Some(delta) = live.get(&list) {
                return Some(*delta + offset);
            }
            let (parent, by) = parents.get(&list)?;
            (list, offset) = (*parent, offset + *by);
        }
    })
}

/// Tells the registries that read in order, and the one that answers by element, that a replay
/// puts `live` back. They keep it as it is and read it when something asks.
fn publish(window: WindowId, live: &Live) {
    crate::automation::publish(window, live);
    crate::text::publish(window, live);
}

/// A registry that holds the writes of replays by reference, and the writes made around them, in
/// the order they came: reading it expands each replay into the writes it stands for. Each write
/// keeps the list it was made into (see [`owner`]), so that a frame that moves the rows of a list in
/// place can find what the rows wrote and move it ([`Layered::shift`]).
pub(crate) struct Layered<T> {
    /// What was read, and the list each write was made into (0 outside any).
    read: Vec<T>,
    owners: Vec<u64>,
    /// What came since: a write is `Slot::One`, a replay that has not been expanded `Slot::Live`.
    pending: Vec<Slot<T>>,
}

enum Slot<T> {
    One(T, u64),
    Live(Live),
}

impl<T> Slot<T> {
    fn owner(&self) -> u64 {
        match self {
            Slot::One(_, owner) => *owner,
            Slot::Live(live) => live.entries.serial,
        }
    }
}

impl<T> Default for Layered<T> {
    fn default() -> Self {
        Self { read: Vec::new(), owners: Vec::new(), pending: Vec::new() }
    }
}

impl<T> Layered<T> {
    pub(crate) fn push(&mut self, value: T) {
        if self.pending.is_empty() {
            self.read.push(value);
            self.owners.push(owner());
        } else {
            self.pending.push(Slot::One(value, owner()));
        }
    }

    pub(crate) fn push_live(&mut self, live: Live) {
        self.pending.push(Slot::Live(live));
    }

    /// How many writes and replays the registry holds, without reading it.
    #[cfg(feature = "test-support")]
    pub(crate) fn slots(&self) -> usize {
        self.read.len() + self.pending.len()
    }

    /// Every write, in order. `from` makes one from the data of a write of `kind` and how far from
    /// where it was made it is made.
    pub(crate) fn all(&mut self, kind: Kind, from: impl Fn(&dyn Any, Point<Pixels>) -> T) -> &[T] {
        self.all_mut(kind, from)
    }

    /// [`Self::all`] for a registry whose entries a patch changes in place.
    pub(crate) fn all_mut(&mut self, kind: Kind, from: impl Fn(&dyn Any, Point<Pixels>) -> T) -> &mut [T] {
        for slot in self.pending.drain(..) {
            match slot {
                Slot::One(value, owner) => {
                    self.read.push(value);
                    self.owners.push(owner);
                }
                Slot::Live(live) => {
                    let list = live.entries.serial;
                    live.each(kind, |data, offset| {
                        self.read.push(from(data, offset));
                        self.owners.push(list);
                    });
                }
            }
        }
        &mut self.read
    }

    /// Takes out every write that was made into one of the lists `old` stand for (or one nested in
    /// them), and every replay that puts one back, and puts the writes of `new` in the place of the
    /// first of them (at the end if there was none), so that what was written around them keeps its
    /// order. For a registry that a patch laid out again.
    ///
    /// The replays that were not read are not expanded: they are kept or taken out whole, and `new` takes
    /// the place of the first among them as replays too, so a patch costs what the registry has read and
    /// the replays it holds, not what they stand for.
    ///
    /// A registry holds the writes of the whole window and a patch replaces a few rows of them, so this
    /// only looks at who owns each write and moves the writes it takes out of the way in place: the runs
    /// of writes that `old` holds are drained, and what is left is not copied.
    pub(crate) fn replace(&mut self, old: &Roots, new: &[Live], kind: Kind, from: impl Fn(&dyn Any, Point<Pixels>) -> T) {
        let brings = new.iter().any(|live| live.has(kind));
        if !brings && self.read.is_empty() && self.pending.is_empty() {
            return;
        }
        let mut owned: rustc_hash::FxHashMap<u64, bool> = Default::default();
        let mut last = (u64::MAX, false);
        let mut holds = |owner: u64| {
            if last.0 != owner {
                last = (owner, *owned.entry(owner).or_insert_with(|| old.hold(owner)));
            }
            last.1
        };

        let taken = held_runs(self.owners.len(), |at| self.owners[at], &mut holds);
        for run in taken.iter().rev() {
            self.read.drain(run.clone());
            self.owners.drain(run.clone());
        }
        let mut taken_pending = held_runs(self.pending.len(), |at| self.pending[at].owner(), &mut holds);
        let Some(first) = taken.first() else {
            // The replays of `new` take the place of the first run, where a patch that puts back as many as it took
            // out moves nothing after it.
            let first = if taken_pending.is_empty() { self.pending.len()..self.pending.len() } else { taken_pending.remove(0) };
            for run in taken_pending.iter().rev() {
                self.pending.drain(run.clone());
            }
            self.pending.splice(first, new.iter().filter(|live| live.has(kind)).cloned().map(Slot::Live));
            return;
        };
        for run in taken_pending.iter().rev() {
            self.pending.drain(run.clone());
        }
        let (at, before) = (first.start, self.read.len());
        for live in new.iter().filter(|live| live.has(kind)) {
            let list = live.entries.serial;
            live.each(kind, |data, offset| {
                self.read.push(from(data, offset));
                self.owners.push(list);
            });
        }
        let added = self.read.len() - before;
        self.read[at..].rotate_right(added);
        self.owners[at..].rotate_right(added);
    }

    /// Puts the writes that were made into the lists of each of `rows` (or into one nested in them)
    /// together, in the order of `rows`, where the first of them was; what was written around them keeps
    /// its order. For a registry that a frame which brought rows in put the writes of at its end.
    pub(crate) fn order_by_rows(&mut self, rows: &[Roots], kind: Kind, from: impl Fn(&dyn Any, Point<Pixels>) -> T) {
        self.all_mut(kind, &from);
        let (read, owners) = (std::mem::take(&mut self.read), std::mem::take(&mut self.owners));
        let mut row_of: rustc_hash::FxHashMap<u64, Option<usize>> = Default::default();
        let (mut block, mut rest) = (Vec::new(), Vec::new());
        let mut at = None;
        for (value, owner) in read.into_iter().zip(owners) {
            match *row_of.entry(owner).or_insert_with(|| rows.iter().position(|roots| roots.hold(owner))) {
                Some(row) => {
                    at.get_or_insert(rest.len());
                    block.push((row, value, owner));
                }
                None => rest.push((value, owner)),
            }
        }
        block.sort_by_key(|(row, ..)| *row);
        let at = at.unwrap_or(rest.len());
        let mut rest = rest.into_iter();
        for (value, owner) in rest.by_ref().take(at) {
            self.read.push(value);
            self.owners.push(owner);
        }
        for (_, value, owner) in block {
            self.read.push(value);
            self.owners.push(owner);
        }
        for (value, owner) in rest {
            self.read.push(value);
            self.owners.push(owner);
        }
    }

    /// Moves every write that was made into one of the lists `roots` stand for, or into one
    /// nested in them, `by` further, with `moves`, and every replay that puts one of them back.
    pub(crate) fn shift(&mut self, roots: &Roots, by: Point<Pixels>, mut moves: impl FnMut(&mut T, Point<Pixels>)) {
        for slot in &mut self.pending {
            match slot {
                Slot::One(value, list) if roots.hold(*list) => moves(value, by),
                Slot::Live(live) if roots.hold(live.entries.serial) => live.delta = live.delta + by,
                _ => {}
            }
        }
        let mut last = (u64::MAX, false);
        for (value, list) in self.read.iter_mut().zip(&self.owners) {
            if last.0 != *list {
                last = (*list, roots.hold(*list));
            }
            if last.1 {
                moves(value, by);
            }
        }
    }
}

/// The runs of a sequence of `len` items, by index, whose owner (`owner_at`) `holds`.
fn held_runs(len: usize, owner_at: impl Fn(usize) -> u64, holds: &mut impl FnMut(u64) -> bool) -> Vec<std::ops::Range<usize>> {
    let mut runs = Vec::new();
    let mut at = 0;
    while at < len {
        if !holds(owner_at(at)) {
            at += 1;
            continue;
        }
        let start = at;
        while at < len && holds(owner_at(at)) {
            at += 1;
        }
        runs.push(start..at);
    }
    runs
}

/// The lists of the tape of a retained root, and so everything it wrote: a list is in the root if
/// it is one of them or was nested in one, however deep.
pub(crate) struct Roots(Vec<u64>);

impl Roots {
    /// Whether the list `serial` is one of the roots' or is nested in one.
    pub(crate) fn hold(&self, serial: u64) -> bool {
        PARENTS.with(|parents| {
            let parents = parents.borrow();
            let mut list = serial;
            loop {
                if self.0.contains(&list) {
                    return true;
                }
                match parents.get(&list) {
                    Some((parent, _)) => list = *parent,
                    None => return false,
                }
            }
        })
    }

    pub(crate) fn extend(&mut self, other: Roots) {
        self.0.extend(other.0);
    }
}

/// The registry writes of one subtree, in the order they were made.
pub(crate) struct Tape {
    prepaint: Rc<Entries>,
    paint: Rc<Entries>,
    lifted: Vec<Rc<Entries>>,
    /// The writes made while it records are kept and not made, see [`Tape::capturing`].
    capture_only: bool,
    /// The tape of a subtree built by a pass that only lays out, see [`Tape::laid_out`].
    laid_out: bool,
}

impl Default for Tape {
    fn default() -> Self {
        Self { prepaint: Entries::new(false), paint: Entries::new(false), lifted: Vec::new(), capture_only: false, laid_out: false }
    }
}

impl Tape {
    /// The tape of a subtree built by a pass that only lays out. Its `prepaint` holds what the
    /// prepaint wrote, and its `paint` what the publications queued by the prepaint wrote once the
    /// whole tree was prepainted ([`Taped`]): a pass that lays out makes both, and a replay of it
    /// puts both back.
    pub(crate) fn laid_out() -> SharedTape {
        Rc::new(RefCell::new(Tape { prepaint: Entries::new(true), paint: Entries::new(true), laid_out: true, ..Tape::default() }))
    }

    /// A tape for a subtree that is prepainted and painted only to see what it would write: the
    /// writes are on the tape and not in the registries, which hold what the frame before made of
    /// the subtree. [`Tape::same_writes`] says whether the frame would have made the same.
    pub(crate) fn capturing() -> SharedTape {
        Rc::new(RefCell::new(Tape { capture_only: true, ..Tape::default() }))
    }

    /// Whether `other` holds the writes this does, phase by phase, in the same order, at the same
    /// places.
    pub(crate) fn same_writes(&self, other: &Tape) -> bool {
        self.prepaint.lines() == other.prepaint.lines()
            && self.paint.lines() == other.paint.lines()
            && self.lifted.len() == other.lifted.len()
            && self.lifted.iter().zip(&other.lifted).all(|(left, right)| left.lines() == right.lines())
    }

    /// [`Self::same_writes`] where the boxes of the elements, and the matrices of their texts and
    /// start regions, may differ in the transforms around them. A patch of a transform that moves
    /// paints the same, and what it publishes of them is what [`Self::each`] reads.
    pub(crate) fn same_writes_apart_from_transforms(&self, other: &Tape, moved: Point<Pixels>) -> bool {
        self.prepaint.same_apart_from_transforms(&other.prepaint, moved)
            && self.paint.same_apart_from_transforms(&other.paint, moved)
            && self.lifted.len() == other.lifted.len()
            && self.lifted.iter().zip(&other.lifted).all(|(left, right)| left.same_apart_from_transforms(right, moved))
    }

    /// [`Self::same_writes_apart_from_transforms`] said by words, which it is held to.
    #[cfg(test)]
    fn same_writes_by_words_apart_from_transforms(&self, other: &Tape, moved: Point<Pixels>) -> bool {
        self.prepaint.lines_apart_from_transforms(moved) == other.prepaint.lines_apart_from_transforms(Point::default())
            && self.paint.lines_apart_from_transforms(moved) == other.paint.lines_apart_from_transforms(Point::default())
            && self.lifted.len() == other.lifted.len()
            && self
                .lifted
                .iter()
                .zip(&other.lifted)
                .all(|(left, right)| left.lines_apart_from_transforms(moved) == right.lines_apart_from_transforms(Point::default()))
    }

    /// What the tape wrote, as the replays that put it back where it was written.
    pub(crate) fn lives(&self, delta: Point<Pixels>) -> Vec<Live> {
        [&self.prepaint, &self.paint]
            .into_iter()
            .chain(&self.lifted)
            .map(|entries| Live { entries: entries.clone(), delta, layout_only: false })
            .collect()
    }

    /// The lists the tape writes into, which everything it wrote (and what was replayed into it)
    /// is in.
    fn roots(&self) -> Roots {
        Roots([&self.prepaint, &self.paint].into_iter().chain(&self.lifted).map(|entries| entries.serial).collect())
    }

    /// Calls `visit` with the data of every write to the registry of `kind`, and how far from where
    /// it was made it is made now (none).
    pub(crate) fn each(&self, kind: Kind, visit: &mut dyn FnMut(&dyn Any, Point<Pixels>)) {
        for entries in [&self.prepaint, &self.paint].into_iter().chain(&self.lifted) {
            entries.walk(Point::default(), false, &mut |effect, offset| {
                if effect.kind() == kind {
                    visit(effect.data(), offset);
                }
            });
        }
    }

    fn entries(&self, phase: Phase) -> Option<&Rc<Entries>> {
        match phase {
            Phase::Prepaint => Some(&self.prepaint),
            Phase::Paint => Some(&self.paint),
            Phase::Lifted(rel) => self.lifted.get(rel as usize),
            Phase::Layout | Phase::LayoutPaint | Phase::LayoutRecorded => {
                unreachable!("nothing records into the layout phases: they replay the others")
            }
        }
    }

    /// The list `phase` is recorded into, for a recording to add to.
    fn recording(&mut self, phase: Phase) -> &mut Entries {
        let list = match phase {
            Phase::Prepaint => &mut self.prepaint,
            Phase::Paint => &mut self.paint,
            Phase::Lifted(rel) => &mut self.lifted[rel as usize],
            Phase::Layout | Phase::LayoutPaint | Phase::LayoutRecorded => {
                unreachable!("nothing records into the layout phases: they replay the others")
            }
        };
        Rc::make_mut(list)
    }

    /// Makes `list` one that holds no write, as a list of its own for what is recorded next: the one
    /// that was there is left as it was when a replay or a subtree around holds it, and is emptied
    /// in place, keeping its storage, when nothing does.
    fn restart(list: &mut Rc<Entries>, laid_out: bool) {
        match Rc::get_mut(list) {
            Some(entries) => entries.restart(laid_out),
            None => *list = Entries::new(laid_out),
        }
    }

    /// This tape as [`Tape::default`] makes one, for the build of a root whose last tape nothing
    /// holds any more to record into.
    fn renew(&mut self) {
        self.capture_only = false;
        self.laid_out = false;
        self.lifted.clear();
        Self::restart(&mut self.prepaint, false);
        Self::restart(&mut self.paint, false);
    }

    /// Starts a list of its own for `phase`, so that what a replay of the one before holds is left
    /// as it was.
    fn start(&mut self, phase: Phase) {
        match phase {
            Phase::Prepaint => Self::restart(&mut self.prepaint, self.laid_out),
            Phase::Paint => Self::restart(&mut self.paint, self.laid_out),
            Phase::Lifted(rel) => {
                let rel = rel as usize;
                let laid_out = self.laid_out;
                if self.lifted.len() <= rel {
                    self.lifted.resize_with(rel + 1, || Entries::new(laid_out));
                }
                self.lifted[rel] = Entries::new(laid_out);
            }
            Phase::Layout | Phase::LayoutPaint | Phase::LayoutRecorded => {
                unreachable!("nothing records into the layout phases: they replay the others")
            }
        }
    }

    /// Puts back what `phase` of the subtree wrote, `delta` from where it wrote it: the registries
    /// are told, and read it when something asks. A subtree inside another that is being recorded
    /// is part of its tape too.
    pub(crate) fn replay(&self, window: WindowId, phase: Phase, delta: Point<Pixels>) {
        debug_assert!(!is_capturing(), "a subtree that is only captured holds no subtree to replay");
        let put = |entries: &Rc<Entries>, layout_only: bool| {
            if !entries.list.is_empty() {
                publish(window, &Live { entries: entries.clone(), delta, layout_only });
            }
        };
        match phase {
            // A pass that only lays out records no tape, so this is not part of one. It makes the
            // writes of prepaint, and those of paint and of the elements handed to the stacking
            // context that it makes from prepaint too.
            Phase::Layout => {
                put(&self.prepaint, false);
                put(&self.paint, true);
                for lifted in &self.lifted {
                    put(lifted, true);
                }
                return;
            }
            Phase::LayoutPaint => return put(&self.paint, true),
            // The subtree was built by a pass that only laid out, and the pass that skips it is
            // inside another that is being recorded, if it is inside one: the writes are part of
            // that one's tape either way.
            Phase::LayoutRecorded => {
                debug_assert!(self.laid_out, "a layout record is replayed from a layout tape");
                put(&self.prepaint, false);
                put(&self.paint, false);
                RECORDING.with(|recordings| {
                    if let Some(recording) = recordings.borrow().last() {
                        debug_assert!(
                            recording.phase == Phase::Paint,
                            "the publications of a pass that only lays out are recorded in the paint list"
                        );
                        let mut outer = recording.tape.borrow_mut();
                        let outer = outer.recording(recording.phase);
                        outer.push_nested(self.prepaint.clone(), delta);
                        outer.push_nested(self.paint.clone(), delta);
                    }
                });
                return;
            }
            Phase::Prepaint | Phase::Paint | Phase::Lifted(_) => {}
        }
        let Some(entries) = self.entries(phase) else {
            return;
        };
        put(entries, false);
        RECORDING.with(|recordings| {
            if let Some(recording) = recordings.borrow().last() {
                // What the context paints, of the subtree or of what it handed over, is replayed
                // inside whichever of the two is being recorded.
                debug_assert!(
                    match phase {
                        Phase::Prepaint => recording.phase == Phase::Prepaint,
                        _ => matches!(recording.phase, Phase::Paint | Phase::Lifted(_)),
                    },
                    "a subtree is replayed in the phase it is recorded in"
                );
                recording.tape.borrow_mut().recording(recording.phase).push_nested(entries.clone(), delta);
            }
        });
    }

    /// What the tape writes `delta` from where it wrote it, as text, one line per write.
    pub(crate) fn describe(&self, delta: Point<Pixels>) -> String {
        let lifted = (0..self.lifted.len() as u32).map(|rel| self.describe_lifted(rel)).collect::<String>();
        self.prepaint.described("prepaint", delta) + &self.paint.described("paint", delta) + &lifted
    }

    /// What the element handed to the stacking context as `rel` wrote, as text.
    fn describe_lifted(&self, rel: u32) -> String {
        self.lifted
            .get(rel as usize)
            .map_or_else(String::new, |entries| entries.described(&format!("lifted {rel} "), Point::default()))
    }
}

pub(crate) type SharedTape = Rc<RefCell<Tape>>;

/// The tape of the last build of each retained root, by element id.
#[derive(Default)]
pub(crate) struct TapeStore {
    tapes: RefCell<rustc_hash::FxHashMap<u64, SharedTape>>,
    /// The tape of the last build of each retained root by a pass that only lays out. Kept apart
    /// from `tapes`, which belong to the recordings of presented frames: a pass that lays out must
    /// leave those for the draw after it.
    laid_out: RefCell<rustc_hash::FxHashMap<u64, SharedTape>>,
    /// While gpui compares frames that replayed with frames built whole: what the tape of each
    /// root that replayed was, when it was replayed.
    verifying: std::cell::Cell<bool>,
    /// How far from where the last build of a root wrote it the frame shown has it, for the roots a frame moved or replayed
    /// elsewhere. A root built again is where it was built and has none.
    moved: RefCell<rustc_hash::FxHashMap<u64, Point<Pixels>>>,
    replayed: RefCell<Vec<(u64, String)>>,
    /// The writes of elements handed to the stacking context that a replay put back, by root and
    /// ordinal: a root that replayed has to have put back every one it wrote when it was built.
    replayed_lifted: RefCell<Vec<(u64, u32, String)>>,
    rows: RefCell<Rows>,
}

/// Which rows of virtual lists the frame shown has, and what a frame that moved them in place did to
/// that: gpui puts the rows that stay where the scroll takes them (`RetainedPhase::Scrolled`), builds
/// the ones that come in, and the ones that stay but cannot be put where the scroll takes them, through
/// the builder of the list, and takes out the ones that leave without saying which. A row that is in the
/// frame shown, in a list that moved, and neither stayed nor was built, left ([`TapeStore::settle_rows`]).
#[derive(Default)]
struct Rows {
    /// The rows of the frame shown, with the list each is a row of and its index in it.
    shown: rustc_hash::FxHashMap<u64, (u64, usize)>,
    /// The rows built since the frame shown was last settled: the rows of a frame built whole, or the
    /// ones that came in by a frame that moved the rows.
    built: rustc_hash::FxHashMap<u64, (u64, usize)>,
    /// The rows that a frame that moved the rows in place left where the scroll took them.
    kept: rustc_hash::FxHashSet<u64>,
    /// The rows of the frame shown that the frame built again where they are, because the recording of each no longer fits
    /// where the scroll put it. They are in `built`; a frame that kept none of its rows has moved the rows all the same.
    rebuilt: rustc_hash::FxHashSet<u64>,
    /// The rows that left and the page's records have not forgotten yet ([`TapeStore::take_left`]).
    left: Vec<u64>,
}

pub(crate) type Tapes = Rc<TapeStore>;

impl TapeStore {
    /// The tape the build of `root` records into: the last build's, emptied, when nothing but the
    /// store holds it (the lists it has are reused when nothing holds them either), else a new one.
    pub(crate) fn renew(&self, root: u64) -> SharedTape {
        self.moved.borrow_mut().remove(&root);
        let mut tapes = self.tapes.borrow_mut();
        if let Some(tape) = tapes.get(&root).filter(|tape| Rc::strong_count(tape) == 1) {
            tape.borrow_mut().renew();
            return tape.clone();
        }
        let tape = SharedTape::default();
        tapes.insert(root, tape.clone());
        tape
    }

    pub(crate) fn set(&self, root: u64, tape: SharedTape) {
        self.moved.borrow_mut().remove(&root);
        self.tapes.borrow_mut().insert(root, tape);
    }

    /// How far from where the last build of `root` wrote it the frame shown has it: what a patch that builds the root again, where
    /// layout puts it, has to add to what it publishes for the registries to say where the frame shows it.
    pub(crate) fn moved(&self, root: u64) -> Point<Pixels> {
        self.moved.borrow().get(&root).copied().unwrap_or_default()
    }

    /// `tape` is what a pass that only lays out wrote when it built `root`.
    pub(crate) fn set_laid_out(&self, root: u64, tape: SharedTape) {
        self.laid_out.borrow_mut().insert(root, tape);
    }

    /// Puts back what the pass that only laid out wrote when it built `root`, `delta` from where it
    /// wrote it.
    fn replay_laid_out(&self, window: WindowId, root: u64, delta: Point<Pixels>) {
        let tape = self
            .laid_out
            .borrow()
            .get(&root)
            .expect("a root skipped with its layout record has the tape of the build that made it")
            .clone();
        tape.borrow().replay(window, Phase::LayoutRecorded, delta);
    }

    /// Whether `captured`, the tape of a subtree prepainted and painted again, holds the writes
    /// that the tape of the build of `root` the frame was recorded from holds, the transforms around
    /// its elements aside.
    pub(crate) fn same_as_recorded(&self, root: u64, captured: &SharedTape, moved: Point<Pixels>) -> bool {
        self.tapes
            .borrow()
            .get(&root)
            .is_some_and(|recorded| captured.borrow().same_writes_apart_from_transforms(&recorded.borrow(), moved))
    }

    /// `captured`, the tape of an anchor that a patch laid out again, is what the last build of `root` wrote now,
    /// `moved` from where the patch built it: the registries give what the build before wrote for what `captured`
    /// writes (the boxes of elements it no longer writes are forgotten, the others published as the patch left them),
    /// and the frame that replays or compares the root finds `captured`.
    pub(crate) fn replace_recorded(&self, window: WindowId, root: u64, captured: &SharedTape, moved: Point<Pixels>) {
        let old = self.tapes.borrow().get(&root).cloned();
        if let Some(old) = old {
            let (old, new) = (old.borrow(), captured.borrow());
            let roots = old.roots();
            crate::text::replace(window, &roots, &new.lives(moved));
            let mut written = rustc_hash::FxHashSet::default();
            new.each(Kind::Bounds, &mut |data, offset| {
                written.insert(crate::automation::id_of_bounds_write(data));
                crate::automation::publish_captured_bounds(data, offset + moved);
            });
            let mut gone = Vec::new();
            old.each(Kind::Bounds, &mut |data, _| {
                let id = crate::automation::id_of_bounds_write(data);
                if !written.contains(&id) {
                    gone.push(id);
                }
            });
            crate::automation::forget_boxes(window, &gone);
        }
        self.tapes.borrow_mut().insert(root, captured.clone());
    }

    /// `captured`, the tape of a row of a list that a patch built again where it stands, has the writes the tape of the last build of
    /// `root` has (the patch only repainted it, which `same_as_recorded` says) and is what that build wrote now: the text registries
    /// take its text layouts, the ones gpui moves with the recording it rewrote, and the frames that replay or compare the root find
    /// it. The boxes are published again where the frame shows them (`moved` from where the patch built them), as the writes of
    /// `captured`, so that a frame that moves the row moves them with the tape it finds for it.
    pub(crate) fn replace_recorded_paint(&self, window: WindowId, root: u64, captured: &SharedTape, moved: Point<Pixels>) {
        let old = self.tapes.borrow().get(&root).cloned().expect("a row that a patch repainted has the tape of the build it was recorded from");
        let new = captured.borrow();
        crate::text::replace(window, &old.borrow().roots(), &new.lives(moved));
        let before = OWNER.replace(new.prepaint.serial);
        new.each(Kind::Bounds, &mut |data, offset| crate::automation::publish_captured_bounds(data, offset + moved));
        OWNER.set(before);
        drop(new);
        self.tapes.borrow_mut().insert(root, captured.clone());
    }

    /// Replays what the last build of `root` wrote in `phase`, `delta` from where it wrote it.
    pub(crate) fn replay(&self, window: WindowId, root: u64, phase: Phase, delta: Point<Pixels>) {
        if phase == Phase::LayoutRecorded {
            return self.replay_laid_out(window, root, delta);
        }
        let tape = self
            .tapes
            .borrow()
            .get(&root)
            .expect("a replayed root has the tape of the build it was recorded from")
            .clone();
        if self.verifying.get() {
            match phase {
                Phase::Prepaint => self.replayed.borrow_mut().push((root, tape.borrow().describe(delta))),
                Phase::Lifted(rel) => self.replayed_lifted.borrow_mut().push((root, rel, tape.borrow().describe_lifted(rel))),
                _ => {}
            }
        }
        if matches!(phase, Phase::Prepaint | Phase::Paint | Phase::Lifted(_)) {
            self.moved.borrow_mut().insert(root, delta);
        }
        tape.borrow().replay(window, phase, delta);
    }

    /// A frame moved the rows of a list in place: the root `root` is `shift` further than the frame
    /// shown had it, and everything it wrote into the registries that the frame shown made is moved
    /// the same. Not written again, which would put it into the registries twice.
    pub(crate) fn shift(&self, window: WindowId, root: u64, shift: Point<Pixels>) {
        self.rows.borrow_mut().kept.insert(root);
        {
            let mut moved = self.moved.borrow_mut();
            let at = moved.entry(root).or_default();
            *at = *at + shift;
        }
        let tape = self
            .tapes
            .borrow()
            .get(&root)
            .expect("a root that a frame moves has the tape of the build it was recorded from")
            .clone();
        let tape = tape.borrow();
        let roots = tape.roots();
        let mut boxes = Vec::new();
        tape.each(Kind::Bounds, &mut |data, _| boxes.push(crate::automation::id_of_bounds_write(data)));
        crate::automation::shift(window, &boxes, &roots, shift);
        crate::text::shift(window, &roots, shift);
    }

    /// A frame is built whole: the rows it builds are the rows of the frame shown.
    pub(crate) fn begin_rows(&self) {
        let mut rows = self.rows.borrow_mut();
        rows.shown.clear();
        rows.built.clear();
        rows.kept.clear();
        rows.rebuilt.clear();
    }

    /// The list `list` builds its row `row`, the one at `index`, in a build that `records` (a presented frame, not a pass that only
    /// lays out). Whether the frame shown holds the row: then the build is of a frame that moves the rows, which builds the row again
    /// where it is, and what the row wrote before is taken out of the registries now, before the build writes what it writes
    /// (the boxes it writes again are put back as it writes them). The caller drops the page's records of the row, which a frame that
    /// builds the row as one that came in has none of.
    pub(crate) fn row_built(&self, window: WindowId, records: bool, list: u64, index: usize, row: u64) -> bool {
        let rebuilt = {
            let mut rows = self.rows.borrow_mut();
            rows.built.insert(row, (list, index));
            let rebuilt = records && rows.shown.contains_key(&row);
            if rebuilt {
                rows.rebuilt.insert(row);
            }
            rebuilt
        };
        if rebuilt {
            if let Some(old) = self.tapes.borrow().get(&row) {
                let old = old.borrow();
                let mut boxes = Vec::new();
                old.each(Kind::Bounds, &mut |data, _| boxes.push(crate::automation::id_of_bounds_write(data)));
                crate::text::replace(window, &old.roots(), &[]);
                crate::automation::forget_boxes(window, &boxes);
            }
        }
        rebuilt
    }

    /// A list scrolled and the frame about to be drawn may move its rows: what was built since the
    /// frame shown was settled is part of it.
    pub(crate) fn fold_rows(&self, window: WindowId) {
        self.settle_rows(window);
        let mut rows = self.rows.borrow_mut();
        let built = std::mem::take(&mut rows.built);
        rows.shown.extend(built);
    }

    /// Takes out of the registries what the rows that a frame that moved the rows in place took out of
    /// the frame wrote, and forgets their tapes: the frame built whole has none of it, and a row that
    /// comes in again is built, so its tape is its own. Does nothing until such a frame has moved
    /// rows (kept one in place, or built one again where it is), and once for each.
    pub(crate) fn settle_rows(&self, window: WindowId) {
        let mut rows = self.rows.borrow_mut();
        if rows.kept.is_empty() && rows.rebuilt.is_empty() {
            return;
        }
        let kept = std::mem::take(&mut rows.kept);
        rows.rebuilt.clear();
        let entered = std::mem::take(&mut rows.built);
        let lists: rustc_hash::FxHashSet<u64> = kept
            .iter()
            .filter_map(|row| rows.shown.get(row))
            .chain(entered.values())
            .map(|(list, _)| *list)
            .collect();
        let left: Vec<u64> = rows
            .shown
            .iter()
            .filter(|(row, (list, _))| lists.contains(list) && !kept.contains(*row) && !entered.contains_key(*row))
            .map(|(row, _)| *row)
            .collect();
        for row in &left {
            rows.shown.remove(row);
        }
        let came: rustc_hash::FxHashSet<u64> = entered.values().map(|(list, _)| *list).collect();
        rows.shown.extend(entered);
        rows.left.extend(&left);
        let mut order: Vec<(u64, usize, u64)> = rows
            .shown
            .iter()
            .filter(|(_, (list, _))| came.contains(list))
            .map(|(row, (list, index))| (*list, *index, *row))
            .collect();
        drop(rows);
        let mut roots = Roots(Vec::new());
        let mut boxes = Vec::new();
        for row in left {
            self.laid_out.borrow_mut().remove(&row);
            let Some(tape) = self.tapes.borrow_mut().remove(&row) else {
                continue;
            };
            let tape = tape.borrow();
            roots.extend(tape.roots());
            tape.each(Kind::Bounds, &mut |data, _| boxes.push(crate::automation::id_of_bounds_write(data)));
        }
        crate::text::replace(window, &roots, &[]);
        crate::automation::forget_boxes(window, &boxes);
        // The rows that came in were written after everything else, wherever they belong in the list.
        order.sort_unstable();
        let tapes = self.tapes.borrow();
        for list in came {
            let rows: Vec<Roots> = order
                .iter()
                .filter(|(owner, ..)| *owner == list)
                .filter_map(|(.., row)| tapes.get(row).map(|tape| tape.borrow().roots()))
                .collect();
            crate::text::order_by_rows(window, &rows);
        }
    }

    /// The rows that left since this was last asked, for the records the page keeps of them to go.
    pub(crate) fn take_left(&self) -> Vec<u64> {
        std::mem::take(&mut self.rows.borrow_mut().left)
    }

    /// The context starts to paint an element that `root` handed to it: what the element writes
    /// until [`Self::end_lifted`] is on the tape of `root`, under `rel`.
    pub(crate) fn begin_lifted(&self, root: u64, rel: u32) {
        let tape = self
            .tapes
            .borrow()
            .get(&root)
            .expect("a root that hands an element to the stacking context has the tape of its build")
            .clone();
        tape.borrow_mut().start(Phase::Lifted(rel));
        RECORDING.with(|recordings| recordings.borrow_mut().push(Recording { tape, phase: Phase::Lifted(rel) }));
    }

    pub(crate) fn end_lifted(&self, root: u64) {
        let recording = RECORDING.with(|recordings| recordings.borrow_mut().pop().expect("a lifted element that begun is ended"));
        debug_assert!(
            matches!(recording.phase, Phase::Lifted(_))
                && self.tapes.borrow().get(&root).is_some_and(|tape| Rc::ptr_eq(tape, &recording.tape)),
            "the ends of lifted elements come in the reverse order of their beginnings"
        );
        recording.end();
    }

    pub(crate) fn verify(&self, verifying: bool) {
        self.verifying.set(verifying);
    }

    /// Forgets the roots that replayed in the pass before.
    pub(crate) fn forget_replays(&self) {
        self.replayed.borrow_mut().clear();
        self.replayed_lifted.borrow_mut().clear();
    }

    /// What the roots that replayed wrote: in the pass that replayed them, what their tapes said
    /// when they did; in the pass that built them, what their tapes say now.
    pub(crate) fn describe_replays(&self, built: bool) -> String {
        let mut replayed = self.replayed.borrow().clone();
        replayed.sort_by_key(|(root, _)| *root);
        replayed
            .into_iter()
            .map(|(root, replayed)| {
                let (tape, lifted) = if built {
                    self.tapes.borrow().get(&root).map_or_else(Default::default, |tape| {
                        let tape = tape.borrow();
                        let lifted = (0..tape.lifted.len() as u32)
                            .map(|rel| tape.describe_lifted(rel))
                            .filter(|slice| !slice.is_empty())
                            .collect::<String>();
                        (tape.describe(Point::default()), lifted)
                    })
                } else {
                    let mut slices: Vec<(u32, String)> = self
                        .replayed_lifted
                        .borrow()
                        .iter()
                        .filter(|(replayed_root, _, slice)| *replayed_root == root && !slice.is_empty())
                        .map(|(_, rel, slice)| (*rel, slice.clone()))
                        .collect();
                    slices.sort_by_key(|(rel, _)| *rel);
                    (replayed, slices.into_iter().map(|(_, slice)| slice).collect())
                };
                format!("tape {root}\n{tape}put back\n{lifted}")
            })
            .collect()
    }

    pub(crate) fn retain(&self, mut keep: impl FnMut(u64) -> bool) {
        self.tapes.borrow_mut().retain(|root, _| keep(*root));
        self.laid_out.borrow_mut().retain(|root, _| keep(*root));
    }
}

struct Recording {
    tape: SharedTape,
    phase: Phase,
}

impl Recording {
    /// The subtree is done: what it wrote is part of the subtree it is inside, if it is inside one.
    fn end(self) {
        let written = self.tape.borrow().entries(self.phase).expect("a recording has its list").clone();
        RECORDING.with(|recordings| {
            if let Some(outer) = recordings.borrow().last() {
                outer.tape.borrow_mut().recording(outer.phase).push_nested(written, Point::default());
            }
        });
    }
}

thread_local! {
    /// The subtrees being prepainted or painted, innermost last. A write belongs to the tape of
    /// the innermost, which the subtrees around it hold by reference once it is done.
    static RECORDING: RefCell<Vec<Recording>> = const { RefCell::new(Vec::new()) };
    /// How many of them are on a tape that [captures](Tape::capturing).
    static CAPTURING: Cell<u32> = const { Cell::new(0) };
}

/// Whether the writes being made are only noted, see [`Tape::capturing`]. For a registry that is
/// written beside the tape, outside [`write`], to leave alone what the frame before made.
pub(crate) fn is_capturing() -> bool {
    CAPTURING.get() > 0
}

/// Which list the write being made is recorded into, or 0 when it is made outside any subtree
/// that records. A registry that answers by element, and does not keep a write per replay, notes it
/// with the write and asks [`Live::mark`] which lists a replay put back.
pub(crate) fn owner() -> u64 {
    OWNER.get()
}

/// Makes a registry write with `apply`, and notes it on the tape of the subtree being prepainted
/// or painted, if there is one, for `describe` to say in words and a frame that replays the
/// subtree to put back. A frame without retained subtrees pays one thread-local read per write.
///
/// `apply` makes the write where it was made; a replay is read by the registry, which is given
/// how far from there it is (`describe` takes that too: a write that holds a position moves by it,
/// any other ignores it).
pub(crate) fn write<D: 'static>(kind: Kind, data: D, apply: fn(&D), describe: fn(&D, Point<Pixels>) -> String) {
    write_with(kind, data, apply, describe, false);
}

/// [`write`] for a registry that a pass which only lays out (a bounds read) writes too, from
/// prepaint: the painted boxes. A subtree that such a pass does not build repeats it from its tape.
pub(crate) fn write_in_layout<D: 'static>(kind: Kind, data: D, apply: fn(&D), describe: fn(&D, Point<Pixels>) -> String) {
    write_with(kind, data, apply, describe, true);
}

fn write_with<D: 'static>(kind: Kind, data: D, apply: fn(&D), describe: fn(&D, Point<Pixels>) -> String, in_layout: bool) {
    let list = RECORDING.with(|recordings| {
        recordings.borrow().last().map(|recording| recording.tape.borrow_mut().recording(recording.phase).serial)
    });
    if !is_capturing() {
        OWNER.set(list.unwrap_or(0));
        apply(&data);
        OWNER.set(0);
    }
    if list.is_some() {
        let effect: Effect = Rc::new(Write { data, describe, in_layout, kind });
        RECORDING.with(|recordings| {
            let recordings = recordings.borrow();
            let recording = recordings.last().expect("a list was found");
            recording.tape.borrow_mut().recording(recording.phase).push_write(effect);
        });
    }
}

/// Puts `tape` under `phase` for as long as it lives. A guard, so that an unwinding paint does not
/// leave a stale tape for the next frame's unrelated writes.
struct Recorder {
    capturing: bool,
}

impl Recorder {
    fn begin(tape: &SharedTape, phase: Phase) -> Self {
        let capturing = tape.borrow().capture_only;
        tape.borrow_mut().start(phase);
        RECORDING.with(|recordings| {
            recordings.borrow_mut().push(Recording { tape: tape.clone(), phase });
        });
        if capturing {
            CAPTURING.set(CAPTURING.get() + 1);
        }
        Self { capturing }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let recording = RECORDING.with(|recordings| recordings.borrow_mut().pop());
        if let Some(recording) = recording {
            recording.end();
        }
        if self.capturing {
            CAPTURING.set(CAPTURING.get() - 1);
        }
    }
}

/// The root of a retained subtree, recording what the subtree writes into the registries.
///
/// It has no node of its own: it asks for the layout of the element it holds and says what that
/// element says of its stacking and clip, as `Retained` needs the subtree's root to.
pub(crate) struct Taped {
    child: AnyElement,
    tape: SharedTape,
}

impl Taped {
    pub(crate) fn new(child: AnyElement, tape: SharedTape) -> Self {
        Self { child, tape }
    }

    /// The root of a subtree built by a pass that only lays out, with the tape of [`Tape::laid_out`].
    pub(crate) fn laid_out(child: AnyElement, tape: SharedTape) -> Self {
        debug_assert!(tape.borrow().laid_out);
        Self { child, tape }
    }

    /// A pass that only lays out has no paint: what the listeners of the subtree write from the
    /// publications they queued in prepaint is recorded between two publications queued around the
    /// prepaint, which run in the order they were queued, outside every prepaint.
    fn prepaint_laid_out(&mut self, window: &mut Window, cx: &mut App) {
        let publishing: Rc<RefCell<Option<Recorder>>> = Rc::default();
        window.publish_layout({
            let (publishing, tape) = (publishing.clone(), self.tape.clone());
            move |_, _| *publishing.borrow_mut() = Some(Recorder::begin(&tape, Phase::Paint))
        });
        {
            self.tape.borrow_mut().lifted.clear();
            let _recording = Recorder::begin(&self.tape, Phase::Prepaint);
            self.child.prepaint(window, cx);
        }
        window.publish_layout(move |_, _| drop(publishing.borrow_mut().take()));
    }
}

impl gpui::IntoElement for Taped {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Taped {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn escapes_to(&self) -> Option<gpui::Escape> {
        self.child.escapes_to()
    }

    // The tape reads no bounds. A subtree that is built whole inside another has no `Taped` around
    // its root, so one that escaped twice would record a frame deeper than the whole build it is
    // compared with.
    fn forwards_escape(&self) -> bool {
        true
    }

    fn lift_z(&self) -> Option<i32> {
        self.child.lift_z()
    }

    fn cull_outset(&self) -> Option<Edges<Pixels>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.tape.borrow().laid_out {
            return self.prepaint_laid_out(window, cx);
        }
        self.tape.borrow_mut().lifted.clear();
        let _recording = Recorder::begin(&self.tape, Phase::Prepaint);
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let _recording = Recorder::begin(&self.tape, Phase::Paint);
        self.child.paint(window, cx);
    }
}

/// What building an element does outside the frame, which a frame that skips the element does
/// not do and so repeats from the record of the last build.
#[derive(Clone, Debug)]
pub(crate) enum BuildEffect {
    /// The element was wrapped to be measured, which keeps its measurement from being pruned.
    Measured(u64),
    /// A style asked for the image at the address, which keeps it loaded and from being evicted.
    Image(gpui::ImageKey, Rc<str>),
    /// A style read the content box of a query container, which the container compares with the
    /// one it has after layout (`ContainerScope::assumption_failed`). The container is outside the
    /// subtree or inside it; one inside has no scope to repeat the read on, and does not need it.
    ContainerRead(u64, crate::css::container_query::Axes),
}

thread_local! {
    /// The build effects of the session being built, in the order they were made.
    static BUILD_EFFECTS: RefCell<Vec<BuildEffect>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn note_build(effect: BuildEffect) {
    BUILD_EFFECTS.with(|effects| effects.borrow_mut().push(effect));
}

pub(crate) fn build_effects_len() -> usize {
    BUILD_EFFECTS.with(|effects| effects.borrow().len())
}

/// The effects noted from `start`, for the record of the element that was built since.
pub(crate) fn build_effects_since(start: usize) -> Vec<BuildEffect> {
    BUILD_EFFECTS.with(|effects| effects.borrow().get(start..).map_or_else(Vec::new, <[BuildEffect]>::to_vec))
}

/// Forgets the notes made from `len`: a build that is not a session's (see
/// `GpuixView::build_unit`) leaves the list as it found it.
pub(crate) fn truncate_build_effects(len: usize) {
    BUILD_EFFECTS.with(|effects| effects.borrow_mut().truncate(len));
}

/// Forgets every note: the frame (or the deferred build) that started a session starts the list
/// over, since a record keeps its own slice.
pub(crate) fn clear_build_effects() {
    BUILD_EFFECTS.with(|effects| effects.borrow_mut().clear());
}


#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        static REGISTRY: Cell<i32> = const { Cell::new(0) };
    }

    /// A write of the kind that is compared by its words, which holds anything.
    fn add(amount: i32) {
        write(Kind::Paragraph, amount, |amount| REGISTRY.set(REGISTRY.get() + amount), |amount, _| format!("add {amount}"));
    }

    fn record(tape: &SharedTape, writes: &[i32]) {
        let _recording = Recorder::begin(tape, Phase::Paint);
        for amount in writes {
            add(*amount);
        }
    }

    #[test]
    fn a_tape_that_captures_notes_the_writes_and_makes_none() {
        REGISTRY.set(0);
        let recorded = SharedTape::default();
        record(&recorded, &[2, 3]);
        assert_eq!(REGISTRY.get(), 5);

        let captured = Tape::capturing();
        record(&captured, &[2, 3]);
        assert_eq!(REGISTRY.get(), 5, "a capture leaves the registry as the frame made it");
        assert!(!is_capturing(), "and only while it records");
        assert!(captured.borrow().same_writes(&recorded.borrow()));

        let other = Tape::capturing();
        record(&other, &[2, 4]);
        assert!(!other.borrow().same_writes(&recorded.borrow()), "a write that differs");
        let fewer = Tape::capturing();
        record(&fewer, &[2]);
        assert!(!fewer.borrow().same_writes(&recorded.borrow()), "a write that is missing");
        add(1);
        assert_eq!(REGISTRY.get(), 6, "a write outside any capture is made");
    }

    #[test]
    fn the_tape_of_a_root_is_compared_with_the_capture_of_a_build_of_it() {
        let tapes = TapeStore::default();
        let recorded = SharedTape::default();
        record(&recorded, &[7]);
        tapes.set(1, recorded);
        let same = Tape::capturing();
        record(&same, &[7]);
        assert!(tapes.same_as_recorded(1, &same, Point::default()));
        let different = Tape::capturing();
        record(&different, &[8]);
        assert!(!tapes.same_as_recorded(1, &different, Point::default()));
        assert!(!tapes.same_as_recorded(2, &same, Point::default()), "a root with no recording has nothing to be the same as");
    }

    fn laid_out(to_window: gpui::TransformationMatrix) -> crate::automation::LaidOut {
        let mut laid_out = crate::automation::LaidOut::of_box(
            gpui::Bounds::new(gpui::point(gpui::px(10.0), gpui::px(20.0)), gpui::size(gpui::px(30.0), gpui::px(40.0))),
            1.0,
        );
        laid_out.to_window = to_window;
        laid_out
    }

    fn record_box(tape: &SharedTape, window: WindowId, to_window: gpui::TransformationMatrix, width: f32) {
        let _recording = Recorder::begin(tape, Phase::Paint);
        let mut laid_out = laid_out(to_window);
        laid_out.border_box.size.width = gpui::px(width);
        crate::automation::record_bounds(window, 1, laid_out, gpui::point(gpui::px(10.0), gpui::px(20.0)), Default::default());
    }

    #[test]
    fn how_far_a_root_is_from_its_build_is_what_frames_moved_it_by_until_it_is_built_again() {
        let window = WindowId::from(912);
        let down = |dy: f32| gpui::point(gpui::px(0.0), gpui::px(dy));
        let tapes = TapeStore::default();
        let recorded = SharedTape::default();
        record_box(&recorded, window, gpui::TransformationMatrix::unit(), 30.0);
        tapes.set(1, recorded);
        assert_eq!(tapes.moved(1), Point::default());

        tapes.shift(window, 1, down(-20.0));
        tapes.shift(window, 1, down(-40.0));
        assert_eq!(tapes.moved(1), down(-60.0), "scrolls add up");
        tapes.replay(window, 1, Phase::Paint, down(-100.0));
        assert_eq!(tapes.moved(1), down(-100.0), "a replay says where the root is");
        tapes.set(1, SharedTape::default());
        assert_eq!(tapes.moved(1), Point::default(), "a root built again is where it was built");
    }

    #[test]
    fn writes_compared_by_what_they_hold_are_the_same_as_when_compared_by_the_words_that_say_them() {
        let window = WindowId::from(913);
        let slid = |dx: f32| gpui::TransformationMatrix::affine([[1.0, 0.0], [0.0, 1.0]], [dx, 0.0]);
        let region = |x: f32, selectable: bool| {
            crate::text::record_start_region(
                window,
                7,
                gpui::Bounds::new(gpui::point(gpui::px(x), gpui::px(2.0)), gpui::size(gpui::px(8.0), gpui::px(9.0))),
                selectable,
                gpui::TransformationMatrix::unit(),
            )
        };
        let child = SharedTape::default();
        record_box(&child, window, slid(1.0), 12.0);
        // (matrix, width, text logged, region at x, region selectable, replayed child at dx)
        let variants: [(gpui::TransformationMatrix, f32, &str, f32, bool, Option<f32>); 9] = [
            (slid(5.0), 30.0, "a", 1.0, true, None),
            (slid(9.0), 30.0, "a", 1.0, true, None),
            (slid(5.0), 31.0, "a", 1.0, true, None),
            (slid(5.0), 30.0, "b", 1.0, true, None),
            (slid(5.0), 30.0, "a", 2.0, true, None),
            (slid(5.0), 30.0, "a", 1.0, false, None),
            (slid(5.0), 30.0, "a", 1.0, true, Some(0.0)),
            (slid(5.0), 30.0, "a", 1.0, true, Some(4.0)),
            (gpui::TransformationMatrix::unit(), 30.0, "a", 1.0, true, Some(4.0)),
        ];
        let tapes: Vec<SharedTape> = variants
            .iter()
            .map(|(matrix, width, text, x, selectable, replayed)| {
                let tape = SharedTape::default();
                {
                    let _recording = Recorder::begin(&tape, Phase::Paint);
                    let mut laid_out = laid_out(*matrix);
                    laid_out.border_box.size.width = gpui::px(*width);
                    crate::automation::record_bounds(window, 1, laid_out, gpui::point(gpui::px(10.0), gpui::px(20.0)), Default::default());
                    crate::text::log_painted_text(window, (*text).into());
                    region(*x, *selectable);
                    if let Some(dx) = replayed {
                        child.borrow().replay(window, Phase::Paint, gpui::point(gpui::px(*dx), gpui::px(0.0)));
                    }
                }
                tape
            })
            .collect();
        let (mut same, mut different) = (0, 0);
        for moved in [Point::default(), gpui::point(gpui::px(3.0), gpui::px(-2.0))] {
            for left in &tapes {
                for right in &tapes {
                    let (left, right) = (left.borrow(), right.borrow());
                    let by_what_they_hold = left.same_writes_apart_from_transforms(&right, moved);
                    assert_eq!(by_what_they_hold, left.same_writes_by_words_apart_from_transforms(&right, moved));
                    if by_what_they_hold {
                        same += 1;
                    } else {
                        different += 1;
                    }
                }
            }
        }
        assert!(same > 18 && different > 18, "the variants are told apart and found equal: {same} same, {different} different");
    }

    #[test]
    fn a_capture_may_differ_from_the_recording_in_the_transforms_and_nothing_else() {
        let window = WindowId::from(911);
        let moved = |dx: f32| gpui::TransformationMatrix::affine([[1.0, 0.0], [0.0, 1.0]], [dx, 0.0]);
        let tapes = TapeStore::default();
        let recorded = SharedTape::default();
        record_box(&recorded, window, moved(5.0), 30.0);
        tapes.set(1, recorded.clone());

        let later = Tape::capturing();
        record_box(&later, window, moved(9.0), 30.0);
        assert!(!later.borrow().same_writes(&recorded.borrow()), "the placement is a write like the others");
        assert!(tapes.same_as_recorded(1, &later, Point::default()), "but a patch of a transform that moves paints the same");
        let wider = Tape::capturing();
        record_box(&wider, window, moved(5.0), 31.0);
        assert!(!tapes.same_as_recorded(1, &wider, Point::default()), "a box that is another size is not the same");

        let mut published = 0;
        later.borrow().each(Kind::Bounds, &mut |data, offset| {
            published += 1;
            crate::automation::publish_captured_bounds(data, offset);
        });
        assert_eq!(published, 1);
        assert_eq!(crate::automation::get_bounds(window, 1).unwrap().to_window, moved(9.0));
    }

    fn log(window: WindowId, text: &'static str) {
        crate::text::log_painted_text(window, text.into());
    }

    fn record_logs(tape: &SharedTape, window: WindowId, texts: &[&'static str]) {
        let _recording = Recorder::begin(tape, Phase::Paint);
        for text in texts {
            log(window, text);
        }
    }

    fn replay(tape: &SharedTape, window: WindowId) {
        tape.borrow().replay(window, Phase::Paint, Point::default());
    }

    #[test]
    fn a_replay_is_read_among_the_writes_made_around_it_in_the_order_they_came() {
        let (recorded_in, window) = (WindowId::from(901), WindowId::from(902));
        let tape = SharedTape::default();
        record_logs(&tape, recorded_in, &["a", "b"]);

        log(window, "before");
        replay(&tape, window);
        log(window, "between");
        replay(&tape, window);
        log(window, "after");
        assert_eq!(crate::text::painted_text(window), ["before", "a", "b", "between", "a", "b", "after"]);
    }

    #[test]
    fn a_replay_holds_what_the_subtree_wrote_then_and_not_what_it_writes_when_built_again() {
        let (recorded_in, window) = (WindowId::from(903), WindowId::from(904));
        let tape = SharedTape::default();
        record_logs(&tape, recorded_in, &["old"]);
        replay(&tape, window);
        record_logs(&tape, recorded_in, &["new"]);
        assert_eq!(crate::text::painted_text(window), ["old"]);
        replay(&tape, window);
        assert_eq!(crate::text::painted_text(window), ["old", "new"]);
    }

    #[test]
    fn a_tape_that_the_store_renews_is_emptied_in_place_and_leaves_what_a_replay_holds() {
        let (recorded_in, window) = (WindowId::from(931), WindowId::from(932));
        let tapes = TapeStore::default();
        let first = tapes.renew(1);
        record_logs(&first, recorded_in, &["old"]);
        replay(&first, window);
        let first_serial = first.borrow().roots().0;
        drop(first);

        let second = tapes.renew(1);
        assert_ne!(second.borrow().roots().0[1], first_serial[1], "the list a replay holds is left as it was, and the tape has one of its own");
        record_logs(&second, recorded_in, &["new"]);
        assert_eq!(crate::text::painted_text(window), ["old"]);
        replay(&second, window);
        assert_eq!(crate::text::painted_text(window), ["old", "new"]);
        let second_serial = second.borrow().roots().0;
        let second_address = Rc::as_ptr(&second);
        drop(second);

        // Nothing holds this one any more but the registry of another window, which has not read it.
        let third = tapes.renew(1);
        assert_eq!(Rc::as_ptr(&third), second_address, "the tape of the store is reused");
        assert_ne!(third.borrow().roots().0[1], second_serial[1], "what was written under a serial is not taken for what is written now");
        for kind in [Kind::Bounds, Kind::StartRegion, Kind::Painted, Kind::Text, Kind::Paragraph, Kind::Measured] {
            third.borrow().each(kind, &mut |_, _| panic!("a renewed tape holds no write"));
        }
    }

    #[test]
    fn a_subtree_that_replays_or_is_built_inside_another_is_part_of_its_tape_either_way() {
        let (recorded_in, window) = (WindowId::from(905), WindowId::from(906));
        let inner = SharedTape::default();
        record_logs(&inner, recorded_in, &["i1", "i2"]);

        let replayed = SharedTape::default();
        {
            let _recording = Recorder::begin(&replayed, Phase::Paint);
            log(window, "o1");
            replay(&inner, window);
            log(window, "o2");
        }
        let built = SharedTape::default();
        {
            let _recording = Recorder::begin(&built, Phase::Paint);
            log(window, "o1");
            record_logs(&SharedTape::default(), window, &["i1", "i2"]);
            log(window, "o2");
        }
        let whole = SharedTape::default();
        record_logs(&whole, window, &["o1", "i1", "i2", "o2"]);

        let said = whole.borrow().describe(Point::default());
        assert_eq!(replayed.borrow().describe(Point::default()), said);
        assert_eq!(built.borrow().describe(Point::default()), said);
        assert!(replayed.borrow().same_writes(&whole.borrow()));
        assert!(built.borrow().same_writes(&whole.borrow()));
    }

    fn box_at(window: WindowId, id: u64, x: f32) {
        use crate::automation::{record_bounds, LaidOut};
        let bounds = Bounds::new(gpui::point(gpui::px(x), gpui::px(0.0)), gpui::size(gpui::px(5.0), gpui::px(5.0)));
        record_bounds(window, id, LaidOut::of_box(bounds, 1.0), bounds.origin, Default::default());
    }

    fn x_of(window: WindowId, id: u64) -> Option<f64> {
        crate::automation::get_bounds(window, id).map(|bounds| bounds.x)
    }

    #[test]
    fn a_box_is_the_one_the_frame_wrote_or_the_one_a_replayed_subtree_recorded_moved_by_the_replay() {
        let window = WindowId::from(907);
        let tape = SharedTape::default();
        {
            let _recording = Recorder::begin(&tape, Phase::Paint);
            box_at(window, 7, 10.0);
        }
        crate::automation::forget_window(window);
        assert_eq!(x_of(window, 7), None, "a frame forgets the boxes of the one before");

        tape.borrow().replay(window, Phase::Paint, gpui::point(gpui::px(3.0), gpui::px(0.0)));
        assert_eq!(x_of(window, 7), Some(13.0));

        // A pass that builds the element and records nothing writes it where the build put it,
        // and the pass after it that replays the subtree finds the box the tape holds.
        crate::automation::forget_window(window);
        box_at(window, 7, 99.0);
        assert_eq!(x_of(window, 7), Some(99.0));
        crate::automation::forget_window(window);
        replay(&tape, window);
        assert_eq!(x_of(window, 7), Some(10.0));

        crate::automation::forget_window(window);
        assert_eq!(x_of(window, 7), None);
    }

    #[test]
    fn a_box_of_a_subtree_inside_another_is_put_back_by_the_replay_of_either() {
        let window = WindowId::from(908);
        let (outer, inner) = (SharedTape::default(), SharedTape::default());
        {
            let _outer = Recorder::begin(&outer, Phase::Paint);
            box_at(window, 1, 5.0);
            let _inner = Recorder::begin(&inner, Phase::Paint);
            box_at(window, 2, 20.0);
        }
        let by = gpui::point(gpui::px(3.0), gpui::px(0.0));

        crate::automation::forget_window(window);
        outer.borrow().replay(window, Phase::Paint, by);
        assert_eq!((x_of(window, 1), x_of(window, 2)), (Some(8.0), Some(23.0)), "the replay moves what is nested in it");

        crate::automation::forget_window(window);
        inner.borrow().replay(window, Phase::Paint, by);
        assert_eq!((x_of(window, 1), x_of(window, 2)), (None, Some(23.0)), "and the replay of what is nested only what it holds");
    }

    fn record_laid_out(tape: &SharedTape, window: WindowId, id: u64, x: f32) {
        let _recording = Recorder::begin(tape, Phase::Paint);
        box_at(window, id, x);
    }

    #[test]
    fn a_box_of_a_layout_tape_and_one_of_a_painted_tape_are_each_put_back_by_their_own_replay() {
        let window = WindowId::from(909);
        let painted = SharedTape::default();
        {
            let _recording = Recorder::begin(&painted, Phase::Paint);
            box_at(window, 1, 10.0);
        }
        let laid_out = Tape::laid_out();
        record_laid_out(&laid_out, window, 1, 20.0);
        assert!(is_laid_out(laid_out.borrow().paint.serial) && !is_laid_out(painted.borrow().paint.serial));

        // The box the layout tape wrote last is the box of the frame, and each replay puts back its own.
        crate::automation::forget_window(window);
        replay(&painted, window);
        assert_eq!(x_of(window, 1), Some(10.0));
        crate::automation::forget_window(window);
        laid_out.borrow().replay(window, Phase::LayoutRecorded, Point::default());
        assert_eq!(x_of(window, 1), Some(20.0));

        // A build that writes without recording leaves both.
        crate::automation::forget_window(window);
        box_at(window, 1, 99.0);
        crate::automation::forget_window(window);
        replay(&painted, window);
        assert_eq!(x_of(window, 1), Some(10.0));
        crate::automation::forget_window(window);
        laid_out.borrow().replay(window, Phase::LayoutRecorded, Point::default());
        assert_eq!(x_of(window, 1), Some(20.0));
    }

    #[test]
    fn a_layout_tape_skipped_inside_another_is_part_of_it() {
        let window = WindowId::from(910);
        let inner = Tape::laid_out();
        record_laid_out(&inner, window, 2, 20.0);

        // The pass that builds the outer subtree skips the inner one, which publishes when the
        // publications of the pass run, inside the outer one's bracket.
        let outer = Tape::laid_out();
        crate::automation::forget_window(window);
        {
            let _recording = Recorder::begin(&outer, Phase::Paint);
            box_at(window, 1, 5.0);
            inner.borrow().replay(window, Phase::LayoutRecorded, Point::default());
        }
        assert_eq!((x_of(window, 1), x_of(window, 2)), (Some(5.0), Some(20.0)));

        crate::automation::forget_window(window);
        outer.borrow().replay(window, Phase::LayoutRecorded, gpui::point(gpui::px(3.0), gpui::px(0.0)));
        assert_eq!((x_of(window, 1), x_of(window, 2)), (Some(8.0), Some(23.0)), "the replay of the outer moves what is nested");
    }

    #[test]
    fn a_root_skipped_with_its_layout_record_is_put_back_where_the_skip_says() {
        let window = WindowId::from(912);
        let store = TapeStore::default();
        let laid_out = Tape::laid_out();
        record_laid_out(&laid_out, window, 1, 20.0);
        store.set_laid_out(7, laid_out);

        // Each skip is as far from the build as the place says, and not from the skip before.
        for by in [3.0_f32, 0.0, 10.0, 10.0, -4.0] {
            crate::automation::forget_window(window);
            store.replay(window, 7, Phase::LayoutRecorded, gpui::point(gpui::px(by), gpui::px(0.0)));
            assert_eq!(x_of(window, 1), Some(f64::from(20.0 + by)));
        }
    }

    #[test]
    fn the_box_of_a_layout_tape_outlasts_the_frames_of_a_page_of_many_boxes() {
        let window = WindowId::from(911);
        let laid_out = Tape::laid_out();
        record_laid_out(&laid_out, window, 1, 20.0);
        // The first reset purges whatever there is, the ones after it only past 4096 boxes.
        crate::automation::forget_window(window);
        for frame in 0..3 {
            for id in 0..5000 {
                box_at(window, 100 + id, frame as f32);
            }
            crate::automation::forget_window(window);
        }
        laid_out.borrow().replay(window, Phase::LayoutRecorded, Point::default());
        assert_eq!(x_of(window, 1), Some(20.0), "the pass that lays the content out again finds its box");

        // Until the element is destroyed.
        crate::automation::retain_bounds(window, |id| id != 1);
        crate::automation::forget_window(window);
        laid_out.borrow().replay(window, Phase::LayoutRecorded, Point::default());
        assert_eq!(x_of(window, 1), None);
    }

    #[test]
    fn the_boxes_a_forced_pass_left_are_read_after_frames_that_did_not_write_them() {
        let window = WindowId::from(913);
        let laid_out = Tape::laid_out();
        record_laid_out(&laid_out, window, 2, 20.0);

        // The pass writes one box and puts back another by a layout record, moved by 3.
        crate::automation::forget_window(window);
        box_at(window, 1, 5.0);
        laid_out.borrow().replay(window, Phase::LayoutRecorded, gpui::point(gpui::px(3.0), gpui::px(0.0)));
        assert_eq!((x_of(window, 1), x_of(window, 2)), (Some(5.0), Some(23.0)));
        crate::automation::keep_bounds(window);

        // The frames after it write and replay neither; one writes another box.
        for frame in 0..3 {
            crate::automation::forget_window(window);
            box_at(window, 3, frame as f32);
            assert_eq!((x_of(window, 1), x_of(window, 2)), (None, None));
        }
        let kept = crate::automation::reading_kept(|| (x_of(window, 1), x_of(window, 2), x_of(window, 3), x_of(window, 4)));
        assert_eq!(kept, (Some(5.0), Some(23.0), Some(2.0), None), "the box a frame wrote is the frame's, and an element no pass wrote has none");
        assert_eq!((x_of(window, 1), x_of(window, 2)), (None, None), "and a read that is not of the pass's does not see them");

        // The boxes outlast a purge of a page of many boxes while they are the pass's.
        for frame in 0..3 {
            for id in 0..5000 {
                box_at(window, 100 + id, frame as f32);
            }
            crate::automation::forget_window(window);
        }
        assert_eq!(crate::automation::reading_kept(|| (x_of(window, 1), x_of(window, 2))), (Some(5.0), Some(23.0)));
    }

    #[test]
    fn the_notes_of_a_build_that_is_not_a_frames_are_taken_back() {
        clear_build_effects();
        note_build(BuildEffect::Measured(1));
        let start = build_effects_len();
        note_build(BuildEffect::Measured(2));
        truncate_build_effects(start);
        assert_eq!(build_effects_len(), 1);
    }

    fn nudge(window: WindowId) -> f64 {
        crate::automation::get_bounds(window, 1).expect("the box was written").y
    }

    #[test]
    fn a_shift_moves_the_box_of_a_root_that_was_built_and_of_one_that_was_replayed() {
        let window = WindowId::from(921);
        let tapes = TapeStore::default();
        let still = gpui::TransformationMatrix::unit();
        let tape = SharedTape::default();
        record_box(&tape, window, still, 30.0);
        tapes.set(1, tape.clone());
        assert_eq!(nudge(window), 20.0);

        // The frame wrote the box (the root was built): it is moved where the frame keeps it.
        tapes.shift(window, 1, gpui::point(gpui::px(0.0), gpui::px(-5.0)));
        assert_eq!(nudge(window), 15.0);
        tapes.shift(window, 1, gpui::point(gpui::px(0.0), gpui::px(-5.0)));
        assert_eq!(nudge(window), 10.0);

        // The next frame puts the root back, 3 down, and a shift moves the replay by what it moved.
        crate::automation::forget_window(window);
        tape.borrow().replay(window, Phase::Paint, gpui::point(gpui::px(0.0), gpui::px(3.0)));
        assert_eq!(nudge(window), 23.0);
        tapes.shift(window, 1, gpui::point(gpui::px(0.0), gpui::px(-5.0)));
        assert_eq!(nudge(window), 18.0);
        tapes.shift(window, 1, gpui::point(gpui::px(0.0), gpui::px(-5.0)));
        assert_eq!(nudge(window), 13.0);
    }

    #[test]
    fn a_shift_leaves_the_boxes_of_the_roots_it_is_not_for() {
        let window = WindowId::from(922);
        let tapes = TapeStore::default();
        let other = SharedTape::default();
        {
            let _recording = Recorder::begin(&other, Phase::Paint);
            crate::automation::record_bounds(window, 2, laid_out(gpui::TransformationMatrix::unit()), gpui::point(gpui::px(10.0), gpui::px(20.0)), Default::default());
        }
        let tape = SharedTape::default();
        record_box(&tape, window, gpui::TransformationMatrix::unit(), 30.0);
        tapes.set(1, tape);
        tapes.set(2, other);
        tapes.shift(window, 1, gpui::point(gpui::px(0.0), gpui::px(-5.0)));
        assert_eq!(nudge(window), 15.0);
        assert_eq!(crate::automation::get_bounds(window, 2).unwrap().y, 20.0);
    }

    #[test]
    fn a_shift_moves_what_a_root_wrote_into_a_layered_registry_and_what_was_nested_in_it() {
        let window = WindowId::from(923);
        let roots = |tape: &SharedTape| tape.borrow().roots();
        let outer = SharedTape::default();
        let inner = SharedTape::default();
        let mut registry: Layered<i32> = Layered::default();
        // A write the outer tape holds, one of a tape nested in it, and one outside both.
        {
            let _outer = Recorder::begin(&outer, Phase::Paint);
            OWNER.set(owner_of(&outer));
            registry.push(1);
            {
                let _inner = Recorder::begin(&inner, Phase::Paint);
                // A list with no write is not nested in the one around it.
                add(1);
                OWNER.set(owner_of(&inner));
                registry.push(2);
            }
            OWNER.set(0);
        }
        registry.push(3);
        log(window, "unrelated");
        let by = gpui::point(gpui::px(0.0), gpui::px(-5.0));
        registry.shift(&roots(&outer), by, |value, by| *value += f32::from(by.y) as i32);
        let read: Vec<i32> = registry.all(Kind::Paragraph, |_, _| 0).to_vec();
        assert_eq!(read, [-4, -3, 3]);
    }

    /// Writes `values` into `registry` as the recording of the list `owner` (0: outside any) does.
    fn push_owned(registry: &mut Layered<i32>, owner: u64, values: &[i32]) {
        for value in values {
            OWNER.set(owner);
            registry.push(*value);
        }
        OWNER.set(0);
    }

    fn numbers(registry: &mut Layered<i32>) -> Vec<i32> {
        registry.all(Kind::Paragraph, |data, _| *data.downcast_ref::<i32>().expect("the test writes numbers")).to_vec()
    }

    fn lives_of(tape: &SharedTape) -> Vec<Live> {
        tape.borrow().lives(Point::default()).into_iter().filter(|live| live.has(Kind::Paragraph)).collect()
    }

    fn read_number(data: &dyn Any, _: Point<Pixels>) -> i32 {
        *data.downcast_ref::<i32>().expect("the test writes numbers")
    }

    fn row_with_nested_list(outer: &SharedTape, inner: &SharedTape) {
        let _outer = Recorder::begin(outer, Phase::Paint);
        add(1);
        let _inner = Recorder::begin(inner, Phase::Paint);
        add(2);
    }

    #[test]
    fn a_replace_puts_the_new_writes_where_the_first_removed_one_was_and_keeps_the_order_of_the_rest() {
        let (old, inner, new, other) = (SharedTape::default(), SharedTape::default(), SharedTape::default(), SharedTape::default());
        row_with_nested_list(&old, &inner);
        record(&new, &[7, 8]);
        record(&other, &[40, 41]);
        let (old_list, inner_list, other_list) = (owner_of(&old), owner_of(&inner), owner_of(&other));
        let roots = old.borrow().roots();
        assert!(roots.hold(inner_list), "a list nested in a root is held by it");
        assert!(!roots.hold(other_list));

        let registry = || {
            let mut registry: Layered<i32> = Layered::default();
            push_owned(&mut registry, 0, &[10]);
            // The outer list, the one nested in it, the outer again, and a list that is not held.
            push_owned(&mut registry, old_list, &[20]);
            push_owned(&mut registry, inner_list, &[21]);
            push_owned(&mut registry, old_list, &[22]);
            push_owned(&mut registry, other_list, &[30]);
            registry
        };

        // Removed from what was read: the new writes take the place of the first, the rest stays in its order.
        let mut read = registry();
        read.replace(&roots, &lives_of(&new), Kind::Paragraph, read_number);
        assert_eq!(numbers(&mut read), [10, 7, 8, 30]);

        // A run of the owner apart from another is taken out as well, and the new writes go where the first run was.
        let mut apart = Layered::default();
        push_owned(&mut apart, old_list, &[20]);
        push_owned(&mut apart, other_list, &[30]);
        push_owned(&mut apart, inner_list, &[21]);
        push_owned(&mut apart, 0, &[10]);
        apart.replace(&roots, &lives_of(&new), Kind::Paragraph, read_number);
        assert_eq!(numbers(&mut apart), [7, 8, 30, 10]);

        // Nothing it holds: the new writes come last, as replays that are not expanded.
        let mut none: Layered<i32> = Layered::default();
        push_owned(&mut none, other_list, &[30]);
        none.replace(&roots, &lives_of(&new), Kind::Paragraph, read_number);
        assert!(matches!(none.pending.as_slice(), [Slot::Live(_)]));
        assert_eq!(numbers(&mut none), [30, 7, 8]);

        // No new writes: only the removal.
        let mut gone = registry();
        gone.replace(&roots, &[], Kind::Paragraph, read_number);
        assert_eq!(numbers(&mut gone), [10, 30]);
        let mut empty: Layered<i32> = Layered::default();
        empty.replace(&roots, &[], Kind::Paragraph, read_number);
        assert!(numbers(&mut empty).is_empty());
    }

    #[test]
    fn a_replace_keeps_a_replay_that_was_not_read_whole_and_puts_the_new_writes_in_the_place_of_the_first_it_takes_out() {
        let (old, inner, new, other, kept) =
            (SharedTape::default(), SharedTape::default(), SharedTape::default(), SharedTape::default(), SharedTape::default());
        row_with_nested_list(&old, &inner);
        record(&new, &[7, 8]);
        record(&other, &[40]);
        record(&kept, &[50, 51]);
        let roots = old.borrow().roots();
        let (old_list, inner_list) = (owner_of(&old), owner_of(&inner));

        let registry = || {
            let mut registry: Layered<i32> = Layered::default();
            push_owned(&mut registry, 0, &[10]);
            // Not read yet: a replay that is kept, a write of the old root, a replay of the old root (taken out whole), a
            // write of the list nested in it, and a write outside.
            registry.push_live(lives_of(&kept).remove(0));
            push_owned(&mut registry, old_list, &[20]);
            registry.push_live(lives_of(&old).remove(0));
            push_owned(&mut registry, inner_list, &[21]);
            push_owned(&mut registry, 0, &[60]);
            registry
        };

        // Nothing it holds was read: the new writes are a replay in the place of the first thing taken out of the replays.
        let mut registry_a = registry();
        registry_a.replace(&roots, &lives_of(&new), Kind::Paragraph, read_number);
        assert_eq!(registry_a.read.len(), 1);
        assert!(matches!(registry_a.pending.as_slice(), [Slot::Live(_), Slot::Live(_), Slot::One(60, 0)]));
        assert_eq!(numbers(&mut registry_a), [10, 50, 51, 7, 8, 60]);

        // What it held was read: the new writes go where that was, the replay of the old root is taken out and the new ones are
        // not put there as well, and the replays that are not its own are kept whole.
        let mut read_part: Layered<i32> = Layered::default();
        push_owned(&mut read_part, 0, &[10]);
        push_owned(&mut read_part, old_list, &[20]);
        push_owned(&mut read_part, 0, &[30]);
        read_part.push_live(lives_of(&kept).remove(0));
        read_part.push_live(lives_of(&old).remove(0));
        read_part.push_live(lives_of(&other).remove(0));
        read_part.replace(&roots, &lives_of(&new), Kind::Paragraph, read_number);
        assert_eq!(read_part.read.len(), 4);
        assert!(matches!(read_part.pending.as_slice(), [Slot::Live(_), Slot::Live(_)]), "the replays that stay are not expanded");
        assert_eq!(numbers(&mut read_part), [10, 7, 8, 30, 50, 51, 40]);
    }

    fn owner_of(tape: &SharedTape) -> u64 {
        tape.borrow().paint.serial
    }

    /// A row of a list: the tape of its build, with the box it painted (`x` from the row, which is what says it was built again
    /// elsewhere) and the text it logged. The list is told first, as `build_virtual_child` does, and what the build wrote goes
    /// into the registries as the frame paints it. Whether the frame shown held the row (it was built again).
    fn built_row_at(tapes: &TapeStore, window: WindowId, list: u64, row: u64, x: f32) -> bool {
        let rebuilt = tapes.row_built(window, true, list, row as usize, row);
        let tape = SharedTape::default();
        {
            let _recording = Recorder::begin(&tape, Phase::Paint);
            box_at(window, row, x);
            log(window, Box::leak(format!("row{row}").into_boxed_str()));
        }
        tapes.set(row, tape);
        rebuilt
    }

    fn built_row(tapes: &TapeStore, window: WindowId, list: u64, row: u64) {
        built_row_at(tapes, window, list, row, row as f32);
    }

    #[test]
    fn the_rows_that_a_frame_which_moved_the_rows_neither_kept_nor_built_left_and_their_writes_go() {
        let window = WindowId::from(924);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        for row in 1..=4 {
            built_row(&tapes, window, 100, row);
        }
        // A row of another list, which the frame does not move.
        built_row(&tapes, window, 200, 50);
        tapes.fold_rows(window);
        assert_eq!(crate::text::painted_text(window).len(), 5);

        // The frame keeps 3 and 4, and builds 5.
        built_row(&tapes, window, 100, 5);
        tapes.shift(window, 3, Point::default());
        tapes.shift(window, 4, Point::default());
        tapes.settle_rows(window);
        let mut left = tapes.take_left();
        left.sort();
        assert_eq!(left, [1, 2]);
        assert_eq!([1, 2, 3, 4, 5, 50].map(|row| x_of(window, row)), [None, None, Some(3.0), Some(4.0), Some(5.0), Some(50.0)]);
        assert!(tapes.take_left().is_empty(), "each row leaves once");
        tapes.settle_rows(window);
        assert!(tapes.take_left().is_empty());

        // The frame after keeps 4 and 5 and builds nothing: 3 left.
        tapes.fold_rows(window);
        tapes.shift(window, 4, Point::default());
        tapes.shift(window, 5, Point::default());
        tapes.settle_rows(window);
        assert_eq!(tapes.take_left(), [3]);
        assert_eq!([3, 4, 5, 50].map(|row| x_of(window, row)), [None, Some(4.0), Some(5.0), Some(50.0)]);
    }

    #[test]
    fn what_the_rows_that_came_in_wrote_is_read_where_their_rows_are_and_not_at_the_end() {
        let window = WindowId::from(926);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        for row in [3, 4, 5] {
            built_row(&tapes, window, 100, row);
        }
        log(window, "after the list");
        tapes.fold_rows(window);

        // 6 comes in at the tail and 2 at the head, 5 leaves.
        built_row(&tapes, window, 100, 6);
        built_row(&tapes, window, 100, 2);
        tapes.shift(window, 3, Point::default());
        tapes.shift(window, 4, Point::default());
        tapes.settle_rows(window);
        assert_eq!(tapes.take_left(), [5]);
        assert_eq!(crate::text::painted_text(window), ["row2", "row3", "row4", "row6", "after the list"]);
    }

    #[test]
    fn a_frame_that_moved_no_row_leaves_none_and_a_frame_built_whole_starts_the_rows_over() {
        let window = WindowId::from(925);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        for row in 1..=2 {
            built_row(&tapes, window, 100, row);
        }
        tapes.fold_rows(window);
        tapes.settle_rows(window);
        assert!(tapes.take_left().is_empty(), "nothing was kept, so nothing is known to have left");

        tapes.begin_rows();
        built_row(&tapes, window, 100, 2);
        tapes.fold_rows(window);
        tapes.shift(window, 2, Point::default());
        tapes.settle_rows(window);
        assert!(tapes.take_left().is_empty(), "the rows of the frame before the whole one are not the frame shown's");
    }
    #[test]
    fn a_frame_that_kept_no_row_and_built_every_row_it_shows_takes_out_the_rows_that_left() {
        let window = WindowId::from(927);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        for row in 1..=4 {
            built_row(&tapes, window, 100, row);
        }
        built_row(&tapes, window, 200, 50);
        tapes.fold_rows(window);

        // The rows 3 and 4 stay but are built again where they are, 5 comes in, 1 and 2 leave: nothing is moved in place.
        assert!(built_row_at(&tapes, window, 100, 3, 30.0));
        assert!(built_row_at(&tapes, window, 100, 4, 40.0));
        assert!(!built_row_at(&tapes, window, 100, 5, 5.0));
        tapes.settle_rows(window);
        let mut left = tapes.take_left();
        left.sort();
        assert_eq!(left, [1, 2]);
        assert_eq!([1, 2, 3, 4, 5, 50].map(|row| x_of(window, row)), [None, None, Some(30.0), Some(40.0), Some(5.0), Some(50.0)]);
        assert_eq!(crate::text::painted_text(window), ["row50", "row3", "row4", "row5"].map(String::from));
        assert!(tapes.take_left().is_empty(), "each row leaves once");
    }

    #[test]
    fn a_row_built_again_where_it_is_is_in_the_registries_once_and_where_the_build_put_it() {
        let window = WindowId::from(928);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        for row in 1..=3 {
            built_row(&tapes, window, 100, row);
        }
        log(window, "after the list");
        tapes.fold_rows(window);

        // 2 is built again, 1 and 3 stay.
        tapes.shift(window, 1, Point::default());
        tapes.shift(window, 3, Point::default());
        assert!(built_row_at(&tapes, window, 100, 2, 20.0));
        tapes.settle_rows(window);
        assert!(tapes.take_left().is_empty());
        assert_eq!(crate::text::painted_text(window), ["row1", "row2", "row3", "after the list"].map(String::from));
        assert_eq!([1, 2, 3].map(|row| x_of(window, row)), [Some(1.0), Some(20.0), Some(3.0)]);

        // The frame after builds it again: the tape that stands is the one of the second build.
        tapes.fold_rows(window);
        tapes.shift(window, 1, Point::default());
        tapes.shift(window, 3, Point::default());
        assert!(built_row_at(&tapes, window, 100, 2, 25.0));
        tapes.settle_rows(window);
        assert_eq!(crate::text::painted_text(window).len(), 4);
        assert_eq!(x_of(window, 2), Some(25.0));
    }

    #[test]
    fn a_row_built_in_a_pass_that_only_lays_out_is_not_built_again_and_a_whole_frame_starts_over() {
        let window = WindowId::from(929);
        crate::automation::forget_window(window);
        let tapes = TapeStore::default();
        tapes.begin_rows();
        built_row(&tapes, window, 100, 1);
        tapes.fold_rows(window);
        assert!(!tapes.row_built(window, false, 100, 1, 1), "a pass that lays out replaces nothing");
        tapes.settle_rows(window);
        assert_eq!(x_of(window, 1), Some(1.0));
        assert!(tapes.take_left().is_empty());

        tapes.begin_rows();
        assert!(!built_row_at(&tapes, window, 100, 1, 1.0), "a frame built whole holds no row of the frame shown");
    }
}
