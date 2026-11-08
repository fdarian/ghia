//! Which subtrees of the element tree a frame leaves unbuilt, because gpui replays what they left in
//! the frame before (#37 step 5b).
//!
//! gpui consumes its elements every frame, so skipping a subtree means handing gpui a
//! `gpui::retained` element in its place and replaying what it prepainted and painted. A frame
//! decides before it builds an element: it skips it when the last build recorded it as eligible, its
//! entry key is the same, and no source of the frame names it or anything below it (see
//! `Sources`). Everything below is also how the last build of an element is judged after the fact,
//! which is how eligibility and the entry key are recorded.
//!
//! A built element has a *key*, what its build is a function of that the retained tree can see: its
//! `subtree_revision`, a fingerprint of what it inherits (hashed by content: group, container and
//! highlight scopes are fresh `Arc`s every frame), and its shape (where it is, what its parent made
//! of it). What the tree cannot see is *volatile*: pointer and focus state, running motion,
//! transitions and animations, scrolling, measurements, the selection. An element is *changed* when
//! its key or its volatile inputs differ from the last build, or it has never been built. The
//! ancestors of changed elements are the *spine*, which builds anyway.
//!
//! A subtree is *retained* when nothing in it changed and nothing in it is on the exclusion list
//! (`Exclusion`), and no absolute box in it has its containing block above it. What it lifts into the
//! stacking context around it does not matter: gpui keeps a lifted element that is a root of its own
//! as a hole in the recording of the subtree around it, and any other as a fragment of it. The
//! maximal such subtrees are the would-be placeholders. They are counted, and every other
//! element is counted under the first reason it is not in one.
//!
//! What an element reads of other elements is in its key, or the element is excluded: a link
//! (`<label>`, `aria-*` references, see `accessibility::links_key`) and whether a click on it is
//! taken (the click path) are in its shape, and a custom element says what it keeps for itself
//! (`CustomElement::retain_state`) or is rebuilt every frame. An `overflow: hidden` element is
//! no obstacle: its scroll offset is a volatile input like a scroller's, and what a clip does to
//! what is inside it is gpui's replay key (content mask, absolute bounds), not the build's.
//!
//! Known gap, found by the verify mode only where a test reaches it: a parent whose children are
//! chosen by `hold_display` (a `display` transition with `allow-discrete`) builds a different set
//! of children with an unchanged key.
//!
//! Not known at build time: that layout gives a retained subtree the same box it had. Step 5's
//! replay key checks that, so the numbers here are an upper bound for frames that move layout.

use std::collections::HashMap;
use std::hash::Hasher;
use std::rc::Rc;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet, FxHasher};

mod debug;
pub(crate) mod gate;
mod patch;
pub(crate) mod scroll_gate;

pub(crate) use patch::Patching;

use crate::events::hover_paint::PATCH_ROOT_MAX_ELEMENTS;
use crate::renderer::{GroupScope, Inherited};
use crate::tape::BuildEffect;

/// A hash of the contents of what the build reads, cheap enough to run once per element.
pub(crate) struct Fingerprint(FxHasher);

impl Fingerprint {
    pub(crate) fn new() -> Self {
        Self(FxHasher::default())
    }

    pub(crate) fn word(&mut self, word: u64) {
        self.0.write_u64(word);
    }

    pub(crate) fn bits(&mut self, flags: &[bool]) {
        self.0.write_u64(flags.iter().fold(0, |bits, flag| bits << 1 | u64::from(*flag)));
    }

    pub(crate) fn f32(&mut self, value: f32) {
        self.0.write_u32(value.to_bits());
    }

    pub(crate) fn f64(&mut self, value: f64) {
        self.0.write_u64(value.to_bits());
    }

    pub(crate) fn option_f64(&mut self, value: Option<f64>) {
        self.0.write_u64(value.map_or(u64::MAX, f64::to_bits));
    }

    pub(crate) fn str(&mut self, value: &str) {
        self.0.write(value.as_bytes());
        self.0.write_u8(0xff);
    }

    pub(crate) fn hash<T: std::hash::Hash>(&mut self, value: &T) {
        value.hash(&mut self.0);
    }

    pub(crate) fn finish(&self) -> u64 {
        self.0.finish()
    }
}

/// Everything in `Inherited` the build of an element below reads. A field added to `Inherited` has
/// to be added here: the size test below is there to say so.
fn inherited_fingerprint(inherited: &Inherited) -> u64 {
    let mut fp = Fingerprint::new();
    fp.bits(&[
        inherited.selectable,
        inherited.inert,
        inherited.pointer_events_none,
        inherited.visibility_hidden,
        inherited.frameless,
        inherited.above_root,
        inherited.table.collapse,
        inherited.table.caption_bottom,
        inherited.table.hide_empty_cells,
    ]);
    fp.f32(inherited.selection_wash.h);
    fp.f32(inherited.selection_wash.s);
    fp.f32(inherited.selection_wash.l);
    fp.f32(inherited.selection_wash.a);
    // A highlight excludes everything it covers, so which one is all the key needs.
    fp.word(inherited.highlight.as_ref().map_or(0, |highlight| highlight.declaration + 1));
    fp.hash(&inherited.app_region);
    inherited.colors.fingerprint(&mut fp);
    inherited.lengths.fingerprint(&mut fp);
    fp.f64(inherited.font_weight);
    inherited.underline_offset.fingerprint(&mut fp);
    fp.option_f64(inherited.line_height);
    fp.f32(inherited.underline_reach);
    fp.hash(&inherited.computed_variations);
    inherited.font_state.fingerprint(&mut fp);
    inherited.direction.fingerprint(&mut fp);
    fp.hash(&inherited.interpolate_size);
    fp.f64(inherited.table.spacing.horizontal);
    fp.f64(inherited.table.spacing.vertical);
    fp.hash(&inherited.table_row);
    fp.hash(&inherited.table_cell);
    fp.hash(&inherited.container);
    let mut group = inherited.groups.as_deref();
    while let Some(scope) = group {
        group_fingerprint(scope, &mut fp);
        group = scope.parent.as_deref();
    }
    fp.word(0);
    if let Some(scope) = inherited.containers.as_deref() {
        scope.fingerprint(&mut fp);
    }
    fp.word(0);
    if let Some(scope) = inherited.self_container.as_deref() {
        scope.fingerprint(&mut fp);
    }
    fp.finish()
}

/// The custom properties `inherited` hands down, which the key holds apart from the rest for the
/// same reason as the colours: only a subtree that read one (`Record::reads_custom`) is another
/// build for a change in them. The containers above hold theirs in `inherited`.
fn custom_fingerprint(inherited: &Inherited) -> u64 {
    let mut fp = Fingerprint::new();
    inherited.custom.fingerprint(&mut fp);
    fp.finish()
}

/// The colours `inherited` hands down, which the key holds apart from the rest: only a subtree
/// that read the colour it inherits (`Record::reads_colors`) is another build for a change in them.
fn colors_fingerprint(inherited: &Inherited) -> u64 {
    let mut fp = Fingerprint::new();
    inherited.colors.fingerprint_colors(&mut fp);
    fp.finish()
}

fn group_fingerprint(scope: &GroupScope, fp: &mut Fingerprint) {
    fp.str(&scope.name);
    fp.bits(&[scope.state.hovered, scope.state.active, scope.state.focused_within]);
}

/// Why an element cannot be inside a retained subtree, whatever happens around it. Step 5 lifts
/// them one at a time; the order here is only the order of the report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Exclusion {
    /// `onScroll` on an element that scrolls: its paint calls the listener. `onLayout` and the
    /// observers are read from the published boxes after the draw (`observers::frame_sweep`).
    PaintReporter,
    /// It declares a `highlight`, or is inside one.
    Highlight,
    /// A custom element that has no `retain_state`: `<code>`, `<markdown>` and `<diff>`, which hold
    /// scrollers whose offset only gpui knows.
    CustomElement,
    /// An `<svg>` that has not been painted yet, whose raster is still being made, or whose document
    /// changed and is too big to be rasterised in paint.
    Svg,
    /// The list and the boxes around it are built by every frame, so no recording holds a list. Its
    /// rows are roots of their own, built in sessions of theirs (`Retain::begin_row`).
    VirtualList,
    /// Inside a table with collapsed borders, which the table paints over its cells.
    CollapsedTable,
    DisplayContents,
    Anchored,
    Sticky,
    Fixed,
    /// `overflow: scroll` or `auto`.
    Scroller,
    /// `layout` prop: moves by an offset of its own. The box is built by every frame, so that its
    /// glide starts where a commit moved it; whether a glide runs is asked of a tick by
    /// [`Retain::preview`], not recorded.
    LayoutAnimation,
    /// Built as part of a paragraph's line.
    AtomicInline,
    /// `position: absolute`, an intrinsic width keyword or a natural width: gpui's layout
    /// rewrites the box after it is requested, so the layout nodes it left are not the next
    /// frame's to use.
    UnstableLayout,
}

impl Exclusion {
    const ALL: [Exclusion; 14] = [
        Self::PaintReporter,
        Self::Highlight,
        Self::CustomElement,
        Self::Svg,
        Self::VirtualList,
        Self::CollapsedTable,
        Self::DisplayContents,
        Self::Anchored,
        Self::Sticky,
        Self::Fixed,
        Self::Scroller,
        Self::LayoutAnimation,
        Self::AtomicInline,
        Self::UnstableLayout,
    ];

    /// Whether what the element paints or lays out follows the clock or the arrival of something
    /// (a raster, an image), so that a tick which builds only what runs on a clock would leave it
    /// as it was. A custom element that has no `retain_state` (`<code>`, `<markdown>`, `<diff>`)
    /// does not: it is rebuilt by every frame that builds its page and paints the same in a tick.
    /// Nor does a virtual list: its rows are measured in the frame that builds them, and what
    /// changes them afterwards (a scroll, a new window of rows, an animation in a row) is a source
    /// of its own, so a tick leaves the list as that frame painted it.
    pub(crate) fn varies_with_time(self) -> bool {
        matches!(self, Self::Highlight | Self::Svg)
    }

    fn name(self) -> &'static str {
        match self {
            Self::PaintReporter => "paint-reporter",
            Self::Highlight => "highlight",
            Self::CustomElement => "custom-element",
            Self::Svg => "svg",
            Self::VirtualList => "virtual-list",
            Self::CollapsedTable => "collapsed-table",
            Self::DisplayContents => "display-contents",
            Self::Anchored => "anchored",
            Self::Sticky => "sticky",
            Self::Fixed => "fixed",
            Self::Scroller => "scroller",
            Self::LayoutAnimation => "layout-animation",
            Self::AtomicInline => "atomic-inline",
            Self::UnstableLayout => "unstable-layout",
        }
    }
}

/// What made an element build differently from the last time, first of these that differs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Cause {
    New,
    /// JS changed it or something below it.
    Edited,
    Inherited,
    Shape,
    Pointer,
    Focus,
    Scroll,
    Measurement,
    Selection,
    Motion,
    Transition,
    Animation,
    MotionValues,
    InlineMotion,
    Blink,
}

impl Cause {
    const ALL: [Cause; 15] = [
        Self::New,
        Self::Edited,
        Self::Inherited,
        Self::Shape,
        Self::Pointer,
        Self::Focus,
        Self::Scroll,
        Self::Measurement,
        Self::Selection,
        Self::Motion,
        Self::Transition,
        Self::Animation,
        Self::MotionValues,
        Self::InlineMotion,
        Self::Blink,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Edited => "edited",
            Self::Inherited => "inherited",
            Self::Shape => "shape",
            Self::Pointer => "pointer",
            Self::Focus => "focus",
            Self::Scroll => "scroll",
            Self::Measurement => "measurement",
            Self::Selection => "selection",
            Self::Motion => "motion",
            Self::Transition => "transition",
            Self::Animation => "animation",
            Self::MotionValues => "motion-values",
            Self::InlineMotion => "inline-motion",
            Self::Blink => "blink",
        }
    }
}

/// Motion that changes what an element builds without the tree changing. Bits of `Vol::dynamic`.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Dynamic {
    Motion = 1,
    Transition = 2,
    Animation = 4,
    MotionValues = 8,
    InlineMotion = 16,
    /// What runs on a `display: contents` element the build was spliced out of, which only its
    /// children are built for: nothing on the child says what it is.
    Spliced = 32,
    /// What the element paints follows the clock and nothing else of it does, see
    /// `CustomElement::follows_clock`.
    Blink = 64,
}

impl Dynamic {
    /// The kinds that only ever run on the element they are noted on, so that what the element
    /// is running can be asked of its own state (`Sources::dormant`).
    pub(crate) const OWN: u8 =
        Self::Motion as u8 | Self::Transition as u8 | Self::Animation as u8 | Self::MotionValues as u8 | Self::Blink as u8;
}

/// What the build of an element is a function of that the retained tree can see.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Key {
    revision: u64,
    inherited: u64,
    /// The colours in `Inherited`, see [`colors_fingerprint`].
    colors: u64,
    /// The custom properties in `Inherited`, see [`custom_fingerprint`].
    custom: u64,
    shape: u64,
}

impl Key {
    /// Whether an element built under `self` is built differently under `now`, given whether it
    /// read the colour and the custom properties it inherits.
    fn inherits_differently(&self, now: &Key, reads_colors: bool, reads_custom: bool) -> bool {
        self.inherited != now.inherited
            || (reads_colors && self.colors != now.colors)
            || (reads_custom && self.custom != now.custom)
    }
}

/// The key an element had when it was entered, before its own build added to its shape: all a
/// frame knows of it before it builds it. A deferred build is entered with the key the frame
/// that deferred it computed, since the parent whose shape it is part of is not there.
#[derive(Clone, Copy)]
pub(crate) struct EnterKey(Key);

/// What the build of an element reads that the retained tree cannot see.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct Vol {
    pointer: u16,
    inline_pointer: u64,
    focus: u16,
    scroll: u64,
    measurement: u64,
    selection: u64,
    dynamic: u8,
}

impl Vol {
    /// The first thing that differs, if any. Motion that is running differs from itself.
    fn cause_against(&self, before: &Vol) -> Option<Cause> {
        if self.pointer != before.pointer || self.inline_pointer != before.inline_pointer {
            return Some(Cause::Pointer);
        }
        if self.focus != before.focus {
            return Some(Cause::Focus);
        }
        if self.scroll != before.scroll {
            return Some(Cause::Scroll);
        }
        if self.measurement != before.measurement {
            return Some(Cause::Measurement);
        }
        if self.selection != before.selection {
            return Some(Cause::Selection);
        }
        let dynamic = self.dynamic | before.dynamic;
        [
            (Dynamic::Motion, Cause::Motion),
            (Dynamic::Transition, Cause::Transition),
            (Dynamic::Animation, Cause::Animation),
            (Dynamic::MotionValues, Cause::MotionValues),
            (Dynamic::InlineMotion, Cause::InlineMotion),
            (Dynamic::Blink, Cause::Blink),
        ]
        .into_iter()
        .find(|(kind, _)| dynamic & *kind as u8 != 0)
        .map(|(_, cause)| cause)
    }
}

/// What the last build recorded about an element.
#[derive(Clone)]
struct Record {
    key: Key,
    enter: Key,
    vol: Vol,
    digest: u64,
    eligible: bool,
    /// Counts the frames that built the element on their own: a frame that finds the element
    /// changed builds it, and what gpui recorded of it before is of another build. See `token`.
    epoch: u64,
    /// What gpui's retained element is keyed by: equal for two frames only when the element was
    /// entered with the same key and has not been built on its own in between.
    token: u64,
    lift_z: Option<i32>,
    forms_context: bool,
    /// `Node::lift_run`.
    lift_run: bool,
    /// The element or something in it is lifted out of it, which a recording is not moved with.
    lifts: bool,
    /// What `Below::holes` added up to when it was built: what the lifted elements in it, however
    /// deep, were keyed by.
    holes: u64,
    /// Elements in the subtree.
    size: u32,
    /// The element is a patch root: something in it declares a hover that only
    /// paints (`Node::patch_root`), it is small enough to be a unit, lifts nothing out of it, and nothing
    /// runs on it. A scroller in it is no reason: its offset is a source, and a tick that finds it
    /// moved is built whole.
    patch_root: bool,
    /// The build read the colour the element inherits (`color::reads`): a text that sets no colour of
    /// its own, a `currentColor`, an element that paints as it likes. A colour is part of the key of
    /// the record only then.
    reads_colors: bool,
    /// Something built in the subtree read a custom property (`custom_properties::reads`): a
    /// transform with a `var()`, a `style()` query on the parent. A subtree that read none is the
    /// same build under other custom properties.
    reads_custom: bool,
    /// The element is costly to build, see [`Entry::costly`]: all that makes a root of one worth it.
    costly: bool,
    subtree: crate::layout::cull::Subtree,
    effects: Option<Rc<[BuildEffect]>>,
    /// Whether gpui has a recording of the subtree to replay: it asked for the build, or the frame
    /// before skipped the subtree.
    seasoned: bool,
    /// The selection the element was built under. The frame that finds a new selection builds
    /// only the elements it visits, so one it did not (under `display: none`) is still of the old.
    selection: u64,
    /// Nothing in the subtree is excluded but for the parts of a collapsed table, which the table
    /// the element is paints itself: `eligible`, or that.
    unit_eligible: bool,
    /// What runs where a unit of the element would be rebuilt, see [`Motion`].
    motion: Motion,
    /// Why the element is no unit though something runs on it, if the build says.
    refusal: Option<Refusal>,
    /// `Node::wrapped` of the last build.
    wrapped: Option<Option<gpui::Pixels>>,
    /// Built in the content a read of geometry forced (`Node::under_forced`): the layout of it is
    /// carried across the draws that skip the host, see [`Retain::skip_content`].
    forced: bool,
}

/// Why an element something runs on is no unit: the first of these that holds of its last build.
/// What a tick that is drawn whole for it is counted under (`getPatchCounters().unpatchable`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The element is of a kind a patch cannot repeat, see [`Exclusion`].
    Excluded(Exclusion),
    /// Something in it is.
    ExcludedBelow(Exclusion),
    /// It holds something absolutely positioned against a containing block outside it: gpui keeps no
    /// root whose layout is rewritten against a box it does not hold. (An absolute element is a unit
    /// itself, its own containing block being outside.)
    Escapes,
    /// Something in it is lifted out of it into a stacking context it does not form.
    Lifts,
    /// Something in it scrolls, which a scroll bypasses the tape a patch compares with.
    Scrolls,
    /// What runs on it moves what it lays out.
    LayoutAnimation,
    /// It holds more elements than a unit may.
    TooLarge,
}

impl Refusal {
    pub(crate) fn key(self) -> String {
        match self {
            Self::Excluded(kind) => format!("Excluded:{}", kind.name()),
            Self::ExcludedBelow(kind) => format!("ExcludedBelow:{}", kind.name()),
            Self::Escapes => "Escapes".to_owned(),
            Self::Lifts => "Lifts".to_owned(),
            Self::Scrolls => "Scrolls".to_owned(),
            Self::LayoutAnimation => "LayoutAnimation".to_owned(),
            Self::TooLarge => "TooLarge".to_owned(),
        }
    }
}

/// The motion a unit would repaint: what runs on the element, or for a table with collapsed
/// borders on the element and its parts, which it paints the borders of.
#[derive(Clone, Copy, Default)]
struct Motion {
    /// `Vol::dynamic` of the elements, or-ed.
    dynamic: u8,
    /// What runs on each of them only changes what it paints, see [`Retain::paints_only`].
    paints_only: bool,
}

impl Record {
    /// Whether the last build of the element found it a unit to be: only paint-only motion runs on
    /// it, and it lifts nothing out of it (`end_unit` judges the build for what is inside).
    fn is_unit_candidate(&self) -> bool {
        let only_motion = self.motion.dynamic & Dynamic::OWN != 0 && self.motion.dynamic & !Dynamic::OWN == 0;
        // `Record::lifts` is true of every lifted element: whether it holds a descendant that lifts
        // out of it is for `end_unit` to find in the build.
        let lifts_out = self.lifts && self.lift_z.is_none();
        self.unit_eligible && !lifts_out && only_motion && self.motion.paints_only
    }
}

const NO_PARENT: u32 = u32::MAX;

/// Where each reason is counted: `perf_counters` keeps one number per slot.
const EXCLUDED: usize = 0;
const UNDER: usize = EXCLUDED + Exclusion::ALL.len();
const CHANGED: usize = UNDER + Exclusion::ALL.len();
const SPINE: usize = CHANGED + Cause::ALL.len();
const ESCAPES: usize = SPINE + 1;
const MOVED: usize = ESCAPES + 1;
const OVERSIZED: usize = MOVED + 1;
pub(crate) const RETAINED: usize = OVERSIZED + 1;
pub(crate) const SLOTS: usize = RETAINED + 1;

/// What a counted slot is called in a report.
pub(crate) fn slot_name(slot: usize) -> String {
    match slot {
        EXCLUDED..UNDER => format!("excluded:{}", Exclusion::ALL[slot - EXCLUDED].name()),
        UNDER..CHANGED => format!("under:{}", Exclusion::ALL[slot - UNDER].name()),
        CHANGED..SPINE => format!("changed:{}", Cause::ALL[slot - CHANGED].name()),
        SPINE => "spine".to_owned(),
        ESCAPES => "escapes".to_owned(),
        MOVED => "moved:scroll".to_owned(),
        OVERSIZED => "oversized:scroll".to_owned(),
        RETAINED => "retained".to_owned(),
        _ => unreachable!("no slot {slot}"),
    }
}

/// A scroller, or other clip scrolled by script, that an element is inside of. A subtree inside it
/// that is skipped is recorded to be put elsewhere when the scroller moves it, see
/// [`gpui::Retained::relocatable`].
#[derive(Clone, Copy)]
pub(crate) struct Scroller {
    pub window: gpui::WindowId,
    /// The size of its box, which bounds what a root is worth recording.
    pub viewport: gpui::Size<gpui::Pixels>,
    /// How far past its clip a root is recorded, see [`gpui::Retained::relocatable`].
    pub overscan: gpui::Pixels,
}

/// Roots of at most this many viewports (per axis) are recorded to be moved by their scroller. A
/// bigger one is not a root: it is built, and what is below it is judged by itself.
const ROOT_VIEWPORTS: f32 = 2.0;

/// How far past the clip of a scroller that is no list a root is recorded, in viewports of the
/// scroller (its height, its width, or the larger, as it scrolls). The recording of a root is put
/// elsewhere while the scroll since it was made is within it, so a bigger one is built fewer
/// times and replays more roots that are not shown.
const OVERSCAN_VIEWPORTS: f32 = 0.5;

impl Scroller {
    /// The scroller `handle` is, if its content can move: it scrolls for the user or by script
    /// along an axis, and it has been laid out. Before its first layout a scroller for the user has
    /// the window for a viewport, which it cannot be bigger than, and the axes its style scrolls
    /// (`declared`, which the handle learns when it paints): the first frame records its content to
    /// be moved, as the frames after do, where it would else record it where it stands and build it
    /// again when the scroller first moves it.
    pub(crate) fn of(
        handle: &gpui::ScrollHandle,
        window: gpui::WindowId,
        window_size: gpui::Size<gpui::Pixels>,
        declared: gpui::Point<bool>,
    ) -> Option<Self> {
        let (offset, max, user) = (handle.offset(), handle.max_offset(), handle.user_scrollable());
        let laid_out = handle.padding_box().size;
        let (viewport, moves_x, moves_y) = if laid_out.width <= gpui::px(0.0) || laid_out.height <= gpui::px(0.0) {
            (window_size, declared.x, declared.y)
        } else {
            (
                laid_out,
                (user.x && max.x > gpui::px(0.0)) || offset.x != gpui::px(0.0),
                (user.y && max.y > gpui::px(0.0)) || offset.y != gpui::px(0.0),
            )
        };
        let reach = match (moves_x, moves_y) {
            (false, false) => return None,
            (true, false) => viewport.width,
            (false, true) => viewport.height,
            (true, true) => viewport.width.max(viewport.height),
        };
        Some(Self { window, viewport, overscan: reach * OVERSCAN_VIEWPORTS })
    }

    /// The scroller a virtual list is for its rows: it always scrolls, by its height. Before its
    /// first layout it has the window for a viewport, as `of` does.
    ///
    /// A row is recorded when the list builds it, up to `overdraw` outside the clip, and replayed
    /// while it is shown, at most a viewport and its own height further (a root is at most
    /// `ROOT_VIEWPORTS` viewports tall, and the box of a row that has never painted is not known).
    /// The region that covers the clip after that travel is the overscan, so a row is not built
    /// again for `RelocationMiss::Region` while it is shown.
    pub(crate) fn of_list(
        window: gpui::WindowId,
        viewport: gpui::Size<gpui::Pixels>,
        overdraw: gpui::Pixels,
        window_size: gpui::Size<gpui::Pixels>,
    ) -> Self {
        let viewport = if viewport.width <= gpui::px(0.0) || viewport.height <= gpui::px(0.0) { window_size } else { viewport };
        Self { window, viewport, overscan: viewport.height * (1.0 + ROOT_VIEWPORTS) + overdraw }
    }

    /// Whether the element's last box is small enough to be recorded to move: one that has no box
    /// yet (it never painted) is not.
    fn holds(&self, id: u64) -> bool {
        self.fits(id) == Some(true)
    }

    /// Whether the element's last box is too big for a root, if it has one.
    fn too_big(&self, id: u64) -> bool {
        self.fits(id) == Some(false)
    }

    fn fits(&self, id: u64) -> Option<bool> {
        crate::automation::get_bounds(self.window, id).map(|bounds| {
            bounds.width <= f64::from(f32::from(self.viewport.width) * ROOT_VIEWPORTS)
                && bounds.height <= f64::from(f32::from(self.viewport.height) * ROOT_VIEWPORTS)
        })
    }
}

/// An element a frame did not build, standing in for the record of its last build.
struct Skipped {
    size: u32,
    digest: u64,
}

struct Node {
    id: u64,
    parent: u32,
    /// One past the last node below this one.
    end: u32,
    key: Key,
    enter: Key,
    vol: Vol,
    exclusion: Option<Exclusion>,
    lift_z: Option<i32>,
    forms_context: bool,
    /// An animation of the element's opacity or transform was current when it was built: the element is an
    /// effect group or has a transform at every value it samples, so `lift_z` holds for as long as the run does.
    lift_run: bool,
    /// The element is a containing block for the absolutely positioned boxes below it.
    positioned: bool,
    /// The element is absolutely positioned: gpui rewrites its box against its containing block.
    absolute: bool,
    /// Something above scrolled, so the box this one was recorded at is not where it is.
    moved: bool,
    /// The scroller around it, if it is one gpui can move recordings for.
    scroller: Option<Scroller>,
    costly: bool,
    /// See [`Entry::patch_root`].
    patch_root: bool,
    /// The element was entered as a candidate patch anchor (`Retain::begin_anchor`).
    anchor: bool,
    /// Only with `verify`: a hash of what the build made of the element itself.
    digest: u64,
    /// The element was built as a `display: none` host, which paints and lays out nothing.
    absent: bool,
    /// Where among the children it built the ones that came back absent were.
    absent_children: Vec<usize>,
    subtree: crate::layout::cull::Subtree,
    /// The build effects noted since the element was entered, and until it was left.
    effects_start: usize,
    effects_end: usize,
    skipped: Option<Skipped>,
    paints_only: bool,
    /// The element is a table with collapsed borders, which paints the borders of its parts.
    collapsed_table: bool,
    /// Whether gpui was handed the element to record when it was left, and the overscan it was
    /// recorded with (`Recording::overscan`).
    wrapped: Option<Option<gpui::Pixels>>,
    /// Whatever the build of the element turns out to be, the frame can hand it to gpui to record,
    /// for the frame after to replay: it is built in a plain context, in a frame that plans, outside
    /// a unit and a deferred build (see `Retain::to_record`).
    records: bool,
    /// The element is the host of content that a read of geometry forces to be built, see
    /// [`Retain::forced_host`].
    forced_host: bool,
    /// An element above it is a forced host: it is built as the content of one.
    under_forced: bool,
    /// `background_images::still_loading` when the element was entered.
    loading: u64,
    /// Open while the element is built, see [`Record::reads_colors`].
    colors_frame: Option<crate::color::reads::Frame>,
    reads_colors: bool,
    /// `custom_properties::reads::count` when the element was entered, while it is built.
    custom_reads_at: u64,
    reads_custom: bool,
}

/// Whether building the element alone costs more than replaying it: it carries text or is not a plain
/// host box (an image, an `<svg>`), see [`Entry::costly`].
pub(crate) fn costly(element: &crate::retained_tree::RetainedElement) -> bool {
    element.content.is_some() || !crate::text::inline::is_host_type(&element.element_type) || element.element_type == "text"
}

/// What `Retain::scan_patch_root` finds in a subtree.
#[derive(Clone, Copy, Default)]
struct PatchRootScan {
    hovers: bool,
    size: u32,
    lifts: bool,
    /// Something below the element (not the element) is worth a root of its own (`Retain::worth`): a patch
    /// root records nothing inside it, so it would take that root from the frames.
    root_below: bool,
    /// The element or something below it is worth a root of its own.
    rooted: bool,
    /// Something in it has a size an intrinsic keyword gives, or declares or follows a group.
    unfit: bool,
}

/// What a node adds up to with what is below it, filled in bottom-up when the build is done.
#[derive(Clone, Copy, Default)]
struct Below {
    changed: Option<Cause>,
    /// The scroll offset of a scroller moved, which moves its children.
    scrolled: bool,
    changed_below: bool,
    /// The first excluded element below, in document order.
    excluded: Option<Exclusion>,
    /// Something below is lifted out of the elements between it and here.
    lifts: bool,
    /// The tokens of the lifted elements below that this one's recording holds a hole or a
    /// fragment for.
    holes: u64,
    epoch: u64,
    token: u64,
    /// Something below is absolutely positioned against a containing block that is not below this
    /// element, or is this element.
    escapes: bool,
    /// Something below was built with a motion running on it.
    dynamic: bool,
    digest: u64,
    size: u32,
}

/// The decision for the last build, for tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Summary {
    pub roots: Vec<u64>,
    pub elements_in_roots: usize,
    pub elements: usize,
}

/// What the build reads that the retained tree cannot show, as the frame found it. The elements
/// that differ from the frame before, and their ancestors, are the spine a frame builds; what is
/// off it can be skipped.
pub(crate) struct Sources<'a> {
    pub tree: &'a crate::retained_tree::RetainedTree,
    pub hovered: &'a [u64],
    /// The elements a hover restyled by paint only since the last frame that took them
    /// (`PointerState::paint_pending`): the tick that patches them takes them from the hover chain's
    /// difference, which it does not look at.
    pub hover_paint: Vec<u64>,
    pub active: &'a [u64],
    pub focus: &'a crate::focus::FocusStyles,
    pub focusable: &'a HashMap<u64, gpui::FocusHandle>,
    pub scrolls: &'a HashMap<u64, gpui::ScrollHandle>,
    /// The elements whose measurement changed since the frame before.
    pub measured: Vec<u64>,
    /// The elements whose accessibility links changed since the frame before.
    pub links: Vec<u64>,
    /// The elements a Web Animations command touched since the frame before. A transition that had
    /// finished runs again after `play()`, and nothing in its last build said it could.
    pub commanded: Vec<u64>,
    /// The elements with `content-visibility: auto` that are to show or skip their content
    /// otherwise than their last build did (`layout::content_visibility::Relevance::pending`).
    pub relevance: Vec<u64>,
    /// The state each custom element says it keeps for itself, see `CustomElement::retain_state`.
    pub customs: Vec<(u64, Option<u64>)>,
    /// The elements with a motion that is running.
    pub motion: Vec<u64>,
    /// Whether the element can be left alone while it is not seen: everything that runs on it
    /// only changes what it paints, and the last frame that reached it culled it (gpui walked it
    /// under an empty content mask). Chrome paints no frame for such a change, and a frame that
    /// builds it again when it shows reads the clock, so nothing it would have built is lost.
    pub dormant: &'a dyn Fn(u64) -> bool,
    /// Whether the element whose only dynamic is the clock of a caret (`Dynamic::Blink`) or a
    /// motion value (`Dynamic::MotionValues`) is to paint otherwise than it was painted, see
    /// `CustomElement::clock_due` and `MotionValueStore::binding_due`. One that is not is left as it
    /// is by a tick.
    pub clock_due: &'a dyn Fn(u64) -> bool,
    /// Everything `dormant` reads that no build of an element tells the frame about: it changes
    /// when the answer may have changed for an element nothing built, so the elements that were
    /// found dormant are asked again.
    pub verdicts: u64,
    pub selection: u64,
    /// The pass of the draw the frame is built in, counted from 1, or 0 for a frame built outside
    /// a draw. Only the first pass of a draw is a frame to the back-off.
    pub pass: usize,
    /// How many subtrees gpui has built late (it could not use the recording it had of them) and
    /// how many it has put elsewhere than they were recorded, since the window was made.
    pub tally: gate::Tally,
    pub relocations: u64,
    /// The frame is built again to be compared with the one that was shown: it is the same frame,
    /// and its roots are planned as that one's were.
    pub reference: bool,
    /// The pass only lays out (a bounds read): it is not a frame, and its output is thrown away.
    pub layout_only: bool,
}

/// What the sources were at the frame before, to tell what changed.
#[derive(Default)]
struct Seen {
    known: bool,
    hovered: Vec<u64>,
    active: Vec<u64>,
    within: Arc<[u64]>,
    visible: Option<u64>,
    dim: Option<Arc<[u64]>>,
    scrolls: FxHashMap<u64, (u32, u32)>,
    customs: FxHashMap<u64, Option<u64>>,
    motion: FxHashSet<u64>,
    selection: u64,
}

/// The elements that became dormant and the ones that stopped being, for whoever keeps their
/// clocks (`CssAnimations::enter_dormant`).
#[derive(Default)]
pub(crate) struct DormantMoves {
    pub entered: Vec<u64>,
    pub left: Vec<u64>,
}

/// What the frame found different from the frame before.
#[derive(Default)]
struct Deltas {
    /// Nothing about the frame before holds (the first frame, a new selection).
    all: bool,
    /// The elements that changed, and their ancestors.
    spine: FxHashSet<u64>,
    /// The elements whose scroll offset moved, which moves what is below them.
    scrolled: FxHashSet<u64>,
    /// Whether a scroller that the frame before had is somewhere else, as opposed to new.
    scrolling: bool,
}

/// What the pointer, focus, scrolls and custom elements differ in from the frame before, see `Retain::compare_sources`.
struct Compared {
    all: bool,
    changed: Vec<u64>,
    scrolled: FxHashSet<u64>,
    scrolling: bool,
    scrolls: FxHashMap<u64, (u32, u32)>,
    customs: FxHashMap<u64, Option<u64>>,
}

/// What the sources differ in from the frame before, see `Retain::compute_deltas`.
struct Found {
    all: bool,
    /// Changed by the pointer, focus, a scroll or a custom element: not by time.
    sourced: Vec<u64>,
    scrolled: FxHashSet<u64>,
    scrolling: bool,
    scrolls: FxHashMap<u64, (u32, u32)>,
    customs: FxHashMap<u64, Option<u64>>,
    motion: FxHashSet<u64>,
    /// Motions that run or just ended and are not dormant.
    running: Vec<u64>,
    /// Elements whose last build found something running on them, that are not dormant.
    dynamic: Vec<u64>,
    /// The elements that were asked whether they are dormant and are.
    entered: FxHashSet<u64>,
    /// The verdicts of the elements that were dormant are not the ones they were found with.
    stale: bool,
}

/// The most elements a unit holds. A unit is built whole in every frame that is built whole (nothing
/// inside it is replayed, so that a tick can build it again exactly) and again by every tick that
/// patches it, so what a patch saves over a frame is the page minus its units: a unit past this
/// has more to build in each of them than a card does, and the page is left to full frames.
const UNIT_MAX_ELEMENTS: u32 = 256;

