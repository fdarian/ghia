//! Scrollbars, painted the way macOS does, in either of its two styles.
//!
//! With "Show scroll bars" on Automatically or When scrolling (`ScrollerStyle::Overlay`), a scroll
//! container's bar is hidden at rest, appears whenever its scroll offset changes, and fades out
//! after a second without movement. While the pointer is over the bar it stays, and the thumb
//! thickens over 150 ms and a faint track shows. The bar takes no layout space.
//!
//! The second it stays costs no frames: one timer is armed for its end, and the frames come only
//! with the 200 ms fade and the thickening, which a frame at a time samples.
//!
//! With it on Always (`ScrollerStyle::Classic`, which macOS also picks while a mouse is
//! attached), the bar is always there: an opaque track and a thumb that does not change, in a
//! gutter the container reserves out of its own box, so `clientWidth` and the content box shrink
//! by it.
//!
//! In both styles the thumb drags, and pressing the track pages toward the pointer. The bar is
//! an overlay (`paint_overlay`), so it never takes part in what the container can scroll. Its
//! hitbox exists only where the bar is visible, so it blocks nothing otherwise.
//!
//! A virtual list's bar also tells gpui how a scroll moves its thumb (`paint_scroll_thumb`), so a
//! frame that moves the rows of the frame shown moves the thumb too and builds nothing: see
//! [`plan_thumb`] and [`move_thumb`].

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use gpui::{StatefulInteractiveElement as _, Styled as _};
use web_time::Instant;