/// The most elements an anchor holds: a patch builds all of it and lays it out again, so one this big
/// is left to the frame built whole.
const ANCHOR_MAX_ELEMENTS: u32 = 1024;

/// A subtree of the last frame built whole that only its running animations change, kept with what
/// builds it again, see `GpuixView::build_unit`.
pub(crate) struct Unit {
    pub id: u64,
    pub env: crate::renderer::FrameEnv,
}

/// What the last frame built whole left for a tick to be patched against.
#[derive(Default)]
struct Plan {
    /// Counts the frames and passes that began, for the key of a unit to differ from the one of the
    /// frame before: a unit is recorded every frame, never replayed.
    serial: u64,
    /// A frame was recorded since the sources were last reset.
    recorded: bool,
    /// A pass that only lays out ran after it, and took the changes it saw out of the sources.
    layout_since: bool,
    /// It built an element whose paint follows the clock or something arriving
    /// ([`Exclusion::varies_with_time`]), which a patch would leave as it was.
    unsteady: bool,
    /// The revision of the root of the tree it was built from.
    revision: u64,
    units: Vec<Unit>,
    ids: FxHashSet<u64>,
    /// The roots of the frame that a hover or a commit patch repaints (`Record::patch_root`), recorded or skipped:
    /// built or replayed by the frame as roots of the recording gpui keeps, and not units in the
    /// sense of `units`, since nothing runs on them.
    patch_roots: Vec<Unit>,
    patch_root_ids: FxHashSet<u64>,
    /// The scrollers of the frame that a patch lays out again (`Retain::end_anchor`): each is wrapped
    /// as a retained root that gpui records as a source for a patch and never replays.
    anchors: Vec<Unit>,
    anchor_ids: FxHashSet<u64>,
    /// The anchors patches laid out again since the frame: what gpui recorded of the roots in them is
    /// of the layout before, so none of those is patched until a frame is built whole.
    repainted: FxHashSet<u64>,
    /// Of those, the anchors whose own recording gpui dropped (it rewrites one only when it can, see
    /// `RecordingRewrite`): none is patched again until a frame is built whole.
    unrecorded: FxHashSet<u64>,
}

/// Why a tick cannot be patched, see `Retain::preview`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unpatchable {
    /// No frame built whole is recorded: the retention is off, resting, or was started over.
    NoFrame,
    /// A pass that only lays out ran since, and took the changes it saw.
    LayoutPass,
    /// The frame built an element whose paint follows the clock, see [`Plan::unsteady`].
    Unsteady,
    /// A `layout` glide is in flight, or its events are still to be sent: a frame steps it, and a
    /// tick would leave it where it was. A `layout` box with no glide running is not this.
    Gliding,
    ScrollAnimation,
    /// The tree is not the one the frame was built from.
    Edited,
    /// The selection changed, or the sources never had a frame to compare with.
    Everything,
    /// Something other than time changed: the pointer, focus, a scroll, a custom element, a
    /// measurement, a link, a command.
    Sourced,
    /// A time-driven change outside every unit that is not dormant, on an element the last build
    /// gives no reason for.
    Outside(u64),
    /// A time-driven change outside every unit that is not dormant, on an element that is no unit
    /// for this reason.
    Refused(Refusal),
    /// A hover restyled an element that no root a patch can repaint holds in the frame that was
    /// built whole: it is not in a recorded or skipped root of a size a unit may be, or the frame
    /// built the root every time.
    Hover(u64),
    /// A commit restyled by paint an element that no root a patch can repaint holds in the frame that
    /// was built whole, as for [`Self::Hover`]: the frame is built whole, and visits the roots.
    Commit(u64),
    /// A commit changed an element that no anchor of the last frame built whole holds
    /// ([contained-layout patches](docs/fork/patch-frames.md)): the frame is built whole, and wraps the anchors again.
    Structure(u64),
    /// A patch laid out the anchor `.0`, or the one that holds the unit `.0`, since the frame built whole: gpui
    /// forgot the recordings of what is nested in it, and of the anchor itself when it could not rewrite it.
    AnchorStale(u64),
    /// A unit that the last frame found nothing left running on (the animation ended in it, while
    /// a source goes on listing it): the frame built whole in the tick's place does not make it a
    /// unit, so a patch would repaint a root that frame does not have.
    Ended(u64),
    /// Nothing is left to repaint, but elements are to enter the dormant set (culled, with only
    /// paint running) or its verdicts moved: a tick draws nothing and settles neither, which the
    /// frame built whole in its place does.
    Dormancy,
}

/// The most frames that follow a recorded frame which found nothing a later frame could skip,
/// before one is recorded again to look.
const BACKOFF_CAP: u32 = 8;

/// Recording a frame costs about 5% of building it. A page with nothing a later frame could skip
/// (a scroller whose rows move with every frame, boxes too small to be a subtree) gains nothing
/// from it, so after a recorded frame that found no such element the frames that follow are not
/// recorded, in stretches that double up to [`BACKOFF_CAP`], and one frame in nine looks again.
/// Recording starts again at once when the scrollers stop moving, since the page is then still.
#[derive(Default)]
struct Backoff {
    /// Frames still to go unrecorded.
    rest: u32,
    /// The length of the next stretch: 0 while recorded frames find something to skip.
    gap: u32,
    /// Whether the frame being built is one of the unrecorded.
    resting: bool,
    /// Whether a scroller moved in the last frame, recorded or not.
    scrolling: bool,
    /// How many elements the tree had when the stretch began: a page that gains or loses
    /// elements is not the page that had nothing to skip.
    elements: usize,
}

/// Whether the roots a scroller moved were put elsewhere or built again, which tells a frame
/// whether to plan on it: a scroller whose rows gpui cannot move (a page whose rows keep a
/// position, or sit under a rounded clip) is no better off with its rows skipped than built, and
/// is worse for the recording that follows.
#[derive(Default)]
struct Relocation {
    /// Roots the last first pass planned to have moved.
    planned: u32,
    /// `Sources::lazy_builds` and `Sources::relocations` at the first pass before.
    lazy_builds: u64,
    relocations: u64,
    /// Frames still to go without planning to move roots.
    rest: u32,
    /// The length of the next stretch: 0 while the roots that were planned to move did.
    gap: u32,
    /// Whether the frame being built plans to move roots.
    resting: bool,
}

pub(crate) struct Retain {
    /// `GPUIX_RETAIN_OFF` stops recording, to time a build without it.
    enabled: bool,
    /// Whether skipping was asked for, which `enabled` can still turn off.
    planning_wanted: bool,
    backoff: Backoff,
    relocation: Relocation,
    gate: gate::Gate,
    /// A subtree gpui asked for is being built inside one that is recorded to move: what is in it
    /// is built, since the recording of a subtree in another cannot be put elsewhere on its own.
    inside_relocatable: bool,
    /// The pass of the draw the frame being built is in, see [`Sources::pass`].
    pass: usize,
    /// How many elements the tree has in the frame being built.
    elements: usize,
    /// Nothing runs or sleeps in the window, as the frame before left it. Taken when a draw's first pass begins and
    /// kept for its later passes and the pass that builds the frame again to compare it: what a root is judged by must
    /// not move between them, and a build that finishes moves it.
    quiet: bool,
    #[cfg(test)]
    frame_log: Vec<bool>,
    /// Whether a frame skips the building of what the sources say did not change, and hands it
    /// to gpui as a retained subtree. Off, the elements are only recorded and judged, which is
    /// what the tests of the judgement read.
    planning: bool,
    /// The exclusions to ignore, by `Exclusion as u32`: what the numbers would be if they were
    /// lifted. For measuring which to lift first; nothing reuses anything.
    lifted: u32,
    verify: bool,
    /// The smallest subtree that is skipped.
    min_root: u32,
    open: bool,
    /// A subtree gpui asked for after the frame was built is being built.
    deferred: bool,
    /// The subtree being built late is inside the content of a forced host: nothing in `nodes`
    /// says so, since it begins at the subtree.
    deferred_forced: bool,
    /// The pass being built only lays out, or is built again to be compared with the frame shown.
    layout_only: bool,
    reference: bool,
    /// The node a unit began at, while it is being built: nothing inside it is skipped.
    unit: Option<u32>,
    /// The node a root that a patch repaints began at, while it is being built: nothing
    /// inside it is skipped or recorded either, since a patch builds the root as one piece and what
    /// it lays out, registers and paints has to be what the recording of the root holds.
    patch_root_unit: Option<u32>,
    plan: Plan,
    /// The elements that patches repainted for a hover since the last frame built whole, whose
    /// roots hold the paint of before in their recordings: that frame builds them again.
    hover_patched: Vec<u64>,
    /// Whether roots are made ready for a patch: off with patching, which would only cost the
    /// roots in them their records.
    makes_patch_roots: bool,
    /// Whether scrollers are wrapped as anchors, which patches lay out again (`set_patch_roots`).
    makes_anchors: bool,
    /// Whether an element or something below it declares a hover that only paints, and how many
    /// elements the subtree holds (up to one more than a patch root may), by the revision of the subtree
    /// (`can_be_patch_root`).
    patch_root_scans: FxHashMap<u64, (u64, PatchRootScan)>,
    /// What the style of an element says of whether its hover only paints, which every scan of a subtree asks again
    /// of every element in it.
    hover_scans: crate::style_memo::StyleMemo<crate::events::hover_paint::Paints>,
    /// A virtual list's row is being built, in a session of its own (`begin_row`): the list builds
    /// its rows in layout, after the render that entered the list closed the page's session.
    row: bool,
    /// The shape of the list the row is a child of, which the row's key takes where an element
    /// takes the shape of its parent.
    row_parent_shape: u64,
    /// The rows built since the last frame that looked, whose records are still wanted.
    rows_seen: FxHashSet<u64>,
    /// The rows the frame before asked for: the ones of them that this frame does not ask for are
    /// the rows the list stopped asking for, whose subtrees keep records (`forget_unseen_rows`).
    rows_before: FxHashSet<u64>,
    /// Some row built since the last frame ended could be skipped by the next, which the page's
    /// session cannot see (`finish_frame`).
    row_candidates: bool,
    /// What the page's session decided, while a row's replaces it in `summary`.
    page_summary: Summary,
    selection: u64,
    nodes: Vec<Node>,
    stack: Vec<u32>,
    /// What each node adds up to with what is below it, settled when the build of the node ends.
    below: Vec<Below>,
    retained: Vec<bool>,
    moved: Vec<bool>,
    records: FxHashMap<u64, Record>,
    /// The elements whose last build found a motion, transition or animation running.
    dynamic: FxHashMap<u64, u8>,
    /// The elements the frames left out of `changed` because they are dormant (`Sources::dormant`),
    /// with the kinds that were running on them when they fell asleep. Their records stay as they
    /// are: the roots above them are replayed. An element is asked once, and sleeps until
    /// something can have changed its answer: a build of it (`woken`), or what `dormant` reads
    /// that no build tells (`verdicts`). Not in `dynamic`, so a frame looks at none of them.
    dormant: FxHashMap<u64, u8>,
    /// The dormant elements a build reached since the frame that last asked about them. They are
    /// still in `dormant` until that frame, which is what the frame that built them saw.
    woken: FxHashSet<u64>,
    /// `Sources::verdicts` when the dormant elements were last asked about.
    verdicts: u64,
    /// The elements that fell asleep or woke up since `take_dormant_moves`.
    moves: DormantMoves,
    /// The elements that skip their content (`content-visibility`) as of their last build.
    skipping: FxHashSet<u64>,
    /// `RetainedTree::removals` when `records` and `dynamic` last dropped the destroyed elements.
    pruned_at: u64,
    seen: Seen,
    deltas: Deltas,
    /// The elements on the spine of a frame since the last build of them. A pass that does not
    /// build one (`display: none` above it, for the layout of a read) does not see what it
    /// changed, and `seen` has moved on, so the frame that does must still find it changed.
    ///
    /// Only elements a build can enter: one it never enters (see
    /// [`RetainedElement::is_built_by_ancestor`]) would stay here for good, and its ancestors
    /// with it, since the spine is the upward closure of this set and what changed.
    unbuilt: FxHashSet<u64>,
    summary: Summary,
    /// The element `exit` left was built absent, until `take_exited_absent`.
    exited_absent: bool,
    mismatches: Vec<String>,
    /// What `getRetainDebug` reports, filled only with `GPUIX_RETAIN_DEBUG`.
    debug: debug::Debug,
    /// What a list scroll is classified against, see `scroll_gate`.
    shown: scroll_gate::ShownFrame,
    clock_asked: scroll_gate::ClockAsked,
}

/// What `Retain::enter` is told about the element about to be built.
pub(crate) struct Entry<'a> {
    pub id: u64,
    pub revision: u64,
    pub inherited: &'a Inherited,
    /// Its index among its parent's children, the last step of its document path.
    pub at: u32,
    pub stacking_root: bool,
    pub stacking_item: bool,
    pub atomic_root: bool,
    /// `Some` for a child spliced out of `display: contents` elements: the key of the styles they
    /// hand down (`layout::contents::Overlay::key`).
    pub contents_overlay: Option<u64>,
    pub anchor_scope: bool,
    /// What an ancestor's `text-box-trim` asks of the ends of the element's lines.
    pub text_box_trim: gpui::TextBoxTrim,
    /// Whether nothing around the element is waiting for something from its build that a skipped
    /// build could not give (the baseline of a box, the text of a line).
    pub plain: bool,
    /// For an element that is a query container or has `@container` blocks: the size layout last
    /// gave the container (`ContainerStore::key`). The scope the element builds for the elements
    /// below it is made from it, and nothing above the element has it.
    pub container: Option<u64>,
    /// Whether the element has a layout node of its own: a table row or row group does not, and
    /// has no layout result for a retained element to be laid out as.
    pub boxed: bool,
    /// The key of a subtree that was deferred, which the frame that deferred it computed.
    pub prekeyed: Option<EnterKey>,
    /// The scroller the element is inside of.
    pub scroller: Option<Scroller>,
    /// Whether an animation of the element's opacity or transform is current now. It is the one input of the lift
    /// that moves with the clock and not with a revision: a record made on the other side of the
    /// start or the end of a run says the element is lifted, or is not, wrongly.
    pub lift_run: &'a dyn Fn() -> bool,
    /// Whether building the element alone costs more than replaying it: it carries text or is
    /// not a plain host box (an image, an `<svg>`). Only a root of one element needs this.
    pub costly: bool,
    /// Whether the element, or something in its subtree, declares a hover that only changes how it
    /// paints (`Retain::can_be_patch_root`): a root built for it is a patch root.
    pub patch_root: bool,
}

/// An element built whole that gpui records in the frame, under the key the frame after enters it
/// with. See `Retain::exit`.
pub(crate) struct Recording {
    pub token: u64,
    pub lift_z: Option<i32>,
    /// Nothing in the root reads the colour of the text style around it, see [`Skip::ignores_text_color`].
    pub ignores_text_color: bool,
    pub subtree: crate::layout::cull::Subtree,
    pub overscan: Option<gpui::Pixels>,
    /// A patch can repaint the root, see [`Record::patch_root`]: gpui keeps what a patch needs of
    /// its surroundings, and the frame keeps what builds it again.
    pub patch_root: bool,
}

/// An element that was skipped, and what its parent and the frame need of it.
pub(crate) struct Skip {
    pub token: u64,
    pub enter: EnterKey,
    pub lift_z: Option<i32>,
    /// Nothing in the root reads the colour it inherits (`Record::reads_colors`), so gpui replays its
    /// recording under another colour of the text style around it. Not for a root a stacking context
    /// paints, or one that hands something to one: that is painted under the colour it has.
    pub ignores_text_color: bool,
    pub subtree: crate::layout::cull::Subtree,
    pub effects: Option<Rc<[BuildEffect]>>,
    /// How far past the clip of its scroller the subtree is recorded, if it is to be put
    /// elsewhere when the scroller moves it.
    pub overscan: Option<gpui::Pixels>,
    /// See [`Recording::patch_root`].
    pub patch_root: bool,
}

/// Why an element that is entered is built and not skipped; `getRetainDebug` reports the ones
/// that a record said could have been.
#[derive(Clone, Copy)]
enum Kept {
    PlanningOff,
    Everything,
    NotPlain,
    NotBoxed,
    Prekeyed,
    InUnit,
    Excluded,
    Moved,
    Spine,
    NoRecord,
    Ineligible,
    TooSmall,
    Revision,
    Inherited,
    Shape,
    LiftRun,
    Unmoved,
    Gated,
}

impl Kept {
    fn name(self) -> &'static str {
        match self {
            Self::PlanningOff => "planning-off",
            Self::Everything => "deltas-all",
            Self::NotPlain => "not-plain",
            Self::NotBoxed => "not-boxed",
            Self::Prekeyed => "prekeyed",
            Self::InUnit => "in-unit",
            Self::Excluded => "excluded-now",
            Self::Moved => "moved",
            Self::Spine => "spine",
            Self::NoRecord => "no-record",
            Self::Ineligible => "ineligible",
            Self::TooSmall => "too-small",
            Self::Revision => "enter-revision",
            Self::Inherited => "enter-inherited",
            Self::Shape => "enter-shape",
            Self::LiftRun => "lift-run",
            Self::Unmoved => "no-longer-moved",
            Self::Gated => "gated",
        }
    }
}

/// A root of fewer elements than this is worth a retained element of its own only if the element
/// is costly to build (`Entry::costly`). Replaying a root has a cost of its own, about what
/// building a plain box costs: 2000 childless boxes in a scroller that nothing changes took 1.3
/// times as long replayed as built (a rounded box 1.0, a text 0.4, since a text is the build that
/// is worth skipping). Measured on the pages of the FF demo (showcase, changelog, command menu,
/// hover, introduction), the texts and icons that are roots of one element are 0.5 to 0.8 ms of
/// 3 to 6 ms per idle frame. `GPUIX_RETAIN_MIN_ROOT=1` takes every box, to measure.
const MIN_ROOT: u32 = 2;

impl Retain {
    pub(crate) fn new() -> Self {
        let enabled = std::env::var_os("GPUIX_RETAIN_OFF").is_none();
        Self {
            enabled,
            planning_wanted: !cfg!(test),
            backoff: Backoff::default(),
            relocation: Relocation::default(),
            gate: gate::Gate::default(),
            inside_relocatable: false,
            pass: 1,
            elements: 0,
            quiet: true,
            #[cfg(test)]
            frame_log: Vec::new(),
            planning: enabled && !cfg!(test),
            lifted: 0,
            verify: cfg!(test) || std::env::var_os("GPUIX_RETAIN_VERIFY").is_some(),
            min_root: std::env::var("GPUIX_RETAIN_MIN_ROOT")
                .ok()
                .and_then(|min| min.parse().ok())
                .unwrap_or(MIN_ROOT),
            open: false,
            deferred: false,
            deferred_forced: false,
            layout_only: false,
            reference: false,
            unit: None,
            patch_root_unit: None,
            plan: Plan::default(),
            hover_patched: Vec::new(),
            makes_patch_roots: true,
            makes_anchors: true,
            patch_root_scans: FxHashMap::default(),
            hover_scans: Default::default(),
            row: false,
            row_parent_shape: 0,
            rows_seen: FxHashSet::default(),
            rows_before: FxHashSet::default(),
            row_candidates: false,
            page_summary: Summary::default(),
            selection: 0,
            nodes: Vec::new(),
            stack: Vec::new(),
            below: Vec::new(),
            retained: Vec::new(),
            moved: Vec::new(),
            records: FxHashMap::default(),
            dynamic: FxHashMap::default(),
            dormant: FxHashMap::default(),
            skipping: FxHashSet::default(),
            woken: FxHashSet::default(),
            verdicts: 0,
            moves: DormantMoves::default(),
            pruned_at: 0,
            seen: Seen::default(),
            deltas: Deltas::default(),
            unbuilt: FxHashSet::default(),
            summary: Summary::default(),
            exited_absent: false,
            mismatches: Vec::new(),
            debug: debug::Debug::from_env(),
            shown: scroll_gate::ShownFrame::default(),
            clock_asked: scroll_gate::ClockAsked::default(),
        }
    }

    /// With `verify` every element hashes what it built, and an element that is judged unchanged
    /// has to hash as it did. A mismatch is a hole in the key. Costs a style formatted per element.
    /// A frame that skips what it judged unchanged has no build to hash, so it is gpui that
    /// compares the frame with one built whole, see [`Self::verifies_frames`].
    pub(crate) fn set_verify(&mut self, verify: bool) {
        self.verify = verify;
        self.patch_root_scans.clear();
    }

    /// Whether a build is being hashed (`digest`): the one that builds a frame whole to compare it.
    pub(crate) fn verifying(&self) -> bool {
        self.verify && !self.planning
    }

    /// Whether gpui builds each frame that replayed something once more, whole, and compares the
    /// two.
    pub(crate) fn verifies_frames(&self) -> bool {
        self.verify && self.planning
    }

    #[cfg(test)]
    pub(crate) fn set_min_root(&mut self, min_root: u32) {
        self.min_root = min_root;
        self.patch_root_scans.clear();
    }

    /// As if the roots that frames planned to have a scroller move were found built again, for
    /// as long as a test draws.
    #[cfg(test)]
    pub(crate) fn stop_relocating(&mut self) {
        self.relocation.rest = u32::MAX;
    }

    /// Turns the skipping of unchanged subtrees on or off, which the next frame starts from
    /// nothing for.
    pub(crate) fn set_planning(&mut self, planning: bool) {
        self.planning_wanted = planning;
        self.planning = planning && self.enabled;
        self.forget();
    }

    /// Turns recording on or off, as `GPUIX_RETAIN_OFF` does for a whole run. The next frame
    /// starts from nothing.
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.planning = enabled && self.planning_wanted;
        self.forget();
    }

    /// Drops what the frames before recorded: the next recorded frame builds everything.
    fn forget(&mut self) {
        // The offsets stay, for the next frame to tell whether a scroller moved since.
        let scrolls = std::mem::take(&mut self.seen.scrolls);
        self.seen = Seen { scrolls, ..Seen::default() };
        self.records.clear();
        self.dynamic.clear();
        self.rows_before.clear();
        self.release_dormant(false);
        self.plan.recorded = false;
        self.publish_shown();
        self.backoff = Backoff::default();
        self.gate.forget();
    }

    /// Counts as if the exclusions named here, by `Exclusion::name`, were lifted.
    pub(crate) fn lift(&mut self, names: &[String]) -> Result<(), String> {
        let mut lifted = 0;
        for name in names {
            let reason = Exclusion::ALL
                .into_iter()
                .find(|reason| reason.name() == name)
                .ok_or_else(|| format!("no exclusion called {name}"))?;
            lifted |= 1 << reason as u32;
        }
        self.lifted = lifted;
        // What was recorded under other exclusions says nothing about these.
        self.records.clear();
        Ok(())
    }

    fn unless_lifted(&self, reason: Exclusion) -> Option<Exclusion> {
        (self.lifted & (1 << reason as u32) == 0).then_some(reason)
    }

    /// Whether each frame since the last call was recorded, a draw's later passes not counted.
    #[cfg(test)]
    pub(crate) fn take_frame_log(&mut self) -> Vec<bool> {
        std::mem::take(&mut self.frame_log)
    }

    pub(crate) fn record_counts(&self) -> [usize; 2] {
        [self.records.len(), self.dynamic.len() + self.dormant.len()]
    }

    /// Whether the frame being built (or the last one) leaves `id` dormant, see `Sources::dormant`.
    pub(crate) fn is_dormant(&self, id: u64) -> bool {
        self.dormant.contains_key(&id)
    }

    /// The elements that fell asleep or woke up in the frames since the last call.
    pub(crate) fn take_dormant_moves(&mut self) -> DormantMoves {
        std::mem::take(&mut self.moves)
    }

    /// Every dormant element wakes. `restore` puts what ran on them back among the dynamic
    /// elements, for the frame after to ask about them as one that was never dormant.
    fn release_dormant(&mut self, restore: bool) {
        for (id, bits) in std::mem::take(&mut self.dormant) {
            self.moves.left.push(id);
            if restore && bits != 0 {
                self.dynamic.entry(id).or_insert(bits);
            }
        }
        self.woken.clear();
    }

    pub(crate) fn mismatches(&self) -> &[String] {
        &self.mismatches
    }

    #[cfg(test)]
    pub(crate) fn summary(&self) -> &Summary {
        &self.summary
    }

    /// Starts the build of a frame. `selection` in `sources` is the identity of the selected
    /// text, 0 for none: text that is in a selection that moved paints differently.
    pub(crate) fn begin_frame(&mut self, sources: Sources) {
        // A frame draws what the tree has, and what was restyled by paint is in it.
        sources.tree.take_restyles();
        sources.tree.take_structure();
        self.prune(sources.tree);
        self.pass = sources.pass;
        self.layout_only = sources.layout_only;
        self.reference = sources.reference;
        self.unit = None;
        self.patch_root_unit = None;
        self.plan.serial += 1;
        if sources.layout_only {
            self.plan.layout_since = true;
            self.publish_shown();
        } else if !sources.reference {
            self.plan = Plan {
                serial: self.plan.serial,
                revision: sources.tree.root_revision(),
                ..Plan::default()
            };
            self.publish_shown();
        }
        if sources.pass == 1 && !sources.layout_only && !sources.reference {
            self.forget_unseen_rows(sources.tree);
        }
        if sources.pass == 1 && !sources.reference {
            self.learn_relocation(sources.tally.lazy_builds, sources.relocations);
            if !sources.layout_only && self.gate.learn(sources.tally, self.backs_off()) == gate::Change::Opened {
                self.records.retain(|id, _| self.gate.sampled(*id));
            }
        }
        self.elements = sources.tree.elements.len();
        if sources.pass == 1 && !sources.reference {
            self.quiet = self.dynamic.is_empty() && self.dormant.is_empty();
        }
        self.backoff.resting = self.enabled && self.rests(&sources);
        #[cfg(test)]
        if sources.pass == 1 && self.enabled {
            self.frame_log.push(!self.backoff.resting);
        }
        self.open = self.enabled && !self.backoff.resting;
        self.deferred = false;
        self.selection = sources.selection;
        self.nodes.clear();
        self.below.clear();
        self.stack.clear();
        // The pass that rebuilds a frame to compare it plans nothing, and builds the elements the
        // frame left dormant, which must stay dormant for what they ask of the window.
        if !sources.reference && !(self.open && self.planning) {
            self.release_dormant(true);
        }
        self.debug.begin_frame(sources.pass);
        crate::tape::clear_build_effects();
        if self.open && self.planning {
            self.find_deltas(&sources);
        }
    }

    /// Judges the roots the frame before planned to have moved, by how many gpui had to build
    /// anyway, and decides whether this frame plans on moving any.
    fn learn_relocation(&mut self, lazy_builds: u64, relocations: u64) {
        let relocation = &mut self.relocation;
        let built = lazy_builds.wrapping_sub(relocation.lazy_builds);
        let moved = relocations.wrapping_sub(relocation.relocations);
        relocation.lazy_builds = lazy_builds;
        relocation.relocations = relocations;
        if relocation.planned > 0 {
            // A root put elsewhere is a build that was not made, and one built late costs about a
            // fifth of a build more than building it in the frame: a few that are put are worth
            // many that are not.
            if moved * 4 < built {
                relocation.gap = (relocation.gap * 2).clamp(1, BACKOFF_CAP);
                relocation.rest = relocation.gap;
            } else {
                relocation.gap = 0;
            }
        }
        relocation.planned = 0;
        relocation.resting = relocation.rest > 0;
        relocation.rest = relocation.rest.saturating_sub(1);
    }

    /// Forgets the elements the tree destroyed. A record of one is never read again (ids are not
    /// reused), but it would stay for as long as the window lives, so a page that mounts and
    /// unmounts rows grows it for good. Looks only when the tree destroyed something.
    fn prune(&mut self, tree: &crate::retained_tree::RetainedTree) {
        if tree.removals() == self.pruned_at {
            return;
        }
        self.pruned_at = tree.removals();
        self.records.retain(|id, _| tree.elements.contains_key(id));
        self.dynamic.retain(|id, _| tree.elements.contains_key(id));
        self.unbuilt.retain(|id| tree.elements.contains_key(id));
        let moves = &mut self.moves;
        self.dormant.retain(|id, _| {
            let exists = tree.elements.contains_key(id);
            if !exists {
                moves.left.push(*id);
            }
            exists
        });
        self.woken.retain(|id| tree.elements.contains_key(id));
        self.skipping.retain(|id| tree.elements.contains_key(id));
        self.patch_root_scans.retain(|id, _| tree.elements.contains_key(id));
    }

    /// Whether the frame about to be built is one that is not recorded, see [`Backoff`].
    fn rests(&mut self, sources: &Sources) -> bool {
        if !self.backs_off() {
            self.backoff = Backoff::default();
            return false;
        }
        // The passes after the first of a draw see the scrollers where the first left them, and
        // are not frames of their own: they follow the first, or the stretch it began.
        if sources.pass != 1 {
            return self.backoff.resting || self.backoff.rest > 0;
        }
        if self.backoff.rest == 0 {
            return false;
        }
        if self.backoff.elements != self.elements {
            self.backoff = Backoff::default();
            return false;
        }
        let scrolls = scroll_bits(sources.scrolls);
        let moving = scrolls != self.seen.scrolls;
        self.seen.scrolls = scrolls;
        let backoff = &mut self.backoff;
        let stopped = backoff.scrolling && !moving;
        backoff.scrolling = moving;
        if stopped {
            backoff.rest = 0;
            return false;
        }
        backoff.rest -= 1;
        true
    }

    /// Whether a root of `size` elements saves more than replaying it costs. A verified run takes
    /// every root, since it is replay that it checks.
    fn worth(&self, size: u32, costly: bool) -> bool {
        self.verify || size >= self.min_root || costly
    }

    /// A verified run records every frame, since it is the recording that it checks.
    fn backs_off(&self) -> bool {
        self.planning && !self.verify
    }

    /// What changed in `sources` since the frame before, as the elements that differ and their
    /// ancestors.
    fn find_deltas(&mut self, sources: &Sources) {
        let found = self.compute_deltas(sources, false);
        self.commit_deltas(sources, found);
    }

    /// What the pointer, the focus, the scrolls and the custom elements say differs from the frame before,
    /// the part of [`Self::compute_deltas`] that no clock moves (`preview` is as it is there).
    fn compare_sources(&self, sources: &Sources, preview: bool) -> Compared {
        let mut changed: Vec<u64> = Vec::new();
        let seen = &self.seen;
        let all = !seen.known || seen.selection != sources.selection;

        if !preview {
            differ(&seen.hovered, sources.hovered, &mut changed);
            changed.extend(&sources.hover_paint);
            changed.extend(&self.hover_patched);
        }
        differ(&seen.active, sources.active, &mut changed);
        differ(&seen.within, &sources.focus.within, &mut changed);
        // The target's ancestors stay in the chain, and `:has(:hover)` changes for the one the
        // target moves to or from.
        if !preview && seen.hovered.first() != sources.hovered.first() {
            changed.extend(seen.hovered.first().into_iter().chain(sources.hovered.first()));
        }
        if seen.active.first() != sources.active.first() {
            changed.extend(seen.active.first().into_iter().chain(sources.active.first()));
        }
        if seen.within.first() != sources.focus.within.first() {
            changed.extend(seen.within.first().into_iter().chain(sources.focus.within.first()));
        }
        if seen.visible != sources.focus.visible {
            changed.extend(seen.visible.into_iter().chain(sources.focus.visible));
        }
        match (&seen.dim, &sources.focus.dim_path) {
            (None, None) => {}
            (Some(before), Some(now)) => differ(before, now, &mut changed),
            // Every focusable element that is not on the path dims, or stops dimming.
            _ => changed.extend(sources.focusable.keys()),
        }

        // A motion element answers to the gestures of the ancestor that controls its variants,
        // which are not on its own chain.
        if !changed.is_empty() {
            let moved: FxHashSet<u64> = changed.iter().copied().collect();
            for &id in &sources.tree.motion_ids {
                if crate::motion::gesture_controller(sources.tree, id).is_some_and(|controller| moved.contains(&controller)) {
                    changed.push(id);
                }
            }
        }

        let mut scrolled = FxHashSet::default();
        let scrolls = scroll_bits(sources.scrolls);
        let mut scrolling = false;
        for (id, bits) in &scrolls {
            match seen.scrolls.get(id) {
                Some(before) if before == bits => continue,
                Some(_) => scrolling = true,
                // What a frame built in a scroller it found at its origin was built where it is, and
                // `Scroller::of` records it to be moved: the first scroll relocates it.
                None if f32::from_bits(bits.0) == 0.0 && f32::from_bits(bits.1) == 0.0 => continue,
                None => {}
            }
            changed.push(*id);
            scrolled.insert(*id);
        }
        changed.extend(seen.scrolls.keys().filter(|id| !scrolls.contains_key(id)));

        let mut customs = FxHashMap::default();
        for (id, state) in &sources.customs {
            if seen.customs.get(id) != Some(state) {
                changed.push(*id);
            }
            customs.insert(*id, *state);
        }
        changed.extend(seen.customs.keys().filter(|id| !customs.contains_key(id)));

        Compared { all, changed, scrolled, scrolling, scrolls, customs }
    }

    /// Whether something differs from the frame shown that a frame that only moves the rows of a list would
    /// leave as it was: a source `compute_deltas` finds for a tick (a press, the focus, a selection, a custom
    /// element, the scroll of a scroller that is no list: the list is not among `Sources::scrolls`), a
    /// measurement, a link, a command or a hover restyled by paint that no frame has drawn. A peek, as `preview` is.
    pub(crate) fn sources_changed(&self, sources: &Sources) -> bool {
        if !self.seen.known {
            return true;
        }
        let compared = self.compare_sources(sources, true);
        compared.all
            || !compared.changed.is_empty()
            || !sources.measured.is_empty()
            || !sources.links.is_empty()
            || !sources.commanded.is_empty()
            || !sources.relevance.is_empty()
            || !sources.hover_paint.is_empty()
    }

    /// What `sources` differ in from what the frame before saw. Changes nothing, so that a tick can
    /// ask whether a frame would find something without being that frame.
    ///
    /// A `preview` is for a tick that a patch can draw, which takes the hover from
    /// `Sources::hover_paint` and does not look at the chain: a hover that restyles by paint is
    /// there, and one that restyles otherwise is a frame built whole before any tick is asked about.
    /// A frame built whole takes the chain's difference, the elements restyled since it by paint,
    /// and those that patches repainted.
    fn compute_deltas(&self, sources: &Sources, preview: bool) -> Found {
        let compared = self.compare_sources(sources, preview);
        let all = compared.all;
        let scrolled = compared.scrolled;
        let scrolling = compared.scrolling;
        let scrolls = compared.scrolls;
        let customs = compared.customs;
        let mut changed = compared.changed;

        let motion: FxHashSet<u64> = sources.motion.iter().copied().collect();
        // A dormant element is not a change: the roots above it keep their recording, and a frame
        // that shows it builds the root late, with the clock of that frame. One that was found
        // dormant is not asked about again until a build reaches it or `verdicts` moves.
        let stale = sources.verdicts != self.verdicts;
        let sleeps = |id: u64| !stale && self.dormant.contains_key(&id) && !self.woken.contains(&id);
        let mut entered = FxHashSet::default();
        let mut running = Vec::new();
        for &id in &motion {
            if sleeps(id) {
                continue;
            }
            if (sources.dormant)(id) {
                entered.insert(id);
            } else {
                running.push(id);
            }
        }
        running.extend(self.seen.motion.iter().filter(|id| !motion.contains(id)));
        let mut dynamic = Vec::new();
        // Everything that is asleep is asked again when the answers may have moved.
        let sleepers = self.dormant.iter().filter(|(id, bits)| stale && **bits != 0 && !self.dynamic.contains_key(id));
        for (&id, &bits) in self.dynamic.iter().chain(sleepers) {
            if entered.contains(&id) || (bits & !Dynamic::OWN == 0 && (sources.dormant)(id)) {
                entered.insert(id);
            } else {
                dynamic.push(id);
            }
        }
        Found { all, sourced: changed, scrolled, scrolling, scrolls, customs, motion, running, dynamic, entered, stale }
    }

    /// Whether the only thing that runs on `id` is the clock of a caret or the values it is bound
    /// to, and neither has changed since it was painted: a tick of any other loop leaves it as it
    /// is, as Chrome paints the caret again only when it blinks and an element only when what it
    /// shows differs.
    fn between_changes(&self, sources: &Sources, id: u64) -> bool {
        let kinds = [Dynamic::Blink as u8, Dynamic::MotionValues as u8];
        self.dynamic.get(&id).is_some_and(|bits| kinds.contains(bits)) && !(sources.clock_due)(id)
    }

    /// Whether `id` is dormant in the frame `found` is the delta of.
    fn asleep_in(&self, found: &Found, id: u64) -> bool {
        found.entered.contains(&id) || (!found.stale && self.dormant.contains_key(&id) && !self.woken.contains(&id))
    }

    /// Makes what `compute_deltas` found the delta of the frame being built, and what the next
    /// frame is compared with.
    fn commit_deltas(&mut self, sources: &Sources, found: Found) {
        let Found { all, sourced, scrolled, scrolling, scrolls, customs, motion, running, dynamic, entered, stale } = found;
        let mut changed = sourced;
        self.hover_patched.clear();
        let seen = &mut self.seen;
        self.debug.sources("pointer-focus-scroll-custom", changed.iter().copied());
        self.debug.sources("motion-just-ended", seen.motion.iter().copied().filter(|id| !sources.motion.contains(id)));
        self.debug.sources("motion-running", running.iter().copied());
        self.debug.sources("dynamic-last-build", dynamic.iter().copied());
        self.debug.sources("dormant", entered.iter().copied());
        self.debug.sources("measurement", sources.measured.iter().copied());
        self.debug.sources("link", sources.links.iter().copied());
        self.debug.sources("web-animation-command", sources.commanded.iter().copied());
        self.debug.sources("content-visibility", sources.relevance.iter().copied());
        changed.extend(running);
        changed.extend(&sources.measured);
        changed.extend(&sources.links);
        changed.extend(&sources.commanded);
        changed.extend(&sources.relevance);
        changed.extend(dynamic);

        seen.known = true;
        seen.hovered = sources.hovered.to_vec();
        seen.active = sources.active.to_vec();
        seen.within = sources.focus.within.clone();
        seen.visible = sources.focus.visible;
        seen.dim = sources.focus.dim_path.clone();
        seen.scrolls = scrolls;
        seen.customs = customs;
        seen.motion = motion;
        seen.selection = sources.selection;
        self.settle_dormant(sources.verdicts, stale, entered);

        // Closed under parent, which is what makes stopping at the first id already in it right:
        // every id it holds had its whole chain walked. Seeding it with `unbuilt` as it is would
        // not be, as the built ancestors of an unbuilt id have left that set.
        let mut spine = FxHashSet::default();
        for id in self.unbuilt.iter().copied().chain(changed) {
            let mut at = Some(id);
            while let Some(id) = at {
                if !spine.insert(id) {
                    break;
                }
                at = sources.tree.elements.get(&id).and_then(|element| element.parent);
            }
        }
        if self.verify {
            check_spine(&spine, sources.tree, &mut self.mismatches);
        }
        self.unbuilt = spine
            .iter()
            .copied()
            .filter(|id| sources.tree.elements.get(id).is_some_and(|element| !element.is_built_by_ancestor(sources.tree)))
            .collect();
        self.forget_changed_under_skipped(&spine, sources.tree);
        self.deltas = Deltas { all, spine, scrolled, scrolling };
    }

    /// A record kept of content a frame skips (`skip_content`) says what the element was when it was
    /// built, and a frame that skips the host builds none of what changed in it: a hover, a focus, a
    /// motion or a measurement that moved. The spine is closed under parent, so the elements in it
    /// are the changed ones and the path up to the host, and the records of those go.
    fn forget_changed_under_skipped(&mut self, spine: &FxHashSet<u64>, tree: &crate::retained_tree::RetainedTree) {
        if self.skipping.is_empty() {
            return;
        }
        for &id in spine {
            let mut up = tree.elements.get(&id).and_then(|element| element.parent);
            while let Some(above) = up {
                if self.skipping.contains(&above) {
                    self.records.remove(&id);
                    break;
                }
                up = tree.elements.get(&above).and_then(|element| element.parent);
            }
        }
    }

    /// Makes the elements `compute_deltas` found dormant the dormant ones, and wakes those it asked
    /// about again and found otherwise.
    fn settle_dormant(&mut self, verdicts: u64, stale: bool, entered: FxHashSet<u64>) {
        let asked: Vec<u64> = if stale {
            self.dormant.keys().copied().collect()
        } else {
            self.woken.iter().copied().filter(|id| self.dormant.contains_key(id)).collect()
        };
        for id in asked {
            if entered.contains(&id) {
                continue;
            }
            let bits = self.dormant.remove(&id).expect("asked about the dormant");
            self.moves.left.push(id);
            // One that a build reached has what ran on it from that build.
            if bits != 0 && !self.woken.contains(&id) {
                self.dynamic.entry(id).or_insert(bits);
            }
        }
        for id in entered {
            let running = self.dynamic.remove(&id);
            match self.dormant.entry(id) {
                std::collections::hash_map::Entry::Occupied(mut asleep) => {
                    if let Some(bits) = running {
                        *asleep.get_mut() = bits;
                    }
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(running.unwrap_or(0));
                    self.moves.entered.push(id);
                }
            }
        }
        self.woken.clear();
        self.verdicts = verdicts;
    }

    /// Starts the build of a subtree that gpui asked for after the frame was built, because the
    /// frame before did not leave it recorded as the same, or does not lay out where it was.
    pub(crate) fn begin_deferred(&mut self, inside_relocatable: bool, forced: bool) {
        self.open = self.enabled && !self.backoff.resting;
        self.deferred = true;
        self.deferred_forced = forced;
        self.unit = None;
        self.patch_root_unit = None;
        self.inside_relocatable = inside_relocatable;
        self.nodes.clear();
        self.below.clear();
        self.stack.clear();
    }

    pub(crate) fn finish_deferred(&mut self) {
        self.debug.deferred(self.nodes.first(), self.nodes.len());
        let _ = self.finish_session();
        self.deferred = false;
        self.deferred_forced = false;
        self.inside_relocatable = false;
    }

    /// Starts the build of a row of a virtual list, which the list asks for while it lays out,
    /// after the session of the page closed. The row is a root like any other: it is entered with
    /// the shape of the list for a parent (`parent_shape`, `current_shape` while the list was
    /// built), skipped when the frame found it unchanged, recorded when it is built. Unlike a
    /// subtree built late it is a build of the frame, so it takes the next epoch, and it is no
    /// part of the page's decision: `plan`, `summary` and the dynamic elements of other rows are
    /// as the page left them.
    pub(crate) fn begin_row(&mut self, parent_shape: u64, row_id: u64) {
        debug_assert!(self.stack.is_empty(), "a row is not built inside an element");
        self.rows_seen.insert(row_id);
        self.open = self.enabled && !self.backoff.resting;
        self.row = true;
        self.row_parent_shape = parent_shape;
        self.unit = None;
        self.patch_root_unit = None;
        self.inside_relocatable = false;
        self.nodes.clear();
        self.below.clear();
        self.stack.clear();
        self.page_summary = std::mem::take(&mut self.summary);
        crate::tape::clear_build_effects();
    }

    pub(crate) fn finish_row(&mut self) {
        self.row_candidates |= self.finish_session();
        self.row = false;
        self.row_parent_shape = 0;
        self.summary = std::mem::take(&mut self.page_summary);
    }

    /// The rows the list stopped asking for since the last frame take their records and dynamic
    /// elements with them, whole subtree and all, as `forget_unbuilt_dynamic` does for the ones
    /// under an absent box. A row that is not built is not visited, so nothing of the page's walk
    /// forgets what is in it. Its records go for two reasons: a list that scrolls through thousands
    /// of rows would keep one per element it ever built, and the box of a row the list does not lay
    /// out is gone (`Scroller::holds`) while its record stays. A frame that asks for it again would
    /// skip it as relocatable, handing gpui a root that cannot be put elsewhere (no box, so no
    /// overscan), which gpui builds late and records without the handles that move what it holds
    /// outside the frame, to replay it under a root that is relocatable once the box is back. A row
    /// without a record is built, and recorded as a root that has no box yet is.
    ///
    /// The subtree is walked from the tree, not listed from what the row's last build made: a root
    /// the build skipped, and what gpui built late inside the row (`begin_deferred`), have records
    /// too, and the build that made them is not the last one. The walk stops at a nested
    /// `<virtual-list>`: its rows are rows of their own, swept when they are among `rows_before`,
    /// and the ones the list never asked for have no record, so descending would visit every row of
    /// an inner list each time the outer row leaves the viewport.
    fn forget_unseen_rows(&mut self, tree: &crate::retained_tree::RetainedTree) {
        let seen = std::mem::take(&mut self.rows_seen);
        if !(self.records.is_empty() && self.dynamic.is_empty()) {
            for_each_unseen_element(&self.rows_before, &seen, tree, |id| {
                self.dynamic.remove(&id);
                self.records.remove(&id);
            });
        }
        self.rows_before = seen;
    }

    /// The rows that a frame that moved the rows of a list in place took out of the frame take their
    /// records, dynamic elements and patch roots with them, as the rows a list stops asking for do in
    /// `forget_unseen_rows`: the frame that moved them is no frame that visits the rest, and a row
    /// that came in again would be skipped with a record of a build whose recording gpui dropped with
    /// the row.
    pub(crate) fn forget_left_rows(&mut self, left: &[u64], tree: &crate::retained_tree::RetainedTree) {
        if left.is_empty() {
            return;
        }
        let left: FxHashSet<u64> = left.iter().copied().collect();
        let mut gone = FxHashSet::default();
        for_each_unseen_element(&left, &FxHashSet::default(), tree, |id| {
            self.dynamic.remove(&id);
            self.records.remove(&id);
            gone.insert(id);
        });
        self.rows_seen.retain(|row| !left.contains(row));
        self.rows_before.retain(|row| !left.contains(row));
        self.plan.patch_roots.retain(|unit| !gone.contains(&unit.id));
        self.plan.patch_root_ids.retain(|id| !gone.contains(id));
        self.plan.anchors.retain(|unit| !gone.contains(&unit.id));
        self.plan.anchor_ids.retain(|id| !gone.contains(id));
        self.plan.repainted.retain(|id| !gone.contains(id));
        self.plan.unrecorded.retain(|id| !gone.contains(id));
    }

    /// The shape of the element being built, for a child that is not built inside it to take as its
    /// parent's (`begin_row`).
    pub(crate) fn current_shape(&self) -> u64 {
        self.stack.last().map_or(0, |at| self.nodes[*at as usize].key.shape)
    }

    /// Stops recording, for a build that is not part of a frame (`GpuixView::build_unit`): nothing
    /// is entered, skipped or noted until `resume` gives back what it returns.
    pub(crate) fn suspend(&mut self) -> bool {
        debug_assert!(self.stack.is_empty(), "a build is not suspended inside another");
        std::mem::replace(&mut self.open, false)
    }

    pub(crate) fn resume(&mut self, open: bool) {
        self.open = open;
    }

    /// Whether the element being built is recorded, so the caller can skip work only the record needs.
    pub(crate) fn recording(&self) -> bool {
        self.open
    }

    /// The element being built (not skipped, just entered) is the root of a unit if the last build
    /// of it found only paint-only motion running on it, nothing is dormant, and the build
    /// around it hands it nothing it could not be built again without (`plain`). Nothing inside
    /// a unit is skipped, and `end_unit` says whether what was built is one. Returns the key the
    /// element was entered with, for the unit to be built again with.
    pub(crate) fn begin_unit(&mut self, plain: bool) -> Option<EnterKey> {
        if !plain
            || !self.planning
            || !self.recording()
            || self.deferred
            || self.row
            || self.layout_only
            || self.unit.is_some()
            || self.patch_root_unit.is_some()
        {
            return None;
        }
        let at = *self.stack.last()?;
        let node = &self.nodes[at as usize];
        if node.exclusion.is_some() || node.skipped.is_some() || self.dormant.contains_key(&node.id) {
            return None;
        }
        let record = self.records.get(&node.id)?;
        if !record.is_unit_candidate() {
            return None;
        }
        if record.size > UNIT_MAX_ELEMENTS {
            crate::perf_counters::unit_oversized();
            return None;
        }
        self.unit = Some(at);
        Some(EnterKey(node.enter))
    }

    /// The build of the element that `begin_unit` made a unit is over: whether what it built is
    /// one, which is judged by the build and not by the record of the build before. The element
    /// and what it holds are exactly the nodes since, and a unit holds none that is excluded, that
    /// scrolls (a scroll bypasses the tape that a patch compares), lifts something out of it, or
    /// is positioned against something outside it. The element itself may be lifted, into the
    /// stacking context around it, as an element with an opacity is, and may be `position: absolute`
    /// (the block that places it is outside, and gpui builds it whole in every frame): the `z` it is lifted at is
    /// returned with the subtree, for the unit to be handed over as gpui wants it, and what it holds
    /// must be consumed by the context it forms, or there is none (a positioned element
    /// without a `z-index`), and nothing in it is lifted.
    pub(crate) fn end_unit(&mut self) -> Option<(crate::layout::cull::Subtree, Option<i32>)> {
        let at = *self.stack.last()?;
        if self.unit != Some(at) {
            return None;
        }
        self.unit = None;
        let first = at as usize;
        let size = self.nodes.len() - first;
        if size > UNIT_MAX_ELEMENTS as usize {
            crate::perf_counters::unit_oversized();
            return None;
        }
        if self.nodes[first].absent {
            return None;
        }
        // Children come after their parent, as in `finish_session`.
        let mut lifts = vec![false; size];
        let mut escapes = vec![false; size];
        let parts_of_unit = self.nodes[first].collapsed_table;
        for index in (0..size).rev() {
            let node = &self.nodes[first + index];
            let excluded = node.exclusion.is_some_and(|reason| index == 0 || !parts_of_unit || reason != Exclusion::CollapsedTable);
            if excluded || node.skipped.is_some() || node.vol.scroll != 0 {
                return None;
            }
            let lifts_below = !node.forms_context && lifts[index];
            let lifts_out = node.lift_z.is_some() || lifts_below;
            let escaped = node.absolute || (!node.positioned && escapes[index]);
            if index == 0 {
                // An absolute root is placed by a box outside it, which gpui keeps no recording of: the
                // frame builds it whole every time, and a patch paints it where that frame left its node.
                let escaped_below = !node.positioned && escapes[index];
                if lifts_below || escaped_below {
                    return None;
                }
                break;
            }
            let parent = node.parent as usize - first;
            lifts[parent] |= lifts_out;
            escapes[parent] |= escaped;
        }
        crate::perf_counters::unit_built();
        Some((self.nodes[first].subtree, self.nodes[first].lift_z))
    }

    /// Keeps the unit built since `begin_unit` for the ticks that follow the frame.
    pub(crate) fn add_unit(&mut self, unit: Unit) {
        // The pass that rebuilds a frame for comparison (after a patch it is the frame shown) wraps
        // the units of the frame it stands for, and leaves the plan as that frame made it.
        if self.reference {
            return;
        }
        self.plan.ids.insert(unit.id);
        self.plan.units.push(unit);
    }

    /// What differs between the keys of two units of the same element in two frames.
    pub(crate) fn unit_key(&self) -> u64 {
        self.plan.serial
    }

    /// The unit of the last frame built whole that is the element `id`: one that a running paint-only
    /// animation changes, or a root that a patch repaints.
    pub(crate) fn unit(&self, id: u64) -> Option<&Unit> {
        self.plan.units.iter().chain(&self.plan.patch_roots).chain(&self.plan.anchors).find(|unit| unit.id == id)
    }

    /// Whether the element `id` is made a patch root if the build leaves it recorded: a patch can repaint it
    /// as one piece. The subtree is small enough (`PATCH_ROOT_MAX_ELEMENTS`), nothing in it has a size an intrinsic
    /// keyword gives or declares or follows a group, and one of:
    /// - it declares a hover that only paints, or holds an element that does, and lifts nothing out of it (`may_lift`)
    ///   unless it is a row of a list, which consumes what is lifted in it: a root that lifts is recorded as one that
    ///   hands elements to the stacking context around, and the roots in it are recorded for it as they were;
    /// - it is a row of a virtual list, whatever its style: what a row holds is built whole already, as a patch root's is;
    /// - it holds no element that is worth a root of its own, lifts nothing, and nothing runs or sleeps in the window:
    ///   a patch root records nothing inside it, which for such an element changes nothing that was recorded (a unit
    ///   is one that something runs on).
    /// Worked out once per revision of the subtree. False while nothing is recorded.
    pub(crate) fn can_be_patch_root(&mut self, tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
        if !self.open || !self.planning || !self.makes_patch_roots {
            return false;
        }
        let scan = self.scan_patch_root(tree, id);
        if scan.unfit || scan.size > PATCH_ROOT_MAX_ELEMENTS {
            return false;
        }
        let Some(element) = tree.elements.get(&id) else {
            return false;
        };
        if crate::layout::stacking::is_virtual_row(tree, element) {
            return true;
        }
        if scan.lifts {
            return false;
        }
        scan.hovers || (self.quiet && !scan.root_below && self.worth(scan.size, costly(element)))
    }

    /// What a subtree holds that a patch root is judged by: whether `id` or something below it declares a hover that
    /// paints only, how many elements it holds, whether something in it might lift, and whether something in it is
    /// worth a root. A subtree bigger than a patch root says it holds one more than one may, and nothing of the
    /// elements below it: they are asked for when they are entered.
    fn scan_patch_root(&mut self, tree: &crate::retained_tree::RetainedTree, id: u64) -> PatchRootScan {
        let Some(element) = tree.elements.get(&id) else {
            return PatchRootScan::default();
        };
        if let Some((revision, scan)) = self.patch_root_scans.get(&id) {
            if *revision == element.subtree_revision {
                return *scan;
            }
        }
        let mut hovers = element.style.as_ref().is_some_and(|style| {
            self.hover_scans.of_one(style, crate::events::hover_paint::paint_hover_of).settled(tree, id)
        });
        let mut lifts = element.style.as_deref().is_some_and(crate::events::hover_paint::may_lift);
        let mut unfit = element
            .style
            .as_deref()
            .is_some_and(|style| crate::events::hover_paint::has_intrinsic_size(style) || crate::events::hover_paint::uses_groups(style));
        let mut root_below = false;
        let mut size = 1;
        for child in &element.children {
            let below = self.scan_patch_root(tree, *child);
            hovers |= below.hovers;
            lifts |= below.lifts;
            unfit |= below.unfit;
            root_below |= below.rooted;
            size += below.size;
            if size > PATCH_ROOT_MAX_ELEMENTS {
                break;
            }
        }
        let scanned = if size > PATCH_ROOT_MAX_ELEMENTS {
            PatchRootScan { hovers: false, size: PATCH_ROOT_MAX_ELEMENTS + 1, lifts, root_below: true, rooted: true, unfit }
        } else {
            let rooted = root_below || self.worth(size, costly(element));
            PatchRootScan { hovers, size, lifts, root_below, rooted, unfit }
        };
        self.patch_root_scans.insert(id, (element.subtree_revision, scanned));
        scanned
    }

    /// The element just entered is the root a patch repaints if the build leaves it recorded
    /// (`Recording::patch_root`): the key it was entered with, for the unit to be built again from.
    ///
    /// What is built below it is built whole and recorded by no root of its own, as in a unit,
    /// until the element is left; a pass that only lays out does the same, but returns none: its
    /// roots are no frame to patch.
    pub(crate) fn begin_patch_root(&mut self) -> Option<EnterKey> {
        // The pass that rebuilds a frame to compare it makes the roots the frame it stands for made: after
        // a patch it is the frame shown.
        if !self.open || !self.planning || self.deferred || self.patch_root_unit.is_some() {
            return None;
        }
        let at = *self.stack.last()?;
        let node = &self.nodes[at as usize];
        // Not asked of the record of the last build: the pass that rebuilds a frame to compare it has
        // the record the first pass made, and has to build the roots in it as that pass did.
        if !(node.patch_root && node.records) {
            return None;
        }
        let enter = EnterKey(node.enter);
        self.patch_root_unit = Some(at);
        // A pass that only lays out builds the root as the frames do, but is no frame to patch.
        (!self.layout_only).then_some(enter)
    }

    /// The element just entered is a scroller that may be a patch anchor: a patch lays the scroller out
    /// again and repaints it, where a unit or a patch root repaints what it is. Unlike them nothing is
    /// suppressed inside it: the frame builds and records the scroller's children as it does (rows and
    /// content that move with a scroll stay roots), and `end_anchor` says whether what was built is one.
    /// Returns the key the element was entered with, for it to be built again with.
    pub(crate) fn begin_anchor(&mut self, plain: bool) -> Option<EnterKey> {
        if !plain
            || !self.makes_anchors
            || !self.planning
            || !self.recording()
            || self.deferred
            || self.row
            || self.layout_only
            || self.unit.is_some()
            || self.patch_root_unit.is_some()
            || self.inside_relocatable
        {
            return None;
        }
        let at = *self.stack.last()?;
        let node = &mut self.nodes[at as usize];
        if node.skipped.is_some() || !node.records || node.moved || self.dormant.contains_key(&node.id) {
            return None;
        }
        node.anchor = true;
        Some(EnterKey(node.enter))
    }

    /// The build of the element `begin_anchor` entered is over, and it is not yet left: whether what it
    /// built is an anchor. It is a scroller and nothing else excluded is in it, nothing runs in it, nothing
    /// in it is lifted out or placed against a block outside it, and it holds at most `ANCHOR_MAX_ELEMENTS`.
    pub(crate) fn end_anchor(&mut self) -> Option<crate::layout::cull::Subtree> {
        let at = *self.stack.last()? as usize;
        let node = &self.nodes[at];
        if !node.anchor {
            return None;
        }
        let own = &self.below[at];
        let refused = node.exclusion != Some(Exclusion::Scroller)
            || own.excluded.is_some()
            || node.absent
            || node.absolute
            || node.lift_z.is_some()
            || own.lifts
            || (!node.positioned && own.escapes)
            || own.dynamic
            || node.vol.dynamic != 0
            || node.forced_host
            || node.under_forced
            || node.skipped.is_some()
            || crate::background_images::still_loading() != node.loading
            || own.size + 1 > ANCHOR_MAX_ELEMENTS;
        (!refused).then_some(node.subtree)
    }

    /// Keeps the anchor built since `begin_anchor` for the patches that follow the frame.
    pub(crate) fn add_anchor(&mut self, unit: Unit) {
        if self.reference {
            return;
        }
        self.plan.anchor_ids.insert(unit.id);
        self.plan.anchors.push(unit);
    }

    /// Whether the last frame built whole has the element `id` as an anchor.
    pub(crate) fn is_anchor(&self, id: u64) -> bool {
        self.plan.anchor_ids.contains(&id)
    }

    /// Tells the tree which scrollers are anchors, once the frame built whole is over: a batch whose
    /// changes lie in them asks for a patch (`RetainedTree::structure_attributed`).
    pub(crate) fn publish_anchors(&self, tree: &crate::retained_tree::RetainedTree) {
        if self.reference || self.layout_only || !self.plan.recorded {
            return;
        }
        tree.set_anchors(self.plan.anchor_ids.clone(), self.plan.revision);
    }

    /// An anchor was patched: what the recordings of its content hold is of the layout before, so
    /// no element of it is skipped by the next frame built whole, which builds and records it all.
    /// `rewritten` says gpui rewrote the recording of the anchor itself, which is then patched again.
    pub(crate) fn anchor_repainted(&mut self, tree: &crate::retained_tree::RetainedTree, id: u64, rewritten: bool) {
        self.plan.repainted.insert(id);
        if !rewritten {
            self.plan.unrecorded.insert(id);
        }
        let mut pending = vec![id];
        while let Some(next) = pending.pop() {
            self.records.remove(&next);
            self.patch_root_scans.remove(&next);
            if let Some(element) = tree.elements.get(&next) {
                pending.extend(element.children.iter().copied());
            }
        }
    }

    /// The anchor of the last frame built whole that holds `id`, walking up.
    fn anchor_holding(&self, tree: &crate::retained_tree::RetainedTree, id: u64) -> Option<u64> {
        let mut at = Some(id);
        while let Some(up) = at {
            if self.plan.anchor_ids.contains(&up) {
                return Some(up);
            }
            at = tree.elements.get(&up).and_then(|element| element.parent);
        }
        None
    }

    /// Whether frames are recorded to be patched: the retention is planning.
    pub(crate) fn plans(&self) -> bool {
        self.planning
    }

    /// Makes the patch roots ready for a patch to repaint, or not (patching is off).
    pub(crate) fn set_patch_roots(&mut self, on: bool) {
        self.makes_patch_roots = on;
        self.makes_anchors = on && std::env::var_os("GPUIX_ANCHORS_OFF").is_none();
    }

    /// Whether the last frame built whole has the element `id` as a root that a patch repaints.
    pub(crate) fn is_patch_root(&self, id: u64) -> bool {
        self.plan.patch_root_ids.contains(&id)
    }

    /// Keeps the root that a patch repaints, for the ticks that follow the frame.
    pub(crate) fn add_patch_root(&mut self, unit: Unit) {
        if self.reference {
            return;
        }
        self.plan.patch_root_ids.insert(unit.id);
        self.plan.patch_roots.push(unit);
    }

    /// The patches that were drawn for the elements `ids` restyled by paint: the roots that hold
    /// them are built again by the next frame built whole.
    pub(crate) fn hover_repainted(&mut self, ids: Vec<u64>) {
        self.hover_patched.extend(ids);
    }

    /// The units of the last frame built whole, in the order it built them.
    #[cfg(test)]
    pub(crate) fn units(&self) -> &[Unit] {
        &self.plan.units
    }

    /// Notes that what runs on the element being built only changes what it paints (or does not):
    /// the element is the root of a unit in a later frame only if it does.
    pub(crate) fn paints_only(&mut self, paints_only: bool) {
        if let Some(node) = self.top() {
            node.paints_only = paints_only;
        }
    }

    /// Whether a tick that finds `sources` can be drawn by building again the units that hold what
    /// changed, and which they are (by element id, in the order the last frame built them). It
    /// can when, since the last frame that was built whole, nothing but time changed (the animations
    /// that run, a motion that ended, an element not yet built), every element it changed is in a
    /// unit or is dormant, the tree is the one that frame was built from, and that frame built
    /// nothing that follows the clock outside the units. Changes nothing: a tick that is not drawn
    /// this way is drawn whole, and finds the same changes.
    ///
    /// `scroll_animating` says whether a scroll animation has frames to run, or a scrollbar has
    /// (it fades or thickens) or is not as the clock has it (its hold ended),
    /// and `gliding` whether a `layout` box has a glide or events that a frame has to carry on.
    /// `sources` is what the tick would be built from, with the peeks of the sources that are taken
    /// when read (`Measurements::peek_changed`, `links::peek_changed`, `take_commanded`'s peek).
    pub(crate) fn preview(&self, sources: &Sources, scroll_animating: bool, gliding: bool) -> Result<Vec<u64>, Unpatchable> {
        if !self.planning || !self.plan.recorded || !self.seen.known {
            return Err(Unpatchable::NoFrame);
        }
        if self.plan.layout_since {
            return Err(Unpatchable::LayoutPass);
        }
        if self.plan.unsteady {
            return Err(Unpatchable::Unsteady);
        }
        if scroll_animating {
            return Err(Unpatchable::ScrollAnimation);
        }
        if gliding {
            return Err(Unpatchable::Gliding);
        }
        // What was restyled by paint since the frame built whole is not an edit: the roots that hold it
        // are built again. Anything else the tree changed since is.
        if sources.tree.patch_barrier() > self.plan.revision {
            return Err(Unpatchable::Edited);
        }
        let found = self.compute_deltas(sources, true);
        if found.all {
            return Err(Unpatchable::Everything);
        }
        if !found.sourced.is_empty() || !sources.measured.is_empty() || !sources.links.is_empty() || !sources.commanded.is_empty() || !sources.relevance.is_empty() {
            // The boxes a layout animation moves are measured, which is a source of its own in the
            // ticks they land in: the tick is whole because of the animation.
            let lays_out = found
                .running
                .iter()
                .chain(&found.dynamic)
                .filter(|id| !self.asleep_in(&found, **id))
                .any(|id| self.records.get(id).is_some_and(|record| record.refusal == Some(Refusal::LayoutAnimation)));
            return Err(if lays_out { Unpatchable::Refused(Refusal::LayoutAnimation) } else { Unpatchable::Sourced });
        }
        let mut touched = FxHashSet::default();
        for &id in found.running.iter().chain(&found.dynamic).chain(&self.unbuilt) {
            if self.asleep_in(&found, id) || self.between_changes(sources, id) {
                continue;
            }
            // Motion runs on an element that has no box (`display: none`), which no build reaches and no
            // frame paints: a tick has nothing of it to draw.
            if sources.tree.elements.get(&id).is_some_and(|element| crate::layout::box_generation::is_hidden(sources.tree, element)) {
                continue;
            }
            let mut at = Some(id);
            let unit = loop {
                match at {
                    Some(up) if self.plan.ids.contains(&up) => break Some(up),
                    Some(up) => at = sources.tree.elements.get(&up).and_then(|element| element.parent),
                    None => break None,
                }
            };
            match unit {
                Some(unit) => {
                    touched.insert(unit);
                }
                None => {
                    return Err(match self.records.get(&id).and_then(|record| record.refusal) {
                        Some(refusal) => Unpatchable::Refused(refusal),
                        None => Unpatchable::Outside(id),
                    });
                }
            }
        }
        // The root that holds an element a hover or a commit restyled by paint, or the unit it is in.
        // The anchors that hold what a commit changed beyond a restyle by paint: they are laid out again, and
        // build everything in them, so what else changed in them needs no root of its own.
        let mut relaid = FxHashSet::default();
        for id in sources.tree.pending_structure() {
            if sources.tree.elements.contains_key(&id) {
                relaid.insert(self.anchor_holding(sources.tree, id).ok_or(Unpatchable::Structure(id))?);
            }
        }
        let covered = |id: u64| !relaid.is_empty() && self.anchor_holding(sources.tree, id).is_some_and(|anchor| relaid.contains(&anchor));
        for &id in &sources.hover_paint {
            if !covered(id) {
                touched.insert(self.root_holding(sources.tree, id).ok_or(Unpatchable::Hover(id))?);
            }
        }
        for id in sources.tree.pending_restyles() {
            if covered(id) {
                continue;
            }
            match self.root_holding(sources.tree, id) {
                Some(root) => {
                    touched.insert(root);
                }
                None if self.in_row_out_of_frame(sources.tree, id) => {}
                None => return Err(Unpatchable::Commit(id)),
            }
        }
        let units: Vec<u64> = self
            .plan
            .units
            .iter()
            .chain(&self.plan.patch_roots)
            .map(|unit| unit.id)
            .filter(|id| touched.contains(id) && !covered(*id))
            .collect();
        let anchors: Vec<u64> = self.plan.anchors.iter().map(|unit| unit.id).filter(|id| relaid.contains(id)).collect();
        if !self.plan.repainted.is_empty() {
            // What is nested in an anchor that a patch spliced was forgotten by gpui, and is neither replayed nor
            // patched until a frame built whole records it.
            let stale = |id: u64| self.anchor_holding(sources.tree, id).is_some_and(|anchor| self.plan.repainted.contains(&anchor));
            if let Some(&id) = units.iter().find(|id| stale(**id)).or_else(|| anchors.iter().find(|id| self.plan.unrecorded.contains(id))) {
                return Err(Unpatchable::AnchorStale(id));
            }
        }
        if units.is_empty() && anchors.is_empty() && (found.stale || !found.entered.is_empty()) {
            return Err(Unpatchable::Dormancy);
        }
        if let Some(&ended) = units
            .iter()
            .find(|id| self.plan.ids.contains(id) && !self.records.get(id).is_some_and(Record::is_unit_candidate))
        {
            return Err(Unpatchable::Ended(ended));
        }
        Ok(units.into_iter().chain(anchors).collect())
    }

    /// Whether `id` is in a row of a virtual list that the frame shown does not hold: a row that is not built has nothing to
    /// repaint, and when a scroll brings it in the list builds it from the tree as it is, restyle included. Not a row that the
    /// frame holds with no root a patch can repaint (one the list measured and did not paint).
    fn in_row_out_of_frame(&self, tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
        let mut at = id;
        while let Some(parent) = tree.elements.get(&at).and_then(|element| element.parent) {
            if tree.elements.get(&parent).is_some_and(|parent| parent.element_type == "virtual-list") {
                return !self.rows_seen.contains(&at);
            }
            at = parent;
        }
        false
    }

    /// The innermost unit or patch root of the last frame built whole that holds `id`, walking up.
    fn root_holding(&self, tree: &crate::retained_tree::RetainedTree, id: u64) -> Option<u64> {
        let mut at = Some(id);
        while let Some(up) = at {
            if self.plan.patch_root_ids.contains(&up) || self.plan.ids.contains(&up) {
                return Some(up);
            }
            at = tree.elements.get(&up).and_then(|element| element.parent);
        }
        None
    }

    /// Records the state the build of the custom element `id` saw, for an element the registry did
    /// not hold when the frame began: the frame after compares its state with this and not with
    /// nothing, which would read as a change.
    pub(crate) fn custom_built(&mut self, id: u64, state: Option<u64>) {
        self.seen.customs.entry(id).or_insert(state);
    }

    /// Enters the element about to be built, or decides to skip it: when the frame found nothing
    /// that its last build read different, and gpui can be handed the subtree to keep. A skipped
    /// element is left entered and exited, and the caller builds a retained element instead.
    pub(crate) fn enter(&mut self, entry: Entry) -> Option<Skip> {
        if !self.enabled {
            return None;
        }
        if !self.open {
            return None;
        }
        let parent = self.stack.last().copied().unwrap_or(NO_PARENT);
        let enter = match entry.prekeyed {
            Some(prekeyed) => prekeyed.0,
            None => {
                let mut shape = Fingerprint::new();
                shape.word(entry.id);
                shape.word(u64::from(entry.at));
                shape.word(self.nodes.get(parent as usize).map_or(self.row_parent_shape, |parent| parent.key.shape));
                shape.word(entry.container.map_or(0, |size| size | 1));
                shape.word(entry.contents_overlay.map_or(0, |key| key | 1));
                shape.bits(&[
                    entry.stacking_root,
                    entry.stacking_item,
                    entry.atomic_root,
                    entry.anchor_scope,
                    entry.text_box_trim.start,
                    entry.text_box_trim.end,
                ]);
                Key {
                    revision: entry.revision,
                    inherited: inherited_fingerprint(entry.inherited),
                    colors: colors_fingerprint(entry.inherited),
                    custom: custom_fingerprint(entry.inherited),
                    shape: shape.finish(),
                }
            }
        };
        let moved = self.nodes.get(parent as usize).is_some_and(|parent| {
            parent.moved || self.deltas.scrolled.contains(&parent.id)
        });
        let exclusion = if entry.atomic_root {
            self.unless_lifted(Exclusion::AtomicInline)
        } else if entry.anchor_scope {
            self.unless_lifted(Exclusion::Anchored)
        } else if entry.inherited.highlight.is_some() {
            self.unless_lifted(Exclusion::Highlight)
        } else if entry.inherited.table.collapse {
            self.unless_lifted(Exclusion::CollapsedTable)
        } else {
            None
        };
        let mut node = Node {
            id: entry.id,
            parent,
            end: 0,
            key: enter,
            enter,
            vol: Vol::default(),
            exclusion,
            lift_z: None,
            forms_context: false,
            lift_run: false,
            positioned: false,
            absolute: false,
            moved,
            scroller: entry.scroller,
            costly: entry.costly,
            patch_root: entry.patch_root,
            anchor: false,
            digest: 0,
            absent: false,
            absent_children: Vec::new(),
            subtree: crate::layout::cull::Subtree::empty(),
            effects_start: crate::tape::build_effects_len(),
            effects_end: 0,
            skipped: None,
            paints_only: false,
            collapsed_table: false,
            wrapped: None,
            forced_host: false,
            under_forced: self.nodes.get(parent as usize).map_or(self.deferred_forced, |parent| parent.forced_host || parent.under_forced),
            loading: crate::background_images::still_loading(),
            colors_frame: None,
            reads_colors: false,
            custom_reads_at: 0,
            reads_custom: false,
            records: self.planning
                && self.gate.samples(entry.id)
                && self.lifted == 0
                && self.unit.is_none()
                && self.patch_root_unit.is_none()
                && !self.deferred
                && !self.inside_relocatable
                && entry.plain
                && entry.boxed
                && entry.prekeyed.is_none(),
        };
        let at = self.nodes.len() as u32;
        match self.skippable(&node, &entry) {
            Ok(record) => {
                node.key = record.key;
                node.vol = record.vol;
                node.lift_z = record.lift_z;
                node.forms_context = record.forms_context;
                node.lift_run = record.lift_run;
                node.reads_colors = record.reads_colors;
                node.reads_custom = record.reads_custom;
                node.subtree = record.subtree;
                node.end = at + 1;
                node.skipped = Some(Skipped { size: record.size, digest: record.digest });
                crate::perf_counters::elements_skipped(u64::from(record.size));
                if record.reads_colors {
                    entry.inherited.colors.note_read();
                }
                if record.reads_custom {
                    crate::css::custom_properties::reads::note();
                }
                let overscan = match record.wrapped {
                    // A scroller laid out empty is no scroller (`Scroller::of`), so the pass that
                    // wrapped the element may have recorded it to stay where it is; skipped as
                    // relocatable, gpui refuses its layout record (`ReplayKey`).
                    Some(wrapped) if self.layout_only => wrapped,
                    _ => node
                        .scroller
                        .filter(|scroller| scroller.holds(node.id) && !record.lifts)
                        .map(|scroller| scroller.overscan),
                };
                let planned = overscan.is_some() && moved && record.seasoned;
                let skip = Skip {
                    token: record.token,
                    enter: EnterKey(enter),
                    lift_z: record.lift_z,
                    ignores_text_color: !record.reads_colors && !record.lifts,
                    subtree: record.subtree,
                    effects: record.effects.clone(),
                    overscan,
                    patch_root: record.patch_root,
                };
                self.nodes.push(node);
                self.below.push(Below::default());
                self.settle(at as usize);
                self.relocation.planned += u32::from(planned);
                if let Some(record) = self.records.get_mut(&entry.id) {
                    record.seasoned = true;
                }
                return Some(skip);
            }
            Err(kept) => self.debug_kept(kept, node.id),
        }
        node.colors_frame = Some(crate::color::reads::open());
        node.custom_reads_at = crate::css::custom_properties::reads::count();
        self.stack.push(at);
        self.nodes.push(node);
        self.below.push(Below::default());
        None
    }

    /// Whether a move of the element by its scroller is not a reason to build it: it is recorded
    /// to be moved, and frames are not resting from planning on it.
    fn relocates(&self, node: &Node, record: Option<&Record>) -> bool {
        !self.relocation.resting
            && record.is_some_and(|record| !record.lifts)
            && node.scroller.is_some_and(|scroller| scroller.holds(node.id))
    }

    /// The record of the last build of the element if the frame can leave it unbuilt, or the
    /// first reason it cannot.
    fn skippable(&self, node: &Node, entry: &Entry) -> Result<&Record, Kept> {
        if !self.planning || self.lifted != 0 {
            return Err(Kept::PlanningOff);
        }
        // A unit is built whole, so that a tick can build it again to what it is, not to what is
        // left of it.
        if self.unit.is_some() || self.patch_root_unit.is_some() {
            return Err(Kept::InUnit);
        }
        if self.deltas.all {
            return Err(Kept::Everything);
        }
        if self.records.get(&node.id).is_some_and(|record| record.selection != self.selection) {
            return Err(Kept::Everything);
        }
        if !entry.plain {
            return Err(Kept::NotPlain);
        }
        if !entry.boxed {
            return Err(Kept::NotBoxed);
        }
        if entry.prekeyed.is_some() {
            return Err(Kept::Prekeyed);
        }
        if node.exclusion.is_some() {
            return Err(Kept::Excluded);
        }
        // A root under a scroller is one gpui can move or one that is built: a box too big to be
        // recorded to move is not a root, and what is moved by a scroller is built unless it can be.
        // What a subtree built late holds is built with it, since the recording of a subtree in
        // another cannot be put elsewhere on its own.
        if self.inside_relocatable
            || node.scroller.is_some_and(|scroller| scroller.too_big(node.id))
            || (node.moved && !self.relocates(node, self.records.get(&node.id)))
        {
            return Err(Kept::Moved);
        }
        if self.deltas.spine.contains(&node.id) {
            return Err(Kept::Spine);
        }
        let record = self.records.get(&node.id).ok_or(Kept::NoRecord)?;
        if !record.eligible {
            return Err(Kept::Ineligible);
        }
        if !self.worth(record.size, record.costly) {
            return Err(Kept::TooSmall);
        }
        if record.enter.revision != node.enter.revision {
            return Err(Kept::Revision);
        }
        if record.enter.inherits_differently(&node.enter, record.reads_colors, record.reads_custom) {
            return Err(Kept::Inherited);
        }
        if record.enter.shape != node.enter.shape {
            return Err(Kept::Shape);
        }
        // The wrapper of a skipped root carries the lift of the record, and the build that replaces
        // a replay that cannot be used makes the element as it is lifted now.
        if record.lift_run != (entry.lift_run)() {
            return Err(Kept::LiftRun);
        }
        // A record made to be moved by a scroller is replayed as one that is not only after a build:
        // gpui keeps the overscan around what it recorded (and the handles that put it elsewhere), which
        // a build that is not asked to move it does not. A pass that only lays out follows the wrap.
        if !self.layout_only
            && record.wrapped.is_some_and(|overscan| overscan.is_some())
            && !(node.scroller.is_some_and(|scroller| scroller.holds(node.id)) && !record.lifts)
        {
            return Err(Kept::Unmoved);
        }
        if !self.layout_only && !self.gate.samples(node.id) {
            return Err(Kept::Gated);
        }
        Ok(record)
    }

    /// Leaves the element built last, and says whether gpui is to record what was built of it.
    pub(crate) fn exit(&mut self) -> Option<Recording> {
        self.exited_absent = false;
        if !self.open {
            return None;
        }
        // A skipped element was never pushed.
        let at = self.stack.pop().expect("exit without enter") as usize;
        if self.patch_root_unit == Some(at as u32) {
            self.patch_root_unit = None;
        }
        let end = self.nodes.len() as u32;
        let node = &mut self.nodes[at];
        node.end = end;
        node.effects_end = crate::tape::build_effects_len();
        node.reads_colors = node.colors_frame.take().is_some_and(crate::color::reads::Frame::close);
        node.reads_custom = crate::css::custom_properties::reads::count() != node.custom_reads_at;
        self.exited_absent = node.absent;
        self.settle(at);
        let recording = self.to_record(at);
        self.nodes[at].wrapped = recording.as_ref().map(|recording| recording.overscan);
        recording
    }

    /// Whether a frame that built the element `at` whole leaves it a root the frame after skips,
    /// if nothing changes, and so is to have gpui record it now: the frame after then finds the
    /// recording it asks for under the key it asks with, and does not build the element again to
    /// make one. It is when `skippable` would take the record this build leaves, given the same
    /// frame, and the element is not one that a frame builds again anyway (a motion runs in it:
    /// recording it every frame costs, and no frame replays it).
    fn to_record(&self, at: usize) -> Option<Recording> {
        let node = &self.nodes[at];
        let own = &self.below[at];
        if !node.records || node.absent || node.moved || own.dynamic || node.vol.dynamic != 0 {
            return None;
        }
        if crate::background_images::still_loading() != node.loading {
            return None;
        }
        let escaped = node.absolute || (!node.positioned && own.escapes);
        if node.exclusion.is_some() || own.excluded.is_some() || escaped {
            return None;
        }
        if !self.worth(own.size, node.costly) {
            return None;
        }
        if node.scroller.is_some_and(|scroller| scroller.too_big(node.id)) {
            return None;
        }
        let lifts = node.lift_z.is_some() || (!node.forms_context && own.lifts);
        let overscan = node
            .scroller
            .filter(|scroller| !lifts && scroller.fits(node.id) != Some(false))
            .map(|scroller| scroller.overscan);
        Some(Recording {
            token: own.token,
            lift_z: node.lift_z,
            ignores_text_color: !node.reads_colors && !lifts,
            subtree: node.subtree,
            overscan,
            patch_root: node.patch_root && !lifts && own.size <= PATCH_ROOT_MAX_ELEMENTS,
        })
    }

    /// Adds the node `at` to what it is below, now that it and everything below it is built. A
    /// skipped node is settled when it is entered, since it is never left.
    fn settle(&mut self, at: usize) {
        let node = &self.nodes[at];
        let mut own = self.below[at];
        if node.skipped.is_none() {
            let before = self.records.get(&node.id);
            own.changed = match before {
                None => Some(Cause::New),
                Some(before) if before.key.revision != node.key.revision => Some(Cause::Edited),
                Some(before) if before.key.inherits_differently(&node.key, before.reads_colors, before.reads_custom) => Some(Cause::Inherited),
                Some(before) if before.key.shape != node.key.shape => Some(Cause::Shape),
                Some(before) => node.vol.cause_against(&before.vol),
            };
            own.scrolled = before.is_some_and(|before| before.vol.scroll != node.vol.scroll);
        }
        let escaped = node.absolute || (!node.positioned && own.escapes);
        let (escapes, epoch, token, holes) = match (&node.skipped, self.records.get(&node.id)) {
            // Its children were never entered, so `own.lifts` is empty: what they lift is what its
            // last build folded, which is `Record::lifts`.
            (Some(_), Some(record)) => (record.lifts, record.epoch, record.token, record.holes),
            (Some(_), None) => unreachable!("an element is skipped by the record of its last build"),
            (None, before) => {
                let escapes = node.lift_z.is_some() || (!node.forms_context && own.lifts);
                let epoch = match (before, self.deferred) {
                    (Some(before), true) => before.epoch,
                    (Some(before), false) => before.epoch + 1,
                    // Not 1: gpui keeps the recording of an element whose record was dropped (retention
                    // turned off and on, `forget_unbuilt_dynamic`) until a frame passes it by, and a
                    // build that took the old key would be replayed from it. The serial is more than
                    // any epoch the element reached, since a build takes a frame.
                    (None, _) => self.plan.serial,
                };
                let mut token = Fingerprint::new();
                token.word(node.enter.revision);
                token.word(node.enter.inherited);
                // A subtree that reads no colour it inherits is the same build under another one.
                if node.reads_colors {
                    token.word(node.enter.colors);
                }
                if node.reads_custom {
                    token.word(node.enter.custom);
                }
                token.word(node.enter.shape);
                token.word(epoch);
                // A hole is not asked for alone: the recording around it is of the build that
                // made it, so it is not the one for another build of the hole.
                token.word(own.holes);
                (escapes, epoch, token.finish(), own.holes)
            }
        };
        own.epoch = epoch;
        own.token = token;
        own.holes = holes;
        let digest = match &node.skipped {
            Some(skipped) => skipped.digest,
            None => {
                let mut fp = Fingerprint::new();
                fp.word(node.digest);
                fp.word(own.digest);
                fp.finish()
            }
        };
        let size = match &node.skipped {
            Some(skipped) => skipped.size,
            None => own.size + 1,
        };
        own.digest = digest;
        own.size = size;
        self.below[at] = own;
        if node.parent == NO_PARENT {
            return;
        }
        let parent = &mut self.below[node.parent as usize];
        parent.changed_below |= own.changed.is_some() || own.changed_below;
        parent.lifts |= escapes;
        if node.lift_z.is_some() {
            parent.holes = parent.holes.rotate_left(7) ^ token;
        } else if !node.forms_context {
            parent.holes = parent.holes.rotate_left(7) ^ holes;
        }
        parent.escapes |= escaped;
        parent.size += size;
        parent.dynamic |= own.dynamic || (node.skipped.is_none() && node.vol.dynamic != 0);
        if parent.excluded.is_none() {
            parent.excluded = node.exclusion.or(own.excluded);
        }
        if !node.absent {
            parent.digest = parent.digest.rotate_left(5).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ digest;
        }
    }

    /// The element being built is a `display: none` host. A parent that built it anyway, because
    /// it still counted a box for it, has the same digest as one that left it out: the frame a
    /// `display` transition ends in is built with it, the next frame without.
    pub(crate) fn absent(&mut self) {
        if let Some(node) = self.top() {
            node.absent = true;
        }
    }

    /// Whether the element left last came back absent, once: the parent says where it put it.
    pub(crate) fn take_exited_absent(&mut self) -> bool {
        std::mem::take(&mut self.exited_absent)
    }

    /// The element being built put a child that came back absent at `index` among its content.
    pub(crate) fn absent_child(&mut self, index: usize) {
        if let Some(node) = self.top() {
            node.absent_children.push(index);
        }
    }

    /// Where the children of the element being built that came back absent are.
    pub(crate) fn absent_children(&mut self) -> Vec<usize> {
        self.top().map(|node| std::mem::take(&mut node.absent_children)).unwrap_or_default()
    }

    fn top(&mut self) -> Option<&mut Node> {
        let at = *self.stack.last()?;
        Some(&mut self.nodes[at as usize])
    }

    /// The first reason wins: it is the one the element is counted under. The parts of a collapsed
    /// table are excluded on entry for every element below the table, which says nothing of
    /// the others: a reason found in the build replaces it, so that a unit that is the table can
    /// tell the parts the table paints from what is excluded for another reason.
    pub(crate) fn exclude(&mut self, reason: Exclusion) {
        let Some(reason) = self.unless_lifted(reason) else { return };
        if let Some(node) = self.top() {
            match node.exclusion {
                Some(first) if first != Exclusion::CollapsedTable => {}
                _ => node.exclusion = Some(reason),
            }
        }
    }

    /// The element being built skips its content (`content-visibility`): nothing below it is built,
    /// and what the frames before recorded of what is below is of builds no frame replays. A
    /// subtree that shows again is built whole, and nothing of it keeps a frame busy while it is
    /// skipped: no running motion, no sleep, and no record but the layout of what a read forced
    /// (`Record::forced`): the pass that forces the content again skips it with that, as a browser
    /// keeps the layout of a locked subtree. A forced record of an element that changed meanwhile
    /// goes too, and so does one that changes while the element skips (`commit_deltas`). Returns
    /// the elements that were dormant, for whoever keeps their clocks. Does its work when the
    /// element begins to skip, and is cheap while it goes on.
    pub(crate) fn skip_content(&mut self, tree: &crate::retained_tree::RetainedTree, id: u64) -> Vec<u64> {
        if !self.skipping.insert(id) {
            return Vec::new();
        }
        let mut asleep = Vec::new();
        let mut pending: Vec<u64> = tree.elements.get(&id).map(|element| element.children.clone()).unwrap_or_default();
        while let Some(below) = pending.pop() {
            if self.records.get(&below).is_some_and(|record| !record.forced || self.deltas.spine.contains(&below)) {
                self.records.remove(&below);
            }
            self.dynamic.remove(&below);
            self.unbuilt.remove(&below);
            self.woken.remove(&below);
            if self.dormant.remove(&below).is_some() {
                self.moves.left.push(below);
                asleep.push(below);
            }
            if let Some(element) = tree.elements.get(&below) {
                pending.extend(&element.children);
            }
        }
        asleep
    }

    /// The element being built is the host of content that a read of geometry forces: it is laid out
    /// for the read and skipped by the frames, which keep the layout of what was built in it.
    pub(crate) fn forced_host(&mut self) {
        if let Some(node) = self.top() {
            node.forced_host = true;
        }
    }

    /// Whether what the element about to be entered holds is built as the content of a forced host.
    pub(crate) fn in_forced_content(&self) -> bool {
        match self.stack.last() {
            Some(&at) => {
                let node = &self.nodes[at as usize];
                node.forced_host || node.under_forced
            }
            None => self.deferred_forced,
        }
    }

    /// The element being built shows its content.
    pub(crate) fn show_content(&mut self, id: u64) {
        if !self.skipping.is_empty() {
            self.skipping.remove(&id);
        }
    }

    /// The element being built is a table with collapsed borders, or holds an anonymous table with
    /// them (no element is that table: the element around its parts is). A unit that is that element
    /// builds the parts again with it, since it is the table that paints their borders.
    pub(crate) fn collapsed_table(&mut self) {
        if let Some(node) = self.top() {
            node.collapsed_table = true;
        }
    }

    /// Whether the element is a containing block (anything but `position: static`) and whether it
    /// is absolutely positioned. The nodes of an absolute box are rewritten by gpui's layout
    /// against its containing block after they are requested, so a subtree can be kept only if
    /// the containing block of every absolute box in it is in it too (gpui checks the same).
    pub(crate) fn containing_block(&mut self, positioned: bool, absolute: bool) {
        if let Some(node) = self.top() {
            node.positioned = positioned;
            node.absolute = absolute;
        }
    }

    /// What of the shape of the element's build the retained tree does not say.
    pub(crate) fn shape(&mut self, word: u64) {
        if let Some(node) = self.top() {
            let mut fp = Fingerprint::new();
            fp.word(node.key.shape);
            fp.word(word);
            node.key.shape = fp.finish();
        }
    }

    pub(crate) fn pointer(&mut self, states: crate::events::state_styles::PointerStates) {
        if let Some(node) = self.top() {
            node.vol.pointer |= pointer_bits(states);
        }
    }

    /// The states of the inline boxes of a paragraph the element holds, see [`mix_pointer`].
    pub(crate) fn inline_pointer(&mut self, mixed: u64) {
        if let Some(node) = self.top() {
            node.vol.inline_pointer = node.vol.inline_pointer.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ mixed;
        }
    }

    pub(crate) fn focus(&mut self, focus: &crate::focus::FocusStyles, id: u64, has_handle: bool) {
        if let Some(node) = self.top() {
            node.vol.focus |= focus_bits(focus, id, has_handle);
        }
    }

    pub(crate) fn scroll(&mut self, offset: gpui::Point<gpui::Pixels>) {
        if let Some(node) = self.top() {
            let mut fp = Fingerprint::new();
            fp.f32(f32::from(offset.x));
            fp.f32(f32::from(offset.y));
            node.vol.scroll = fp.finish() | 1;
        }
    }

    pub(crate) fn measurement(&mut self, measurement: Option<&crate::motion::measure::Measurement>) {
        let Some(measurement) = measurement else { return };
        if let Some(node) = self.top() {
            let mut fp = Fingerprint::new();
            measurement.fingerprint(&mut fp);
            node.vol.measurement = fp.finish() | 1;
        }
    }

    pub(crate) fn dynamic(&mut self, kind: Dynamic) {
        self.dynamic_bits(kind as u8);
    }

    /// The element paints what follows the clock and nothing else of it does (`Dynamic::Blink`). It
    /// is a unit then, unless something else runs on it that changes more than its paint.
    pub(crate) fn blinks(&mut self) {
        if let Some(node) = self.top() {
            if node.vol.dynamic & Dynamic::OWN == 0 {
                node.paints_only = true;
            }
            node.vol.dynamic |= Dynamic::Blink as u8;
        }
    }

    /// `Dynamic` kinds as bits. A spliced child notes what runs on the `display: contents` element
    /// it came out of: that element is never built, so it cannot say so itself, and its child's
    /// record is what puts the way up to it on the spine while it runs.
    pub(crate) fn dynamic_bits(&mut self, bits: u8) {
        if bits == 0 {
            return;
        }
        if let Some(node) = self.top() {
            node.vol.dynamic |= bits;
        }
    }

    /// The element holds text of its own, which a selection paints over.
    pub(crate) fn text(&mut self) {
        let selection = self.selection;
        if let Some(node) = self.top() {
            node.vol.selection = selection;
        }
    }

    /// The `z-index` the element is lifted into the stacking context around it with, if it is,
    /// and whether it is one.
    pub(crate) fn stacking(&mut self, decide: impl FnOnce() -> (Option<i32>, bool)) {
        if self.recording() {
            let (lift_z, forms_context) = decide();
            if let Some(node) = self.top() {
                node.lift_z = lift_z;
                node.forms_context = forms_context;
            }
        }
    }

    /// Whether an animation of the element's opacity or transform is current in this build.
    pub(crate) fn lift_run(&mut self, runs: bool) {
        if let Some(node) = self.top() {
            node.lift_run = runs;
        }
    }

    /// What the element's parent needs to know of how far it draws.
    pub(crate) fn subtree(&mut self, subtree: crate::layout::cull::Subtree) {
        if let Some(node) = self.top() {
            node.subtree = subtree;
        }
    }

    /// Adds what the build made of the element to its digest. Only formatted when verifying.
    pub(crate) fn digest(&mut self, built: impl FnOnce() -> String) {
        if !self.verify || self.planning {
            return;
        }
        let built = built();
        if let Some(node) = self.top() {
            let mut fp = Fingerprint::new();
            fp.word(node.digest);
            fp.str(&built);
            node.digest = fp.finish();
        }
    }

    /// Ends the build of a frame.
    pub(crate) fn finish_frame(&mut self) {
        let recorded = self.open;
        let candidates = self.finish_session();
        if recorded && self.backs_off() && self.pass == 1 {
            // The rows were built after the frame they belong to; a frame that rests records none.
            let rows = std::mem::take(&mut self.row_candidates);
            self.back_off(candidates | rows);
            self.gate.note_roots(self.summary.roots.len(), self.summary.elements_in_roots);
        }
    }

    /// Whether the build of the node `at` can be a unit if nothing else is against it, and the motion
    /// that would be repainted. A table with collapsed borders paints the borders of its parts, so
    /// the parts of the table are excluded from everything but a unit that is the table, and the motion
    /// that repaints them is the motion of the table and what is in it.
    fn unit_facts(&self, at: usize, eligible: bool, escaped: bool) -> (bool, Motion) {
        let node = &self.nodes[at];
        let own = Motion { dynamic: node.vol.dynamic, paints_only: node.paints_only };
        if !node.collapsed_table || node.skipped.is_some() {
            return (eligible, own);
        }
        let inside = &self.nodes[at + 1..node.end as usize];
        let only_parts = node.exclusion.is_none()
            && !escaped
            && inside.iter().all(|inner| inner.exclusion.is_none_or(|reason| reason == Exclusion::CollapsedTable));
        // An element with nothing running on it says nothing about whether it paints only.
        let start = Motion { paints_only: own.paints_only || own.dynamic == 0, ..own };
        let motion = inside.iter().fold(start, |motion, inner| Motion {
            dynamic: motion.dynamic | inner.vol.dynamic,
            paints_only: motion.paints_only && (inner.vol.dynamic == 0 || inner.paints_only),
        });
        (eligible || only_parts, motion)
    }

    /// Why the node `at`, which something runs on, is no unit, in the order `begin_unit` and `end_unit`
    /// refuse: what they judge of the build is judged here of the same facts.
    fn refusal(&self, at: usize, own: Below, escaped: bool, unit_eligible: bool, motion: Motion) -> Option<Refusal> {
        let node = &self.nodes[at];
        // First: what moves a box is a layout animation, whatever else the element is.
        if !motion.paints_only {
            return Some(Refusal::LayoutAnimation);
        }
        if !unit_eligible {
            // The parts of a collapsed table are excluded for the table to paint over: what is.
            let below = if node.collapsed_table {
                self.nodes[at + 1..node.end as usize]
                    .iter()
                    .find_map(|inner| inner.exclusion.filter(|kind| *kind != Exclusion::CollapsedTable))
            } else {
                own.excluded
            };
            return Some(match (node.exclusion, below) {
                (Some(kind), _) => Refusal::Excluded(kind),
                (None, Some(kind)) => Refusal::ExcludedBelow(kind),
                (None, None) => {
                    debug_assert!(escaped, "an element that is not eligible is excluded or escaped");
                    Refusal::Escapes
                }
            });
        }
        if !node.forms_context && own.lifts {
            return Some(Refusal::Lifts);
        }
        if own.size > UNIT_MAX_ELEMENTS {
            return Some(Refusal::TooLarge);
        }
        if self.nodes[at..node.end as usize].iter().any(|inner| inner.vol.scroll != 0) {
            return Some(Refusal::Scrolls);
        }
        None
    }

    /// Why the part of a collapsed table at `at` is no unit: the table is the unit of what runs on
    /// its parts, so it is the table's reason.
    fn table_refusal(&self, at: usize) -> Option<Refusal> {
        let mut up = self.nodes[at].parent;
        while up != NO_PARENT {
            let table = &self.nodes[up as usize];
            if table.collapsed_table {
                return self.records.get(&table.id).and_then(|record| record.refusal);
            }
            up = table.parent;
        }
        None
    }

    /// Plans the frames that follow a recorded one that found `candidates`, or none, to skip.
    fn back_off(&mut self, candidates: bool) {
        if candidates || self.nodes.is_empty() {
            self.backoff.gap = 0;
            return;
        }
        self.backoff.gap = (self.backoff.gap * 2).clamp(1, BACKOFF_CAP);
        let scrolling = self.deltas.scrolling;
        let gap = self.backoff.gap;
        self.forget();
        self.backoff = Backoff { rest: gap, gap, resting: false, scrolling, elements: self.elements };
    }

    /// Decides what this build would have reused, counts it, and keeps what the next build compares
    /// itself with. Returns whether some element in it could be skipped by a frame that finds it
    /// unchanged and unmoved.
    fn finish_session(&mut self) -> bool {
        if !self.open {
            return false;
        }
        self.open = false;
        debug_assert!(self.stack.is_empty(), "an element was entered and never exited");
        self.stack.clear();
        let count = self.nodes.len();

        self.retained.clear();
        self.retained.resize(count, false);
        self.moved.clear();
        self.moved.resize(count, false);
        self.summary = Summary { roots: Vec::new(), elements_in_roots: 0, elements: count };
        let mut counts = [0u64; SLOTS];
        let mut large = 0;
        let mut candidates = false;
        let all_effects = crate::tape::build_effects_since(0);
        let mut built_dynamic = FxHashSet::default();
        let mut unsteady = false;
        let keep_slots = self.debug_wants_slots();
        let mut slots = Vec::new();
        for at in 0..count {
            let node = &self.nodes[at];
            let own = self.below[at];
            let escaped = node.absolute || (!node.positioned && own.escapes);
            let eligible = node.exclusion.is_none() && own.excluded.is_none() && !escaped;
            // An absolute element is no root to skip, and it is the root of a unit.
            let escaped_below = !node.positioned && own.escapes;
            let unit_clear = node.exclusion.is_none() && own.excluded.is_none() && !escaped_below;
            let lifts = node.lift_z.is_some() || (!node.forms_context && own.lifts);
            let clean = own.changed.is_none() && !own.changed_below;
            let parent = (node.parent != NO_PARENT).then_some(node.parent as usize);
            self.moved[at] = parent.is_some_and(|parent| self.moved[parent] || self.below[parent].scrolled);
            // A root under a scroller that gpui can record to move is skipped by a frame that finds
            // the scroller moved. One that it cannot is built when it does.
            let holds = eligible
                && !lifts
                && node.skipped.is_none()
                && node.scroller.is_some_and(|scroller| scroller.holds(node.id));
            let relocates = holds && !self.relocation.resting;
            let too_big = eligible
                && node.skipped.is_none()
                && node.scroller.is_some_and(|scroller| scroller.too_big(node.id));
            let oversized = clean && too_big;
            // What a scroller that only appeared moves is not a loss: the frame after it finds the rows still.
            let carried = (node.moved || self.moved[at]) && self.deltas.scrolling && !relocates;
            candidates |= node.skipped.is_some() || (eligible && self.worth(own.size, node.costly) && !carried && !too_big);

            let slot = if parent.is_some_and(|parent| self.retained[parent]) {
                self.retained[at] = true;
                RETAINED
            } else if oversized {
                counts[OVERSIZED] += 1;
                OVERSIZED
            } else if node.skipped.is_none() && clean && eligible && self.moved[at] && !relocates {
                counts[MOVED] += 1;
                MOVED
            } else if node.skipped.is_some() || (clean && eligible) {
                self.retained[at] = true;
                let size = own.size as usize;
                self.summary.roots.push(node.id);
                self.summary.elements_in_roots += size;
                if size >= LARGE_ROOT {
                    large += size;
                }
                RETAINED
            } else {
                let slot = if let Some(excluded) = node.exclusion {
                    EXCLUDED + excluded as usize
                } else if let Some(cause) = own.changed {
                    CHANGED + cause as usize
                } else if own.changed_below {
                    SPINE
                } else if let Some(excluded) = own.excluded {
                    UNDER + excluded as usize
                } else {
                    debug_assert!(escaped, "an element that is not retained is changed, excluded or escaped");
                    ESCAPES
                };
                counts[slot] += 1;
                slot
            };
            if keep_slots {
                slots.push(slot);
            }

            if node.skipped.is_some() {
                continue;
            }
            unsteady |= node.exclusion.is_some_and(Exclusion::varies_with_time);
            self.unbuilt.remove(&node.id);
            if self.retained[at] && self.verify && !self.planning {
                check(&self.records, &mut self.mismatches, node.id, own.digest, eligible);
            }
            if !self.dormant.is_empty() && self.dormant.contains_key(&node.id) {
                self.woken.insert(node.id);
            }
            if node.vol.dynamic != 0 {
                self.dynamic.insert(node.id, node.vol.dynamic);
                built_dynamic.insert(node.id);
            } else {
                self.dynamic.remove(&node.id);
            }
            let (epoch, token, holes) = (own.epoch, own.token, own.holes);
            let (unit_eligible, motion) = self.unit_facts(at, unit_clear, escaped_below);
            let refusal = if node.exclusion == Some(Exclusion::CollapsedTable) {
                self.table_refusal(at)
            } else if motion.dynamic & Dynamic::OWN != 0 {
                self.refusal(at, own, escaped_below, unit_eligible, motion)
            } else {
                None
            };
            // What a tick can patch is worth recording for where nothing can be skipped: the units of the
            // frame after come from these records, so a page that forgets them never has one.
            candidates |= motion.dynamic & Dynamic::OWN != 0 && refusal.is_none();
            let effects = (node.effects_end > node.effects_start)
                .then(|| Rc::<[BuildEffect]>::from(&all_effects[node.effects_start..node.effects_end]));
            self.records.insert(
                node.id,
                Record {
                    key: node.key,
                    enter: node.enter,
                    vol: node.vol,
                    digest: own.digest,
                    eligible,
                    epoch,
                    token,
                    lift_z: node.lift_z,
                    forms_context: node.forms_context,
                    lift_run: node.lift_run,
                    lifts,
                    holes,
                    size: own.size,
                    patch_root: node.patch_root && eligible && !lifts && own.size <= PATCH_ROOT_MAX_ELEMENTS && node.vol.dynamic == 0 && !own.dynamic,
                    reads_colors: node.reads_colors,
                    reads_custom: node.reads_custom,
                    costly: node.costly,
                    subtree: node.subtree,
                    effects,
                    seasoned: self.deferred,
                    selection: self.selection,
                    unit_eligible,
                    motion,
                    refusal,
                    wrapped: node.wrapped,
                    forced: node.under_forced,
                },
            );
        }

        // A row is built after the frame it belongs to, and says nothing of whether that frame
        // was steady.
        if !self.reference && !self.layout_only && !self.row {
            self.plan.recorded = true;
            self.plan.unsteady |= unsteady;
            self.publish_shown();
        }
        if !self.deferred && !self.row {
            self.forget_unbuilt_dynamic(&built_dynamic);
        }
        if keep_slots && !self.deferred && !self.row {
            self.debug_capture(&slots);
        }

        counts[RETAINED] = self.summary.elements_in_roots as u64;
        crate::perf_counters::retain_slots(&counts);
        crate::perf_counters::retained(self.summary.roots.len() as u64, large as u64);
        candidates
    }

    /// A whole frame visits every element it does not skip, and it skips none that has a dynamic
    /// one below it, unless the dynamic one is dormant. So a dynamic element that this frame did not visit sits under one that has no
    /// box (`display: none`), and its record is of a build that is gone: it would keep every
    /// ancestor on the spine for as long as the window lives. Its record goes too, since a frame
    /// that shows it again must build it, not take what was recorded while its motion ran.
    fn forget_unbuilt_dynamic(&mut self, built: &FxHashSet<u64>) {
        let stale: Vec<u64> = self
            .dynamic
            .keys()
            .copied()
            .filter(|id| !built.contains(id) && !self.dormant.contains_key(id))
            .collect();
        for id in stale {
            self.dynamic.remove(&id);
            self.records.remove(&id);
        }
    }
}