use crate::scroll::Overflow;
use crate::style::StyleDesc;

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)] // objc 0.2's msg_send! expands to cfg(feature = "cargo-clippy")
mod observer {
    use block::ConcreteBlock;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSPreferredScrollerStyleDidChangeNotification: *mut Object;
    }

    /// Calls back when "Show scroll bars" changes, and stops when dropped.
    pub(crate) struct ScrollerStyleObserver {
        token: *mut Object,
    }

    impl ScrollerStyleObserver {
        /// `on_change` runs on the main queue, which is the thread GPUI runs on.
        pub(crate) fn new(on_change: impl Fn() + 'static) -> Self {
            // SAFETY: the block is copied to the heap, so the center keeps it alive until
            // `removeObserver:`. `token` is retained until drop.
            unsafe {
                let center: *mut Object = msg_send![class!(NSNotificationCenter), defaultCenter];
                let main_queue: *mut Object = msg_send![class!(NSOperationQueue), mainQueue];
                let block = ConcreteBlock::new(move |_notification: *mut Object| on_change());
                let block = block.copy();
                let token: *mut Object = msg_send![center,
                    addObserverForName: NSPreferredScrollerStyleDidChangeNotification
                    object: std::ptr::null_mut::<Object>()
                    queue: main_queue
                    usingBlock: block
                ];
                let token: *mut Object = msg_send![token, retain];
                Self { token }
            }
        }
    }

    impl Drop for ScrollerStyleObserver {
        fn drop(&mut self) {
            // SAFETY: `token` came from `addObserverForName:` and was retained in `new`.
            unsafe {
                let center: *mut Object = msg_send![class!(NSNotificationCenter), defaultCenter];
                let _: () = msg_send![center, removeObserver: self.token];
                let _: () = msg_send![self.token, release];
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use observer::ScrollerStyleObserver;

/// How long a bar stays fully visible after the offset last moved.
const IDLE: Duration = Duration::from_millis(1000);
/// How long it then takes to fade out.
const FADE: Duration = Duration::from_millis(200);
/// Gap between the thumb and the edge of the scrollport.
const EDGE_INSET: f32 = 2.0;
/// The shortest a thumb gets, however long the content.
const MIN_THUMB: f32 = 20.0;
/// How much of the viewport pressing the track pages by.
const PAGE_FRACTION: f32 = 0.9;
/// How long the thumb takes to thicken under the pointer, and to thin again.
const HOVER_GROW: Duration = Duration::from_millis(150);
/// The width of a classic bar's gutter: `auto`, and `thin`.
const CLASSIC_GUTTER: f32 = 15.0;
const CLASSIC_GUTTER_THIN: f32 = 11.0;
/// How many times in a row an `overflow: auto` scroller may add or drop its gutter, so content
/// that cannot settle cannot flip for ever.
const MAX_GUTTER_FLIPS: u8 = 4;

/// The macOS "Show scroll bars" setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScrollerStyle {
    /// Automatically based on mouse or trackpad (with a trackpad), or When scrolling.
    Overlay,
    /// Always, and what Automatically gives while a mouse is attached.
    Classic,
}

impl ScrollerStyle {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "overlay" => Ok(Self::Overlay),
            "classic" => Ok(Self::Classic),
            other => Err(format!(
                "Unknown scrollbar style \"{other}\", expected \"overlay\" or \"classic\""
            )),
        }
    }

    /// What the OS asks for. Only macOS has the setting; elsewhere bars are overlays.
    pub(crate) fn of_system(cx: &gpui::App) -> Self {
        if cfg!(target_os = "macos") && !cx.should_auto_hide_scrollbars() {
            Self::Classic
        } else {
            Self::Overlay
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Width {
    Auto,
    Thin,
    None,
}

/// What a style asks the bar to look like.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Look {
    width: Width,
    /// `None` follows the system appearance.
    colors: Option<(gpui::Rgba, gpui::Rgba)>,
    scroller: ScrollerStyle,
}

impl Look {
    /// `scrollbarWidth` is `auto`, `thin` or `none`, and `scrollbarColor` is `auto` or
    /// `<thumb> <track>`. A value that is none of those is ignored, as CSS ignores it.
    pub(crate) fn of(style: &StyleDesc, context: &crate::color::ColorContext) -> Self {
        let width = match style.scrollbar_width.as_deref() {
            Some("thin") => Width::Thin,
            Some("none") => Width::None,
            _ => Width::Auto,
        };
        let colors = style
            .scrollbar_color
            .as_deref()
            .and_then(|value| parse_colors(value, context));
        Self { width, colors, scroller: SCROLLER.get() }
    }

    pub(crate) fn hidden(self) -> bool {
        self.width == Width::None
    }

    fn classic(self) -> bool {
        self.scroller == ScrollerStyle::Classic && !self.hidden()
    }

    /// The room a classic bar takes from its container, zero for an overlay.
    pub(crate) fn gutter(self) -> f32 {
        match (self.classic(), self.width) {
            (false, _) => 0.0,
            (true, Width::Thin) => CLASSIC_GUTTER_THIN,
            (true, _) => CLASSIC_GUTTER,
        }
    }

    /// Gap between the thumb and the edge of its bar.
    fn inset(self) -> f32 {
        match (self.classic(), self.width) {
            (false, _) => EDGE_INSET,
            (true, Width::Thin) => 2.0,
            (true, _) => 3.0,
        }
    }

    /// Thumb thickness at rest and under the pointer. A classic thumb does not change.
    fn thickness(self) -> (f32, f32) {
        if self.classic() {
            let thumb = self.gutter() - 2.0 * self.inset();
            return (thumb, thumb);
        }
        match self.width {
            Width::Thin => (4.0, 7.0),
            _ => (7.0, 11.0),
        }
    }

    /// How far across the container the bar's hit area and track reach.
    fn bar(self) -> f32 {
        if self.classic() {
            self.gutter()
        } else {
            self.thickness().1 + EDGE_INSET
        }
    }
}

/// `"<thumb> <track>"`: two colours, each a CSS colour that may itself contain spaces inside
/// parentheses.
fn parse_colors(
    value: &str,
    context: &crate::color::ColorContext,
) -> Option<(gpui::Rgba, gpui::Rgba)> {
    let mut tokens = Vec::new();
    let (mut depth, mut start) = (0usize, None);
    for (index, character) in value.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {}
        }
        let space = character.is_whitespace() && depth == 0;
        match (space, start) {
            (false, None) => start = Some(index),
            (true, Some(from)) => {
                tokens.push(&value[from..index]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        tokens.push(&value[from..]);
    }
    let [thumb, track] = tokens.as_slice() else {
        return None;
    };
    Some((context.resolve(thumb)?, context.resolve(track)?))
}

fn default_colors(window: &gpui::Window, classic: bool) -> (gpui::Rgba, gpui::Rgba) {
    let dark = matches!(
        window.appearance(),
        gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
    );
    let (shade, thumb, track) = if dark { (1.0, 0.5, 0.08) } else { (0.0, 0.5, 0.06) };
    let thumb = gpui::Rgba { r: shade, g: shade, b: shade, a: thumb };
    if classic {
        // A classic track covers whatever scrolls under it, so it is solid.
        let ground = if dark { 0.16 } else { 0.97 };
        return (thumb, gpui::Rgba { r: ground, g: ground, b: ground, a: 1.0 });
    }
    (thumb, gpui::Rgba { r: shade, g: shade, b: shade, a: track })
}

fn ease_in_out(progress: f32) -> f32 {
    progress * progress * (3.0 - 2.0 * progress)
}

/// How far the pointer has thickened one bar, between 0 (at rest) and 1 (under the pointer).
#[derive(Clone, Copy, Default)]
struct Grow {
    from: f32,
    target: f32,
    started: Option<Instant>,
}

impl Grow {
    fn value(self, now: Instant) -> f32 {
        let Some(started) = self.started else {
            return self.target;
        };
        let progress = now.saturating_duration_since(started).as_secs_f32()
            / HOVER_GROW.as_secs_f32();
        self.from + (self.target - self.from) * ease_in_out(progress.min(1.0))
    }

    /// Heads for `target` from wherever it is now, starting at `now`.
    fn aim(&mut self, target: f32, now: Instant) {
        if target != self.target {
            self.from = self.value(now);
            self.target = target;
            self.started = Some(now);
        }
    }

    fn animating(self, now: Instant) -> bool {
        self.started
            .is_some_and(|started| now.saturating_duration_since(started) < HOVER_GROW)
    }
}

/// Whether a classic scroller reserves a gutter on an axis. `overflow: auto` does once something
/// scrolls, which `needed` says it did in the build before this one: a draw builds again when
/// that changed the gutter, so the frame it presents has it.
fn wants_gutter(overflow: Overflow, needed: bool) -> bool {
    match overflow {
        Overflow::Scroll => true,
        Overflow::Auto => needed,
        _ => false,
    }
}

/// The thumb of a bar along one axis: where it starts and how long it is, in the track's own
/// coordinates. `track` is the bar's length, `max_scroll` how far the content can move and
/// `offset` how far it has (zero or negative). `None` when the content fits.
pub(crate) fn scrollbar_thumb(track: f32, max_scroll: f32, offset: f32) -> Option<(f32, f32)> {
    if track <= 0.0 || max_scroll <= 1.0 {
        return None;
    }
    let length = (track * track / (track + max_scroll)).clamp(MIN_THUMB.min(track), track);
    let progress = (-offset / max_scroll).clamp(0.0, 1.0);
    Some((progress * (track - length), length))
}

/// What a bar scrolls.
#[derive(Clone)]
pub(crate) enum Source {
    Container { id: u64, handle: gpui::ScrollHandle },
    List(gpui::ListState, Rc<crate::visible_range::RangeReporter>),
}

impl Source {
    /// Which axes the user scrolls, so which ones get a bar.
    fn axes(&self) -> [bool; 2] {
        match self {
            Source::Container { handle, .. } => {
                let user = handle.user_scrollable();
                [user.x, user.y]
            }
            Source::List(..) => [false, true],
        }
    }

    /// How far the content can move and how far it has (zero or negative).
    fn extent(&self) -> (gpui::Point<gpui::Pixels>, gpui::Point<gpui::Pixels>) {
        match self {
            Source::Container { handle, .. } => (handle.max_offset(), handle.offset()),
            Source::List(state, _) => match state.averaged_scroll_extent() {
                // Rows not yet measured count as the average measured row, so the thumb does
                // not jump as rows come into view.
                Some((max, offset)) => (
                    gpui::point(gpui::px(0.0), max),
                    gpui::point(gpui::px(0.0), -offset),
                ),
                None => (
                    state.max_offset_for_scrollbar(),
                    state.scroll_px_offset_for_scrollbar(),
                ),
            },
        }
    }

    /// The box the bars sit in, given the element's own bounds.
    fn port(&self, bounds: gpui::Bounds<gpui::Pixels>) -> gpui::Bounds<gpui::Pixels> {
        match self {
            Source::Container { handle, .. } => handle.padding_box(),
            Source::List(..) => bounds,
        }
    }

    /// The room the container reserved for its bars: a list's are overlays.
    fn gutter(&self) -> gpui::Size<gpui::Pixels> {
        match self {
            Source::Container { handle, .. } => handle.scrollbar_size(),
            Source::List(..) => gpui::size(gpui::px(0.0), gpui::px(0.0)),
        }
    }

    /// A user's drag or click on a list's bar is a scroll the page hears of as it hears of a wheel.
    /// It is reported here, not by gpui's `set_offset_from_scrollbar_by_user`: that reads the range
    /// at `logical_scroll_top`, which for a bottom-aligned list at its end is the item count, and
    /// reports no rows then.
    fn set_offset(&self, offset: gpui::Point<gpui::Pixels>) {
        match self {
            Source::Container { id, handle } => {
                crate::scroll::scroll_to(*id, handle, offset, crate::scroll::Behavior::Instant);
            }
            Source::List(state, reporter) => {
                let before = state.scroll_px_offset_for_scrollbar();
                state.set_offset_from_scrollbar(offset);
                if state.scroll_px_offset_for_scrollbar() != before {
                    reporter.report_at(state, state.logical_scroll_top());
                }
            }
        }
    }

    /// A list keeps its totals steady while a thumb is held, so the thumb does not run away.
    fn drag(&self, started: bool) {
        if let Source::List(state, _) = self {
            if started {
                state.scrollbar_drag_started();
            } else {
                state.scrollbar_drag_ended();
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Drag {
    axis: usize,
    /// How far into the thumb the pointer took hold.
    grab: f32,
}

/// Where one axis' bar is, in window coordinates.
#[derive(Clone, Copy)]
struct AxisLayout {
    strip: gpui::Bounds<gpui::Pixels>,
    track_start: f32,
    track_len: f32,
    thumb_start: f32,
    thumb_len: f32,
    max: f32,
    port_len: f32,
    inset: f32,
}

#[derive(Default)]
pub(crate) struct State {
    last_offset: Option<gpui::Point<gpui::Pixels>>,
    last_active: Option<Instant>,
    hover: [bool; 2],
    drag: Option<Drag>,
    layout: [Option<AxisLayout>; 2],
    /// Tracks with no thumb: a classic bar with nothing to scroll, and the corner where two meet.
    empty_tracks: Vec<gpui::Bounds<gpui::Pixels>>,
    hitboxes: [Option<gpui::Hitbox>; 2],
    grow: [Grow; 2],
    alpha: f32,
    /// What the last paint drew, which a tick that leaves the bar as it was has to find true of
    /// the clock it is at ([`stale_at`]).
    painted: Painted,
    /// The alpha does not follow the clock: a classic bar, or one the pointer holds.
    pinned: bool,
    was_held: bool,
    /// Wakes the window when the hold ends, so the fade starts without a frame having asked.
    hold_timer: Option<HoldTimer>,
    seen: u64,
    /// Per axis, whether the content scrolled when last laid out. An `overflow: auto` scroller
    /// reserves its gutter from it.
    needed: [bool; 2],
    /// Per axis, whether the scroller was built with a gutter.
    reserved: [bool; 2],
    /// Per axis, whether the gutter follows `needed`.
    follows_need: [bool; 2],
    flips: u8,
    /// The draw `reserve` last ran in, and the gutter it began with.
    draw: u64,
    draw_start: [bool; 2],
    /// Per axis, the draw (`DRAW`) in which the gutter was added. It stays for the rest of that
    /// draw, as Blink keeps a bar that appeared during a layout, so a gutter that shrinks the
    /// content until it fits cannot make the passes of one draw take it away again.
    frozen: [Option<u64>; 2],
    /// The last prepaint asked for another frame: the bar fades, grows or settles its gutter.
    needs_frames: bool,
    /// The bar is a virtual list's.
    list: bool,
}

#[derive(Clone, Copy, Default)]
struct Painted {
    alpha: f32,
    grow: [f32; 2],
}

struct HoldTimer {
    /// The end of the hold it waits for.
    at: Instant,
    /// Dropping it cancels the wait.
    _task: gpui::Task<()>,
}

thread_local! {
    static STATES: RefCell<HashMap<u64, Rc<RefCell<State>>>> = RefCell::new(HashMap::new());
    static FRAME: Cell<u64> = const { Cell::new(0) };
    static DRAW: Cell<u64> = const { Cell::new(0) };
    static NOW: Cell<Option<Instant>> = const { Cell::new(None) };
    static CLOCK: RefCell<Option<crate::automation::AutomationClock>> = const { RefCell::new(None) };
    static SCROLLER: Cell<ScrollerStyle> = const { Cell::new(ScrollerStyle::Overlay) };
}

/// Call before building a frame, with the time its animations run on and the clock that time came
/// from, the style the bars take and the pass of the draw it is (1 for the first build). Drops the
/// bars of scrollers that were not built last frame, and with them the timers they waited on.
pub(crate) fn begin_frame(
    now: Instant,
    clock: &crate::automation::AutomationClock,
    scroller: ScrollerStyle,
    pass: usize,
) {
    NOW.set(Some(now));
    CLOCK.with(|cell| *cell.borrow_mut() = Some(clock.clone()));
    SCROLLER.set(scroller);
    if pass <= 1 {
        DRAW.set(DRAW.get() + 1);
    }
    let frame = FRAME.get() + 1;
    FRAME.set(frame);
    STATES.with(|states| {
        states
            .borrow_mut()
            .retain(|_, state| state.borrow().seen + 1 >= frame);
    });
}

fn now() -> Instant {
    NOW.get().unwrap_or_else(Instant::now)
}

/// The clock's instant, which a frame that builds nothing has no `now` of its own to sample at.
fn clock_now() -> Instant {
    CLOCK.with(|cell| {
        cell.borrow()
            .as_ref()
            .expect("a frame began before a bar is planned")
            .now()
    })
}

/// Whether a bar of the last frame asked for another frame: it fades, grows or settles its gutter.
pub(crate) fn needs_frames() -> bool {
    STATES.with(|states| states.borrow().values().any(|state| state.borrow().needs_frames))
}

/// Whether a bar of a scroll container (a list's are planned, see [`plan_thumb`]) was painted at
/// an alpha or a thickness that the clock has since changed. A frame that moves the rows builds no
/// bar, so it would leave the end of its hold, or the thickening, unseen.
pub(crate) fn container_bar_stale() -> bool {
    let now = clock_now();
    let frame = FRAME.get();
    STATES.with(|states| {
        states.borrow().values().any(|state| {
            let st = state.borrow();
            st.seen == frame && !st.list && st.stale_at(now)
        })
    })
}

/// Whether a bar of the last frame was painted at an alpha or a thickness that the clock has since
/// changed: its hold ended, or the pointer's thickening ran on. A tick that built only a unit would
/// leave the bar as the frame before drew it.
pub(crate) fn stale_at(now: Instant) -> bool {
    let frame = FRAME.get();
    STATES.with(|states| {
        states.borrow().values().any(|state| {
            let st = state.borrow();
            st.seen == frame && st.stale_at(now)
        })
    })
}

/// How visible an overlay bar is, given when it last moved or was held: whole for [`IDLE`], then
/// fading over [`FADE`].
fn alpha_at(last_active: Option<Instant>, now: Instant) -> f32 {
    let Some(active) = last_active else {
        return 0.0;
    };
    let elapsed = now.saturating_duration_since(active);
    if elapsed < IDLE {
        1.0
    } else if elapsed < IDLE + FADE {
        1.0 - (elapsed - IDLE).as_secs_f32() / FADE.as_secs_f32()
    } else {
        0.0
    }
}

impl State {
    fn stale_at(&self, now: Instant) -> bool {
        let alpha = if self.pinned { 1.0 } else { alpha_at(self.last_active, now) };
        alpha != self.painted.alpha
            || (0..2).any(|axis| self.grow[axis].value(now) != self.painted.grow[axis])
    }

    /// Has one timer wait for `ends`, the end of the hold, and none when there is no hold. A timer
    /// already waiting for it is left alone: prepaint runs again in the culled, the multi-pass and
    /// the reference passes of a draw.
    fn wake_at(&mut self, ends: Option<Instant>, view: gpui::EntityId, window: &gpui::Window, cx: &gpui::App) {
        let Some(at) = ends else {
            self.hold_timer = None;
            return;
        };
        if self.hold_timer.as_ref().is_some_and(|timer| timer.at == at) {
            return;
        }
        let clock = CLOCK
            .with(|cell| cell.borrow().clone())
            .expect("a frame began before its bars are prepainted");
        // The clock the bar samples is not the executor's, which is what the timer counts: a timer
        // that fires before the clock got to `at` waits for the rest.
        let task = window.spawn(cx, async move |cx| {
            loop {
                let remaining = at.saturating_duration_since(clock.now());
                if remaining.is_zero() {
                    break;
                }
                cx.background_executor().timer(remaining).await;
            }
            cx.update(|_, cx| cx.notify_paint_only(view)).ok();
        });
        self.hold_timer = Some(HoldTimer { at, _task: task });
    }
}

pub(crate) fn state_for(id: u64) -> Rc<RefCell<State>> {
    STATES.with(|states| states.borrow_mut().entry(id).or_default().clone())
}

/// Gives a scroll container its bars, if its style does not turn them off, and the room for them
/// that a classic bar takes. `overflow` is the container's, per axis (x, then y).
pub(crate) fn attach<E: gpui::Styled + gpui::StatefulInteractiveElement>(
    el: E,
    id: u64,
    source: Source,
    style: &StyleDesc,
    colors: &crate::color::ColorContext,
    overflow: [Overflow; 2],
) -> E {
    let look = Look::of(style, colors);
    if look.hidden() {
        return el;
    }
    let state = state_for(id);
    let el = reserve(el, &state, look, overflow);
    overlay(el, state, source, look)
}

/// [`attach`] for a virtual list, which keeps the size its style gives it: its bars are drawn over
/// it and take no room.
pub(crate) fn attach_to_list<E: gpui::StatefulInteractiveElement>(
    el: E,
    id: u64,
    source: Source,
    style: &StyleDesc,
    colors: &crate::color::ColorContext,
) -> E {
    let look = Look::of(style, colors);
    if look.hidden() {
        return el;
    }
    overlay(el, state_for(id), source, look)
}

/// The bars are the element's overlay, so its `clipPath` and its hitbox parent chain cut them too.
fn overlay<E: gpui::StatefulInteractiveElement>(
    el: E,
    state: Rc<RefCell<State>>,
    source: Source,
    look: Look,
) -> E {
    el.prepaint_overlay({
        let (state, source) = (state.clone(), source.clone());
        move |bounds, window, cx| prepaint(&state, &source, look, bounds, window, cx)
    })
    .paint_overlay(move |bounds, window, cx| paint(&state, &source, look, bounds, window, cx))
}

/// Makes the container leave room for its classic bars. A bar for the vertical axis takes width
/// and one for the horizontal axis takes height, and a bar the user cannot move (`hidden`) takes
/// nothing.
fn reserve<E: gpui::Styled + gpui::StatefulInteractiveElement>(
    el: E,
    state: &Rc<RefCell<State>>,
    look: Look,
    overflow: [Overflow; 2],
) -> E {
    let mut st = state.borrow_mut();
    let gutter = look.gutter();
    if gutter == 0.0 {
        st.reserved = [false; 2];
        st.follows_need = [false; 2];
        return el;
    }
    let draw = DRAW.get();
    if st.draw != draw {
        // A draw that dropped the gutter and took it back (content that scrolls without it and
        // fits with it) ended where it began, which is no oscillation to stop.
        if st.reserved == st.draw_start {
            st.flips = 0;
        }
        st.draw = draw;
        st.draw_start = st.reserved;
    }
    let wanted = [0, 1].map(|axis| {
        wants_gutter(overflow[axis], st.needed[axis])
            || (st.reserved[axis] && st.frozen[axis] == Some(draw))
    });
    if wanted == st.reserved {
        st.flips = 0;
    } else if st.flips < MAX_GUTTER_FLIPS {
        st.flips += 1;
        for axis in 0..2 {
            if wanted[axis] && !st.reserved[axis] {
                st.frozen[axis] = Some(draw);
            }
        }
        st.reserved = wanted;
    }
    st.follows_need = [0, 1].map(|axis| overflow[axis] == Overflow::Auto);
    let reserved = st.reserved;
    el.scrollbar_width(gpui::px(gutter))
        .without_scrollbar(!reserved[0], !reserved[1])
}

fn axis_of(bounds: gpui::Bounds<gpui::Pixels>, vertical: bool) -> (f32, f32) {
    if vertical {
        (f32::from(bounds.origin.y), f32::from(bounds.size.height))
    } else {
        (f32::from(bounds.origin.x), f32::from(bounds.size.width))
    }
}

/// Where the bars of a source lie for its extent now.
struct Bars {
    layout: [Option<AxisLayout>; 2],
    /// Tracks with no thumb: a classic bar with nothing to scroll, and the corner where two meet.
    empty_tracks: Vec<gpui::Bounds<gpui::Pixels>>,
    /// Per axis, whether the content scrolls.
    needed: [bool; 2],
}

/// Works out where the bars of `source` lie in the box `bounds`, which prepaint and the plan of a
/// frame that moves the rows both ask, so a thumb is where the frame built whole would put it.
fn lay_out(source: &Source, look: Look, bounds: gpui::Bounds<gpui::Pixels>) -> Bars {
    let (max, offset) = source.extent();
    let port = source.port(bounds);
    let gutter = source.gutter();
    let bar = look.bar();
    let [user_x, user_y] = source.axes();
    let scrolls = [user_x && f32::from(max.x) > 0.5, user_y && f32::from(max.y) > 0.5];
    // The bar of the x axis lies along the bottom, so it takes the gutter's height.
    let room = [f32::from(gutter.height), f32::from(gutter.width)];
    let shown = [scrolls[0] || room[0] > 0.0, scrolls[1] || room[1] > 0.0];
    let corner = if shown[0] && shown[1] && room == [0.0, 0.0] { bar } else { 0.0 };

    let mut layout: [Option<AxisLayout>; 2] = [None, None];
    let mut empty_tracks = Vec::new();
    for (index, vertical) in [(0, false), (1, true)] {
        if !shown[index] {
            continue;
        }
        let (port_start, port_len) = axis_of(port, vertical);
        let track_len = port_len - corner;
        let strip = match (vertical, room[index] > 0.0) {
            (true, true) => gpui::Bounds::new(
                gpui::point(port.right(), port.top()),
                gpui::size(gutter.width, gpui::px(track_len)),
            ),
            (false, true) => gpui::Bounds::new(
                gpui::point(port.left(), port.bottom()),
                gpui::size(gpui::px(track_len), gutter.height),
            ),
            (true, false) => gpui::Bounds::new(
                gpui::point(port.right() - gpui::px(bar), port.top()),
                gpui::size(gpui::px(bar), gpui::px(track_len)),
            ),
            (false, false) => gpui::Bounds::new(
                gpui::point(port.left(), port.bottom() - gpui::px(bar)),
                gpui::size(gpui::px(track_len), gpui::px(bar)),
            ),
        };
        let (max_scroll, scrolled) = if vertical {
            (f32::from(max.y), f32::from(offset.y))
        } else {
            (f32::from(max.x), f32::from(offset.x))
        };
        let thumb = scrollbar_thumb(track_len, max_scroll, scrolled).filter(|_| scrolls[index]);
        let Some((thumb_start, thumb_len)) = thumb else {
            if room[index] > 0.0 {
                empty_tracks.push(strip);
            }
            continue;
        };
        layout[index] = Some(AxisLayout {
            strip,
            track_start: port_start,
            track_len,
            thumb_start,
            thumb_len,
            max: max_scroll,
            port_len,
            inset: look.inset(),
        });
    }
    if room[0] > 0.0 && room[1] > 0.0 {
        empty_tracks.push(gpui::Bounds::new(
            gpui::point(port.right(), port.bottom()),
            gpui::size(gutter.width, gutter.height),
        ));
    }
    Bars { layout, empty_tracks, needed: scrolls }
}

/// Whether the offset moved from `last`, as the bar counts a move.
fn moved(last: gpui::Point<gpui::Pixels>, offset: gpui::Point<gpui::Pixels>) -> bool {
    (f32::from(last.x - offset.x)).abs() > 0.01 || (f32::from(last.y - offset.y)).abs() > 0.01
}

/// What a bar's activity comes to at an instant, from where its offset is and who holds it.
struct Activity {
    last_active: Option<Instant>,
    held: bool,
    pinned: bool,
    alpha: f32,
}

impl Activity {
    fn holding(&self, now: Instant) -> bool {
        !self.pinned && self.last_active.is_some_and(|active| now < active + IDLE)
    }

    fn fading(&self, now: Instant) -> bool {
        !self.pinned && self.alpha > 0.0 && !self.holding(now)
    }

    /// The end of the hold, while there is one.
    fn hold_ends(&self, now: Instant) -> Option<Instant> {
        self.last_active.filter(|_| self.holding(now)).map(|active| active + IDLE)
    }
}

impl State {
    /// What prepaint makes of the bar at `now` for an offset: a move, or a hold, starts the
    /// bar's second again. The hold starts when the pointer lets go, not when a frame last saw
    /// it there: no frame is asked for while it stays.
    fn activity(&self, offset: gpui::Point<gpui::Pixels>, now: Instant, classic: bool) -> Activity {
        let mut last_active = self.last_active;
        if self.last_offset.is_some_and(|last| moved(last, offset)) {
            last_active = Some(now);
        }
        let held = self.hover.iter().any(|hovered| *hovered) || self.drag.is_some();
        if held || self.was_held {
            last_active = Some(now);
        }
        let alpha = if classic { 1.0 } else { alpha_at(last_active, now) };
        Activity { last_active, held, pinned: classic || held, alpha }
    }
}

/// Works out whether and where the bars show, and inserts their hitboxes. Prepaint, because a
/// hitbox can only be inserted there.
fn prepaint(
    state: &Rc<RefCell<State>>,
    source: &Source,
    look: Look,
    bounds: gpui::Bounds<gpui::Pixels>,
    window: &mut gpui::Window,
    cx: &gpui::App,
) {
    let mut st = state.borrow_mut();
    st.seen = FRAME.get();
    st.list = matches!(source, Source::List(..));
    let now = now();
    let (_, offset) = source.extent();
    let classic = look.classic();

    let activity = st.activity(offset, now, classic);
    st.last_offset = Some(offset);
    let bars = lay_out(source, look, bounds);
    st.needed = bars.needed;
    let layout = bars.layout;
    st.last_active = activity.last_active;
    st.was_held = activity.held;
    st.pinned = activity.pinned;
    let alpha = activity.alpha;
    st.wake_at(activity.hold_ends(now), window.current_view(), window, cx);

    st.layout = layout;
    st.empty_tracks = bars.empty_tracks;
    st.alpha = alpha;
    for index in 0..2 {
        st.hitboxes[index] = match layout[index] {
            Some(axis) if alpha > 0.0 => {
                Some(window.insert_hitbox(axis.strip, gpui::HitboxBehavior::BlockMouseExceptScroll))
            }
            _ => None,
        };
        if st.hitboxes[index].is_none() {
            st.hover[index] = false;
        }
        let dragged = st.drag.is_some_and(|drag| drag.axis == index);
        let thickened = !classic && (st.hover[index] || dragged);
        st.grow[index].aim(if thickened { 1.0 } else { 0.0 }, now);
    }
    let growing = st.grow.iter().any(|grow| grow.animating(now));
    // An `overflow: auto` gutter follows the layout it caused: this build laid out without (or
    // with) a gutter the content did (or did not) call for, so the draw builds again before it
    // presents. A gutter frozen on in this draw stays however little it scrolls.
    let draw = DRAW.get();
    let settling = st.flips < MAX_GUTTER_FLIPS
        && (0..2).any(|axis| {
            st.follows_need[axis]
                && st.needed[axis] != st.reserved[axis]
                && !(st.reserved[axis] && st.frozen[axis] == Some(draw))
        });
    if settling {
        window.request_redraw_before_present();
    }
    // The draw ran out of passes: what it presents has the old gutter, and the next frame builds
    // with the new one.
    let unsettled = settling && crate::layout::container::last_pass(window);
    st.needs_frames = activity.fading(now) || growing || unsettled;
    if st.needs_frames {
        window.request_animation_frame();
    }
}

fn along(position: gpui::Point<gpui::Pixels>, vertical: bool) -> f32 {
    if vertical {
        f32::from(position.y)
    } else {
        f32::from(position.x)
    }
}

/// Moves `axis` to a scroll position (pixels from the start) without touching the other one.
fn scroll_axis_to(source: &Source, axis: usize, position: f32, max: f32) {
    let (_, mut offset) = source.extent();
    let target = gpui::px(0.0 - position.clamp(0.0, max));
    if axis == 1 {
        offset.y = target;
    } else {
        offset.x = target;
    }
    source.set_offset(offset);
}

impl AxisLayout {
    /// Whether the track is the same one, whatever the thumb on it.
    fn same_track(&self, other: &AxisLayout) -> bool {
        self.strip == other.strip
            && self.track_start == other.track_start
            && self.track_len == other.track_len
            && self.port_len == other.port_len
            && self.max == other.max
            && self.inset == other.inset
    }
}

/// The box of a thumb or a track along an axis, `start` and `len` from the start of the track.
fn bar_rect(axis: &AxisLayout, vertical: bool, start: f32, len: f32, thickness: f32) -> gpui::Bounds<gpui::Pixels> {
    let strip = axis.strip;
    if vertical {
        gpui::Bounds::new(
            gpui::point(strip.right() - gpui::px(axis.inset + thickness), gpui::px(axis.track_start + start)),
            gpui::size(gpui::px(thickness), gpui::px(len)),
        )
    } else {
        gpui::Bounds::new(
            gpui::point(gpui::px(axis.track_start + start), strip.bottom() - gpui::px(axis.inset + thickness)),
            gpui::size(gpui::px(len), gpui::px(thickness)),
        )
    }
}

/// What a list's bar painted, which a scroll that moves the rows is planned against.
#[derive(Clone, Copy)]
struct ShownBar {
    /// The bar of the vertical axis, the only one a list has.
    layout: Option<AxisLayout>,
    alpha: f32,
    grow: f32,
}

/// Where a scroll that moved a list puts the thumb of its bar, against what the frame shown
/// painted, as the frame built whole would: the bounds of the thumb if it moves, or why the frame
/// cannot be one that builds nothing. The clock is the one a frame samples at, so a bar whose
/// hold has since ended, or that has begun to fade, is not one that stays as painted.
fn plan_thumb(
    state: &Rc<RefCell<State>>,
    source: &Source,
    look: Look,
    bounds: gpui::Bounds<gpui::Pixels>,
    shown: &ShownBar,
    drawn: Option<gpui::Bounds<gpui::Pixels>>,
) -> Result<Option<gpui::Bounds<gpui::Pixels>>, gpui::ScrollThumbMiss> {
    use gpui::ScrollThumbMiss as Miss;

    let now = clock_now();
    let st = state.borrow();
    let (_, offset) = source.extent();
    let activity = st.activity(offset, now, look.classic());
    if shown.alpha <= 0.0 {
        return if activity.alpha > 0.0 { Err(Miss::Appear) } else { Ok(None) };
    }
    if activity.alpha != shown.alpha {
        return Err(Miss::Alpha);
    }
    let (Some(painted), Some(placed)) = (shown.layout, lay_out(source, look, bounds).layout[1]) else {
        return Err(Miss::Size);
    };
    if !placed.same_track(&painted) {
        return Err(Miss::Track);
    }
    if placed.thumb_len != painted.thumb_len || st.grow[1].value(now) != shown.grow {
        return Err(Miss::Size);
    }
    let (rest, hover) = look.thickness();
    let thickness = rest + (hover - rest) * shown.grow;
    // Against where the thumb is drawn now, which is not where the frame shown painted it once a
    // translate moved it: a scroll that brings it back there moves it back.
    let thumb = bar_rect(&placed, true, placed.thumb_start, placed.thumb_len, thickness);
    Ok((drawn != Some(thumb)).then_some(thumb))
}

/// What prepaint takes from a list's new position, for a frame that moved the rows and built
/// nothing: where the bar is, what it is doing, and the end of its hold. The listeners of the
/// bar read this, and the hold of the bar is a second after the scroll and not after the frame
/// that painted the thumb.
fn move_thumb(
    state: &Rc<RefCell<State>>,
    source: &Source,
    look: Look,
    bounds: gpui::Bounds<gpui::Pixels>,
    view: gpui::EntityId,
    window: &gpui::Window,
    cx: &gpui::App,
) {
    let now = clock_now();
    let mut st = state.borrow_mut();
    let (_, offset) = source.extent();
    let activity = st.activity(offset, now, look.classic());
    st.last_offset = Some(offset);
    st.last_active = activity.last_active;
    st.was_held = activity.held;
    st.pinned = activity.pinned;
    let bars = lay_out(source, look, bounds);
    st.needed = bars.needed;
    st.layout = bars.layout;
    st.wake_at(activity.hold_ends(now), view, window, cx);
}

/// Draws the bars and listens for the pointer.
fn paint(
    state: &Rc<RefCell<State>>,
    source: &Source,
    look: Look,
    bounds: gpui::Bounds<gpui::Pixels>,
    window: &mut gpui::Window,
    _cx: &mut gpui::App,
) {
    let (layout, empty_tracks, hitboxes, alpha, painted) = {
        let mut st = state.borrow_mut();
        for index in 0..2 {
            if let Some(hitbox) = &st.hitboxes[index] {
                st.hover[index] = hitbox.is_hovered(window);
            }
        }
        let now = now();
        st.painted = Painted { alpha: st.alpha, grow: [st.grow[0].value(now), st.grow[1].value(now)] };
        (st.layout, st.empty_tracks.clone(), st.hitboxes.clone(), st.alpha, st.painted)
    };
    let view = window.current_view();
    // A list tells gpui how a scroll moves its thumb, whether or not it paints one.
    let note_thumb = |window: &mut gpui::Window, thumb: Option<gpui::PaintQuad>| {
        let Source::List(list, _) = source else { return };
        let shown = ShownBar { layout: layout[1], alpha, grow: painted.grow[1] };
        let plan = {
            let (state, source) = (state.clone(), source.clone());
            Rc::new(move |_: &gpui::Window, drawn| plan_thumb(&state, &source, look, bounds, &shown, drawn))
        };
        let moved = {
            let (state, source) = (state.clone(), source.clone());
            Rc::new(move |window: &mut gpui::Window, cx: &mut gpui::App| {
                move_thumb(&state, &source, look, bounds, view, window, cx)
            })
        };
        window.paint_scroll_thumb(list, thumb, plan, moved);
    };
    if alpha <= 0.0 {
        note_thumb(window, None);
        return;
    }

    let classic = look.classic();
    let (thumb_color, track_color) = look
        .colors
        .unwrap_or_else(|| default_colors(window, classic));
    let (rest, hover) = look.thickness();
    let scaled = |color: gpui::Rgba, share: f32| -> gpui::Hsla {
        gpui::Rgba { a: color.a * alpha * share, ..color }.into()
    };
    let rounded = |bounds, radius: f32, color| {
        gpui::quad(
            bounds,
            gpui::px(radius),
            color,
            gpui::px(0.0),
            gpui::transparent_black(),
            gpui::BorderStyle::default(),
        )
    };
    let paint_rect = |window: &mut gpui::Window, bounds, radius: f32, color| {
        window.paint_quad(rounded(bounds, radius, color));
    };
    for track in &empty_tracks {
        paint_rect(window, *track, 0.0, scaled(track_color, 1.0));
    }
    let mut thumb_noted = false;
    {
        let st = state.borrow();
        let now = now();
        for (index, vertical) in [(0, false), (1, true)] {
            let Some(axis) = layout[index] else { continue };
            let grown = st.grow[index].value(now);
            let thickness = rest + (hover - rest) * grown;
            let rect = |start: f32, len: f32, thickness: f32| bar_rect(&axis, vertical, start, len, thickness);
            if classic {
                paint_rect(window, axis.strip, 0.0, scaled(track_color, 1.0));
            } else if grown > 0.0 {
                paint_rect(
                    window,
                    rect(0.0, axis.track_len, hover),
                    hover / 2.0,
                    scaled(track_color, grown),
                );
            }
            let thumb = rounded(
                rect(axis.thumb_start, axis.thumb_len, thickness),
                thickness / 2.0,
                scaled(thumb_color, 1.0),
            );
            // A list's one bar is along the vertical axis.
            if vertical && matches!(source, Source::List(..)) {
                note_thumb(window, Some(thumb));
                thumb_noted = true;
            } else {
                window.paint_quad(thumb);
            }
        }
    }
    if !thumb_noted {
        note_thumb(window, None);
    }

    window.on_mouse_event({
        let (state, source, hitboxes) = (state.clone(), source.clone(), hitboxes.clone());
        move |event: &gpui::MouseMoveEvent, phase, window, cx| {
            if phase != gpui::DispatchPhase::Capture {
                return;
            }
            let mut st = state.borrow_mut();
            if let Some(drag) = st.drag {
                let Some(axis) = st.layout[drag.axis] else { return };
                let travel = axis.track_len - axis.thumb_len;
                if travel > 0.0 {
                    let pointer = along(event.position, drag.axis == 1);
                    let fraction = (pointer - drag.grab - axis.track_start) / travel;
                    scroll_axis_to(&source, drag.axis, fraction.clamp(0.0, 1.0) * axis.max, axis.max);
                }
                cx.notify(view);
                return;
            }
            let hover = [0, 1].map(|index| {
                hitboxes[index]
                    .as_ref()
                    .is_some_and(|hitbox| hitbox.is_hovered(window))
            });
            if hover != st.hover {
                st.hover = hover;
                cx.notify(view);
            }
        }
    });
    window.on_mouse_event({
        let (state, source) = (state.clone(), source.clone());
        move |event: &gpui::MouseDownEvent, phase, window, cx| {
            if phase != gpui::DispatchPhase::Bubble || event.button != gpui::MouseButton::Left {
                return;
            }
            // A drag region covers the scrollbar under it, as in Electron.
            if crate::events::app_region::in_drag_region(window, event.position) {
                return;
            }
            let mut st = state.borrow_mut();
            for index in 0..2 {
                let (Some(hitbox), Some(axis)) = (&hitboxes[index], st.layout[index]) else {
                    continue;
                };
                if !hitbox.is_hovered(window) {
                    continue;
                }
                let pointer = along(event.position, index == 1);
                let thumb = axis.track_start + axis.thumb_start;
                if pointer >= thumb && pointer <= thumb + axis.thumb_len {
                    st.drag = Some(Drag { axis: index, grab: pointer - thumb });
                    source.drag(true);
                } else {
                    // Page toward the pointer.
                    let (_, offset) = source.extent();
                    let position = 0.0
                        - if index == 1 { f32::from(offset.y) } else { f32::from(offset.x) };
                    let page = axis.port_len * PAGE_FRACTION;
                    let next = if pointer < thumb { position - page } else { position + page };
                    scroll_axis_to(&source, index, next, axis.max);
                }
                cx.stop_propagation();
                cx.notify(view);
                return;
            }
        }
    });
    window.on_mouse_event({
        let (state, source) = (state.clone(), source.clone());
        move |_: &gpui::MouseUpEvent, phase, _, cx| {
            if phase == gpui::DispatchPhase::Capture && state.borrow_mut().drag.take().is_some() {
                source.drag(false);
                cx.notify(view);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thumb_is_the_viewports_share_of_the_content() {
        // 100 of 300: a third of the track.
        let (start, length) = scrollbar_thumb(100.0, 200.0, 0.0).unwrap();
        assert_eq!(start, 0.0);
        assert!((length - 100.0 / 3.0).abs() < 0.01);
    }

    #[test]
    fn a_thumb_runs_the_whole_track_as_the_content_runs_its_distance() {
        let (_, length) = scrollbar_thumb(100.0, 200.0, 0.0).unwrap();
        let (start, same_length) = scrollbar_thumb(100.0, 200.0, -200.0).unwrap();
        assert_eq!(length, same_length);
        assert!((start + length - 100.0).abs() < 0.01);
        let (halfway, _) = scrollbar_thumb(100.0, 200.0, -100.0).unwrap();
        assert!((halfway - (100.0 - length) / 2.0).abs() < 0.01);
    }

    #[test]
    fn a_thumb_stays_inside_the_track_when_the_offset_overshoots() {
        let (start, length) = scrollbar_thumb(100.0, 200.0, -450.0).unwrap();
        assert!((start + length - 100.0).abs() < 0.01);
        assert_eq!(scrollbar_thumb(100.0, 200.0, 30.0).unwrap().0, 0.0);
    }

    #[test]
    fn a_thumb_is_never_shorter_than_a_grabbable_length_nor_longer_than_the_track() {
        assert_eq!(scrollbar_thumb(100.0, 100_000.0, 0.0).unwrap().1, 20.0);
        assert_eq!(scrollbar_thumb(10.0, 100_000.0, 0.0).unwrap().1, 10.0);
    }

    #[test]
    fn content_that_fits_has_no_thumb() {
        assert_eq!(scrollbar_thumb(100.0, 0.0, 0.0), None);
        assert_eq!(scrollbar_thumb(100.0, 0.5, 0.0), None);
        assert_eq!(scrollbar_thumb(0.0, 200.0, 0.0), None);
    }

    #[test]
    fn colors_are_two_css_colors_with_spaces_allowed_inside_parentheses() {
        let context = crate::color::ColorContext::root(crate::color::Scheme::Light);
        let parse_colors = |value| parse_colors(value, &context);
        let (thumb, track) = parse_colors("rgb(255 0 0 / 50%)   #00ff00").unwrap();
        assert_eq!((thumb.r, thumb.a), (1.0, 0.5));
        assert_eq!(track.g, 1.0);
        assert!(parse_colors("#ff0000").is_none(), "one colour is not enough");
        assert!(parse_colors("red green blue").is_none());
        assert!(parse_colors("auto").is_none());
    }

    #[test]
    fn width_is_auto_thin_or_none() {
        let look = |width: &str| {
            Look::of(
                &StyleDesc { scrollbar_width: Some(width.to_string()), ..Default::default() },
                &crate::color::ColorContext::root(crate::color::Scheme::Light),
            )
        };
        assert_eq!(look("thin").thickness(), (4.0, 7.0));
        assert!(look("none").hidden());
        assert_eq!(look("auto").thickness(), (7.0, 11.0));
        assert_eq!(look("nonsense").thickness(), (7.0, 11.0));
    }

    fn classic_look(width: Option<&str>) -> Look {
        let mut look = Look::of(
            &StyleDesc { scrollbar_width: width.map(str::to_string), ..Default::default() },
            &crate::color::ColorContext::root(crate::color::Scheme::Light),
        );
        look.scroller = ScrollerStyle::Classic;
        look
    }

    #[test]
    fn a_classic_bar_takes_15_pixels_or_11_when_thin_and_an_overlay_takes_none() {
        assert_eq!(classic_look(None).gutter(), 15.0);
        assert_eq!(classic_look(Some("thin")).gutter(), 11.0);
        assert_eq!(classic_look(Some("none")).gutter(), 0.0);
        let overlay = Look::of(
            &StyleDesc::default(),
            &crate::color::ColorContext::root(crate::color::Scheme::Light),
        );
        assert_eq!(overlay.gutter(), 0.0);
    }

    #[test]
    fn a_classic_thumb_fills_its_gutter_less_the_inset_and_does_not_thicken() {
        assert_eq!(classic_look(None).thickness(), (9.0, 9.0));
        assert_eq!(classic_look(Some("thin")).thickness(), (7.0, 7.0));
        assert_eq!(classic_look(None).bar(), 15.0);
    }

    #[test]
    fn the_scrollbar_style_is_overlay_or_classic() {
        assert_eq!(ScrollerStyle::parse("overlay"), Ok(ScrollerStyle::Overlay));
        assert_eq!(ScrollerStyle::parse("classic"), Ok(ScrollerStyle::Classic));
        assert!(ScrollerStyle::parse("always").is_err());
    }

    #[test]
    fn scroll_reserves_a_gutter_and_auto_only_once_something_scrolls() {
        assert!(wants_gutter(Overflow::Scroll, false));
        assert!(!wants_gutter(Overflow::Auto, false));
        assert!(wants_gutter(Overflow::Auto, true));
        assert!(!wants_gutter(Overflow::Hidden, true));
        assert!(!wants_gutter(Overflow::Visible, true));
    }

    #[test]
    fn thickening_eases_over_150_ms_from_wherever_it_was() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut grow = Grow::default();
        assert_eq!(grow.value(at(0)), 0.0);
        grow.aim(1.0, at(0));
        assert_eq!(grow.value(at(0)), 0.0);
        assert!((grow.value(at(75)) - 0.5).abs() < 0.001);
        assert!(grow.value(at(30)) < 0.2, "eases in");
        assert_eq!(grow.value(at(150)), 1.0);
        assert_eq!(grow.value(at(10_000)), 1.0);
        assert!(grow.animating(at(149)) && !grow.animating(at(150)));

        // The pointer leaves halfway: it thins from where it got to, not from fully grown.
        let mut grow = Grow::default();
        grow.aim(1.0, at(0));
        grow.aim(0.0, at(75));
        assert!((grow.value(at(75)) - 0.5).abs() < 0.001);
        assert_eq!(grow.value(at(225)), 0.0);
    }

    #[test]
    fn a_bar_is_whole_for_a_second_then_fades_over_200_ms() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        assert_eq!(alpha_at(None, at(0)), 0.0);
        assert_eq!(alpha_at(Some(start), at(0)), 1.0);
        assert_eq!(alpha_at(Some(start), at(999)), 1.0);
        assert_eq!(alpha_at(Some(start), at(1000)), 1.0);
        assert!((alpha_at(Some(start), at(1100)) - 0.5).abs() < 0.001);
        assert_eq!(alpha_at(Some(start), at(1200)), 0.0);
        assert_eq!(alpha_at(Some(start), at(60_000)), 0.0);
    }

    #[test]
    fn a_bar_is_stale_once_the_clock_has_changed_what_it_painted() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut st = State {
            last_active: Some(start),
            painted: Painted { alpha: 1.0, grow: [0.0; 2] },
            ..State::default()
        };
        assert!(!st.stale_at(at(0)));
        assert!(!st.stale_at(at(999)), "the hold changes nothing on screen");
        assert!(st.stale_at(at(1001)), "the fade has begun");
        st.pinned = true;
        assert!(!st.stale_at(at(60_000)), "a bar the pointer holds or a classic one stays");
        st.pinned = false;
        st.painted.alpha = 0.0;
        assert!(!st.stale_at(at(60_000)), "a bar that is gone stays gone");
    }

    #[test]
    fn a_bar_that_thickens_is_stale_until_it_has_painted_the_end_of_the_ease() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut st = State { pinned: true, painted: Painted { alpha: 1.0, grow: [0.0; 2] }, ..State::default() };
        st.grow[1].aim(1.0, start);
        assert!(!st.stale_at(at(0)));
        assert!(st.stale_at(at(75)));
        st.painted.grow = [0.0, st.grow[1].value(at(150))];
        assert!(!st.stale_at(at(5000)));
    }

    #[test]
    fn aiming_at_the_same_target_does_not_restart_the_ease() {
        let start = Instant::now();
        let mut grow = Grow::default();
        grow.aim(1.0, start);
        grow.aim(1.0, start + Duration::from_millis(100));
        assert_eq!(grow.value(start + Duration::from_millis(150)), 1.0);
    }
}