/// Calls `visit` for each element of the rows `before` asked for and `seen` did not, and of the
/// subtrees under them, but not the children of a nested `<virtual-list>` (`forget_unseen_rows`).
fn for_each_unseen_element(
    before: &FxHashSet<u64>,
    seen: &FxHashSet<u64>,
    tree: &crate::retained_tree::RetainedTree,
    mut visit: impl FnMut(u64),
) {
    let mut pending: Vec<u64> = before.iter().copied().filter(|row| !seen.contains(row)).collect();
    while let Some(id) = pending.pop() {
        visit(id);
        if let Some(element) = tree.elements.get(&id) {
            if element.element_type != "virtual-list" {
                pending.extend(element.children.iter().copied());
            }
        }
    }
}

/// The scroll offsets of the scrollers, as the bits that tell one frame's from another's.
fn scroll_bits(scrolls: &HashMap<u64, gpui::ScrollHandle>) -> FxHashMap<u64, (u32, u32)> {
    scrolls
        .iter()
        .map(|(id, handle)| {
            let offset = handle.offset();
            (*id, (f32::from(offset.x).to_bits(), f32::from(offset.y).to_bits()))
        })
        .collect()
}

/// The ids that are in one of `before` and `now`, not in both, added to `changed`.
fn differ(before: &[u64], now: &[u64], changed: &mut Vec<u64>) {
    changed.extend(before.iter().filter(|id| !now.contains(id)));
    changed.extend(now.iter().filter(|id| !before.contains(id)));
}

/// An element judged unchanged has to have been built as it was last time: the hash of what the
/// build made of it and of everything below it is the one the last build recorded.
fn check(records: &FxHashMap<u64, Record>, mismatches: &mut Vec<String>, id: u64, digest: u64, eligible: bool) {
    let Some(before) = records.get(&id) else { return };
    let problem = if before.digest != digest {
        "built differently"
    } else if before.eligible != eligible {
        "was judged differently"
    } else {
        return;
    };
    report(mismatches, format!("element {id} was judged unchanged and {problem}"));
}

fn report(mismatches: &mut Vec<String>, message: String) {
    crate::perf_counters::retain_mismatch();
    // Loud, for a suite run under `GPUIX_RETAIN_VERIFY`: nothing reads the counter there.
    eprintln!("[retain] {message}");
    if mismatches.len() < 32 {
        mismatches.push(message);
    }
}

/// The spine has to hold the parent of every element on it: a root is skipped when it is off the
/// spine, so one missing above a changed element replays its subtree with that element frozen.
fn check_spine(spine: &FxHashSet<u64>, tree: &crate::retained_tree::RetainedTree, mismatches: &mut Vec<String>) {
    for id in spine {
        let Some(parent) = tree.elements.get(id).and_then(|element| element.parent) else { continue };
        if !spine.contains(&parent) {
            report(mismatches, format!("element {id} is on the spine and its parent {parent} is not"));
        }
    }
}

/// Roots of at least this many elements are counted again on their own: a one-element placeholder
/// costs about what it saves.
const LARGE_ROOT: usize = 8;

/// `mixed` with the states of the `index`th inline box, which only count when one applies.
pub(crate) fn mix_pointer(mixed: u64, index: usize, states: crate::events::state_styles::PointerStates) -> u64 {
    match pointer_bits(states) {
        0 => mixed,
        bits => mixed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (index as u64) << 16 ^ u64::from(bits),
    }
}

fn pointer_bits(states: crate::events::state_styles::PointerStates) -> u16 {
    [
        states.hovered,
        states.active,
        states.group_hovered,
        states.group_active,
        states.group_focused_within,
        states.has_hovered,
        states.has_active,
        states.has_focused,
        states.disabled,
        states.enabled,
        states.has_disabled,
        states.has_enabled,
        states.focus_within,
        states.has_focus_visible,
        states.focus_visible,
    ]
    .into_iter()
    .fold(0, |bits, flag| bits << 1 | u16::from(flag))
}

/// How the focus state touches `id`: nothing is focused for most of the elements most of the time.
fn focus_bits(focus: &crate::focus::FocusStyles, id: u64, has_handle: bool) -> u16 {
    let mut bits = u16::from(has_handle);
    if focus.within.is_empty() {
        return bits;
    }
    bits |= u16::from(focus.within.contains(&id)) << 1;
    bits |= u16::from(focus.visible == Some(id)) << 2;
    bits |= u16::from(focus.has_focus(id)) << 3;
    bits |= u16::from(focus.has_focus_visible(id)) << 4;
    bits |= u16::from(has_handle && focus.dim_path.as_deref().is_some_and(|path| !path.contains(&id))) << 5;
    bits
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use gpui::AppContext as _;

    use super::*;
    use crate::renderer::GpuixView;
    use crate::retained_tree::{Dirty, RetainedTree};

    #[test]
    fn the_fingerprint_names_every_field_of_inherited() {
        // `inherited_fingerprint` lists the fields by hand. Adding one changes this size, and the
        // fingerprint has to learn it or the key will not see it change.
        assert_eq!(std::mem::size_of::<Inherited>(), 368);
    }

    #[test]
    fn every_pointer_state_has_a_bit_of_its_own() {
        use crate::events::state_styles::PointerStates;
        // A state added to `PointerStates` changes this size, and `pointer_bits` has to learn it.
        assert_eq!(std::mem::size_of::<PointerStates>(), 15);
        let each = [
            PointerStates { hovered: true, ..Default::default() },
            PointerStates { active: true, ..Default::default() },
            PointerStates { group_hovered: true, ..Default::default() },
            PointerStates { group_active: true, ..Default::default() },
            PointerStates { group_focused_within: true, ..Default::default() },
            PointerStates { has_hovered: true, ..Default::default() },
            PointerStates { has_active: true, ..Default::default() },
            PointerStates { has_focused: true, ..Default::default() },
            PointerStates { disabled: true, ..Default::default() },
            PointerStates { enabled: true, ..Default::default() },
            PointerStates { has_disabled: true, ..Default::default() },
            PointerStates { has_enabled: true, ..Default::default() },
            PointerStates { focus_within: true, ..Default::default() },
            PointerStates { has_focus_visible: true, ..Default::default() },
            PointerStates { focus_visible: true, ..Default::default() },
        ];
        let mut seen = 0;
        for states in each {
            assert!(states.any());
            let bits = pointer_bits(states);
            assert_eq!(bits.count_ones(), 1, "{states:?}");
            assert_eq!(seen & bits, 0, "{states:?} shares a bit");
            seen |= bits;
        }
    }

    fn root_inherited() -> Inherited {
        Inherited::root(
            &crate::theme::Theme::dark(),
            gpui::WindowAppearance::Light,
            false,
            gpui::size(gpui::px(800.0), gpui::px(600.0)),
        )
    }

    fn build(retain: &mut Retain, inherited: &Inherited, built: &str) {
        let (tree, focus) = (RetainedTree::new(), crate::focus::FocusStyles::default());
        let (handles, scrolls) = (HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree: &tree,
            hovered: &[],
            hover_paint: Vec::new(),
            active: &[],
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        retain.enter(Entry {
            id: 1,
            revision: 7,
            inherited,
            at: 0,
            stacking_root: true,
            stacking_item: false,
            atomic_root: false,
            contents_overlay: None,
            anchor_scope: false,
            text_box_trim: Default::default(),
            plain: true,
            boxed: true,
            container: None,
            prekeyed: None,
            scroller: None,
            lift_run: &|| false,
            costly: true,
                patch_root: false,
        });
        retain.stacking(|| (None, true));
        retain.digest(|| built.to_owned());
        retain.exit();
        retain.finish_frame();
    }

    #[test]
    fn what_was_judged_unchanged_but_built_differently_is_reported() {
        let inherited = root_inherited();
        let mut retain = Retain::new();
        retain.set_verify(true);
        build(&mut retain, &inherited, "red");
        build(&mut retain, &inherited, "red");
        assert_eq!(retain.summary().roots, vec![1]);
        assert!(retain.mismatches().is_empty());
        // The key did not move, the build did: this is the hole the check exists to find.
        build(&mut retain, &inherited, "blue");
        assert_eq!(retain.mismatches().len(), 1, "{:?}", retain.mismatches());
    }

    #[test]
    fn a_new_element_is_a_change_and_a_second_look_is_not() {
        let inherited = root_inherited();
        let mut retain = Retain::new();
        build(&mut retain, &inherited, "");
        assert_eq!(retain.summary().roots, Vec::<u64>::new());
        build(&mut retain, &inherited, "");
        assert_eq!(retain.summary().roots, vec![1]);
    }

    /// A frame of element 1 with the child 2 in it, each built whole (or skipped), for the recordings
    /// `exit` asks gpui for: `(skipped, recordings of 2 and 1)`.
    fn nested_frame(retain: &mut Retain, motion_in_child: bool) -> (bool, Vec<Option<(u64, bool)>>) {
        let (tree, focus) = (RetainedTree::new(), crate::focus::FocusStyles::default());
        let (handles, scrolls) = (HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree: &tree,
            hovered: &[],
            hover_paint: Vec::new(),
            active: &[],
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        let inherited = root_inherited();
        let entry = |id, at| Entry {
            id,
            revision: 7,
            inherited: &inherited,
            at,
            stacking_root: false,
            stacking_item: false,
            atomic_root: false,
            contents_overlay: None,
            anchor_scope: false,
            text_box_trim: Default::default(),
            plain: true,
            boxed: true,
            container: None,
            prekeyed: None,
            scroller: None,
            lift_run: &|| false,
            costly: true,
                patch_root: false,
        };
        let mut recordings = Vec::new();
        let skipped = retain.enter(entry(1, 0)).is_some();
        if !skipped {
            if retain.enter(entry(2, 0)).is_none() {
                if motion_in_child {
                    retain.dynamic(Dynamic::Animation);
                }
                recordings.push(retain.exit().map(|recording| (recording.token, recording.lift_z.is_some())));
            }
            recordings.push(retain.exit().map(|recording| (recording.token, recording.lift_z.is_some())));
        }
        retain.finish_frame();
        (skipped, recordings)
    }

    #[test]
    fn an_element_built_whole_is_recorded_under_the_token_its_record_has_and_the_frame_after_skips_it() {
        let mut retain = Retain::new();
        retain.set_planning(true);
        // The first frame has nothing known from before: everything is built, and recorded.
        let (skipped, recordings) = nested_frame(&mut retain, false);
        assert!(!skipped);
        let [Some((child, _)), Some((parent, _))] = recordings[..] else { panic!("both are recorded: {recordings:?}") };
        assert_eq!(retain.records[&2].token, child);
        assert_eq!(retain.records[&1].token, parent);
        // The frame after skips the root under the key gpui has the recording of.
        let tree = RetainedTree::new();
        let focus = crate::focus::FocusStyles::default();
        let (handles, scrolls) = (HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree: &tree,
            hovered: &[],
            hover_paint: Vec::new(),
            active: &[],
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        let inherited = root_inherited();
        let skip = retain
            .enter(Entry {
                id: 1,
                revision: 7,
                inherited: &inherited,
                at: 0,
                stacking_root: false,
                stacking_item: false,
                atomic_root: false,
                contents_overlay: None,
                anchor_scope: false,
                text_box_trim: Default::default(),
                plain: true,
                boxed: true,
                container: None,
                prekeyed: None,
                scroller: None,
                lift_run: &|| false,
                costly: true,
                patch_root: false,
            })
            .expect("the root is skipped by the frame after the one that built it");
        assert_eq!(skip.token, parent);
        retain.finish_frame();
    }

    #[test]
    fn an_element_with_a_motion_in_it_is_not_recorded_and_nor_is_the_one_above_it() {
        let mut retain = Retain::new();
        retain.set_planning(true);
        let (_, recordings) = nested_frame(&mut retain, true);
        assert_eq!(recordings.len(), 2);
        assert!(recordings[0].is_none(), "the element the motion runs on is built by every frame");
        assert!(recordings[1].is_none(), "and so is the one above it");
    }

    /// What a frame is told changed, by the sources the tests below vary.
    #[derive(Default)]
    struct Changes {
        hovered: Vec<u64>,
        active: Vec<u64>,
        within: Vec<u64>,
        measured: Vec<u64>,
        links: Vec<u64>,
        commanded: Vec<u64>,
        relevance: Vec<u64>,
        selection: u64,
        /// An animation of the opacity of element 1 is current.
        lift_run: bool,
    }

    /// A frame of the one element 1, which it builds or leaves unvisited (a layout-only pass with
    /// `display: none` above it). Returns whether the frame skipped it.
    fn frame(retain: &mut Retain, changes: Changes, visit: bool) -> bool {
        let lift_run = changes.lift_run;
        // Element 1 is in the tree: a change to one the tree destroyed is nobody's to find (`unbuilt` drops it).
        let (tree, focus) = (tree_of(&[(1, None, "div", None)]), crate::focus::FocusStyles {
            within: changes.within.into(),
            ..Default::default()
        });
        let (handles, scrolls) = (HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree: &tree,
            hovered: &changes.hovered,
            hover_paint: Vec::new(),
            active: &changes.active,
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: changes.measured,
            links: changes.links,
            commanded: changes.commanded,
            relevance: changes.relevance,
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: changes.selection,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        let inherited = root_inherited();
        let mut skipped = false;
        if visit {
            skipped = retain
                .enter(Entry {
                    id: 1,
                    revision: 7,
                    inherited: &inherited,
                    at: 0,
                    stacking_root: true,
                    stacking_item: false,
                    atomic_root: false,
                    contents_overlay: None,
                    anchor_scope: false,
                    text_box_trim: Default::default(),
                    plain: true,
                    boxed: true,
                    container: None,
                    prekeyed: None,
                    scroller: None,
                    lift_run: &|| lift_run,
                    costly: true,
                patch_root: false,
                })
                .is_some();
            if !skipped {
                retain.lift_run(lift_run);
                retain.stacking(|| (lift_run.then_some(0), true));
                retain.exit();
            }
        }
        retain.finish_frame();
        skipped
    }

    #[test]
    fn what_changed_in_a_pass_that_did_not_visit_an_element_is_found_by_the_pass_that_does() {
        let changes: [(&str, fn() -> Changes); 7] = [
            ("hovered", || Changes { hovered: vec![1], ..Default::default() }),
            ("active", || Changes { active: vec![1], ..Default::default() }),
            ("focus within", || Changes { within: vec![1], ..Default::default() }),
            ("measured", || Changes { measured: vec![1], ..Default::default() }),
            ("links", || Changes { links: vec![1], ..Default::default() }),
            ("commanded", || Changes { commanded: vec![1], ..Default::default() }),
            ("content-visibility", || Changes { relevance: vec![1], ..Default::default() }),
        ];
        for (name, change) in changes {
            let mut retain = Retain::new();
            retain.set_planning(true);
            for _ in 0..3 {
                frame(&mut retain, Changes::default(), true);
            }
            assert!(frame(&mut retain, Changes::default(), true), "{name}: an element that did not change is skipped");

            // The pass is told, and never gets to the element: the sources do not tell again.
            frame(&mut retain, change(), false);
            frame(&mut retain, Changes::default(), false);
            assert!(!frame(&mut retain, Changes::default(), true), "{name}: the element is built");
            assert!(frame(&mut retain, Changes::default(), true), "{name}: then it is skipped again");
        }
    }

    #[test]
    fn a_record_made_on_the_other_side_of_the_start_or_end_of_an_opacity_run_is_not_skipped() {
        let run = |lift_run| Changes { lift_run, ..Default::default() };
        let mut retain = Retain::new();
        retain.set_planning(true);
        for _ in 0..3 {
            frame(&mut retain, run(true), true);
        }
        assert!(frame(&mut retain, run(true), true), "a run that goes on leaves the lift as the record has it");
        // The wrapper of a skipped root carries the lift of the record, which the run made: with the
        // run over, the element is lifted as its static opacity says.
        assert!(!frame(&mut retain, run(false), true), "the run is over");
        assert!(frame(&mut retain, run(false), true), "a record made after it is skipped again");
        assert!(!frame(&mut retain, run(true), true), "a run has started");
        assert!(frame(&mut retain, run(true), true));
    }

    #[test]
    fn an_element_a_new_selection_did_not_reach_is_built_when_it_is_visited() {
        let mut retain = Retain::new();
        retain.set_planning(true);
        for _ in 0..3 {
            frame(&mut retain, Changes::default(), true);
        }
        frame(&mut retain, Changes { selection: 5, ..Default::default() }, false);
        assert!(!frame(&mut retain, Changes { selection: 5, ..Default::default() }, true));
    }

    /// `(id, parent, type, display)` as a tree, the first being the root.
    fn tree_of(nodes: &[(u64, Option<u64>, &str, Option<&str>)]) -> RetainedTree {
        let mut tree = RetainedTree::new();
        for (id, _, kind, display) in nodes {
            tree.create_element(*id, kind.to_string());
            tree.set_style(*id, Arc::new(crate::style::StyleDesc {
                display: display.map(str::to_owned),
                ..Default::default()
            }));
        }
        for (id, parent, ..) in nodes {
            if let Some(parent) = parent {
                tree.append_child(*parent, *id);
            }
        }
        tree.set_root(nodes[0].0);
        tree
    }

    /// A frame over `tree` in which `motion` runs and a build enters `built`, nested in that order.
    fn frame_of(retain: &mut Retain, tree: &RetainedTree, motion: &[u64], built: &[u64]) {
        let focus = crate::focus::FocusStyles::default();
        let (handles, scrolls) = (HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree,
            hovered: &[],
            hover_paint: Vec::new(),
            active: &[],
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: motion.to_vec(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        let inherited = root_inherited();
        for id in built {
            retain.enter(Entry {
                id: *id,
                revision: 7,
                inherited: &inherited,
                at: 0,
                stacking_root: true,
                stacking_item: false,
                atomic_root: false,
                contents_overlay: None,
                anchor_scope: false,
                text_box_trim: Default::default(),
                plain: true,
                boxed: true,
                container: None,
                prekeyed: None,
                scroller: None,
                lift_run: &|| false,
                costly: true,
                patch_root: false,
            });
            retain.stacking(|| (None, true));
        }
        for _ in built {
            retain.exit();
        }
        retain.finish_frame();
    }

    fn sorted(ids: &FxHashSet<u64>) -> Vec<u64> {
        let mut ids: Vec<u64> = ids.iter().copied().collect();
        ids.sort_unstable();
        ids
    }

    #[test]
    fn a_changed_element_below_an_unbuilt_wrapper_still_has_its_ancestors_on_the_spine() {
        // 1 > 2 > 3 (display: contents) > 4, the one that moves.
        let tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "div", None),
            (3, Some(2), "div", Some("contents")),
            (4, Some(3), "div", None),
        ]);
        let mut retain = Retain::new();
        retain.set_planning(true);
        frame_of(&mut retain, &tree, &[4], &[1, 2]);
        assert_eq!(sorted(&retain.deltas.spine), vec![1, 2, 3, 4]);
        // 4 was not reached by the build, and 3 is spliced out of 2.
        assert_eq!(sorted(&retain.unbuilt), vec![4]);
        // The walk from 4 used to stop at 3, which the frame before had left in `unbuilt`.
        frame_of(&mut retain, &tree, &[4], &[1, 2]);
        assert_eq!(sorted(&retain.deltas.spine), vec![1, 2, 3, 4]);
    }

    #[test]
    fn a_changed_element_the_tree_destroyed_is_not_left_unbuilt() {
        // 1 > 2, and 9, which a list recycled while the pointer was over it: the pointer's chain still
        // named it in the frame before, so it is a change. Nothing builds it and nothing can, so it
        // stays in `unbuilt` for good and every tick that follows is declined `Outside`.
        let tree = tree_of(&[(1, None, "div", None), (2, Some(1), "div", None)]);
        let mut retain = Retain::new();
        retain.set_planning(true);
        frame_of(&mut retain, &tree, &[9], &[1, 2]);
        assert!(retain.unbuilt.is_empty(), "{:?}", sorted(&retain.unbuilt));
    }

    #[test]
    fn a_changed_row_of_a_virtual_list_is_not_left_unbuilt() {
        // 1 > 2 (virtual-list) > 3 (a row) > 4, the one the pointer is over. The list builds its rows
        // in its layout, each in a session of its own (`begin_row`), outside the frame's walk: the
        // spine has to reach the row, which is built because 4 changed, and the walk leaves nothing
        // of the rows in `unbuilt`.
        let tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "virtual-list", None),
            (3, Some(2), "div", None),
            (4, Some(3), "div", None),
        ]);
        let mut retain = Retain::new();
        retain.set_planning(true);
        frame_of(&mut retain, &tree, &[4], &[1, 2]);
        assert_eq!(sorted(&retain.deltas.spine), vec![1, 2, 3, 4]);
        assert!(retain.unbuilt.is_empty(), "{:?}", sorted(&retain.unbuilt));
    }

    #[test]
    fn the_spine_missing_the_parent_of_an_element_on_it_is_a_mismatch() {
        // 1 > 2 > 3 (display: contents) > 4.
        let tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "div", None),
            (3, Some(2), "div", Some("contents")),
            (4, Some(3), "div", None),
        ]);
        let spine = |ids: &[u64]| ids.iter().copied().collect::<FxHashSet<u64>>();
        let mut mismatches = Vec::new();
        check_spine(&spine(&[1, 2, 3, 4]), &tree, &mut mismatches);
        assert!(mismatches.is_empty(), "{mismatches:?}");
        // What the walk that stopped at the first id it had left behind: 3 is not on it.
        check_spine(&spine(&[1, 2, 4]), &tree, &mut mismatches);
        assert_eq!(mismatches, vec!["element 4 is on the spine and its parent 3 is not".to_owned()]);
    }

    #[test]
    fn a_verified_frame_finds_the_spine_closed_under_parent() {
        let tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "div", None),
            (3, Some(2), "div", Some("contents")),
            (4, Some(3), "div", None),
        ]);
        let mut retain = Retain::new();
        retain.set_planning(true);
        retain.set_verify(true);
        frame_of(&mut retain, &tree, &[4], &[1, 2]);
        frame_of(&mut retain, &tree, &[4], &[1, 2]);
        assert!(retain.mismatches().is_empty(), "{:?}", retain.mismatches());
    }

    /// A frame of 1 > 2 > 3 in which 3 is lifted out of 2 and 1, and `revision` is the revision 1
    /// is entered with. Returns whether the frame skipped 2.
    fn lifted_frame(retain: &mut Retain, revision: u64) -> bool {
        let tree = RetainedTree::new();
        let (focus, handles, scrolls) = (crate::focus::FocusStyles::default(), HashMap::new(), HashMap::new());
        retain.begin_frame(Sources {
            tree: &tree,
            hovered: &[],
            hover_paint: Vec::new(),
            active: &[],
            focus: &focus,
            focusable: &handles,
            scrolls: &scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only: false,
        });
        let inherited = root_inherited();
        let enter = |retain: &mut Retain, id: u64, revision: u64| {
            retain.enter(Entry {
                id,
                revision,
                inherited: &inherited,
                at: 0,
                stacking_root: true,
                stacking_item: false,
                atomic_root: false,
                contents_overlay: None,
                anchor_scope: false,
                text_box_trim: Default::default(),
                plain: true,
                boxed: true,
                container: None,
                prekeyed: None,
                scroller: None,
                lift_run: &|| false,
                costly: true,
                patch_root: false,
            })
        };
        enter(retain, 1, revision);
        retain.stacking(|| (None, false));
        let skipped = enter(retain, 2, 7).is_some();
        if !skipped {
            retain.stacking(|| (None, false));
            enter(retain, 3, 7);
            retain.stacking(|| (Some(1), false));
            retain.exit();
            retain.exit();
        }
        retain.exit();
        retain.finish_frame();
        skipped
    }

    #[test]
    fn a_skipped_element_lifts_what_its_last_build_lifted() {
        let mut retain = Retain::new();
        retain.set_planning(true);
        assert!(!lifted_frame(&mut retain, 1));
        assert!(retain.records[&1].lifts && retain.records[&2].lifts);
        // 1 is edited and built; 2 is not, and its children are not entered.
        for revision in 2..6 {
            assert!(lifted_frame(&mut retain, revision), "2 is skipped");
            assert!(retain.records[&2].lifts, "revision {revision}: 2 is still recorded to lift");
            assert!(retain.records[&1].lifts, "revision {revision}: 1 lifts what 2 lifted, though it did not enter it");
        }
    }

    #[test]
    fn what_no_build_enters_is_not_carried_but_what_it_may_enter_is() {
        let carried = |tree: &RetainedTree, id: u64, built: &[u64]| {
            let mut retain = Retain::new();
            retain.set_planning(true);
            frame_of(&mut retain, tree, &[id], built);
            sorted(&retain.unbuilt)
        };
        // Below an `<svg>`, which is entered and paints them as one image.
        let svg = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "svg", None),
            (3, Some(2), "g", None),
            (4, Some(3), "path", None),
        ]);
        assert_eq!(carried(&svg, 4, &[1]), vec![2]);
        // An inline `<span>` and the one in it are parts of the paragraph of the div around them.
        let inline = tree_of(&[(1, None, "div", None), (2, Some(1), "span", None), (3, Some(2), "span", None)]);
        assert_eq!(carried(&inline, 3, &[1]), Vec::<u64>::new());
        // The root of a tree is built as a host, not spliced out of a parent.
        let contents_root = tree_of(&[(1, None, "div", Some("contents")), (2, Some(1), "div", None)]);
        assert_eq!(carried(&contents_root, 2, &[]), vec![1, 2]);
        // A `display: none` element is not entered by a pass that skips it, and its children can be.
        let hidden = tree_of(&[(1, None, "div", None), (2, Some(1), "div", Some("none")), (3, Some(2), "div", None)]);
        assert_eq!(carried(&hidden, 3, &[1]), vec![2, 3]);
    }

    /// An element of the page under test.
    struct El {
        id: u64,
        parent: Option<u64>,
        element_type: &'static str,
        style: &'static str,
        text: Option<&'static str>,
        props: Vec<(&'static str, serde_json::Value)>,
    }

    fn div(id: u64, parent: Option<u64>, style: &'static str) -> El {
        El { id, parent, element_type: "div", style, text: None, props: Vec::new() }
    }

    fn text(id: u64, parent: u64, content: &'static str) -> El {
        El { id, parent: Some(parent), element_type: "text", style: "{}", text: Some(content), props: Vec::new() }
    }

    fn typed(id: u64, parent: u64, element_type: &'static str, style: &'static str) -> El {
        El { id, parent: Some(parent), element_type, style, text: None, props: Vec::new() }
    }

    fn with(mut element: El, key: &'static str, value: serde_json::Value) -> El {
        element.props.push((key, value));
        element
    }

    /// A column of three cards of three lines each: 1 is the page, 10, 20 and 30 the cards, and
    /// 11 to 13, 21 to 23, 31 to 33 their lines, each holding a text.
    fn page(card_styles: [&'static str; 3]) -> Vec<El> {
        let mut elements = vec![div(
            1,
            None,
            r##"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300, "color": "#223344"}"##,
        )];
        for (card, style) in [10, 20, 30].into_iter().zip(card_styles) {
            elements.push(div(card, Some(1), style));
            for line in 1..=3 {
                elements.push(div(card + line, Some(card), r#"{"height": 10}"#));
                elements.push(text(card * 10 + line, card + line, "some words"));
            }
        }
        elements
    }

    struct Scene {
        tree: Arc<Mutex<RetainedTree>>,
        window: gpui::WindowHandle<GpuixView>,
    }

    impl Scene {
        fn new(cx: &mut gpui::TestAppContext, elements: Vec<El>) -> Self {
            let tree = Arc::new(Mutex::new(RetainedTree::new()));
            {
                let mut tree = tree.lock().unwrap();
                for element in &elements {
                    tree.create_element(element.id, element.element_type.to_owned());
                    let style = tree.styles.intern(element.style.as_bytes()).unwrap();
                    tree.set_style(element.id, style);
                    if let Some(content) = element.text {
                        tree.set_text(element.id, content.to_owned());
                    }
                    for (key, value) in &element.props {
                        tree.set_custom_prop(element.id, (*key).to_owned(), value.clone());
                    }
                }
                for element in &elements {
                    if let Some(parent) = element.parent {
                        tree.append_child(parent, element.id);
                    }
                }
                tree.set_root(elements[0].id);
            }
            let view_tree = tree.clone();
            let window = cx.add_window(|window, _| {
                crate::events::enable_dom_hit_testing(window);
                crate::layout::container::allow_redraw_passes(window);
                let mut view = GpuixView::new(
                    view_tree,
                    None,
                    "test".to_owned(),
                    crate::text::SharedSelection::default(),
                    crate::events::state::PointerRequests::default(),
                );
                view.clock.pause();
                view
            });
            let scene = Self { tree, window };
            scene.draw(cx);
            scene
        }

        /// A frame, then a check that nothing judged unchanged was built differently.
        fn draw(&self, cx: &mut gpui::TestAppContext) {
            cx.update_window(self.window.into(), |_, window, app| {
                window.refresh();
                window.draw(app).clear(app);
            })
            .unwrap();
            self.assert_sound(cx);
        }

        fn assert_sound(&self, cx: &mut gpui::TestAppContext) {
            let mismatches = self.window.update(cx, |view, _, _| view.retain.mismatches().to_vec()).unwrap();
            assert!(mismatches.is_empty(), "{mismatches:?}");
            let replayed = cx
                .update_window(self.window.into(), |_, window, _| window.retention_mismatches().to_vec())
                .unwrap();
            assert!(replayed.is_empty(), "{replayed:?}");
        }

        /// The roots the last build would have reused, sorted.
        fn roots(&self, cx: &mut gpui::TestAppContext) -> Vec<u64> {
            let mut roots = self.window.update(cx, |view, _, _| view.retain.summary().roots.clone()).unwrap();
            roots.sort_unstable();
            roots
        }

        fn elements_in_roots(&self, cx: &mut gpui::TestAppContext) -> (usize, usize) {
            self.window
                .update(cx, |view, _, _| (view.retain.summary().elements_in_roots, view.retain.summary().elements))
                .unwrap()
        }

        /// Draws until a frame changes nothing, which a page that is not animating does by the second.
        fn settle(&self, cx: &mut gpui::TestAppContext) {
            for _ in 0..3 {
                self.draw(cx);
            }
        }

        /// A test app draws inline when an input changes what is shown, so the frame this makes is
        /// the one the pointer is already in.
        fn mouse_to(&self, cx: &mut gpui::TestAppContext, id: u64) {
            let bounds = crate::automation::get_bounds(self.window.window_id(), id).expect("painted");
            let inside = gpui::point(gpui::px((bounds.x + 2.0) as f32), gpui::px((bounds.y + 2.0) as f32));
            gpui::VisualTestContext::from_window(self.window.into(), cx).simulate_mouse_move(
                inside,
                None,
                Default::default(),
            );
            self.assert_sound(cx);
        }

        fn mouse_away(&self, cx: &mut gpui::TestAppContext) {
            gpui::VisualTestContext::from_window(self.window.into(), cx).simulate_mouse_move(
                gpui::point(gpui::px(790.0), gpui::px(590.0)),
                None,
                Default::default(),
            );
            self.assert_sound(cx);
        }

        fn set_prop(&self, id: u64, key: &str, value: serde_json::Value) {
            self.tree.lock().unwrap().set_custom_prop(id, key.to_owned(), value);
        }

        /// How many elements the last frames counted under `reason`.
        fn counted(reason: &str) -> u64 {
            crate::perf_counters::retain_reasons()
                .iter()
                .find(|(name, _)| name == reason)
                .map_or(0, |(_, count)| *count)
        }

        fn set_style(&self, id: u64, style: &str) {
            let mut tree = self.tree.lock().unwrap();
            let style = tree.styles.intern(style.as_bytes()).unwrap();
            tree.set_style(id, style);
        }
    }

    /// A page that skips what it judges unchanged, drawn until its roots are recorded. With
    /// `verify`, every frame that replays something is built again and compared.
    fn planned(cx: &mut gpui::TestAppContext, card_styles: [&'static str; 3], verify: bool) -> Scene {
        let scene = Scene::new(cx, page(card_styles));
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.retain.set_verify(verify);
            })
            .unwrap();
        for _ in 0..4 {
            scene.notified_draw(cx);
        }
        scene
    }

    impl Scene {
        /// A frame of a view that notified, which does not refresh the window.
        fn notified_draw(&self, cx: &mut gpui::TestAppContext) {
            self.window.update(cx, |_, _, cx| cx.notify()).unwrap();
            cx.update_window(self.window.into(), |_, window, app| window.draw(app).clear(app)).unwrap();
            self.assert_sound(cx);
        }
    }

    fn retained_counters(scene: &Scene, cx: &mut gpui::TestAppContext) -> gpui::RetainedCounters {
        cx.update_window(scene.window.into(), |_, window, _| window.retained_counters()).unwrap()
    }

    #[gpui::test]
    fn a_replayed_page_is_the_page_a_build_makes(cx: &mut gpui::TestAppContext) {
        let scene = planned(cx, [CARD; 3], true);
        let before = retained_counters(&scene, cx);
        scene.notified_draw(cx);
        scene.notified_draw(cx);
        let after = retained_counters(&scene, cx);
        assert!(after.verified > before.verified, "frames that replayed were compared: {after:?}");
        assert_eq!(after.mismatches, 0);
    }

    impl Scene {
        /// A read of a bounds on a window that has a change to show: a pass that lays out and
        /// does not paint. Returns the boxes it published, how many elements it built and what the
        /// retained subtrees did, all as the pass left them (the test app draws the window once it
        /// is over).
        fn layout_only(&self, cx: &mut gpui::TestAppContext) -> (String, u64, gpui::RetainedCounters) {
            crate::perf_counters::reset();
            let result = cx
                .update_window(self.window.into(), |view, window, app| {
                    view.downcast::<GpuixView>().unwrap().update(app, |_, cx| cx.notify());
                    assert!(window.draw_if_dirty(app), "a pass ran");
                    (
                        crate::automation::describe_bounds(window.window_handle().window_id()),
                        crate::perf_counters::snapshot().elements_built,
                        window.retained_counters(),
                    )
                })
                .unwrap();
            self.assert_sound(cx);
            result
        }

        /// The boxes of the last frame, after a frame that builds every element.
        fn built_bounds(&self, cx: &mut gpui::TestAppContext) -> String {
            self.draw(cx);
            crate::automation::describe_bounds(self.window.window_id())
        }
    }

    #[gpui::test]
    fn a_layout_only_pass_publishes_the_boxes_a_build_publishes(cx: &mut gpui::TestAppContext) {
        let scene = planned(cx, [CARD; 3], true);
        let all = 1 + 3 * (1 + 3 * 2);

        // The last card grows, and nothing before it moves.
        scene.set_style(30, r#"{"height": 90}"#);
        let (published, _, during) = scene.layout_only(cx);
        assert!(during.layout_replays >= 5, "{during:?}");
        assert!(during.verified > 0, "the pass was compared with a build of it: {during:?}");
        assert_eq!(published, scene.built_bounds(cx));
        assert!(published.lines().count() >= all as usize - 3, "the boxes of what was skipped are there:\n{published}");

        // The first card grows and moves the others, which are built where they are.
        scene.settle(cx);
        scene.set_style(10, r#"{"height": 90}"#);
        let (published, _, _) = scene.layout_only(cx);
        assert_eq!(published, scene.built_bounds(cx));

        // And the frame after a pass is the frame a build makes, which replays what the pass
        // left alone.
        scene.settle(cx);
        let before = retained_counters(&scene, cx);
        scene.set_style(30, r#"{"height": 60}"#);
        scene.layout_only(cx);
        scene.notified_draw(cx);
        let after = retained_counters(&scene, cx);
        assert!(after.replays > before.replays, "{after:?}");
        assert_eq!(after.mismatches, 0, "{after:?}");
        assert!(after.verified > before.verified);
    }

    #[gpui::test]
    fn a_layout_only_pass_builds_the_spine_and_what_changed(cx: &mut gpui::TestAppContext) {
        let scene = planned(cx, [CARD; 3], false);
        let pass = |cx: &mut gpui::TestAppContext| {
            let before = retained_counters(&scene, cx);
            let (_, built, after) = scene.layout_only(cx);
            (built, after.layout_skips - before.layout_skips, after.layout_replays - before.layout_replays, after.layout_builds - before.layout_builds)
        };
        // Nothing changed: the page is the one root, and the pass skips it.
        assert_eq!(pass(cx), (0, 1, 1, 0));
        scene.settle(cx);

        // The page and the last card are built, each in a root of its own that leaves a layout record;
        // the other cards and the lines of the last are not, and are where they were.
        scene.set_style(30, r#"{"height": 90}"#);
        assert_eq!(pass(cx), (2, 5, 5, 2));
        scene.settle(cx);

        // The cards after the first move, and are built where they are.
        scene.set_style(10, r#"{"height": 90}"#);
        let (built, skips, replays, builds) = pass(cx);
        assert!(built > 2, "{built}");
        // The cards moved, and so did the lines in them, which are skipped inside the cards built. The
        // page and the first card, which a pass built whole before, are built in roots of their own now.
        assert_eq!((skips, replays, builds), (17, 3, 16));
    }

    #[gpui::test]
    fn a_box_that_goes_away_with_a_transition_running_and_comes_back(cx: &mut gpui::TestAppContext) {
        let shown = |width: u32, display: &str| {
            format!(
                r#"{{"width": {width}, "height": 20, "display": "{display}", "transition": "width 1s linear"}}"#
            )
        };
        let elements = vec![
            div(1, None, r#"{"width": 400, "height": 300}"#),
            div(2, Some(1), Box::leak(shown(100, "block").into_boxed_str())),
        ];
        let scene = Scene::new(cx, elements);
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.retain.set_verify(true);
                view.retain.set_min_root(1);
            })
            .unwrap();
        let step = |cx: &mut gpui::TestAppContext, width: u32, display: &str, ms: f64| {
            scene.set_style(2, &shown(width, display));
            scene.window.update(cx, |view, _, _| { view.clock.fast_forward_ms(ms); }).unwrap();
            scene.notified_draw(cx);
        };
        for _ in 0..3 {
            scene.notified_draw(cx);
        }
        step(cx, 200, "block", 0.0);
        step(cx, 200, "block", 500.0);
        step(cx, 200, "none", 0.0);
        step(cx, 200, "none", 16.0);
        step(cx, 300, "none", 0.0);
        step(cx, 300, "none", 16.0);
        step(cx, 300, "block", 0.0);
        step(cx, 300, "block", 500.0);
    }

    #[gpui::test]
    fn a_page_that_does_not_move_is_not_built(cx: &mut gpui::TestAppContext) {
        let scene = planned(cx, [CARD; 3], false);
        let before = retained_counters(&scene, cx);
        crate::perf_counters::reset();
        scene.notified_draw(cx);
        scene.notified_draw(cx);
        let after = retained_counters(&scene, cx);
        assert_eq!(crate::perf_counters::snapshot().elements_built, 0);
        assert!(after.replays > before.replays, "{after:?}");
        assert_eq!(after.builds, before.builds);
        assert_eq!(after.lazy_builds, before.lazy_builds);
        assert_eq!(after.total_non_reusable(), 0, "{after:?}");
    }

    const CARD: &str = r#"{"height": 60}"#;
    const HOVER_CARD: &str = r##"{"height": 60, "hover": {"backgroundColor": "#aa0000"}}"##;

    /// A scroller of three cards, which are subtrees a frame could skip when the scroller is
    /// where it was, under a page that is not one since it holds a scroller.
    fn scroller_page() -> Vec<El> {
        let mut elements = vec![
            div(1, None, r#"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300}"#),
            div(
                2,
                Some(1),
                r#"{"display": "flex", "flexDirection": "column", "width": 400, "height": 40, "overflowY": "auto"}"#,
            ),
        ];
        for card in [10, 20, 30] {
            elements.push(div(card, Some(2), r#"{"height": 30}"#));
            for line in 1..=2 {
                elements.push(div(card + line, Some(card), r#"{"height": 10}"#));
                elements.push(text(card * 10 + line, card + line, "some words"));
            }
        }
        elements
    }

    /// A scroller of boxes of one element each, which no frame skips on its own.
    fn boxes_page() -> Vec<El> {
        let mut elements = vec![
            div(1, None, r#"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300}"#),
            div(
                2,
                Some(1),
                r#"{"display": "flex", "flexDirection": "column", "width": 400, "height": 40, "overflowY": "auto"}"#,
            ),
        ];
        for id in 10..16 {
            elements.push(div(id, Some(2), r#"{"height": 30}"#));
        }
        elements
    }

    /// A scene that skips what it can and backs off, as a window does outside a test.
    fn backing_off(cx: &mut gpui::TestAppContext, elements: Vec<El>) -> Scene {
        let scene = Scene::new(cx, elements);
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.retain.set_verify(false);
                // A box of one element is a subtree to skip, unless this says it is not.
                view.retain.set_min_root(2);
            })
            .unwrap();
        scene
    }

    /// Draws `frames` frames and says for each whether it was recorded. A test app draws more
    /// than once when it flushes effects, so these are the frames the retention saw.
    fn frame_log(scene: &Scene, cx: &mut gpui::TestAppContext, draw: impl FnOnce(&Scene, &mut gpui::TestAppContext)) -> Vec<bool> {
        scene.window.update(cx, |view, _, _| view.retain.take_frame_log()).unwrap();
        draw(scene, cx);
        scene.window.update(cx, |view, _, _| view.retain.take_frame_log()).unwrap()
    }

    fn draws(frames: usize) -> impl FnOnce(&Scene, &mut gpui::TestAppContext) {
        move |scene, cx| (0..frames).for_each(|_| scene.notified_draw(cx))
    }

    #[gpui::test]
    fn a_page_with_nothing_to_skip_is_recorded_less_and_less_often(cx: &mut gpui::TestAppContext) {
        let scene = backing_off(cx, boxes_page());
        let log = frame_log(&scene, cx, draws(12));
        let recorded: Vec<usize> = (0..log.len()).filter(|at| log[*at]).collect();
        // Stretches of 1, 2, 4, 8 and 8 unrecorded frames between the recorded ones.
        let gaps: Vec<usize> = recorded.windows(2).map(|pair| pair[1] - pair[0] - 1).collect();
        assert_eq!(gaps, [1, 2, 4, 8, 8, 8][..gaps.len()], "{log:?}");
        assert!(gaps.len() >= 3, "{log:?}");
    }

    #[gpui::test]
    fn a_page_that_gains_an_element_is_recorded_at_once(cx: &mut gpui::TestAppContext) {
        let scene = backing_off(cx, boxes_page());
        let log = frame_log(&scene, cx, draws(8));
        assert!(!log[log.len() - 1], "in the middle of a stretch: {log:?}");
        {
            let mut tree = scene.tree.lock().unwrap();
            tree.create_element(99, "div".to_owned());
            let style = tree.styles.intern(br#"{"height": 30}"#).unwrap();
            tree.set_style(99, style);
            tree.append_child(2, 99);
        }
        let log = frame_log(&scene, cx, draws(1));
        assert!(log[0], "{log:?}");
    }

    #[gpui::test]
    fn a_page_with_a_subtree_to_skip_is_recorded_every_frame(cx: &mut gpui::TestAppContext) {
        let scene = backing_off(cx, page([CARD; 3]));
        let log = frame_log(&scene, cx, draws(12));
        assert!(log.iter().all(|recorded| *recorded), "{log:?}");
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn a_verified_page_is_recorded_every_frame(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, boxes_page());
        scene.window.update(cx, |view, _, _| view.retain.set_planning(true)).unwrap();
        let log = frame_log(&scene, cx, draws(12));
        assert!(log.iter().all(|recorded| *recorded), "{log:?}");
    }

    #[gpui::test]
    fn a_scroller_whose_cards_can_be_moved_is_recorded_every_frame_it_moves(cx: &mut gpui::TestAppContext) {
        let scene = backing_off(cx, scroller_page());
        scene.notified_draw(cx);
        scene.notified_draw(cx);
        let moving = frame_log(&scene, cx, |scene, cx| {
            (1..=12).for_each(|top| {
                scene
                    .window
                    .update(cx, |view, _, _| {
                        view.scroll_handles[&2].set_offset(gpui::point(gpui::px(0.), gpui::px(-(top as f32))));
                    })
                    .unwrap();
                scene.draw(cx);
            })
        });
        // The cards are not in the same place twice, and a frame can put them where they are.
        assert!(moving.iter().all(|recorded| *recorded), "{moving:?}");
    }

    #[gpui::test]
    fn frames_are_recorded_again_the_moment_the_scrollers_stop(cx: &mut gpui::TestAppContext) {
        // A scroller whose cards gpui was found not to be moving: they are built when it moves.
        let scene = backing_off(cx, scroller_page());
        scene.window.update(cx, |view, _, _| view.retain.stop_relocating()).unwrap();
        scene.notified_draw(cx);
        let scroll = |scene: &Scene, cx: &mut gpui::TestAppContext, top: f32| {
            scene
                .window
                .update(cx, |view, _, _| {
                    view.scroll_handles
                        .get(&2)
                        .expect("the scroller has a handle")
                        .set_offset(gpui::point(gpui::px(0.), gpui::px(-top)));
                })
                .unwrap();
            scene.draw(cx);
        };
        // Moving every frame, the cards are never in the same place twice: recorded to look,
        // 1, 2, 4 frames apart.
        let moving = frame_log(&scene, cx, |scene, cx| (1..=12).for_each(|top| scroll(scene, cx, top as f32)));
        assert!(moving.iter().filter(|recorded| !**recorded).count() >= 6, "{moving:?}");
        // Stopped, whatever the stretch it is in: the next frame is recorded, and the one after
        // replays the cards.
        let rest = moving.iter().rev().take_while(|recorded| !**recorded).count();
        let stopped = frame_log(&scene, cx, |scene, cx| scroll(scene, cx, 12.));
        assert!(stopped[0], "{moving:?} {stopped:?} {rest}");
        scene.notified_draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        let before = retained_counters(&scene, cx);
        scene.notified_draw(cx);
        assert!(retained_counters(&scene, cx).replays > before.replays, "and the cards are replayed again");
    }

    #[test]
    fn roots_gpui_builds_again_after_a_scroll_are_not_planned_to_move_for_a_while() {
        let mut retain = Retain::new();
        retain.relocation.planned = 20;
        // Twenty planned, five put elsewhere and as many built again as were put: kept.
        retain.learn_relocation(5, 5);
        assert!(!retain.relocation.resting);
        retain.relocation.planned = 20;
        // Built again more often than put elsewhere: rests for 1, then 2, then 4 frames, up to 8,
        // counting the frame that follows the judged one, which rests too.
        let mut lazy = 5;
        for gap in [1, 2, 4, 8, 8] {
            lazy += 10;
            retain.relocation.planned = 20;
            retain.learn_relocation(lazy, 5);
            assert!(retain.relocation.resting, "{gap}: the frame after the one that was found built again");
            let rested = (0..gap + 3)
                .map(|_| {
                    retain.learn_relocation(lazy, 5);
                    retain.relocation.resting
                })
                .collect::<Vec<_>>();
            assert_eq!(rested.iter().filter(|resting| **resting).count(), gap - 1, "{gap}: {rested:?}");
            assert!(!rested[gap], "{gap}: looks again after the stretch: {rested:?}");
        }
        // And once the roots that were planned to move did, the next stretch starts from one again.
        retain.relocation.planned = 20;
        retain.learn_relocation(lazy, 100);
        assert_eq!(retain.relocation.gap, 0);
    }

    #[gpui::test]
    fn a_page_that_does_not_move_is_one_retainable_root(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([CARD; 3]));
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        let (inside, all) = scene.elements_in_roots(cx);
        assert_eq!(inside, all);
        assert_eq!(all, 1 + 3 * (1 + 3 * 2));
    }

    #[gpui::test]
    fn hovering_a_card_changes_it_and_leaves_the_rest(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([HOVER_CARD, CARD, CARD]));
        scene.settle(cx);
        scene.mouse_to(cx, 10);
        // The page is the spine and the hovered card builds; what is in the card does not inherit
        // its background, so its lines are reusable.
        assert_eq!(scene.roots(cx), vec![11, 12, 13, 20, 30]);
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![1], "it is still hovered, and builds as it did");
        scene.mouse_away(cx);
        assert_eq!(scene.roots(cx), vec![11, 12, 13, 20, 30], "its style went back");
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn a_hover_that_changes_what_children_inherit_changes_them_too(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(
            cx,
            page([r##"{"height": 60, "hover": {"color": "#ff0000"}}"##, CARD, CARD]),
        );
        scene.settle(cx);
        scene.mouse_to(cx, 10);
        assert_eq!(scene.roots(cx), vec![20, 30]);
        scene.mouse_away(cx);
        assert_eq!(scene.roots(cx), vec![20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn a_color_the_page_hands_down_changes_everything_below_it(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([CARD; 3]));
        scene.settle(cx);
        scene.set_style(
            1,
            r##"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300, "color": "#ffaa00"}"##,
        );
        scene.draw(cx);
        assert_eq!(scene.roots(cx), Vec::<u64>::new());
        scene.settle(cx);
        // A background is not inherited.
        scene.set_style(
            1,
            r##"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300, "color": "#ffaa00", "backgroundColor": "#101010"}"##,
        );
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
    }

    #[gpui::test]
    fn a_card_that_sets_its_own_colour_is_not_changed_by_the_colour_of_the_page(cx: &mut gpui::TestAppContext) {
        const OWN: &str = r##"{"color": "#00aa44", "borderWidth": 3, "borderStyle": "solid", "borderColor": "currentColor"}"##;
        let scene = Scene::new(cx, page([OWN; 3]));
        scene.settle(cx);
        scene.set_style(
            1,
            r##"{"display": "flex", "flexDirection": "column", "width": 400, "height": 300, "color": "#ffaa00"}"##,
        );
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
    }

    #[gpui::test]
    fn a_card_whose_text_sets_its_own_colour_is_not_changed_by_the_colour_of_the_page(cx: &mut gpui::TestAppContext) {
        let mut elements = vec![div(
            1,
            None,
            r##"{"display": "flex", "flexWrap": "wrap", "width": 640, "color": "#223344"}"##,
        )];
        for card in [10, 20, 30] {
            elements.push(div(card, Some(1), r##"{"width": 140, "height": 60, "backgroundColor": "#335577"}"##));
            for line in 1..=2 {
                elements.push(div(card + line, Some(card), r##"{"height": 20}"##));
                let host = card * 10 + line;
                elements.push(typed(host, card + line, "text", r##"{"color": "#ffffff"}"##));
                elements.push(text(host * 10, host, "some words"));
            }
        }
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        scene.set_style(1, r##"{"display": "flex", "flexWrap": "wrap", "width": 640, "color": "#ffaa00"}"##);
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
    }

    #[gpui::test]
    fn what_text_inherits_from_the_page_changes_everything_below_it(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([CARD; 3]));
        scene.settle(cx);
        let page_style = |extra: &str| {
            format!(
                r##"{{"display": "flex", "flexDirection": "column", "width": 400, "height": 300, "color": "#223344", {extra}}}"##
            )
        };
        for (what, extra) in [
            ("an underline offset", r#""textUnderlineOffset": 3"#),
            ("variation settings", r#""fontVariationSettings": "\"wght\" 650""#),
            ("a text box trim", r#""textBox": "trim-both cap alphabetic""#),
            // An unset one of these in a transition or a motion below starts from it.
            ("a hidden visibility", r#""visibility": "hidden""#),
            ("a unitless line height", r#""lineHeight": 1.5"#),
            ("a pointer-events of none", r#""pointerEvents": "none""#),
            ("a border spacing", r#""borderSpacing": "3px 5px""#),
            // The start of a logical inline pair below it is the other side.
            ("a right to left direction", r#""direction": "rtl""#),
        ] {
            scene.set_style(1, &page_style(extra));
            scene.draw(cx);
            assert_eq!(scene.roots(cx), Vec::<u64>::new(), "{what}");
            scene.settle(cx);
            assert_eq!(scene.roots(cx), vec![1], "{what}");
        }
    }

    #[gpui::test]
    fn a_window_resize_changes_what_viewport_units_mean(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([r#"{"height": 60, "fontSize": "2vw"}"#, CARD, CARD]));
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        cx.simulate_window_resize(scene.window.into(), gpui::size(gpui::px(500.0), gpui::px(300.0)));
        scene.assert_sound(cx);
        assert_eq!(scene.roots(cx), Vec::<u64>::new(), "the viewport is in what everything inherits");
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn a_container_that_resizes_is_retained_with_what_reads_it_once_the_size_is_settled(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(div(40, Some(1), r#"{"width": 200, "height": 30, "containerType": "inline-size"}"#));
        elements.push(div(41, Some(40), r#"{"width": "50cqw", "height": 10}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        // The size is part of the key of the container and of what is in it: a frame that finds
        // the container resized builds it, and the page above it.
        scene.set_style(40, r#"{"width": 100, "height": 30, "containerType": "inline-size"}"#);
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn a_parent_of_a_child_with_container_blocks_is_retained(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(div(40, Some(1), r#"{"width": 200, "height": 30, "containerType": "inline-size"}"#));
        elements.push(div(41, Some(40), r#"{"height": 10}"#));
        elements.push(div(42, Some(41), r#"{"height": 5, "@container": {"(min-width: 300px)": {"display": "none"}}}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        scene.set_style(40, r#"{"width": 400, "height": 30, "containerType": "inline-size"}"#);
        scene.draw(cx);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn the_debug_report_names_what_a_frame_built_and_what_it_skipped(cx: &mut gpui::TestAppContext) {
        let scene = backing_off(cx, page([CARD; 3]));
        scene.window.update(cx, |view, _, _| view.retain.set_debug(true)).unwrap();
        let report = |cx: &mut gpui::TestAppContext| -> serde_json::Value {
            let report = scene
                .window
                .update(cx, |view, _, _| view.retain.debug_report(&scene.tree.lock().unwrap()))
                .unwrap();
            serde_json::from_str(&report).unwrap()
        };
        // The first frame builds all of the page, and calls its first element new.
        scene.draw(cx);
        let first = report(cx);
        assert_eq!(first["builtNodes"], 22, "{first}");
        assert_eq!(first["skippedRoots"], 0, "{first}");
        // Once it is settled the page is one skipped root.
        scene.settle(cx);
        let settled = report(cx);
        assert_eq!(settled["builtNodes"], 0, "{settled}");
        assert_eq!(settled["skippedRoots"], 1, "{settled}");
        assert_eq!(settled["skippedElements"], 22, "{settled}");
    }

    #[gpui::test]
    fn an_absolute_box_is_retained_with_the_positioned_box_that_places_it(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(div(40, Some(1), r#"{"position": "relative", "width": 100, "height": 30}"#));
        elements.push(div(41, Some(40), r#"{"height": 20}"#));
        elements.push(div(42, Some(41), r#"{"position": "absolute", "top": 0, "left": 0, "width": 10, "height": 10}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        // The box is in the relative one, which is in the page: nothing is in the way.
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn an_absolute_box_with_no_positioned_ancestor_below_a_root_ends_the_roots_above_it(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(div(40, Some(1), r#"{"width": 100, "height": 30}"#));
        elements.push(div(41, Some(40), r#"{"height": 20}"#));
        elements.push(div(42, Some(41), r#"{"position": "absolute", "top": 0, "left": 0, "width": 10, "height": 10}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        // Its containing block is above the page's children, so only the three cards are roots.
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
    }

    #[gpui::test]
    fn an_animating_node_is_changed_every_frame_and_nothing_else_is(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(with(
            div(40, Some(1), r#"{"height": 30, "opacity": 0.2}"#),
            "motion",
            serde_json::json!({
                "generation": 1,
                "initial": { "opacity": 0.2 },
                "animate": { "opacity": 0.9 },
                "transition": { "duration": 600.0, "ease": "linear" }
            }),
        ));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        for _ in 0..5 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.draw(cx);
            assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        }
    }

    #[gpui::test]
    fn a_change_of_text_changes_the_line_that_holds_it_and_what_is_above(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page([CARD; 3]));
        scene.settle(cx);
        scene.tree.lock().unwrap().set_text(101, "other words".to_owned());
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![12, 13, 20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn focus_changes_the_focused_element_and_dims_the_other_focusable_ones(cx: &mut gpui::TestAppContext) {
        let focusable = |id, parent| {
            with(
                div(id, Some(parent), r##"{"height": 20, "focusVisible": {"outlineWidth": 2, "outlineColor": "#0000ff"}}"##),
                "tabIndex",
                serde_json::json!(0),
            )
        };
        let mut elements = page([CARD; 3]);
        elements.push(focusable(40, 1));
        elements.push(focusable(50, 1));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        scene.window.update(cx, |_, window, _| window.activate_window()).unwrap();
        cx.run_until_parked();
        crate::perf_counters::reset();
        // The inline draws of a test app are the frames that see the focus, so the counters
        // of those are what to look at, and that none of them built an unchanged element differently.
        scene.window.update(cx, |view, window, cx| view.request_focus(40, window, cx)).unwrap();
        scene.settle(cx);
        let reasons = crate::perf_counters::retain_reasons();
        let changed_by_focus = reasons.iter().find(|(reason, _)| reason == "changed:focus").map_or(0, |(_, count)| *count);
        // The focused one, and the other, which dims while a control is focus-visible.
        assert!(changed_by_focus >= 2, "{reasons:?}");
        assert_eq!(scene.roots(cx), vec![1]);
        scene.window.update(cx, |_, window, _| window.blur()).unwrap();
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    const HIDDEN_CARD: &str = r#"{"height": 60, "overflow": "hidden"}"#;

    /// `page` with lines taller than their card, so a hidden card has something to scroll.
    fn page_with_tall_lines(card_styles: [&'static str; 3]) -> Vec<El> {
        let mut elements = page(card_styles);
        for element in &mut elements {
            if element.style == r#"{"height": 10}"# {
                element.style = r#"{"height": 30}"#;
            }
        }
        elements
    }

    #[gpui::test]
    fn a_hidden_overflow_is_retained_until_script_moves_what_it_clips(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, page_with_tall_lines([HIDDEN_CARD, CARD, CARD]));
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1], "the clipping card is no obstacle");
        crate::perf_counters::reset();
        scene
            .window
            .update(cx, |view, _, _| {
                view.scroll_handles[&10].set_offset(gpui::point(gpui::px(0.0), gpui::px(-20.0)));
            })
            .unwrap();
        scene.draw(cx);
        // The card read a new offset, and its lines sit somewhere else because of it: they are
        // roots that a frame can put where they are, as the lines of a scroller are.
        assert_eq!(scene.roots(cx), vec![11, 12, 13, 20, 30]);
        assert_eq!(Scene::counted("changed:scroll"), 1);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    /// The page, and under it a label of the control `email`, then the control.
    fn labelled_input() -> Vec<El> {
        let mut elements = page([CARD; 3]);
        elements.push(with(div(40, Some(1), r#"{"height": 20}"#), "id", serde_json::json!("row")));
        elements.push(with(typed(41, 1, "label", r#"{"height": 10}"#), "htmlFor", serde_json::json!("email")));
        elements.push(text(42, 41, "Email"));
        elements.push(with(typed(43, 1, "input", r#"{"height": 20}"#), "id", serde_json::json!("email")));
        elements
    }

    #[gpui::test]
    fn a_label_is_retained_and_changes_when_the_control_it_names_stops_taking_its_click(
        cx: &mut gpui::TestAppContext,
    ) {
        let scene = Scene::new(cx, labelled_input());
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        crate::perf_counters::reset();
        scene.set_prop(43, "disabled", serde_json::json!(true));
        scene.draw(cx);
        // The label's own subtree is untouched. What it reads of the control is whether a click
        // on it goes anywhere, which is in its shape, and the shape of what it holds follows it.
        assert_eq!(scene.roots(cx), vec![10, 20, 30, 40]);
        assert_eq!(Scene::counted("changed:shape"), 2);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        scene.set_prop(43, "disabled", serde_json::json!(false));
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30, 40]);
    }

    #[gpui::test]
    fn an_element_an_aria_reference_names_changes_when_the_reference_does(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(with(typed(40, 1, "div", r#"{"height": 20}"#), "id", serde_json::json!("hint")));
        elements.push(text(41, 40, "Be brief"));
        elements.push(typed(50, 1, "div", r#"{"height": 20}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        crate::perf_counters::reset();
        scene.set_prop(50, "aria-describedby", serde_json::json!("hint"));
        scene.draw(cx);
        // 40 is named by 50 now and gets a node for it, with nothing of its own having changed.
        // Its text is keyed by the shape it sits in.
        assert_eq!(Scene::counted("changed:shape"), 2);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    fn icon(size: &'static str, motion: Option<serde_json::Value>) -> Vec<El> {
        let mut elements = page([CARD; 3]);
        elements.push(typed(40, 1, "svg", size));
        let mut circle = with(
            with(typed(41, 40, "circle", "{}"), "cx", serde_json::json!(12)),
            "r",
            serde_json::json!(6),
        );
        if let Some(motion) = motion {
            circle = with(circle, "motion", motion);
        }
        elements.push(circle);
        elements
    }

    const SMALL_ICON: &str = r##"{"width": 24, "height": 24, "color": "#336699"}"##;

    #[gpui::test]
    fn an_svg_is_retained_once_it_has_been_painted(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, icon(SMALL_ICON, None));
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        scene.set_prop(41, "r", serde_json::json!(8));
        scene.draw(cx);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn an_svg_whose_shapes_move_is_changed_every_frame_of_it(cx: &mut gpui::TestAppContext) {
        let elements = icon(
            SMALL_ICON,
            Some(serde_json::json!({
                "generation": 1,
                "initial": { "r": 2.0 },
                "animate": { "r": 10.0 },
                "transition": { "duration": 0.6, "ease": "linear" }
            })),
        );
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        crate::perf_counters::reset();
        for _ in 0..4 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.draw(cx);
            // The circle is never built as an element; its animated attributes reach the svg
            // as part of the XML, and the svg is the one that changes.
            assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        }
        assert!(Scene::counted("changed:shape") >= 4, "{:?}", crate::perf_counters::retain_reasons());
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(2000.0)).unwrap();
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1], "it came to rest");
    }

    #[gpui::test]
    fn an_svg_whose_shape_runs_a_css_animation_is_changed_every_frame_of_it(cx: &mut gpui::TestAppContext) {
        let mut elements = icon(SMALL_ICON, None);
        elements.iter_mut().find(|element| element.id == 41).unwrap().style =
            r#"{"animation": "grow 600ms linear"}"#;
        let scene = Scene::new(cx, elements);
        scene
            .window
            .update(cx, |view, _, _| {
                view.keyframes.define("grow", r#"{"from": {"r": 2}, "to": {"r": 10}}"#).unwrap();
            })
            .unwrap();
        scene.draw(cx);
        crate::perf_counters::reset();
        for _ in 0..4 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.draw(cx);
            // The circle is never built, so its animation is advanced by the svg writing it, and
            // the svg is the one that changes.
            assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        }
        assert!(Scene::counted("changed:shape") >= 4, "{:?}", crate::perf_counters::retain_reasons());
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(2000.0)).unwrap();
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1], "it came to rest");
    }

    #[gpui::test]
    fn an_svg_waiting_for_its_raster_is_built_again_when_the_raster_lands_and_not_every_frame(cx: &mut gpui::TestAppContext) {
        let scene = Scene::new(cx, icon(r#"{"width": 300, "height": 200}"#, None));
        crate::perf_counters::reset();
        scene.draw(cx);
        assert_eq!(Scene::counted("excluded:svg"), 0, "{:?}", crate::perf_counters::retain_reasons());
        assert_eq!(scene.roots(cx), vec![1], "the page is one root while the job runs");
        cx.run_until_parked();
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn an_img_is_retained_once_it_has_loaded_and_changes_when_script_hands_it_an_image(
        cx: &mut gpui::TestAppContext,
    ) {
        let mut elements = page([CARD; 3]);
        elements.push(with(
            typed(40, 1, "img", r#"{"width": 16, "height": 16}"#),
            "src",
            serde_json::json!("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%2F%3E"),
        ));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
        crate::perf_counters::reset();
        scene
            .window
            .update(cx, |view, window, cx| {
                view.set_image_pixels(
                    40,
                    1,
                    1,
                    vec![255; 4],
                    crate::custom_elements::img::PixelFormat::Rgba,
                    window,
                    cx,
                )
                .unwrap();
            })
            .unwrap();
        // The app draws as soon as the image is set.
        scene.assert_sound(cx);
        // Nothing in the tree moved: the source is what the element keeps for itself.
        assert_eq!(Scene::counted("changed:shape"), 1, "{:?}", crate::perf_counters::retain_reasons());
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
        scene.settle(cx);
        assert_eq!(scene.roots(cx), vec![1]);
    }

    #[gpui::test]
    fn an_img_still_loading_and_a_code_block_are_never_retained(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD; 3]);
        elements.push(with(
            typed(40, 1, "img", r#"{"width": 16, "height": 16}"#),
            "src",
            serde_json::json!("blob:never-arrives"),
        ));
        elements.push(typed(41, 1, "code", r#"{"height": 20}"#));
        let scene = Scene::new(cx, elements);
        scene.settle(cx);
        crate::perf_counters::reset();
        scene.draw(cx);
        assert_eq!(Scene::counted("excluded:custom-element"), 2);
        assert_eq!(scene.roots(cx), vec![10, 20, 30]);
    }

    /// The sources of a frame over `tree` in which `motion` runs and `hovered` is under the pointer.
    fn sources_of<'a>(
        tree: &'a RetainedTree,
        focus: &'a crate::focus::FocusStyles,
        handles: &'a HashMap<u64, gpui::FocusHandle>,
        scrolls: &'a HashMap<u64, gpui::ScrollHandle>,
        hovered: &'a [u64],
        layout_only: bool,
    ) -> Sources<'a> {
        Sources {
            tree,
            hovered,
            hover_paint: Vec::new(),
            active: &[],
            focus,
            focusable: handles,
            scrolls,
            measured: Vec::new(),
            links: Vec::new(),
            commanded: Vec::new(),
            relevance: Vec::new(),
            customs: Vec::new(),
            motion: Vec::new(),
            dormant: &|_| false,
            clock_due: &|_| false,
            verdicts: 0,
            selection: 0,
            pass: 1,
            tally: Default::default(),
            relocations: 0,
            reference: false,
            layout_only,
        }
    }

    /// A page of `1 > 2 > (3, 4)` and `1 > 5`, with whatever `build` enters in a frame of it.
    struct Units {
        tree: RetainedTree,
        retain: Retain,
        inherited: Inherited,
        focus: crate::focus::FocusStyles,
        handles: HashMap<u64, gpui::FocusHandle>,
        scrolls: HashMap<u64, gpui::ScrollHandle>,
        /// The revision each element is entered with, 7 for those not edited.
        revisions: HashMap<u64, u64>,
        /// The custom elements the registry holds when a frame begins, with their `retain_state`.
        customs: Vec<(u64, Option<u64>)>,
        /// The elements that declare a hover that only paints, or hold one.
        patch_roots: FxHashSet<u64>,
        /// The elements a hover restyled by paint, which the next preview and frame find.
        hover_paint: Vec<u64>,
    }

    impl Units {
        fn new() -> Self {
            let tree = tree_of(&[
                (1, None, "div", None),
                (2, Some(1), "div", None),
                (3, Some(2), "div", None),
                (4, Some(2), "div", None),
                (5, Some(1), "div", None),
            ]);
            let mut retain = Retain::new();
            retain.set_planning(true);
            Self {
                tree,
                retain,
                inherited: root_inherited(),
                focus: Default::default(),
                handles: HashMap::new(),
                scrolls: HashMap::new(),
                revisions: HashMap::new(),
                customs: Vec::new(),
                patch_roots: FxHashSet::default(),
                hover_paint: Vec::new(),
            }
        }

        /// The next frame finds `id` edited, as one that starts to run something is.
        fn edit(&mut self, id: u64) {
            *self.revisions.entry(id).or_insert(7) += 1;
        }

        /// A frame in which `hovered` is under the pointer, that `build` builds.
        fn frame(&mut self, hovered: &[u64], layout_only: bool, build: impl FnOnce(&mut Self)) {
            let mut sources = sources_of(&self.tree, &self.focus, &self.handles, &self.scrolls, hovered, layout_only);
            sources.customs = self.customs.clone();
            sources.hover_paint = std::mem::take(&mut self.hover_paint);
            self.retain.begin_frame(sources);
            build(self);
            self.retain.finish_frame();
        }

        fn enter(&mut self, id: u64) -> bool {
            let skipped = self.enter_in(id, None).is_some();
            if !skipped {
                self.retain.stacking(|| (None, true));
            }
            skipped
        }

        fn enter_in(&mut self, id: u64, scroller: Option<Scroller>) -> Option<Skip> {
            self.retain
                .enter(Entry {
                    id,
                    revision: self.revisions.get(&id).copied().unwrap_or(7),
                    inherited: &self.inherited,
                    at: 0,
                    stacking_root: true,
                    stacking_item: false,
                    atomic_root: false,
                    contents_overlay: None,
                    anchor_scope: false,
                    text_box_trim: Default::default(),
                    plain: true,
                    boxed: true,
                    container: None,
                    prekeyed: None,
                    scroller,
                    lift_run: &|| false,
                    costly: true,
                    patch_root: self.patch_roots.contains(&id),
                })
        }

        /// Builds the element `id` the way `build_element_in` does for a patch root, with `inside` building what is in it.
        /// Says whether it is one. Nothing if the frame
        /// skipped it, in which case the skip says whether it is and it is kept as one.
        fn patch_root(&mut self, id: u64, inside: impl FnOnce(&mut Self)) -> Option<bool> {
            if let Some(skip) = self.enter_in(id, None) {
                if skip.patch_root {
                    let env = crate::renderer::FrameEnv::for_test(self.inherited.clone(), skip.enter, web_time::Instant::now());
                    self.retain.add_patch_root(Unit { id, env });
                }
                return None;
            }
            self.retain.stacking(|| (None, true));
            let enter = self.retain.begin_patch_root();
            inside(self);
            let recording = self.retain.exit();
            let hover = enter.zip(recording).filter(|(_, recording)| recording.patch_root);
            if let Some((enter, _)) = hover {
                let env = crate::renderer::FrameEnv::for_test(self.inherited.clone(), enter, web_time::Instant::now());
                self.retain.add_patch_root(Unit { id, env });
            }
            Some(hover.is_some())
        }

        /// Builds the element `id` the way `build_element_in` does, with `inside` building what is
        /// in it. Says whether the element was begun as a unit, and if so whether what was built
        /// is one. Nothing if the frame skipped it.
        fn element(&mut self, id: u64, motion: Option<bool>, inside: impl FnOnce(&mut Self)) -> Option<bool> {
            if self.enter(id) {
                return None;
            }
            let enter = self.retain.begin_unit(true);
            if let Some(paints_only) = motion {
                self.retain.dynamic(Dynamic::Animation);
                self.retain.paints_only(paints_only);
            }
            inside(self);
            let unit = enter.map(|enter| (enter, self.retain.end_unit().is_some()));
            if let Some((enter, true)) = unit {
                let env = crate::renderer::FrameEnv::for_test(self.inherited.clone(), enter, web_time::Instant::now());
                self.retain.add_unit(Unit { id, env });
            }
            self.retain.exit();
            unit.map(|(_, built)| built)
        }

        fn leaf(&mut self, id: u64) {
            self.element(id, None, |_| {});
        }

        fn ids(&self) -> Vec<u64> {
            self.retain.units().iter().map(|unit| unit.id).collect()
        }

        /// The sources of a frame that nothing but time moved.
        fn sources(&self) -> Sources<'_> {
            sources_of(&self.tree, &self.focus, &self.handles, &self.scrolls, &[], false)
        }

        fn preview(&self, hovered: &[u64], scroll_animating: bool) -> Result<Vec<u64>, Unpatchable> {
            let mut sources = sources_of(&self.tree, &self.focus, &self.handles, &self.scrolls, hovered, false);
            sources.hover_paint = self.hover_paint.clone();
            self.retain.preview(&sources, scroll_animating, false)
        }

        /// The page, with 2 and 4 running something (whether it only paints, if so).
        fn page(&mut self, hovered: &[u64], two: Option<bool>, four: Option<bool>) {
            self.pass(hovered, false, two, four);
        }

        fn pass(&mut self, hovered: &[u64], layout_only: bool, two: Option<bool>, four: Option<bool>) {
            self.frame(hovered, layout_only, |page| {
                page.element(1, None, |page| {
                    page.element(2, two, |page| {
                        page.leaf(3);
                        page.element(4, four, |_| {});
                    });
                    page.leaf(5);
                });
            });
        }
    }

    /// A frame of the page in which 2 is entered inside `scroller`, with the skip it got.
    fn page_in(page: &mut Units, layout_only: bool, scroller: Option<Scroller>) -> Option<Skip> {
        let mut skip = None;
        page.frame(&[], layout_only, |page| {
            page.element(1, None, |page| {
                skip = page.enter_in(2, scroller);
                if skip.is_none() {
                    page.retain.stacking(|| (None, true));
                    page.leaf(3);
                    page.leaf(4);
                    page.retain.exit();
                }
            });
        });
        skip
    }

    #[test]
    fn a_list_records_its_rows_to_cover_the_travel_of_a_row_that_is_shown() {
        let window = gpui::WindowId::from(4);
        let list = Scroller::of_list(window, gpui::size(gpui::px(900.0), gpui::px(780.0)), gpui::px(512.0), gpui::size(gpui::px(1000.0), gpui::px(600.0)));
        // Built at the far side of the overdraw, a row of at most `ROOT_VIEWPORTS` viewports is shown until it
        // leaves across the viewport.
        assert_eq!(list.overscan, gpui::px(780.0 * 3.0 + 512.0));
        let unlaid = Scroller::of_list(window, gpui::size(gpui::px(0.0), gpui::px(0.0)), gpui::px(512.0), gpui::size(gpui::px(1000.0), gpui::px(600.0)));
        assert_eq!(unlaid.overscan, gpui::px(600.0 * 3.0 + 512.0));
    }

    #[test]
    fn a_pass_that_only_lays_out_skips_a_root_with_the_overscan_it_was_wrapped_with() {
        let window = gpui::WindowId::from(1);
        let list = Scroller { window, viewport: gpui::size(gpui::px(900.0), gpui::px(780.0)), overscan: gpui::px(390.0) };
        crate::automation::set_bounds(window, 2, crate::automation::ElementBounds::plain(0.0, 0.0, 100.0, 100.0));
        let mut page = Units::new();
        // A list laid out empty is no scroller, and the entry is wrapped to stay where it is.
        assert!(page_in(&mut page, true, None).is_none());
        // The page is edited, so the frames that follow enter the entry.
        page.edit(1);
        let skip = page_in(&mut page, true, Some(list)).expect("the entry is skipped");
        assert_eq!(skip.overscan, None, "gpui would refuse a layout record that is relocatable when it was not recorded to be");
        // A pass that paints is not held to it.
        page.edit(1);
        let skip = page_in(&mut page, false, Some(list)).expect("the entry is skipped");
        assert_eq!(skip.overscan, Some(gpui::px(390.0)));
    }

    #[test]
    fn the_content_under_a_scroller_first_found_in_a_painted_frame_is_still_recorded_to_be_moved() {
        let window = gpui::WindowId::from(2);
        let list = Scroller { window, viewport: gpui::size(gpui::px(900.0), gpui::px(780.0)), overscan: gpui::px(390.0) };
        crate::automation::set_bounds(window, 2, crate::automation::ElementBounds::plain(0.0, 0.0, 100.0, 100.0));
        let mut page = Units::new();
        assert!(page_in(&mut page, false, Some(list)).is_none());
        // 2 is built in the frame that finds the handle of the scroller, at its origin, and recorded: a handle
        // that is new is not a scroll, so what is under it is not moved.
        page.scrolls.insert(1, gpui::ScrollHandle::new());
        page.edit(1);
        page.edit(2);
        assert!(page_in(&mut page, false, Some(list)).is_none(), "2 was edited");
        assert!(!page.retain.deltas.scrolled.contains(&1));
        page.edit(1);
        let skip = page_in(&mut page, false, Some(list)).expect("the frame after skips the record the frame that found the handle made");
        assert_eq!(skip.overscan, Some(gpui::px(390.0)), "recorded to be moved by the scroller");
        // The first scroll puts it elsewhere instead of building it.
        page.scrolls[&1].set_offset(gpui::point(gpui::px(0.0), gpui::px(-40.0)));
        page.edit(1);
        assert!(page_in(&mut page, false, Some(list)).is_some(), "relocated, not built");
        assert!(page.retain.deltas.scrolled.contains(&1));
    }

    #[test]
    fn a_record_made_to_be_moved_is_built_again_where_its_scroller_moves_nothing_now() {
        let window = gpui::WindowId::from(3);
        let list = Scroller { window, viewport: gpui::size(gpui::px(900.0), gpui::px(780.0)), overscan: gpui::px(390.0) };
        crate::automation::set_bounds(window, 2, crate::automation::ElementBounds::plain(0.0, 0.0, 100.0, 100.0));
        let mut page = Units::new();
        assert!(page_in(&mut page, false, Some(list)).is_none());
        page.edit(1);
        let skip = page_in(&mut page, false, Some(list)).expect("skipped while the scroller can move it");
        assert_eq!(skip.overscan, Some(gpui::px(390.0)));
        // The scroller laid out with nothing to scroll (`Scroller::of`): gpui keeps the overscan and the handles of
        // what it recorded to be moved, which a build that is not asked to move it leaves out.
        page.edit(1);
        assert!(page_in(&mut page, false, None).is_none(), "built, to be recorded as it is now");
        page.edit(1);
        let skip = page_in(&mut page, false, None).expect("the build recorded it where it stays");
        assert_eq!(skip.overscan, None);
    }

    /// A frame of the page in which 2 holds the content a read forces (`forced`) or skips, edited so that it is
    /// built. Says whether 3 and 4 were skipped with their records.
    fn host_frame(page: &mut Units, hovered: &[u64], layout_only: bool, forced: bool) -> [bool; 2] {
        let mut skipped = [false; 2];
        page.edit(1);
        page.edit(2);
        page.frame(hovered, layout_only, |page| {
            page.element(1, None, |page| {
                page.element(2, None, |page| {
                    if forced {
                        page.retain.forced_host();
                        page.retain.show_content(2);
                        for (child, skipped) in [3, 4].into_iter().zip(&mut skipped) {
                            *skipped = page.enter(child);
                            if !*skipped {
                                page.retain.exit();
                            }
                        }
                    } else {
                        page.retain.skip_content(&page.tree, 2);
                    }
                });
            });
        });
        skipped
    }

    #[test]
    fn a_frame_that_skips_content_keeps_the_records_of_what_a_read_forced() {
        let mut page = Units::new();
        assert_eq!(host_frame(&mut page, &[], true, true), [false, false], "built whole");
        assert_eq!(host_frame(&mut page, &[], false, false), [false, false]);
        assert!(page.retain.records.contains_key(&3) && page.retain.records.contains_key(&4));
        assert_eq!(host_frame(&mut page, &[], true, true), [true, true], "the pass that forces it skips both");
        assert_eq!(host_frame(&mut page, &[], false, false), [false, false]);
        assert_eq!(host_frame(&mut page, &[], true, true), [true, true], "however many draws come first");

        // A record of a build that was not forced goes when the content begins to skip.
        let mut page = Units::new();
        page.page(&[], None, None);
        host_frame(&mut page, &[], false, false);
        assert!(!page.retain.records.contains_key(&3) && !page.retain.records.contains_key(&4));
        assert_eq!(host_frame(&mut page, &[], true, true), [false, false]);
    }

    #[test]
    fn what_changes_under_content_a_frame_skips_is_not_replayed_when_a_read_forces_it() {
        let mut page = Units::new();
        host_frame(&mut page, &[], true, true);
        // The pointer moves onto 3 in the frame that begins to skip the content.
        host_frame(&mut page, &[3], false, false);
        assert!(!page.retain.records.contains_key(&3), "it changed");
        assert!(page.retain.records.contains_key(&4), "and 4 did not");
        assert_eq!(host_frame(&mut page, &[3], true, true), [false, true]);

        // It moves onto 4 in a frame after that skipped the content.
        host_frame(&mut page, &[3], false, false);
        assert!(page.retain.records.contains_key(&3) && page.retain.records.contains_key(&4));
        host_frame(&mut page, &[4], false, false);
        assert!(!page.retain.records.contains_key(&3) && !page.retain.records.contains_key(&4), "3 is no longer hovered, and 4 is");
        assert!(page.retain.records.contains_key(&2), "the host is built by every frame");
        assert_eq!(host_frame(&mut page, &[4], true, true), [false, false]);
    }

    #[test]
    fn a_custom_element_the_build_made_is_not_a_change_in_the_frame_after() {
        let mut page = Units::new();
        page.page(&[], None, None);
        // The registry did not hold 3 when that frame began, and the build made it.
        page.frame(&[], false, |page| page.retain.custom_built(3, Some(9)));
        page.customs = vec![(3, Some(9))];
        page.page(&[], None, None);
        assert!(!page.retain.deltas.spine.contains(&3), "{:?}", page.retain.deltas.spine);
        // One that paints on to another state is.
        page.customs = vec![(3, Some(10))];
        page.page(&[], None, None);
        assert!(page.retain.deltas.spine.contains(&3));
    }

    #[test]
    fn a_scroller_first_found_at_its_origin_is_not_scrolled() {
        let mut page = Units::new();
        page.pass(&[], true, None, None);
        page.scrolls.insert(2, gpui::ScrollHandle::new());
        page.pass(&[], true, None, None);
        assert!(!page.retain.deltas.scrolled.contains(&2));
        assert!(!page.retain.deltas.spine.contains(&2), "{:?}", page.retain.deltas.spine);
        assert!(page.retain.seen.scrolls.contains_key(&2), "the frame after compares with it");
        // It moves, and is scrolled.
        page.scrolls[&2].set_offset(gpui::point(gpui::px(0.0), gpui::px(-40.0)));
        page.pass(&[], true, None, None);
        assert!(page.retain.deltas.scrolled.contains(&2));
        // One that is first found away from its origin is scrolled.
        let moved = gpui::ScrollHandle::new();
        moved.set_offset(gpui::point(gpui::px(0.0), gpui::px(-40.0)));
        page.scrolls.insert(5, moved);
        page.pass(&[], true, None, None);
        assert!(page.retain.deltas.scrolled.contains(&5));

        // A frame that paints finds them the same: at the origin is not a change, away from it is.
        page.scrolls.insert(3, gpui::ScrollHandle::new());
        let moved = gpui::ScrollHandle::new();
        moved.set_offset(gpui::point(gpui::px(-8.0), gpui::px(0.0)));
        page.scrolls.insert(6, moved);
        page.page(&[], None, None);
        assert!(!page.retain.deltas.scrolled.contains(&3));
        assert!(!page.retain.deltas.spine.contains(&3), "{:?}", page.retain.deltas.spine);
        assert!(page.retain.deltas.scrolled.contains(&6));
        page.scrolls[&3].set_offset(gpui::point(gpui::px(0.0), gpui::px(-40.0)));
        page.page(&[], None, None);
        assert!(page.retain.deltas.scrolled.contains(&3), "its first scroll is the change");
    }

    #[test]
    fn a_tick_that_only_runs_the_animation_of_a_unit_previews_that_unit() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        assert_eq!(page.ids(), Vec::<u64>::new(), "an element is a unit once a build found it running");
        page.page(&[], Some(true), None);
        assert_eq!(page.ids(), vec![2]);
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
        let (unbuilt, seen) = (sorted(&page.retain.unbuilt), page.retain.seen.hovered.clone());
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a preview takes nothing from the next one");
        assert_eq!((sorted(&page.retain.unbuilt), page.retain.seen.hovered.clone()), (unbuilt, seen));
        // The frame that follows finds what the preview found.
        page.page(&[], Some(true), None);
        assert_eq!(page.ids(), vec![2]);
    }

    #[test]
    fn a_unit_whose_animation_ended_in_the_last_frame_is_not_patched() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        // The frame that finds the animation over is still built as the unit the frame before
        // found, and a source goes on saying that the element runs something (an SVG shape with
        // an animation that holds its end value does): the next frame builds it as no unit.
        page.page(&[], None, None);
        assert_eq!(page.ids(), vec![2]);
        let mut sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
        sources.motion = vec![2];
        assert_eq!(page.retain.preview(&sources, false, false), Err(Unpatchable::Ended(2)));
        page.page(&[], None, None);
        assert_eq!(page.ids(), Vec::<u64>::new());
    }

    #[test]
    fn a_unit_is_the_outermost_element_that_runs_something_that_only_paints() {
        let mut page = Units::new();
        page.page(&[], Some(true), Some(true));
        page.page(&[], Some(true), Some(true));
        assert_eq!(page.ids(), vec![2], "the element inside it is part of it");
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
    }

    #[test]
    fn an_element_whose_animation_moves_what_it_lays_out_is_not_a_unit() {
        let mut page = Units::new();
        page.page(&[], Some(false), None);
        page.page(&[], Some(false), None);
        assert_eq!(page.ids(), Vec::<u64>::new());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)));
        // One inside the one that lays out is the unit.
        page.edit(4);
        page.page(&[], Some(false), Some(true));
        page.page(&[], Some(false), Some(true));
        assert_eq!(page.ids(), vec![4]);
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)));
    }

    #[test]
    fn an_element_with_more_elements_than_a_unit_may_hold_is_not_one() {
        let mut page = Units::new();
        let big = |page: &mut Units| {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |page| {
                        for id in 100..100 + UNIT_MAX_ELEMENTS as u64 {
                            page.leaf(id);
                        }
                    });
                });
            });
        };
        crate::perf_counters::reset();
        big(&mut page);
        big(&mut page);
        assert_eq!(page.ids(), Vec::<u64>::new());
        assert_eq!(crate::perf_counters::snapshot().units_oversized, 1);
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::TooLarge)));
    }

    #[test]
    fn what_a_patch_could_not_repeat_makes_what_holds_it_no_unit() {
        let holds: [(&str, fn(&mut Retain), Refusal); 4] = [
            ("an exclusion", |retain| retain.exclude(Exclusion::Scroller), Refusal::ExcludedBelow(Exclusion::Scroller)),
            ("a scroll", |retain| retain.scroll(gpui::point(gpui::px(0.0), gpui::px(-4.0))), Refusal::Scrolls),
            ("a lifted element", |retain| retain.stacking(|| (Some(1), false)), Refusal::Lifts),
            ("an absolute box against a parent outside", |retain| retain.containing_block(false, true), Refusal::Escapes),
        ];
        for (what, note, refusal) in holds {
            let mut page = Units::new();
            page.page(&[], Some(true), None);
            let mut unit = None;
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    unit = page.element(2, Some(true), |page| {
                        // Nothing it holds is handed to a stacking context of its own.
                        page.retain.stacking(|| (None, false));
                        page.leaf(3);
                        page.element(4, None, |page| note(&mut page.retain));
                    });
                    page.leaf(5);
                });
            });
            assert_eq!(unit, Some(false), "{what}: begun as a unit, and not one when it was built");
            assert_eq!(page.ids(), Vec::<u64>::new(), "{what}");
            assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(refusal)), "{what}: the tick says why");
        }
        // The same page without any of them has its unit.
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        assert_eq!(page.ids(), vec![2]);
    }

    #[test]
    fn an_excluded_element_is_no_unit_and_a_tick_says_why() {
        let mut page = Units::new();
        for _ in 0..2 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |page| page.retain.exclude(Exclusion::AtomicInline));
                });
            });
        }
        assert_eq!(page.ids(), Vec::<u64>::new());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::Excluded(Exclusion::AtomicInline))));
    }

    #[test]
    fn an_absolute_element_is_a_unit_and_so_is_one_that_holds_the_box_it_is_a_containing_block_of() {
        // Absolute against a block outside it, with an absolute box of its own inside.
        let mut page = Units::new();
        for _ in 0..2 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |page| {
                        page.retain.containing_block(true, true);
                        page.element(3, None, |page| page.retain.containing_block(false, true));
                    });
                });
            });
        }
        assert_eq!(page.ids(), vec![2]);
        assert!(page.preview(&[], false).is_ok());
        // The page does not skip it: gpui builds an absolute box whole in every frame, as it
        // keeps no recording of what a box outside places.
        assert!(!page.retain.records.get(&2).unwrap().eligible);
        assert!(page.retain.records.get(&2).unwrap().unit_eligible);
    }

    #[test]
    fn an_element_that_is_not_positioned_is_no_unit_when_an_absolute_box_in_it_is_against_a_block_outside() {
        let mut page = Units::new();
        for _ in 0..2 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |page| {
                        page.retain.containing_block(false, false);
                        page.element(3, None, |page| page.retain.containing_block(false, true));
                    });
                });
            });
        }
        assert_eq!(page.ids(), Vec::<u64>::new());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::Escapes)));
    }

    #[test]
    fn an_absolute_element_whose_animation_moves_a_box_is_refused_as_a_layout_animation() {
        let mut page = Units::new();
        for _ in 0..2 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(false), |page| page.retain.containing_block(false, true));
                });
            });
        }
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)));
    }

    #[test]
    fn a_refusal_is_counted_under_a_key_that_names_it() {
        let keys: Vec<String> = [
            Refusal::Excluded(Exclusion::AtomicInline),
            Refusal::ExcludedBelow(Exclusion::Svg),
            Refusal::Escapes,
            Refusal::Lifts,
            Refusal::Scrolls,
            Refusal::LayoutAnimation,
            Refusal::TooLarge,
        ]
        .map(Refusal::key)
        .to_vec();
        assert_eq!(
            keys,
            ["Excluded:atomic-inline", "ExcludedBelow:svg", "Escapes", "Lifts", "Scrolls", "LayoutAnimation", "TooLarge"]
        );
    }

    impl Units {
        /// The page with 2 a table with collapsed borders, which 3 (a row) and 4 are the parts of; `row` is
        /// what runs on the row, `cell` what 4 notes (an exclusion, for instance).
        fn table(&mut self, row: Option<bool>, cell: impl Fn(&mut Retain)) {
            self.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, None, |page| {
                        page.retain.collapsed_table();
                        page.inherited.table.collapse = true;
                        page.element(3, row, |_| {});
                        page.element(4, None, |page| cell(&mut page.retain));
                        page.inherited.table.collapse = false;
                    });
                    page.leaf(5);
                });
            });
        }
    }

    impl Units {
        /// The frame of a page in which 2 is a virtual list (beside 5, or inside it when `nested`), and
        /// the shape its rows are keyed with.
        fn list_frame(&mut self, nested: bool) -> u64 {
            let mut shape = 0;
            self.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    let mut list = |page: &mut Units| {
                        page.element(2, None, |page| {
                            page.retain.exclude(Exclusion::VirtualList);
                            shape = page.retain.current_shape();
                        });
                    };
                    if nested {
                        page.element(5, None, list);
                    } else {
                        list(page);
                        page.leaf(5);
                    }
                });
            });
            shape
        }

        /// Builds the row `id` of the list the way `GpuixView::build_virtual_child` does, after the page's
        /// session closed: in one of its own. Nothing if the row was skipped, otherwise whether gpui is
        /// to record what was built.
        fn row(&mut self, list_shape: u64, id: u64, inside: impl FnOnce(&mut Self)) -> Option<bool> {
            self.retain.begin_row(list_shape, id);
            let recorded = if self.enter(id) {
                None
            } else {
                inside(self);
                Some(self.retain.exit().is_some())
            };
            self.retain.finish_row();
            recorded
        }
    }

    #[test]
    fn a_row_whose_revision_did_not_change_is_skipped_by_its_own_session() {
        let mut page = Units::new();
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), Some(true), "the first build of a row is recorded");
        assert_eq!(page.row(shape, 4, |_| {}), Some(true));
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), None);
        assert_eq!(page.row(shape, 4, |_| {}), None);
        assert!(page.retain.nodes[0].skipped.is_some());
    }

    #[test]
    fn a_changed_row_is_built_and_recorded_while_its_siblings_are_skipped() {
        let mut page = Units::new();
        let shape = page.list_frame(false);
        page.row(shape, 3, |_| {});
        page.row(shape, 4, |_| {});
        page.edit(3);
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), Some(true), "built, and recorded for the frame after");
        assert_eq!(page.row(shape, 4, |_| {}), None);
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), None, "the record the row left is the one the next frame takes");
        assert_eq!(page.row(shape, 4, |_| {}), None);
    }

    #[test]
    fn a_row_key_changes_with_the_shape_of_the_list() {
        let mut page = Units::new();
        let beside = page.list_frame(false);
        page.row(beside, 3, |_| {});
        let inside = page.list_frame(true);
        assert_ne!(beside, inside);
        assert_eq!(page.row(inside, 3, |_| {}), Some(true), "the list moved in the document, and so did its row");
        let inside = page.list_frame(true);
        assert_eq!(page.row(inside, 3, |_| {}), None);
    }

    #[test]
    fn the_frame_shown_is_published_to_the_scroll_gate_while_it_is_a_whole_recorded_one() {
        let mut page = Units::new();
        fn page_shown(page: &Units) -> Option<u64> {
            page.retain.shown.get()
        }
        assert_eq!(page_shown(&page), None, "nothing is shown before a frame");
        page.frame(&[], false, |page| {
            page.element(1, None, |_| {});
        });
        assert_eq!(page_shown(&page), Some(page.retain.plan.revision), "a recorded frame is the one a scroll is classified against");
        page.frame(&[], true, |_| {});
        assert_eq!(page_shown(&page), None, "a pass that only lays out takes the changes the frame shown has not seen");
        page.frame(&[], false, |page| {
            page.element(1, None, |_| {});
        });
        assert!(page_shown(&page).is_some());
        page.retain.set_planning(false);
        assert_eq!(page_shown(&page), None, "a retention that does not plan records no frame");
    }

    #[test]
    fn row_sessions_do_not_touch_summary_plan_or_the_dynamic_entries_of_other_elements() {
        let mut page = Units::new();
        let mut shape = 0;
        page.frame(&[], false, |page| {
            page.element(1, None, |page| {
                page.element(2, None, |page| {
                    page.retain.exclude(Exclusion::VirtualList);
                    shape = page.retain.current_shape();
                });
                page.element(5, Some(true), |_| {});
            });
        });
        let summary = page.retain.summary.clone();
        assert_eq!(page.retain.dynamic.get(&5), Some(&(Dynamic::Animation as u8)));
        assert!(!page.retain.plan.unsteady);
        // Only a page's session says a frame was recorded.
        page.retain.plan.recorded = false;

        let animating = |page: &mut Units| page.retain.dynamic(Dynamic::Animation);
        let svg = |page: &mut Units| page.retain.exclude(Exclusion::Svg);
        assert_eq!(page.row(shape, 3, animating), Some(false), "a row with something running is not recorded");
        assert_eq!(page.row(shape, 4, svg), Some(false), "an excluded row is not recorded either");
        assert_eq!(page.retain.summary, summary);
        assert!(!page.retain.plan.recorded);
        assert!(!page.retain.plan.unsteady, "a row that varies with time does not make the frame unsteady");
        assert_eq!(page.retain.dynamic.get(&5), Some(&(Dynamic::Animation as u8)), "the page's entry survives the rows");
        assert_eq!(page.retain.dynamic.get(&3), Some(&(Dynamic::Animation as u8)), "and the row's is kept for the frames that follow");
    }

    #[test]
    fn a_row_the_list_stopped_asking_for_takes_the_records_of_its_whole_subtree_with_it() {
        let mut page = Units::new();
        // The rows 3 and 4, and under 3 a root (6, with 7 in it) that a build of the row can skip.
        page.tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "div", None),
            (3, Some(2), "div", None),
            (4, Some(2), "div", None),
            (6, Some(3), "div", None),
            (7, Some(6), "div", None),
            (8, Some(7), "div", None),
        ]);
        let nested = |page: &mut Units| {
            page.element(6, None, |page| page.leaf(7));
        };
        let shape = page.list_frame(false);
        page.row(shape, 3, nested);
        page.row(shape, 4, |_| {});
        // 8 is built late by gpui, after the row's session: no build of the row lists it.
        page.retain.begin_deferred(false, false);
        page.leaf(8);
        page.retain.finish_deferred();
        for frame in 0..3 {
            // The row is restyled, so it is built and 6 is skipped: a list of what the build made leaves 6 out.
            page.edit(3);
            let shape = page.list_frame(false);
            page.row(shape, 3, |page| {
                if frame == 0 {
                    nested(page);
                } else {
                    assert!(page.element(6, None, |_| {}).is_none(), "6 is skipped");
                }
            });
            page.row(shape, 4, |_| {});
        }
        assert!(page.retain.records.contains_key(&3) && page.retain.records.contains_key(&6));
        assert!(page.retain.records.contains_key(&7) && page.retain.records.contains_key(&8));

        // The list scrolls: the first frame asks for 4 and not for 3, and the sweep of the frame after
        // (it compares the rows the frame before last asked for, 3 and 4, with those the last one did, 4) drops 3.
        let shape = page.list_frame(false);
        page.row(shape, 4, |_| {});
        let shape = page.list_frame(false);
        page.row(shape, 4, |_| {});
        for id in [3, 6, 7, 8] {
            assert!(!page.retain.records.contains_key(&id), "{id} belongs to a row nobody asks for");
        }
        assert!(page.retain.records.contains_key(&4));

        // The dynamic entries are the page session's to drop in a frame that records, so the sweep is
        // called by itself, as a rest frame (no page session) leaves it: 7 has an entry from the row's build.
        page.retain.dynamic.insert(7, Dynamic::Animation as u8);
        page.retain.dynamic.insert(4, Dynamic::Animation as u8);
        page.retain.rows_before = [3, 4].into_iter().collect();
        page.retain.rows_seen = [4].into_iter().collect();
        page.retain.forget_unseen_rows(&page.tree);
        assert!(!page.retain.dynamic.contains_key(&7), "an element of the unseen row's subtree");
        assert!(page.retain.dynamic.contains_key(&4), "a row the list still asks for");
    }

    #[test]
    fn a_row_a_frame_that_moved_the_rows_took_out_leaves_no_record_and_no_patch_root_and_the_others_keep_theirs() {
        let mut page = Units::new();
        page.tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "div", None),
            (3, Some(2), "div", None),
            (4, Some(2), "div", None),
            (6, Some(3), "div", None),
            (7, Some(4), "div", None),
        ]);
        let shape = page.list_frame(false);
        page.row(shape, 3, |page| page.leaf(6));
        page.row(shape, 4, |page| page.leaf(7));
        for id in [3, 4] {
            let env = crate::renderer::FrameEnv::for_test(page.inherited.clone(), EnterKey(Key::default()), web_time::Instant::now());
            page.retain.add_patch_root(Unit { id, env });
        }
        page.retain.dynamic.insert(6, Dynamic::Animation as u8);
        assert!(page.retain.rows_seen.contains(&3));

        page.retain.forget_left_rows(&[3], &page.tree);
        for id in [3, 6] {
            assert!(!page.retain.records.contains_key(&id), "{id} is of the row that left");
        }
        assert!(!page.retain.dynamic.contains_key(&6));
        assert!(!page.retain.rows_seen.contains(&3));
        assert!(!page.retain.is_patch_root(3) && page.retain.unit(3).is_none());
        assert!(page.retain.records.contains_key(&4) && page.retain.records.contains_key(&7));
        assert!(page.retain.is_patch_root(4) && page.retain.unit(4).is_some());
    }

    #[test]
    fn the_sweep_of_unseen_rows_stops_at_a_nested_list_and_still_takes_the_inner_rows_it_asked_for() {
        // 3 is an outer row holding the list 6; 7 is a row of 6 with 8 in it, 9 a row the list never asked for.
        let tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "virtual-list", None),
            (3, Some(2), "div", None),
            (4, Some(2), "div", None),
            (5, Some(3), "div", None),
            (6, Some(3), "virtual-list", None),
            (7, Some(6), "div", None),
            (8, Some(7), "div", None),
            (9, Some(6), "div", None),
        ]);
        let set = |ids: &[u64]| ids.iter().copied().collect::<FxHashSet<u64>>();
        let mut visited = Vec::new();
        for_each_unseen_element(&set(&[3, 4]), &set(&[4]), &tree, |id| visited.push(id));
        visited.sort_unstable();
        assert_eq!(visited, [3, 5, 6], "the inner list is visited, its rows are not");

        visited.clear();
        for_each_unseen_element(&set(&[3, 7]), &set(&[4]), &tree, |id| visited.push(id));
        visited.sort_unstable();
        assert_eq!(visited, [3, 5, 6, 7, 8], "an inner row the list asked for is swept as a row, with its subtree");
    }

    #[test]
    fn the_page_session_of_the_next_frame_drops_what_a_row_had_running() {
        let mut page = Units::new();
        let shape = page.list_frame(false);
        page.row(shape, 3, |page| {
            page.retain.dynamic(Dynamic::Animation);
            page.leaf(5);
        });
        assert_eq!(page.retain.dynamic.get(&3), Some(&(Dynamic::Animation as u8)), "there for the deltas of the next frame");
        // The page's session closes before any row of the frame is built and has not built the row's
        // elements, so it forgets them (`forget_unbuilt_dynamic`): the row is built again by the frame
        // that asks for it, whether or not the list does.
        page.list_frame(false);
        assert!(!page.retain.dynamic.contains_key(&3));
        assert!(!page.retain.records.contains_key(&3));
    }

    #[test]
    fn a_row_the_list_stopped_asking_for_is_built_when_it_comes_back() {
        // Its box is gone while the list does not lay it out, and a record kept would have it skipped
        // as a root that cannot be put elsewhere: gpui builds that late and records it without the
        // handles a relocatable root has, and a replay of that is not what a build of the frame makes.
        let mut page = Units::new();
        let shape = page.list_frame(false);
        page.row(shape, 3, |_| {});
        page.row(shape, 4, |_| {});
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), None);
        assert_eq!(page.row(shape, 4, |_| {}), None);
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 4, |_| {}), None);
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), Some(true), "built, and recorded for the frame after");
        assert_eq!(page.row(shape, 4, |_| {}), None);
        let shape = page.list_frame(false);
        assert_eq!(page.row(shape, 3, |_| {}), None);
    }

    /// The row 3 of a list, built in a session of its own inside `scroller` with the `lift_z` the renderer
    /// decided for its root (a child of the row lifts one more, `child_lifted`), and what the frame after
    /// skips it with.
    fn row_skip(page: &mut Units, scroller: Scroller, lift_z: Option<i32>, child_lifted: bool) -> Skip {
        for _ in 0..2 {
            let shape = page.list_frame(false);
            page.retain.begin_row(shape, 3);
            let skip = page.enter_in(3, Some(scroller));
            if skip.is_none() {
                page.retain.stacking(|| (lift_z, true));
                page.leaf(4);
                if child_lifted {
                    assert!(!page.enter(5));
                    page.retain.stacking(|| (Some(1), false));
                    page.retain.exit();
                }
                page.retain.exit();
            }
            page.retain.finish_row();
            if let Some(skip) = skip {
                return skip;
            }
        }
        unreachable!("the second frame found the row unchanged")
    }

    #[test]
    fn a_row_root_that_does_not_lift_is_relocatable_whatever_is_lifted_inside_its_context() {
        let window = gpui::WindowId::from(4);
        let list = Scroller { window, viewport: gpui::size(gpui::px(900.0), gpui::px(780.0)), overscan: gpui::px(390.0) };
        crate::automation::set_bounds(window, 3, crate::automation::ElementBounds::plain(0.0, 0.0, 100.0, 100.0));
        // `None` is what the renderer decides for the root of a row: the list's lift barrier takes its own
        // position. A row is a stacking context, so the absolute children of a mailbox row stay in it.
        let skip = row_skip(&mut Units::new(), list, None, true);
        assert_eq!(skip.lift_z, None);
        assert_eq!(skip.overscan, Some(gpui::px(390.0)));
        // A root that lifts is a hole in gpui's recording and cannot be put elsewhere.
        let skip = row_skip(&mut Units::new(), list, Some(0), true);
        assert_eq!(skip.lift_z, Some(0));
        assert_eq!(skip.overscan, None);
    }

    #[test]
    fn a_root_that_is_no_row_keeps_its_lift_and_is_not_relocatable() {
        let window = gpui::WindowId::from(5);
        let scroller = Scroller { window, viewport: gpui::size(gpui::px(900.0), gpui::px(780.0)), overscan: gpui::px(390.0) };
        crate::automation::set_bounds(window, 2, crate::automation::ElementBounds::plain(0.0, 0.0, 100.0, 100.0));
        let root_skip = |lift_z: Option<i32>| {
            let mut page = Units::new();
            for _ in 0..2 {
                let mut skip = None;
                page.edit(1);
                page.frame(&[], false, |page| {
                    page.element(1, None, |page| {
                        skip = page.enter_in(2, Some(scroller));
                        if skip.is_none() {
                            page.retain.stacking(|| (lift_z, false));
                            page.leaf(3);
                            page.retain.exit();
                        }
                    });
                });
                if let Some(skip) = skip {
                    return skip;
                }
            }
            unreachable!("the second frame found the root unchanged")
        };
        let lifting = root_skip(Some(0));
        assert_eq!(lifting.lift_z, Some(0));
        assert_eq!(lifting.overscan, None);
        assert_eq!(root_skip(None).overscan, Some(gpui::px(390.0)));
    }

    #[test]
    fn begin_unit_is_refused_in_a_row() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        page.frame(&[], false, |page| {
            page.element(1, None, |page| {
                assert!(page.element(2, Some(true), |_| {}).is_some(), "an element of the page is begun as a unit");
            });
        });
        page.retain.begin_row(0, 2);
        assert!(!page.enter(2));
        assert!(page.retain.begin_unit(true).is_none(), "a tick builds a unit, and no tick builds a row");
        page.retain.exit();
        page.retain.finish_row();
    }

    #[test]
    fn a_table_with_collapsed_borders_is_the_unit_of_the_paint_only_animation_of_its_parts() {
        let mut page = Units::new();
        page.table(Some(true), |_| {});
        assert_eq!(page.ids(), Vec::<u64>::new(), "a unit is made once a build found something running");
        page.table(Some(true), |_| {});
        assert_eq!(page.ids(), vec![2], "the table, not the row that runs it");
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
        page.table(Some(true), |_| {});
        assert_eq!(page.ids(), vec![2]);

        // The frame that finds it over is still built as the unit, and the one after as none.
        page.table(None, |_| {});
        assert_eq!(page.ids(), vec![2]);
        page.table(None, |_| {});
        assert_eq!(page.ids(), Vec::<u64>::new(), "nothing runs in the table any more");
    }

    #[test]
    fn a_table_with_collapsed_borders_is_no_unit_when_a_part_moves_what_it_lays_out() {
        let mut page = Units::new();
        page.table(Some(false), |_| {});
        page.table(Some(false), |_| {});
        assert_eq!(page.ids(), Vec::<u64>::new());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)));
    }

    #[test]
    fn a_table_with_collapsed_borders_is_no_unit_when_a_part_is_excluded_for_another_reason() {
        for (what, exclude) in [("a scroller", Exclusion::Scroller), ("a code block", Exclusion::CustomElement)] {
            let mut page = Units::new();
            page.table(Some(true), |retain| retain.exclude(exclude));
            page.table(Some(true), |retain| retain.exclude(exclude));
            assert_eq!(page.ids(), Vec::<u64>::new(), "{what} in a part");
        }
        // The parts of the table are no reason for the elements around it to be retained.
        let mut page = Units::new();
        page.table(None, |_| {});
        assert_eq!(page.retain.records.get(&2).map(|record| record.eligible), Some(false));
        assert_eq!(page.retain.records.get(&1).map(|record| record.eligible), Some(false));
    }

    #[test]
    fn a_lifted_element_is_a_unit_unless_it_lifts_what_is_in_it_out_with_it() {
        // (the element forms a stacking context, something in it is lifted, whether it is a unit)
        let cases = [
            (true, false, true),
            (false, false, true),
            (true, true, true),
            (false, true, false),
        ];
        for (forms_context, child_lifted, is_unit) in cases {
            let mut page = Units::new();
            let mut unit = None;
            for _ in 0..3 {
                page.frame(&[], false, |page| {
                    page.element(1, None, |page| {
                        unit = page.element(2, Some(true), |page| {
                            page.retain.stacking(|| (Some(0), forms_context));
                            page.element(4, None, |page| {
                                if child_lifted {
                                    page.retain.stacking(|| (Some(1), false));
                                }
                            });
                        });
                    });
                });
            }
            let expected = is_unit.then_some(2);
            assert_eq!(page.ids().first().copied(), expected, "context {forms_context}, lifted child {child_lifted}");
            assert_eq!(unit, Some(is_unit), "context {forms_context}, lifted child {child_lifted}");
        }
    }

    #[test]
    fn nothing_inside_a_unit_is_skipped() {
        let mut page = Units::new();
        // Frame by frame: the first records, the second sees 3 and 4 unchanged and 2 running.
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        page.frame(&[], false, |page| {
            page.element(1, None, |page| {
                assert!(!page.enter(2));
                assert!(page.retain.begin_unit(true).is_some());
                page.retain.dynamic(Dynamic::Animation);
                page.retain.paints_only(true);
                assert!(!page.enter(3), "3 is unchanged and would be skipped outside a unit");
                page.retain.exit();
                assert!(page.retain.end_unit().is_some());
                page.retain.exit();
            });
        });
        page.frame(&[], false, |page| {
            page.element(1, None, |page| {
                assert!(!page.enter(2));
                page.retain.dynamic(Dynamic::Animation);
                page.retain.paints_only(true);
                assert!(page.enter(3), "the same 3 is skipped when 2 is not a unit");
                page.retain.exit();
            });
        });
    }

    #[test]
    fn a_tick_that_changes_more_than_time_is_not_previewed() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        assert_eq!(page.preview(&[], true), Err(Unpatchable::ScrollAnimation));
        page.tree.set_text(3, "words".to_owned());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Edited));
    }

    #[test]
    fn a_restyle_in_a_row_the_frame_does_not_hold_needs_no_unit_and_one_in_a_row_it_holds_with_no_root_is_a_commit() {
        let mut page = Units::new();
        page.tree = tree_of(&[
            (1, None, "div", None),
            (2, Some(1), "virtual-list", None),
            (3, Some(2), "div", None),
            (4, Some(2), "div", None),
            (6, Some(3), "div", None),
            (7, Some(4), "div", None),
        ]);
        page.tree.set_commit_patching(true);
        for id in [6, 7] {
            page.tree.set_style(id, restyled(r##"{"backgroundColor":"#111111"}"##));
        }
        let shape = page.list_frame(false);
        // The list builds the row 3 and not the row 4.
        page.row(shape, 3, |page| page.leaf(6));
        page.tree.take_dirty();
        page.tree.take_restyles();

        page.tree.set_style(7, restyled(r##"{"backgroundColor":"#222222"}"##));
        assert_eq!(page.tree.pending_restyles(), [7]);
        assert_eq!(page.preview(&[], false), Ok(vec![]), "a row that is not built has nothing to repaint, and is built with the new style when it comes in");

        page.tree.set_style(6, restyled(r##"{"backgroundColor":"#222222"}"##));
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Commit(6)), "a row that is built and no root holds is a frame built whole");

        let env = crate::renderer::FrameEnv::for_test(page.inherited.clone(), EnterKey(Key::default()), web_time::Instant::now());
        page.retain.add_patch_root(Unit { id: 3, env });
        assert_eq!(page.preview(&[], false), Ok(vec![3]), "the root of the row that is built is repainted, the one that is not needs no unit");

        page.retain.forget_left_rows(&[3], &page.tree);
        assert_eq!(page.preview(&[], false), Ok(vec![]), "a row that left the frame is not one that is built");
    }

    fn restyled(json: &str) -> Arc<crate::style::StyleDesc> {
        Arc::new(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn a_restyle_by_paint_is_no_edit_but_any_other_change_is_one_a_frame_built_whole_ends() {
        let mut page = Units::new();
        page.patch_roots = [2, 3].into_iter().collect();
        page.tree.set_commit_patching(true);
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#111111"}"##));
        page.tree.set_style(5, restyled(r##"{"backgroundColor":"#111111"}"##));
        assert_eq!(hover_page(&mut page, &[]), [Some(false), Some(true), Some(false)]);
        page.tree.take_dirty();
        assert_eq!(page.preview(&[], false), Ok(vec![]), "nothing changed");

        // A colour that stays visible: the revision moved, the barrier did not.
        let frame_revision = page.retain.plan.revision;
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#222222"}"##));
        assert_eq!(page.tree.take_dirty(), Dirty::PaintPatchable);
        assert!(page.tree.revision() > frame_revision);
        assert!(page.tree.patch_barrier() <= frame_revision);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "the root that holds 3 is repainted");

        // An element no root holds is a frame built whole, which visits the roots.
        page.tree.set_style(5, restyled(r##"{"backgroundColor":"#333333"}"##));
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Commit(5)));
        page.tree.take_restyles();
        assert_eq!(page.preview(&[], false), Ok(vec![]), "once a frame took what was restyled");

        // An opacity that crosses 1 changes what is painted in kind: no restyle a root repaints, though it only paints. It is
        // a change of the element that no anchor holds (this page has none), which a frame built whole draws.
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#222222","opacity":0.5}"##));
        assert_eq!(page.tree.take_dirty(), Dirty::Paint);
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Structure(3)));
        // And it stays one for the restyles after it, until a frame is built whole.
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#444444","opacity":0.5}"##));
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Structure(3)));
        hover_page(&mut page, &[]);
        assert_eq!(page.preview(&[], false), Ok(vec![]), "the frame built whole took what changed");

        // A text, a node or a prop is one too.
        page.tree.set_text(3, "words".to_owned());
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Structure(3)));
        // What no element is named for is a barrier: the tree is not the one the frame was built from.
        page.tree.set_universal_style(Some(restyled(r##"{"color":"#123456"}"##)));
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Edited));
    }

    #[test]
    fn a_restyle_is_not_classified_while_patching_is_off() {
        let mut page = Units::new();
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#111111"}"##));
        page.tree.take_dirty();
        page.tree.set_style(3, restyled(r##"{"backgroundColor":"#222222"}"##));
        assert_eq!(page.tree.take_dirty(), Dirty::Paint);
        assert!(page.tree.pending_restyles().is_empty());
        assert_eq!(page.tree.patch_barrier(), page.tree.revision() - 1);
    }

    #[test]
    fn a_frame_that_only_moves_the_rows_of_a_list_asks_for_the_sources_a_tick_asks_for() {
        let mut page = Units::new();
        page.page(&[], None, None);
        page.page(&[], None, None);
        assert!(!page.retain.sources_changed(&page.sources()), "nothing but time and the scroll of a list differs");

        // The pointer is the classifier's: a hover chain that moved is no source here.
        let moved = [3, 2, 1];
        let mut sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &moved, false);
        assert!(!page.retain.sources_changed(&sources));
        // What a tick treats as a source is one: a press, the focus, a selection, a measurement, a link, a command, a
        // relevance, a hover restyled by paint that no frame drew, a custom element, the scroll of a scroller.
        let pressed = [3];
        sources = page.sources();
        sources.active = &pressed;
        assert!(page.retain.sources_changed(&sources), "the active chain");
        sources = page.sources();
        sources.selection = 7;
        assert!(page.retain.sources_changed(&sources), "the selection");
        for (what, edit) in [
            ("a measurement", (|sources: &mut Sources| sources.measured = vec![3]) as fn(&mut Sources)),
            ("a link", |sources| sources.links = vec![3]),
            ("a command", |sources| sources.commanded = vec![3]),
            ("a relevance", |sources| sources.relevance = vec![3]),
            ("a hover restyled by paint", |sources| sources.hover_paint = vec![3]),
            ("a custom element", |sources| sources.customs = vec![(5, Some(1))]),
        ] {
            sources = page.sources();
            edit(&mut sources);
            assert!(page.retain.sources_changed(&sources), "{what}");
        }
        page.focus.within = Arc::from([5]);
        assert!(page.retain.sources_changed(&page.sources()), "the focus");
        page.focus.within = Arc::from([]);
        assert!(!page.retain.sources_changed(&page.sources()));
        page.scrolls.insert(2, gpui::ScrollHandle::new());
        page.scrolls[&2].set_offset(gpui::point(gpui::px(0.0), gpui::px(-40.0)));
        assert!(page.retain.sources_changed(&page.sources()), "a scroller that is no list scrolled");
    }

    #[test]
    fn the_sources_of_a_frame_that_was_never_built_are_a_change() {
        let page = Units::new();
        let sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
        assert!(page.retain.sources_changed(&sources));
    }

    /// The page with 1, 2 and 3 holding a hover that paints (3 declares it), whose roots a frame records.
    fn hover_page(page: &mut Units, hovered: &[u64]) -> [Option<bool>; 3] {
        let mut roots = [None; 3];
        page.frame(hovered, false, |page| {
            roots[0] = page.patch_root(1, |page| {
                roots[1] = page.patch_root(2, |page| {
                    roots[2] = page.patch_root(3, |_| {});
                    page.leaf(4);
                });
                page.leaf(5);
            });
        });
        roots
    }

    #[test]
    fn a_hover_that_only_paints_is_not_a_source_of_a_tick() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        hover_page(&mut page, &[]);
        hover_page(&mut page, &[]);
        assert_eq!(page.preview(&[3, 2, 1], false), Ok(vec![]), "the chain moved and nothing was restyled");
        assert_eq!(page.preview(&[], false), Ok(vec![]));
        page.focus.within = Arc::from([5]);
        assert_eq!(page.preview(&[3, 2, 1], false), Err(Unpatchable::Sourced), "the focus is a source");
    }

    #[test]
    fn the_outermost_root_that_holds_a_hover_is_the_hover_root_and_holds_what_is_in_it() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        let first = hover_page(&mut page, &[]);
        assert_eq!(first, [Some(true), Some(false), Some(false)], "what is below the root is built in it, recorded by nothing");
        assert_eq!(page.retain.plan.patch_root_ids, [1].into_iter().collect());
        for restyled in [vec![3], vec![3, 4], vec![5], vec![1]] {
            page.hover_paint = restyled;
            assert_eq!(page.preview(&[], false), Ok(vec![1]));
        }
    }

    #[test]
    fn a_tick_repaints_the_roots_that_hold_what_a_hover_restyled() {
        let mut page = Units::new();
        // 1 is too big to be a root (it is not asked for a hover), 2 and 5 hold a hover.
        page.patch_roots = [2, 3, 5].into_iter().collect();
        let first = hover_page(&mut page, &[]);
        assert_eq!(first, [Some(false), Some(true), Some(false)]);
        page.hover_paint = vec![3];
        assert_eq!(page.preview(&[3, 2, 1], false), Ok(vec![2]));
        page.hover_paint = vec![3, 4];
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
        // A frame that skips a root registers it if it holds a hover, and the roots in it are not visited:
        // here the page above 2 is skipped, and a hover in it is a frame built whole, which visits them.
        page.hover_paint.clear();
        let again = hover_page(&mut page, &[]);
        assert_eq!(again, [None, None, None], "the page is skipped");
        assert!(page.retain.plan.patch_root_ids.is_empty());
        page.hover_paint = vec![3];
        assert_eq!(page.preview(&[3, 2, 1], false), Err(Unpatchable::Hover(3)));
    }

    #[test]
    fn a_skipped_root_that_holds_a_hover_is_kept_as_one() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        hover_page(&mut page, &[]);
        page.hover_paint.clear();
        let again = hover_page(&mut page, &[]);
        assert_eq!(again, [None, None, None], "the page is skipped");
        assert_eq!(page.retain.plan.patch_root_ids, [1].into_iter().collect());
        page.hover_paint = vec![3];
        assert_eq!(page.preview(&[3, 2, 1], false), Ok(vec![1]));
    }

    #[test]
    fn an_element_no_root_holds_is_a_frame_built_whole() {
        let mut page = Units::new();
        page.patch_roots = [2, 3].into_iter().collect();
        hover_page(&mut page, &[]);
        page.hover_paint = vec![5];
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Hover(5)));
        page.hover_paint = vec![1];
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Hover(1)), "nor is the page");
        page.hover_paint = vec![3];
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
    }

    #[test]
    fn a_root_found_unfit_is_no_hover_root_and_blocks_the_roots_in_it_all_the_same() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        // Something runs in 3, so the root above it is built every frame and is no patch root.
        let mut inner = None;
        page.frame(&[], false, |page| {
            let outer = page.patch_root(1, |page| {
                inner = page.element(3, Some(true), |_| {});
                page.leaf(4);
            });
            assert_eq!(outer, Some(false));
        });
        assert_eq!(inner, None, "the element with the animation is no unit inside the root");
        assert!(page.retain.plan.patch_root_ids.is_empty());
        assert!(page.retain.records.get(&1).is_some_and(|record| !record.patch_root), "recorded as no patch root");
    }

    #[test]
    fn a_frame_built_whole_after_a_patch_builds_the_roots_the_patch_repainted() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        hover_page(&mut page, &[]);
        hover_page(&mut page, &[]);
        // A frame that finds nothing changed skips the roots: here 1.
        page.frame(&[], false, |page| assert!(page.enter(1), "the page is skipped"));
        // The pointer entered 3, and a patch drew it.
        page.hover_paint = vec![3];
        page.retain.hover_repainted(std::mem::take(&mut page.hover_paint));
        page.frame(&[3, 2, 1], false, |page| {
            assert!(!page.enter(1), "the root above an element a patch repainted is built");
            assert!(!page.enter(2));
            assert!(!page.enter(3));
            for id in [3, 2, 1] {
                page.retain.exit();
                let _ = id;
            }
        });
        page.frame(&[3, 2, 1], false, |page| assert!(page.enter(1), "and skipped again once built"));
    }

    #[test]
    fn a_frame_takes_what_the_hover_restyled_by_paint_before_it() {
        let mut page = Units::new();
        page.patch_roots = [1, 2, 3].into_iter().collect();
        hover_page(&mut page, &[]);
        hover_page(&mut page, &[]);
        page.hover_paint = vec![3];
        page.frame(&[3, 2, 1], false, |page| {
            assert!(!page.enter(1), "a hover that the frame has to draw is on its spine");
            assert!(!page.enter(2));
            assert!(!page.enter(3));
            for _ in 0..3 {
                page.retain.exit();
            }
        });
    }

    #[test]
    fn a_tick_after_a_pass_that_only_lays_out_is_not_previewed() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        page.pass(&[], true, Some(true), None);
        assert_eq!(page.preview(&[], false), Err(Unpatchable::LayoutPass));
        page.page(&[], Some(true), None);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a frame built whole gives a new start");
    }

    #[test]
    fn an_element_that_blinks_is_a_unit_unless_something_that_lays_out_runs_on_it_too() {
        for (runs, is_unit) in [(None, true), (Some(true), true), (Some(false), false)] {
            let mut page = Units::new();
            for _ in 0..3 {
                page.frame(&[], false, |page| {
                    page.element(1, None, |page| {
                        page.element(2, runs, |page| page.retain.blinks());
                        page.leaf(3);
                    });
                });
            }
            assert_eq!(page.ids(), if is_unit { vec![2] } else { Vec::new() }, "{runs:?}");
            let due = Sources { clock_due: &|_| true, ..sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false) };
            assert_eq!(
                page.retain.preview(&due, false, false),
                if is_unit { Ok(vec![2]) } else { Err(Unpatchable::Refused(Refusal::LayoutAnimation)) },
                "{runs:?}"
            );
        }
    }

    #[test]
    fn a_caret_is_touched_by_the_tick_of_its_phase_and_by_no_other() {
        let mut page = Units::new();
        for _ in 0..3 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, None, |page| page.retain.blinks());
                    page.element(4, Some(true), |_| {});
                });
            });
        }
        assert_eq!(page.ids(), vec![2, 4]);
        assert_eq!(page.preview(&[], false), Ok(vec![4]), "a tick of the animation leaves the caret as painted");
        let due = Sources { clock_due: &|id| id == 2, ..sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false) };
        assert_eq!(page.retain.preview(&due, false, false), Ok(vec![2, 4]), "the tick of the phase paints it too");
    }

    #[test]
    fn an_element_bound_to_a_value_is_touched_when_the_value_can_have_changed_and_not_otherwise() {
        let mut page = Units::new();
        for _ in 0..3 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, None, |page| {
                        page.retain.dynamic(Dynamic::MotionValues);
                        page.retain.paints_only(true);
                    });
                    page.element(4, Some(true), |_| {});
                });
            });
        }
        assert_eq!(page.ids(), vec![2, 4]);
        assert_eq!(page.preview(&[], false), Ok(vec![4]), "a value that rests leaves the element as it was painted");
        let due = Sources { clock_due: &|id| id == 2, ..sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false) };
        assert_eq!(page.retain.preview(&due, false, false), Ok(vec![2, 4]), "a value that moved or was written paints it again");
    }

    #[test]
    fn a_layout_bound_to_a_value_that_rests_is_no_reason_to_draw_the_tick_whole() {
        let mut page = Units::new();
        for _ in 0..3 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, None, |page| {
                        page.retain.dynamic(Dynamic::MotionValues);
                        page.retain.paints_only(false);
                    });
                    page.element(4, Some(true), |_| {});
                });
            });
        }
        assert_eq!(page.ids(), vec![4]);
        assert_eq!(page.preview(&[], false), Ok(vec![4]), "a width that rests moves no box");
        let due = Sources { clock_due: &|id| id == 2, ..sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false) };
        assert_eq!(page.retain.preview(&due, false, false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)), "a value that moves lays out");
    }

    #[test]
    fn a_caret_that_runs_beside_another_clock_is_touched_by_every_tick() {
        let mut page = Units::new();
        for _ in 0..3 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |page| page.retain.blinks());
                });
            });
        }
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
    }

    #[test]
    fn a_frame_that_built_what_follows_the_clock_outside_the_units_is_not_previewed() {
        let mut page = Units::new();
        let build = |page: &mut Units, varies: Exclusion| {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |_| {});
                    page.element(5, None, |page| page.retain.exclude(varies));
                });
            });
        };
        build(&mut page, Exclusion::Sticky);
        build(&mut page, Exclusion::Sticky);
        assert_eq!(page.ids(), vec![2]);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a sticky box follows the scroll, not the clock");
        build(&mut page, Exclusion::CustomElement);
        build(&mut page, Exclusion::CustomElement);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a code block is rebuilt by its frame, and paints the same in a tick");
        build(&mut page, Exclusion::VirtualList);
        build(&mut page, Exclusion::VirtualList);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a list is painted as its frame made it, a tick leaves it alone");
        for varies in [Exclusion::Highlight, Exclusion::Svg] {
            build(&mut page, varies);
            assert_eq!(page.preview(&[], false), Err(Unpatchable::Unsteady), "{varies:?}");
        }
        build(&mut page, Exclusion::LayoutAnimation);
        build(&mut page, Exclusion::LayoutAnimation);
        assert_eq!(page.ids(), vec![2]);
        assert_eq!(page.preview(&[], false), Ok(vec![2]), "a layout box with no glide running leaves a tick alone");
        let sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
        assert_eq!(page.retain.preview(&sources, false, true), Err(Unpatchable::Gliding), "a glide in flight is stepped by a frame");
    }

    #[test]
    fn a_page_with_a_loop_and_nothing_to_skip_is_recorded_at_every_frame() {
        let mut page = Units::new();
        for _ in 0..6 {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |_| {});
                    page.element(5, None, |page| page.retain.exclude(Exclusion::LayoutAnimation));
                });
            });
        }
        assert_eq!(page.retain.take_frame_log(), vec![true; 6], "a back-off forgets the records the next unit is chosen from");
        assert_eq!(page.ids(), vec![2]);
        assert_eq!(page.preview(&[], false), Ok(vec![2]));
    }

    #[test]
    fn an_element_that_runs_outside_the_units_blocks_the_tick_unless_nobody_sees_it() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        // 5 runs something that lays out.
        let both = |page: &mut Units| {
            page.frame(&[], false, |page| {
                page.element(1, None, |page| {
                    page.element(2, Some(true), |_| {});
                    page.element(5, Some(false), |_| {});
                });
            });
        };
        page.edit(5);
        both(&mut page);
        both(&mut page);
        assert_eq!(page.preview(&[], false), Err(Unpatchable::Refused(Refusal::LayoutAnimation)));
        let sources = Sources { dormant: &|id| id == 5, ..sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false) };
        assert_eq!(page.retain.preview(&sources, false, false), Ok(vec![2]), "dormant: the tick carries its clock without building it");
    }

    #[test]
    fn motion_on_an_element_that_has_no_box_does_not_block_a_tick() {
        let mut page = Units::new();
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        let motion_on_5 = |page: &Units| {
            let mut sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
            sources.motion = vec![5];
            page.retain.preview(&sources, false, false)
        };
        assert_eq!(motion_on_5(&page), Err(Unpatchable::Outside(5)), "a box that is drawn and runs something outside the unit");
        let none = serde_json::json!({"display": "none"});
        page.tree.set_style(5, std::sync::Arc::new(serde_json::from_value(none).expect("a style")));
        page.page(&[], Some(true), None);
        page.page(&[], Some(true), None);
        assert_eq!(motion_on_5(&page), Ok(vec![2]), "no frame builds or paints it");
    }

    /// A frame of the page in which 3 and 4 run something that paints, and `culled` says which
    /// of them the frame finds dormant. Gives the ids it was asked about and what moved.
    fn dormancy_frame(page: &mut Units, culled: &dyn Fn(u64) -> bool, verdicts: u64) -> (Vec<u64>, DormantMoves) {
        let asked = std::cell::RefCell::new(Vec::new());
        let ask = |id: u64| {
            asked.borrow_mut().push(id);
            culled(id)
        };
        let mut sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
        sources.dormant = &ask;
        sources.verdicts = verdicts;
        page.retain.begin_frame(sources);
        let moves = page.retain.take_dormant_moves();
        page.element(1, None, |page| {
            page.element(2, None, |page| {
                page.element(3, Some(true), |_| {});
                page.element(4, Some(true), |_| {});
            });
            page.leaf(5);
        });
        page.retain.finish_frame();
        let mut asked = asked.into_inner();
        asked.sort_unstable();
        (asked, moves)
    }

    #[test]
    fn a_dormant_element_is_asked_about_once_and_again_only_when_something_can_have_changed_the_answer() {
        let mut page = Units::new();
        let culled = |_: u64| true;
        // The first frame builds everything, and the elements that run something are asked about.
        dormancy_frame(&mut page, &culled, 0);
        let (asked, moves) = dormancy_frame(&mut page, &culled, 0);
        assert_eq!(asked, vec![3, 4]);
        assert_eq!((in_order(moves.entered), moves.left), (vec![3, 4], vec![]));
        assert!(page.retain.is_dormant(3) && page.retain.is_dormant(4));
        for _ in 0..3 {
            let (asked, moves) = dormancy_frame(&mut page, &culled, 0);
            assert_eq!(asked, Vec::<u64>::new(), "a frame in which nothing changed asks about no one");
            assert!(moves.entered.is_empty() && moves.left.is_empty());
        }

        // A build that reaches 4 (with the elements above it, as an edit does) wakes it for the frame after.
        for id in [1, 2, 4] {
            page.edit(id);
        }
        let (asked, _) = dormancy_frame(&mut page, &culled, 0);
        assert_eq!(asked, Vec::<u64>::new(), "the frame that builds it still sees what the frame before found");
        assert!(page.retain.is_dormant(4));
        let shown = |id: u64| id != 4;
        let (asked, moves) = dormancy_frame(&mut page, &shown, 0);
        assert_eq!(asked, vec![4], "only the element that was built is asked about");
        assert_eq!((moves.entered, moves.left), (vec![], vec![4]));
        assert!(page.retain.is_dormant(3) && !page.retain.is_dormant(4));

        // What the answers are read from moves with no build of an element: all that sleep are asked.
        let (asked, moves) = dormancy_frame(&mut page, &shown, 1);
        assert_eq!(asked, vec![3, 4], "4 runs something and is asked about in every frame, 3 is asked again");
        assert!(moves.entered.is_empty() && moves.left.is_empty());
        let none = |_: u64| false;
        let (asked, moves) = dormancy_frame(&mut page, &none, 2);
        assert_eq!(asked, vec![3, 4]);
        assert_eq!(moves.left, vec![3]);
        assert!(!page.retain.is_dormant(3));
        let (asked, _) = dormancy_frame(&mut page, &none, 2);
        assert_eq!(asked, vec![3, 4], "what runs on an element that is not dormant is asked about in every frame");
    }

    #[test]
    fn a_tick_with_nothing_to_repaint_is_drawn_whole_until_the_elements_are_dormant_and_is_empty_after() {
        let mut page = Units::new();
        let none = |_: u64| false;
        let culled = |_: u64| true;
        dormancy_frame(&mut page, &none, 0);
        dormancy_frame(&mut page, &none, 0);
        let preview = |page: &Units, dormant: &dyn Fn(u64) -> bool, verdicts: u64| {
            let mut sources = sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false);
            sources.dormant = dormant;
            sources.verdicts = verdicts;
            sources.motion = vec![3, 4];
            page.retain.preview(&sources, false, false)
        };
        assert_eq!(preview(&page, &culled, 0), Err(Unpatchable::Dormancy), "3 and 4 are to enter the dormant set, which a frame does");
        dormancy_frame(&mut page, &culled, 0);
        assert!(page.retain.is_dormant(3) && page.retain.is_dormant(4));
        assert_eq!(preview(&page, &culled, 0), Ok(vec![]), "they sleep: nothing to repaint, and nothing to settle");
        assert_eq!(preview(&page, &culled, 1), Err(Unpatchable::Dormancy), "the answers they sleep on moved");
    }

    fn in_order(mut ids: Vec<u64>) -> Vec<u64> {
        ids.sort_unstable();
        ids
    }

    #[test]
    fn dormant_elements_wake_when_retention_stops_and_when_they_are_destroyed() {
        let mut page = Units::new();
        let culled = |_: u64| true;
        dormancy_frame(&mut page, &culled, 0);
        dormancy_frame(&mut page, &culled, 0);
        assert!(page.retain.is_dormant(3) && page.retain.is_dormant(4));
        page.tree.destroy_element(4);
        page.retain.begin_frame(sources_of(&page.tree, &page.focus, &page.handles, &page.scrolls, &[], false));
        let moves = page.retain.take_dormant_moves();
        assert_eq!(moves.left, vec![4], "the clock of a destroyed element is let go");
        assert!(page.retain.is_dormant(3) && !page.retain.is_dormant(4));
        page.retain.finish_frame();
        page.retain.set_planning(false);
        assert!(!page.retain.is_dormant(3));
        assert_eq!(page.retain.take_dormant_moves().left, vec![3]);
    }

    const TINTED: &str = r#"{"height": 60, "animation": "tint 600ms linear infinite"}"#;

    /// A page whose second card runs a colour animation, drawn until its card is a unit.
    fn tinted(cx: &mut gpui::TestAppContext, verify: bool) -> Scene {
        let scene = Scene::new(cx, page([CARD, TINTED, CARD]));
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.retain.set_verify(verify);
                view.keyframes
                    .define("tint", r##"{"from": {"color": "#ff0000"}, "to": {"color": "#0000ff"}}"##)
                    .unwrap();
            })
            .unwrap();
        for _ in 0..6 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.notified_draw(cx);
        }
        scene
    }

    fn units_of(scene: &Scene, cx: &mut gpui::TestAppContext) -> Vec<u64> {
        scene
            .window
            .update(cx, |view, _, _| view.retain.units().iter().map(|unit| unit.id).collect())
            .unwrap()
    }

    #[gpui::test]
    fn a_card_that_runs_a_colour_is_a_unit_and_the_other_cards_are_not(cx: &mut gpui::TestAppContext) {
        crate::perf_counters::reset();
        let scene = tinted(cx, false);
        assert_eq!(units_of(&scene, cx), vec![20]);
        assert!(crate::perf_counters::snapshot().units_built >= 1);
        // What a frame could reuse is judged as it was without the unit: the lines of the card
        // are roots beside the cards that are still, though the unit builds them.
        assert_eq!(scene.roots(cx), vec![10, 21, 22, 23, 30]);
    }

    #[gpui::test]
    fn a_frame_built_whole_around_units_is_the_frame_it_was_without_them(cx: &mut gpui::TestAppContext) {
        // Every frame that replayed something is built again whole and compared with it.
        let scene = tinted(cx, true);
        assert_eq!(units_of(&scene, cx), vec![20]);
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
        scene.notified_draw(cx);
        scene.assert_sound(cx);
    }

    #[gpui::test]
    fn a_tick_of_a_colour_is_previewed_and_its_unit_built_alone(cx: &mut gpui::TestAppContext) {
        let scene = tinted(cx, false);
        let tapes = scene.window.update(cx, |view, _, _| view.tapes.clone()).unwrap();
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
        let (preview, built) = scene
            .window
            .update(cx, |view, window, cx| {
                let now = view.clock.now();
                let records = view.retain.record_counts();
                let preview = view.preview_tick(window, now);
                let built = view.build_unit(20, now, window, cx);
                assert!(view.build_unit(10, now, window, cx).is_none(), "10 is not a unit");
                assert_eq!(view.retain.record_counts(), records, "nothing of the frames is touched");
                assert_eq!(view.frame_instant, Some(now));
                (preview, built)
            })
            .unwrap();
        assert_eq!(preview, Ok(vec![20]));
        let built = built.expect("20 is a unit");
        assert_eq!(built.id, crate::renderer::retained_id(20));
        // It was not painted: it wrote nothing, while the frame wrote the boxes of the card.
        assert!(!tapes.same_as_recorded(20, &built.tape, gpui::Point::default()));
        // And the tick is still the same tick: nothing was taken by the preview or the build.
        assert_eq!(
            scene.window.update(cx, |view, window, _| view.preview_tick(window, view.clock.now())).unwrap(),
            Ok(vec![20])
        );
    }

    impl Scene {
        /// A frame that is a tick: the window is not told, the clock moved.
        fn tick(&self, cx: &mut gpui::TestAppContext) {
            cx.update_window(self.window.into(), |_, window, app| {
                window.request_tick();
                window.draw(app).clear(app);
            })
            .unwrap();
            self.assert_sound(cx);
        }

        fn patches(&self, cx: &mut gpui::TestAppContext) -> gpui::PatchCounters {
            cx.update_window(self.window.into(), |_, window, _| window.patch_counters()).unwrap()
        }
    }

    #[gpui::test]
    fn a_tick_of_a_colour_is_drawn_by_patching_the_frame_before(cx: &mut gpui::TestAppContext) {
        let scene = tinted(cx, true);
        let before = scene.patches(cx);
        for _ in 0..4 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.tick(cx);
        }
        let after = scene.patches(cx);
        assert_eq!(after.patched_frames - before.patched_frames, 4);
        assert_eq!(after.patched_units - before.patched_units, 4);
        assert_eq!(after.total_declines(), before.total_declines());
        // The frame a pointer or a commit asks for (the test app draws it as the notification flushes)
        // is built whole, and the ticks go on after it.
        scene.window.update(cx, |view, _, cx| {
            view.clock.fast_forward_ms(16.0);
            cx.notify();
        })
        .unwrap();
        assert_eq!(scene.patches(cx).patched_frames, after.patched_frames);
        for _ in 0..2 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.tick(cx);
        }
        assert_eq!(scene.patches(cx).patched_frames, after.patched_frames + 2);
    }

    /// A page whose `<svg>` (a unit once drawn) runs a shape animation, with `size` its box.
    fn spinning(cx: &mut gpui::TestAppContext, size: &'static str) -> Scene {
        spinning_as(cx, size, r#"{"animation": "grow 600ms linear infinite"}"#)
    }

    /// `spinning` with the style of the shape.
    fn spinning_as(cx: &mut gpui::TestAppContext, size: &'static str, style: &'static str) -> Scene {
        let mut elements = icon(size, None);
        elements.iter_mut().find(|element| element.id == 41).unwrap().style = style;
        let scene = Scene::new(cx, elements);
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.retain.set_verify(true);
                view.keyframes.define("grow", r#"{"from": {"r": 2}, "to": {"r": 10}}"#).unwrap();
            })
            .unwrap();
        for _ in 0..6 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.notified_draw(cx);
            cx.run_until_parked();
        }
        scene
    }

    #[gpui::test]
    fn an_svg_whose_shape_runs_an_animation_is_a_unit_and_its_ticks_are_patched(cx: &mut gpui::TestAppContext) {
        let scene = spinning(cx, SMALL_ICON);
        assert_eq!(units_of(&scene, cx), vec![40]);
        let before = scene.patches(cx);
        for _ in 0..4 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.tick(cx);
        }
        let after = scene.patches(cx);
        assert_eq!(after.patched_frames - before.patched_frames, 4);
        assert_eq!(after.total_declines(), before.total_declines());
    }

    #[gpui::test]
    fn the_tick_after_the_frame_that_found_a_shape_animation_over_is_built_whole(cx: &mut gpui::TestAppContext) {
        let scene = spinning_as(cx, SMALL_ICON, r#"{"animation": "grow 600ms linear forwards"}"#);
        assert_eq!(units_of(&scene, cx), vec![40]);
        // The frame that finds the animation over is still built as the unit the frame before found.
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(1000.0)).unwrap();
        cx.update_window(scene.window.into(), |_, window, app| {
            window.refresh();
            window.draw(app).clear(app);
        })
        .unwrap();
        assert_eq!(units_of(&scene, cx), vec![40]);
        // The shape holds its end value and is listed as animated, but the next frame built whole makes
        // no unit of the svg: a patch would repaint a root that frame does not have.
        let before = scene.patches(cx);
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
        scene.tick(cx);
        let after = scene.patches(cx);
        assert_eq!(after.patched_frames, before.patched_frames);
        assert_eq!(units_of(&scene, cx), Vec::<u64>::new());
    }

    #[gpui::test]
    fn an_svg_too_big_to_raster_at_rest_is_rasterised_in_paint_while_its_shape_runs_and_is_a_unit(cx: &mut gpui::TestAppContext) {
        let scene = spinning(cx, r#"{"width": 300, "height": 200}"#);
        assert_eq!(units_of(&scene, cx), vec![40]);
        let before = scene.patches(cx);
        for _ in 0..4 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.tick(cx);
            cx.run_until_parked();
        }
        let after = scene.patches(cx);
        assert_eq!(after.patched_frames - before.patched_frames, 4);
        assert_eq!(after.total_declines(), before.total_declines());
    }

    #[gpui::test]
    fn a_tick_declined_after_its_clocks_stepped_emits_each_event_once(cx: &mut gpui::TestAppContext) {
        let scene = tinted(cx, false);
        let seen = Arc::new(Mutex::new(Vec::new()));
        scene
            .window
            .update(cx, |view, _, _| {
                let seen = seen.clone();
                view.event_callback = Some(Arc::new(move |payload| seen.lock().unwrap().push(payload.event_type)));
            })
            .unwrap();
        scene.tree.lock().unwrap().set_event_listener(20, "animationiteration".to_owned(), true);
        let iterations = || seen.lock().unwrap().iter().filter(|event| *event == "animationiteration").count();
        // 600 ms loops, 96 ms in: a tick on each side of the end of the first iteration.
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(480.0)).unwrap();
        scene.notified_draw(cx);
        assert_eq!(iterations(), 0);
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(48.0)).unwrap();
        let built = scene
            .window
            .update(cx, |view, window, cx| view.build_patch(window, cx).map(|built| built.units.len()))
            .unwrap();
        assert_eq!(built, Some(1), "the tick was stepped and its unit built; gpui declines the patch");
        assert_eq!(iterations(), 1);
        scene.notified_draw(cx);
        assert_eq!(iterations(), 1, "the frame built whole in its place finds the iteration reported");
        scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
        scene.tick(cx);
        assert_eq!(iterations(), 1);
    }

    #[gpui::test]
    fn a_card_with_more_elements_than_a_unit_may_hold_is_built_as_before(cx: &mut gpui::TestAppContext) {
        let mut elements = page([CARD, TINTED, CARD]);
        for index in 0..UNIT_MAX_ELEMENTS as u64 {
            elements.push(div(1000 + index, Some(20), r#"{"height": 1}"#));
        }
        crate::perf_counters::reset();
        let scene = Scene::new(cx, elements);
        scene
            .window
            .update(cx, |view, _, _| {
                view.retain.set_planning(true);
                view.keyframes
                    .define("tint", r##"{"from": {"color": "#ff0000"}, "to": {"color": "#0000ff"}}"##)
                    .unwrap();
            })
            .unwrap();
        for _ in 0..6 {
            scene.window.update(cx, |view, _, _| view.clock.fast_forward_ms(16.0)).unwrap();
            scene.notified_draw(cx);
        }
        assert_eq!(units_of(&scene, cx), Vec::<u64>::new());
        assert!(crate::perf_counters::snapshot().units_oversized >= 1);
    }
}
