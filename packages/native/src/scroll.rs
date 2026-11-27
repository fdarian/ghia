//! Scrolling, as a browser does it: which elements scroll, how far they can, and how a
//! script moves them.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use gpui::prelude::*;
use web_time::Instant;

use crate::style::StyleDesc;
use crate::window_map::WindowMap;

/// What one axis of CSS `overflow` does to the element's content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Overflow {
    Visible,
    /// `clip`: the content is cut off and the element is not a scroll container.
    Clip,
    /// `hidden`: cut off, but a scroll container that only code scrolls, as in a browser.
    Hidden,
    Scroll,
    /// Scrolls like `scroll`. It differs only when scrollbars take layout space (see
    /// [`crate::scrollbar::ScrollerStyle::Classic`]): `auto` reserves the room once there is
    /// something to scroll.
    Auto,
}

impl Overflow {
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value {
            Some("scroll") => Self::Scroll,
            Some("auto") => Self::Auto,
            Some("hidden") => Self::Hidden,
            Some("clip") => Self::Clip,
            _ => Self::Visible,
        }
    }

    pub(crate) fn clips(self) -> bool {
        self != Self::Visible
    }

    /// Whether the element has a scroll offset: `scroll`, `auto` and `hidden`.
    pub(crate) fn has_offset(self) -> bool {
        matches!(self, Self::Scroll | Self::Auto | Self::Hidden)
    }

    /// Whether the user scrolls it, which is what gets a scrollbar.
    pub(crate) fn scrolls_for_user(self) -> bool {
        matches!(self, Self::Scroll | Self::Auto)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Axes {
    pub x: Overflow,
    pub y: Overflow,
}

impl Axes {
    /// The computed overflow of a style: `overflowX` and `overflowY` override the `overflow`
    /// shorthand, and `visible` beside `hidden`, `scroll` or `auto` computes to `auto`, so that
    /// axis is clipped and scrolls too. Beside `clip` it stays `visible` (CSS Overflow 3).
    pub(crate) fn of(style: &StyleDesc) -> Self {
        let declared = Self::declared(style);
        let scroll_container = declared.x.has_offset() || declared.y.has_offset();
        let computed = |overflow: Overflow| {
            if scroll_container && overflow == Overflow::Visible {
                Overflow::Auto
            } else {
                overflow
            }
        };
        Self {
            x: computed(declared.x),
            y: computed(declared.y),
        }
    }

    /// What the style says, before `visible` is resolved against the other axis. A state style
    /// that declares one axis is read with this, since the other axis is the base style's.
    pub(crate) fn declared(style: &StyleDesc) -> Self {
        Self {
            x: Overflow::parse(style.overflow_x.as_deref().or(style.overflow.as_deref())),
            y: Overflow::parse(style.overflow_y.as_deref().or(style.overflow.as_deref())),
        }
    }

    /// Whether the element has a scroll offset on either axis.
    pub(crate) fn scrolls(self) -> bool {
        self.x.has_offset() || self.y.has_offset()
    }
}

fn overscroll(value: Option<&str>) -> gpui::OverscrollBehavior {
    match value {
        Some("contain") => gpui::OverscrollBehavior::Contain,
        Some("none") => gpui::OverscrollBehavior::None,
        _ => gpui::OverscrollBehavior::Auto,
    }
}

/// The vertical `overscrollBehavior` of a style: the axis value, else the shorthand.
pub(crate) fn overscroll_y(style: &StyleDesc) -> gpui::OverscrollBehavior {
    overscroll(
        style
            .overscroll_behavior_y
            .as_deref()
            .or(style.overscroll_behavior.as_deref()),
    )
}

/// Makes `el` a scroll container if its style asks for one, and drops the handle of an
/// element that no longer is.
///
/// The handle outlives the frame in `handles`, which is how GPUI keeps the offset between
/// renders. Overflow never changes `display` or the element's children: a scroller lays out
/// exactly as it would without `overflow`.
pub(crate) fn apply_container<E: gpui::Styled + gpui::StatefulInteractiveElement>(
    mut el: E,
    window: gpui::WindowId,
    id: u64,
    style: Option<&StyleDesc>,
    colors: &crate::color::ColorContext,
    handles: &mut HashMap<u64, gpui::ScrollHandle>,
) -> E {
    let Some(style) = style else {
        handles.remove(&id);
        set_smooth_by_default(window, id, false);
        return el;
    };
    let axes = Axes::of(style);
    if !axes.scrolls() {
        handles.remove(&id);
        set_smooth_by_default(window, id, false);
        return el;
    }
    el = match (axes.x.has_offset(), axes.y.has_offset()) {
        (true, true) => el.overflow_scroll(),
        (true, false) => el.overflow_x_scroll(),
        _ => el.overflow_y_scroll(),
    };
    el = el.programmatic_scroll_only(axes.x == Overflow::Hidden, axes.y == Overflow::Hidden);
    // A browser moves both axes of a diagonal wheel, and gives each axis only its own delta.
    // This is also what makes GPUI hand the unused delta to an ancestor.
    el.style().allow_concurrent_scroll = Some(true);
    let both = style.overscroll_behavior.as_deref();
    el = el.overscroll_behavior(
        overscroll(style.overscroll_behavior_x.as_deref().or(both)),
        overscroll(style.overscroll_behavior_y.as_deref().or(both)),
    );
    set_smooth_by_default(window, id, style.scroll_behavior.as_deref() == Some("smooth"));
    let handle = handles.entry(id).or_insert_with(gpui::ScrollHandle::new);
    el = el.track_scroll(handle);
    if axes.x.scrolls_for_user() || axes.y.scrolls_for_user() {
        el = crate::scrollbar::attach(
            el,
            window,
            id,
            crate::scrollbar::Source::Container {
                id,
                handle: handle.clone(),
            },
            style,
            colors,
            [axes.x, axes.y],
        );
    }
    el
}

/// What a frame that moved the content of the scroller `id` in place (`Window::note_scroll_moved`) leaves to its
/// owner: the boxes the build wrote for the elements between it and the roots that moved, which no root's tape moves
/// (`WindowBounds::shift_built`).
pub(crate) fn on_translated<E: gpui::StatefulInteractiveElement>(
    el: E,
    window: gpui::WindowId,
    id: u64,
    tree: std::sync::Arc<std::sync::Mutex<crate::retained_tree::RetainedTree>>,
) -> E {
    let ready = tree.clone();
    el.on_scroll_translated(
        move || ready.try_lock().is_ok(),
        move |_, _, translation| {
            let tree = tree.try_lock().expect("the translate was planned with the tree free; what runs between the plan and the write (thumb moved callbacks, `RetainedPhase::Scrolled` hooks) does not hold its lock");
            let roots: rustc_hash::FxHashSet<u64> = translation.roots.iter().filter_map(crate::renderer::retained_root_of).collect();
            let mut built = Vec::new();
            let scroller = tree.elements.get(&id).expect("the gate found the tree as the frame shown was built from, which has the scroller");
            let mut pending: Vec<u64> = scroller.children.clone();
            while let Some(child) = pending.pop() {
                if roots.contains(&child) {
                    continue;
                }
                built.push(child);
                if let Some(element) = tree.elements.get(&child) {
                    pending.extend(element.children.iter().copied());
                }
            }
            crate::automation::shift_built(window, &built, translation.shift);
        },
    )
}

/// `[scrollLeft, scrollTop, scrollWidth, scrollHeight, clientWidth, clientHeight]` as the DOM
/// reports them. The scroll position is a whole device pixel (see [`dom_position`]). `painted` is the element's box, which an element that does not scroll has no
/// scroll handle for: its content is as big as it is.
///
/// The sizes are integers, as Chrome's are: the size of the padding box (or of the scrollable
/// overflow) rounded half up, from what layout measured and not from the boxes as painted, so a
/// fractional width reads as Chrome reads it.
pub(crate) fn metrics(
    handle: Option<&gpui::ScrollHandle>,
    painted: Option<crate::automation::ElementBounds>,
) -> Option<[f64; 6]> {
    let painted = painted?;
    let (reserved_width, reserved_height) = handle.map_or((0.0, 0.0), |handle| {
        let bars = handle.scrollbar_size();
        (f64::from(f32::from(bars.width)), f64::from(f32::from(bars.height)))
    });
    let client = ClientBox::of(painted, reserved_width, reserved_height);
    let Some(handle) = handle else {
        return Some(client.unscrolled());
    };
    let offset = clamp_offset(handle.offset(), handle.max_offset());
    let position = dom_position(offset, handle.scale_factor());
    Some([
        position[0],
        position[1],
        round_half_up(client.width.max(painted.content_width)),
        round_half_up(client.height.max(painted.content_height)),
        client.rounded_width,
        client.rounded_height,
    ])
}

/// [`metrics`] of a virtual list, which scrolls by the rows it holds and not by a handle, from its
/// last layout: `scrollTop` is its offset and `scrollHeight` the rows and the padding around them.
/// `None` is a list that has not been laid out, which has no box to measure.
pub(crate) fn list_metrics(list: Option<gpui::ListDomScroll>) -> Option<[f64; 6]> {
    let list = list?;
    let client_width = round_half_up(f64::from(f32::from(list.client.width)));
    let client_height = round_half_up(f64::from(f32::from(list.client.height)));
    Some([
        0.0,
        f64::from(f32::from(list.top)),
        client_width,
        round_half_up(f64::from(f32::from(list.client.height.max(list.content_height)))),
        client_width,
        client_height,
    ])
}

/// The padding box of an element less what is reserved for scrollbars, as layout measured it.
struct ClientBox {
    width: f64,
    height: f64,
    rounded_width: f64,
    rounded_height: f64,
}

impl ClientBox {
    fn of(painted: crate::automation::ElementBounds, reserved_width: f64, reserved_height: f64) -> Self {
        // A collapsed table's outer halves are its border for `clientLeft` but not for its client size (see `ElementBounds::collapsed_table`).
        let (border_x, border_y) = if painted.collapsed_table {
            (0.0, 0.0)
        } else {
            (painted.client_left + painted.border_right, painted.client_top + painted.border_bottom)
        };
        let width = (painted.width - border_x - reserved_width).max(0.0);
        let height = (painted.height - border_y - reserved_height).max(0.0);
        Self {
            width,
            height,
            rounded_width: round_half_up(width),
            rounded_height: round_half_up(height),
        }
    }

    /// An element with nothing to scroll: its content is as big as it is.
    fn unscrolled(&self) -> [f64; 6] {
        [0.0, 0.0, self.rounded_width, self.rounded_height, self.rounded_width, self.rounded_height]
    }
}

/// `Math.round`, which is how Chrome rounds a `LayoutUnit` for `clientWidth` and `scrollWidth`.
fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn clamp_offset(
    offset: gpui::Point<gpui::Pixels>,
    max: gpui::Point<gpui::Pixels>,
) -> gpui::Point<gpui::Pixels> {
    gpui::point(
        offset.x.clamp(-max.x, gpui::px(0.0)),
        offset.y.clamp(-max.y, gpui::px(0.0)),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Behavior {
    /// Follow the scroller's `scrollBehavior` style.
    Auto,
    Instant,
    Smooth,
}

impl Behavior {
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            None | Some("auto") => Ok(Self::Auto),
            Some("instant") => Ok(Self::Instant),
            Some("smooth") => Ok(Self::Smooth),
            Some(other) => Err(format!(
                "Unknown scroll behavior \"{other}\", expected \"auto\", \"instant\" or \"smooth\""
            )),
        }
    }
}

thread_local! {
    /// Scrollers whose `scrollBehavior` style is `smooth`, for calls that name no behavior.
    /// `apply_container` says for each scroller it builds whether it is one, and a frame that does
    /// not build a scroller leaves what it said. Thread-local like `SCROLL_HANDLES`, so the
    /// same napi calls can reach it without a window update.
    static SMOOTH_BY_DEFAULT: RefCell<WindowMap<()>> = RefCell::new(WindowMap::default());
    static ANIMATIONS: RefCell<WindowMap<Animation>> = RefCell::new(WindowMap::default());
    /// What code wrote to the scrollers of each window since its hover last took it, see [`take_writes`].
    static WRITES: RefCell<HashMap<gpui::WindowId, Writes>> = RefCell::new(HashMap::new());
}

/// The scrolls code made in a window that the hover under a still pointer has not heard of yet
/// (`events/hover_after_scroll.rs`): a scroller moved at once, or began a smooth scroll.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Writes {
    pub instant: bool,
    pub smooth: bool,
}

/// Records that code scrolled a scroller of `window`: every scroll a script, a key, a bar or a
/// `scrollIntoView` makes ends here, so the hover follows it as it follows `scrollTo`.
pub(crate) fn note_write(window: gpui::WindowId, smooth: bool) {
    WRITES.with(|writes| {
        let mut writes = writes.borrow_mut();
        let written = writes.entry(window).or_default();
        if smooth {
            written.smooth = true;
        } else {
            written.instant = true;
        }
    });
}

/// What was written to the scrollers of `window` since the last call.
pub(crate) fn take_writes(window: gpui::WindowId) -> Writes {
    WRITES.with(|writes| writes.borrow_mut().remove(&window)).unwrap_or_default()
}

/// Call before building a frame of `window`, so a scroller that was removed does not keep
/// `scrollBehavior: "smooth"`.
pub(crate) fn begin_frame(window: gpui::WindowId, exists: impl Fn(u64) -> bool) {
    SMOOTH_BY_DEFAULT.with(|smooth| smooth.borrow_mut().of_mut(window).retain(|id, _| exists(*id)));
}

/// Drops the scroll state of a window that closed: its smooth scrolls end with it.
pub(crate) fn forget_window(window: gpui::WindowId) {
    SMOOTH_BY_DEFAULT.with(|smooth| smooth.borrow_mut().forget(window));
    ANIMATIONS.with(|animations| animations.borrow_mut().forget(window));
    WRITES.with(|writes| writes.borrow_mut().remove(&window));
}

/// Whether `id` is an element that has a box to scroll in the layout being built. One under
/// `display: none` has none, and the DOM ignores a scroll position set on it; one below a
/// skipped element has one only in a pass that forces that element for a read of geometry, which
/// is also what lets `scrollHeight` of a scroller in skipped content be its extent.
pub(crate) fn has_scrolling_box(tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
    tree.elements
        .get(&id)
        .is_some_and(|element| !crate::layout::box_generation::is_hidden_in_pass(tree, element))
}

fn set_smooth_by_default(window: gpui::WindowId, id: u64, smooth: bool) {
    SMOOTH_BY_DEFAULT.with(|set| {
        if smooth {
            set.borrow_mut().insert(window, id, ());
        } else {
            set.borrow_mut().remove(window, id);
        }
    });
}

pub(crate) fn is_smooth(window: gpui::WindowId, id: u64, behavior: Behavior) -> bool {
    match behavior {
        Behavior::Smooth => true,
        Behavior::Instant => false,
        Behavior::Auto => SMOOTH_BY_DEFAULT.with(|smooth| smooth.borrow().contains(window, id)),
    }
}

/// The scroll offset GPUI keeps (how far the content moved: zero, then negative) for a DOM scroll
/// position (`scrollLeft`, `scrollTop`: zero or more). `0.0 - v`, not `-v`, so a position of
/// zero stays `+0`. Every renderer method that takes a scroll position goes through here and
/// through [`dom_position`]: this pair is the only place the sign flips.
pub(crate) fn gpui_offset(left: f64, top: f64) -> gpui::Point<gpui::Pixels> {
    gpui::point(gpui::px((0.0 - left) as f32), gpui::px((0.0 - top) as f32))
}

/// The DOM scroll position `[scrollLeft, scrollTop]` of a GPUI scroll offset, rounded half up to a
/// device pixel of a window of `scale`, as Chrome reads back a scroll offset that lies between two
/// (a wheel or a trackpad scrolls by fractions). `None` is a scroller that has not been laid out,
/// which has no scale to snap to and is read as it is stored.
pub(crate) fn dom_position(offset: gpui::Point<gpui::Pixels>, scale: Option<f32>) -> [f64; 2] {
    [
        snap_to_device(0.0 - f64::from(f32::from(offset.x)), scale),
        snap_to_device(0.0 - f64::from(f32::from(offset.y)), scale),
    ]
}

fn snap_to_device(position: f64, scale: Option<f32>) -> f64 {
    match scale {
        Some(scale) => {
            let scale = f64::from(scale);
            (position * scale + 0.5).floor() / scale
        }
        None => position,
    }
}

/// `offset` held to a whole device pixel: the offset whose [`dom_position`] is the position it
/// would be written back as. A write is rounded here before it is clamped, as Chrome snaps the
/// offset a script asks for.
pub(crate) fn snapped_offset(offset: gpui::Point<gpui::Pixels>, scale: Option<f32>) -> gpui::Point<gpui::Pixels> {
    let position = dom_position(offset, scale);
    gpui_offset(position[0], position[1])
}

/// The DOM scroll position of a scroll container, held to the range of the last layout: a write
/// that was recorded before the layout that clamps it reads back clamped.
pub(crate) fn handle_position(handle: &gpui::ScrollHandle) -> [f64; 2] {
    dom_position(clamp_offset(handle.offset(), handle.max_offset()), handle.scale_factor())
}

/// The DOM scroll position of a scroll container as it is stored, which a write that was not clamped
/// yet has out of the range.
pub(crate) fn stored_position(handle: &gpui::ScrollHandle) -> [f64; 2] {
    dom_position(handle.offset(), handle.scale_factor())
}

/// The DOM scroll position of a virtual list.
pub(crate) fn list_position(state: &gpui::ListState) -> [f64; 2] {
    match state.dom_scroll() {
        Some(list) => [0.0, f64::from(f32::from(list.top))],
        None => dom_position(state.scroll_px_offset_for_scrollbar(), None),
    }
}

/// Scrolls a virtual list to `target` (an offset: zero, then negative) rounded to a device pixel
/// and held to the range of the last layout. Returns whether it moved.
pub(crate) fn scroll_list_to(window: gpui::WindowId, state: &gpui::ListState, target: gpui::Point<gpui::Pixels>) -> bool {
    let before = state.scroll_px_offset_for_scrollbar();
    state.set_offset_from_scrollbar(snapped_offset(target, state.scale_factor()));
    let moved = state.scroll_px_offset_for_scrollbar() != before;
    if moved {
        note_write(window, false);
    }
    moved
}

/// Moves a virtual list to the offset of a thumb or a click on its track, which is not rounded to a device pixel
/// as a write of code is. Returns whether it moved.
pub(crate) fn scroll_list_by_bar(window: gpui::WindowId, state: &gpui::ListState, offset: gpui::Point<gpui::Pixels>) -> bool {
    let before = state.scroll_px_offset_for_scrollbar();
    state.set_offset_from_scrollbar(offset);
    let moved = state.scroll_px_offset_for_scrollbar() != before;
    if moved {
        note_write(window, false);
    }
    moved
}

/// Scrolls a virtual list to a row (`ListState::scroll_to`), which lays out later: it is a write now.
pub(crate) fn scroll_list_to_row(window: gpui::WindowId, state: &gpui::ListState, offset: gpui::ListOffset) {
    state.scroll_to(offset);
    note_write(window, false);
}

/// Moves a scroller to `target` (an offset: zero, then negative), instantly or by a smooth
/// animation. A new call replaces the animation in flight, and a target the scroller is already
/// at only does that: it moves nothing, so the caller need not draw or report a scroll. Returns
/// whether the scroller moved or will.
///
/// `target` is rounded to a device pixel and then held to the range of the last layout, as
/// `scrollTop = n` is in a browser, which lays out first when the tree changed: a caller whose
/// layout is older than the tree lays out before it calls, or records the write for the layout
/// that comes next (see `scroll_write`), and a scroller that shrinks later is clamped by the layout
/// that shrank it.
pub(crate) fn scroll_to(
    window: gpui::WindowId,
    id: u64,
    handle: &gpui::ScrollHandle,
    target: gpui::Point<gpui::Pixels>,
    behavior: Behavior,
) -> bool {
    let target = clamp_offset(snapped_offset(target, handle.scale_factor()), handle.max_offset());
    move_to(window, id, handle, target, behavior)
}

/// Ends the smooth scroll of `id` in flight, which any other write to it does.
pub(crate) fn end_smooth_scroll(window: gpui::WindowId, id: u64) {
    ANIMATIONS.with(|animations| animations.borrow_mut().remove(window, id));
}

fn move_to(
    window: gpui::WindowId,
    id: u64,
    handle: &gpui::ScrollHandle,
    target: gpui::Point<gpui::Pixels>,
    behavior: Behavior,
) -> bool {
    end_smooth_scroll(window, id);
    if target == handle.offset() {
        return false;
    }
    let smooth = is_smooth(window, id, behavior);
    note_write(window, smooth);
    if !smooth {
        handle.set_offset(target);
        return true;
    }
    ANIMATIONS.with(|animations| {
        animations.borrow_mut().insert(
            window,
            id,
            Animation {
                handle: handle.clone(),
                from: handle.offset(),
                to: target,
                started: None,
                duration: Duration::ZERO,
                written: handle.offset(),
            },
        );
    });
    true
}

struct Animation {
    handle: gpui::ScrollHandle,
    from: gpui::Point<gpui::Pixels>,
    to: gpui::Point<gpui::Pixels>,
    /// Set by the first frame that sees the animation, so it runs on the clock that frame uses.
    started: Option<Instant>,
    duration: Duration,
    /// What this animation last wrote. An offset that differs belongs to someone else (the
    /// wheel, a scrollbar, an instant `scrollTo`), which ends the animation.
    written: gpui::Point<gpui::Pixels>,
}

/// The shortest and longest a smooth scroll takes. A longer distance takes longer, up to the cap.
const SMOOTH_MIN: Duration = Duration::from_millis(300);
const SMOOTH_MAX: Duration = Duration::from_millis(450);
const SMOOTH_MS_PER_PX: f32 = 0.05;
/// Material's standard curve: quick to get going, long to settle, like a browser's.
const SMOOTH_CURVE: [f64; 4] = [0.4, 0.0, 0.2, 1.0];

/// Whether a smooth scroll has frames to run.
#[cfg(test)]
pub(crate) fn animating() -> bool {
    ANIMATIONS.with(|animations| !animations.borrow().is_empty())
}

/// Whether a smooth scroll of a scroller of `window` has frames to run.
pub(crate) fn animating_in(window: gpui::WindowId) -> bool {
    ANIMATIONS.with(|animations| !animations.borrow().of(window).is_empty())
}

/// Advances the smooth scrolls of `window` to `now`. True while one still has frames to run.
pub(crate) fn advance_animations(window: gpui::WindowId, now: Instant) -> bool {
    ANIMATIONS.with(|animations| {
        let mut animations = animations.borrow_mut();
        let held = animations.of_mut(window);
        held.retain(|_, animation| advance(animation, now));
        !held.is_empty()
    })
}

fn advance(animation: &mut Animation, now: Instant) -> bool {
    let current = animation.handle.offset();
    if animation.started.is_some() && current != animation.written {
        return false;
    }
    let started = match animation.started {
        Some(started) => started,
        None => {
            let distance = f32::from(animation.to.x - animation.from.x)
                .abs()
                .max(f32::from(animation.to.y - animation.from.y).abs());
            let extra = Duration::from_secs_f32(distance * SMOOTH_MS_PER_PX / 1000.0);
            animation.duration = (SMOOTH_MIN + extra).min(SMOOTH_MAX);
            animation.started = Some(now);
            now
        }
    };
    let progress = (now.saturating_duration_since(started).as_secs_f64()
        / animation.duration.as_secs_f64())
    .min(1.0);
    // The curve is solved numerically; the ends are exact so a finished scroll lands on its target.
    let eased = if progress <= 0.0 {
        0.0
    } else if progress >= 1.0 {
        1.0
    } else {
        crate::motion::cubic_bezier(progress, SMOOTH_CURVE) as f32
    };
    let lerp = |from: gpui::Pixels, to: gpui::Pixels| from + (to - from) * eased;
    let next = clamp_offset(
        gpui::point(
            lerp(animation.from.x, animation.to.x),
            lerp(animation.from.y, animation.to.y),
        ),
        animation.handle.max_offset(),
    );
    animation.handle.set_offset(next);
    animation.written = next;
    progress < 1.0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Align {
    Start,
    Center,
    End,
    Nearest,
}

impl Align {
    pub(crate) fn parse(value: Option<&str>, default: Self) -> Result<Self, String> {
        match value {
            None => Ok(default),
            Some("start") => Ok(Self::Start),
            Some("center") => Ok(Self::Center),
            Some("end") => Ok(Self::End),
            Some("nearest") => Ok(Self::Nearest),
            Some(other) => Err(format!(
                "Unknown scroll alignment \"{other}\", expected \"start\", \"center\", \"end\" or \"nearest\""
            )),
        }
    }
}

/// What `scrollIntoView` was asked for, with the DOM's defaults.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IntoView {
    pub block: Align,
    pub inline: Align,
    pub behavior: Behavior,
}

impl IntoView {
    /// What a browser does for a newly focused element: the nearest edge, and only if it is
    /// not in view.
    pub(crate) const NEAREST: Self = Self {
        block: Align::Nearest,
        inline: Align::Nearest,
        behavior: Behavior::Auto,
    };

    pub(crate) fn parse(
        block: Option<&str>,
        inline: Option<&str>,
        behavior: Option<&str>,
    ) -> Result<Self, String> {
        Ok(Self {
            block: Align::parse(block, Align::Start)?,
            inline: Align::parse(inline, Align::Nearest)?,
            behavior: Behavior::parse(behavior)?,
        })
    }
}

pub(crate) fn parse_touch_phase(value: Option<&str>) -> Result<gpui::TouchPhase, String> {
    match value {
        // Each simulated wheel call is a gesture of its own unless the caller says it
        // continues one, so a test that wheels two scrollers in a row is not latched to the first.
        None | Some("started") => Ok(gpui::TouchPhase::Started),
        Some("moved") => Ok(gpui::TouchPhase::Moved),
        Some("ended") => Ok(gpui::TouchPhase::Ended),
        Some("cancelled") => Ok(gpui::TouchPhase::Cancelled),
        Some(other) => Err(format!(
            "Unknown touch phase \"{other}\", expected \"started\", \"moved\", \"ended\" or \"cancelled\""
        )),
    }
}

/// The change in `scrollTop` (or `scrollLeft`) that puts the target (`target_start..target_end`)
/// in the scrollport (`port_start..port_end`) as `align` asks. All in the same coordinates.
/// `Nearest` follows CSSOM View.
pub(crate) fn align_delta(
    align: Align,
    target_start: f32,
    target_end: f32,
    port_start: f32,
    port_end: f32,
) -> f32 {
    match align {
        Align::Start => target_start - port_start,
        Align::End => target_end - port_end,
        Align::Center => (target_start + target_end) / 2.0 - (port_start + port_end) / 2.0,
        Align::Nearest => {
            let before = target_start < port_start;
            let after = target_end > port_end;
            let fits = target_end - target_start < port_end - port_start;
            match (before, after) {
                (false, false) | (true, true) => 0.0,
                (true, false) if fits => target_start - port_start,
                (true, false) => target_end - port_end,
                (false, true) if fits => target_end - port_end,
                (false, true) => target_start - port_start,
            }
        }
    }
}

/// What a scrolling key asks for, with the amounts a browser uses.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct KeyScroll {
    vertical: bool,
    amount: KeyAmount,
    /// Space also activates a focused control, which wins over scrolling.
    pub(crate) activates_controls: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum KeyAmount {
    Pixels(f32),
    /// Fraction of the client size.
    Pages(f32),
    Start,
    End,
}

const ARROW_STEP: f32 = 40.0;
const PAGE_FRACTION: f32 = 0.9;

impl KeyScroll {
    /// `None` for a key that does not scroll. `key` is the GPUI key name.
    pub(crate) fn parse(key: &str, shift: bool) -> Option<Self> {
        let (vertical, amount) = match key {
            "up" => (true, KeyAmount::Pixels(-ARROW_STEP)),
            "down" => (true, KeyAmount::Pixels(ARROW_STEP)),
            "left" => (false, KeyAmount::Pixels(-ARROW_STEP)),
            "right" => (false, KeyAmount::Pixels(ARROW_STEP)),
            "pageup" => (true, KeyAmount::Pages(-PAGE_FRACTION)),
            "pagedown" => (true, KeyAmount::Pages(PAGE_FRACTION)),
            "space" => (true, KeyAmount::Pages(if shift { -PAGE_FRACTION } else { PAGE_FRACTION })),
            "home" => (true, KeyAmount::Start),
            "end" => (true, KeyAmount::End),
            _ => return None,
        };
        Some(Self {
            vertical,
            amount,
            activates_controls: key == "space",
        })
    }

    /// Whether a focused editable still scrolls for `key`. Chrome on macOS binds Home, End, Page Up
    /// and Page Down to `scrollToBeginningOfDocument:` and friends, which scroll the nearest scroller
    /// under the caret; arrows and Space are editing keys, and with Shift Page Up and Down extend the
    /// selection instead.
    pub(crate) fn scrolls_under_editable(key: &str, shift: bool) -> bool {
        match key {
            "home" | "end" => true,
            "pageup" | "pagedown" => !shift,
            _ => false,
        }
    }

    /// Where `handle` would scroll to, or `None` if it cannot move that way.
    fn target(self, handle: &gpui::ScrollHandle) -> Option<gpui::Point<gpui::Pixels>> {
        let offset = handle.offset();
        let max = handle.max_offset();
        let client = handle.padding_box().size;
        let user = handle.user_scrollable();
        if !(if self.vertical { user.y } else { user.x }) {
            return None;
        }
        let (position, range, size) = if self.vertical {
            (-f32::from(offset.y), f32::from(max.y), f32::from(client.height))
        } else {
            (-f32::from(offset.x), f32::from(max.x), f32::from(client.width))
        };
        let next = match self.amount {
            KeyAmount::Pixels(step) => position + step,
            KeyAmount::Pages(fraction) => position + fraction * size,
            KeyAmount::Start => 0.0,
            KeyAmount::End => range,
        }
        .clamp(0.0, range.max(0.0));
        if (next - position).abs() < 0.01 {
            return None;
        }
        // `0.0 -` rather than negation: an offset of 0 must be +0, not -0.
        Some(if self.vertical {
            gpui::point(offset.x, gpui::px(0.0 - next))
        } else {
            gpui::point(gpui::px(0.0 - next), offset.y)
        })
    }
}

/// Scrolls the first of `scrollers` (innermost first) that can move the way `key` asks.
pub(crate) fn scroll_by_key<'a>(
    window: gpui::WindowId,
    scrollers: impl IntoIterator<Item = (u64, &'a gpui::ScrollHandle)>,
    key: KeyScroll,
) -> bool {
    for (id, handle) in scrollers {
        if let Some(target) = key.target(handle) {
            scroll_to(window, id, handle, target, Behavior::Auto);
            return true;
        }
    }
    false
}

/// A box in the window's space, or in the space of one scroller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    /// The box with sides parallel to the axes that holds the corners of this one after `matrix`
    /// (what of it is behind the eye of a perspective is cut off first), or `None` for a box that
    /// is all behind the eye.
    pub(crate) fn through(&self, matrix: &gpui::TransformationMatrix) -> Option<Self> {
        if !matrix.is_affine() {
            let bounds = gpui::Bounds::new(
                gpui::point(gpui::px(self.x), gpui::px(self.y)),
                gpui::size(gpui::px(self.width), gpui::px(self.height)),
            );
            let mapped = matrix.try_bounding_box(bounds)?;
            return Some(Self {
                x: f32::from(mapped.origin.x),
                y: f32::from(mapped.origin.y),
                width: f32::from(mapped.size.width),
                height: f32::from(mapped.size.height),
            });
        }
        let [[a, b], [c, d]] = matrix.linear().map(|row| row.map(f64::from));
        let [e, f] = matrix.translation().map(f64::from);
        let (x0, y0) = (f64::from(self.x), f64::from(self.y));
        let (x1, y1) = (x0 + f64::from(self.width), y0 + f64::from(self.height));
        let (mut left, mut top) = (f64::INFINITY, f64::INFINITY);
        let (mut right, mut bottom) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
            let (x, y) = (a * x + b * y + e, c * x + d * y + f);
            left = left.min(x);
            right = right.max(x);
            top = top.min(y);
            bottom = bottom.max(y);
        }
        Some(Self { x: left as f32, y: top as f32, width: (right - left) as f32, height: (bottom - top) as f32 })
    }
}

/// Scrolls one scroll container so `target`, a box in the space it lays out in, sits where
/// `options` ask, and moves `target` to where that leaves it, for the next container out. False
/// if the container could not move.
pub(crate) fn scroll_into_view(
    window: gpui::WindowId,
    id: u64,
    handle: &gpui::ScrollHandle,
    target: &mut Rect,
    options: IntoView,
) -> bool {
    let port = handle.padding_box();
    let max = handle.max_offset();
    let offset = handle.offset();
    let along = |scrolls: bool, align, start: f32, length: f32, port_start: gpui::Pixels, port_end: gpui::Pixels| {
        if !scrolls {
            return 0.0;
        }
        align_delta(align, start, start + length, f32::from(port_start), f32::from(port_end))
    };
    let dx = along(
        f32::from(max.x) > 0.0,
        options.inline,
        target.x,
        target.width,
        port.left(),
        port.right(),
    );
    let dy = along(
        f32::from(max.y) > 0.0,
        options.block,
        target.y,
        target.height,
        port.top(),
        port.bottom(),
    );
    let next = clamp_offset(
        snapped_offset(
            gpui::point(offset.x - gpui::px(dx), offset.y - gpui::px(dy)),
            handle.scale_factor(),
        ),
        max,
    );
    if next == offset {
        return false;
    }
    target.x += f32::from(next.x - offset.x);
    target.y += f32::from(next.y - offset.y);
    scroll_to(window, id, handle, next, options.behavior);
    true
}

/// Scrolls the scroller `id` to `window_box`, a box of the window, and gives the box that holds
/// the target after it. `None` where the scroller's transform flattens the plane.
pub(crate) fn scroll_in_its_space(
    window_id: gpui::WindowId,
    id: u64,
    handle: &gpui::ScrollHandle,
    window_box: Rect,
    options: IntoView,
    scrolled: &mut bool,
) -> Option<Rect> {
    let space = crate::automation::get_bounds(window_id, id)?;
    if !space.is_transformed() {
        let mut target = window_box;
        *scrolled |= scroll_into_view(window_id, id, handle, &mut target, options);
        return Some(target);
    }
    let mut target = window_box.through(&space.to_window.inverse()?)?;
    *scrolled |= scroll_into_view(window_id, id, handle, &mut target, options);
    target.through(&space.to_window)
}

/// The `offset_in_item` that scrolls a virtual list's row (`top`, `height` in window
/// coordinates, if it is painted) as `align` asks, given the list's viewport. `None` when
/// `Nearest` finds the row already in view. A row that is not painted cannot be measured, so it
/// goes to the top of the viewport.
pub(crate) fn virtual_list_offset(
    align: Align,
    row: Option<(f32, f32)>,
    viewport: (f32, f32),
) -> Option<f32> {
    let Some((top, height)) = row else {
        return Some(0.0);
    };
    let (port_top, port_height) = viewport;
    let delta = align_delta(align, top, top + height, port_top, port_top + port_height);
    if align == Align::Nearest && delta == 0.0 {
        return None;
    }
    Some(port_top + delta - top)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_focused_editable_keeps_the_arrows_and_space_and_scrolls_for_the_document_keys() {
        for key in ["up", "down", "left", "right", "space"] {
            assert!(!KeyScroll::scrolls_under_editable(key, false), "{key}");
            assert!(!KeyScroll::scrolls_under_editable(key, true), "shift {key}");
        }
        for key in ["home", "end", "pageup", "pagedown"] {
            assert!(KeyScroll::scrolls_under_editable(key, false), "{key}");
        }
        assert!(!KeyScroll::scrolls_under_editable("pagedown", true), "Shift+Page Down extends the selection");
    }

    #[test]
    fn writes_are_told_to_the_window_they_were_made_in_once() {
        let (first, second) = (gpui::WindowId::from(1), gpui::WindowId::from(2));
        note_write(first, false);
        note_write(first, true);
        assert_eq!(take_writes(second), Writes::default());
        assert_eq!(take_writes(first), Writes { instant: true, smooth: true });
        assert_eq!(take_writes(first), Writes::default());
    }

    #[test]
    fn a_smooth_scroll_belongs_to_its_window() {
        let (first, second) = (gpui::WindowId::from(1), gpui::WindowId::from(2));
        let handle = gpui::ScrollHandle::new();
        assert!(move_to(first, 77, &handle, gpui_offset(0.0, 100.0), Behavior::Smooth));
        assert!(animating() && animating_in(first) && !animating_in(second));
        assert_eq!(take_writes(first), Writes { instant: false, smooth: true });
        end_smooth_scroll(first, 77);
        assert!(!animating_in(first));
    }

    fn turn(degrees: f32) -> gpui::TransformationMatrix {
        let (sin, cos) = degrees.to_radians().sin_cos();
        gpui::TransformationMatrix::affine([[cos, -sin], [sin, cos]], [0.0, 0.0])
    }

    fn close(rect: Rect, want: (f32, f32, f32, f32)) {
        let got = (rect.x, rect.y, rect.width, rect.height);
        assert!(
            [got.0 - want.0, got.1 - want.1, got.2 - want.2, got.3 - want.3].iter().all(|error| error.abs() < 1e-4),
            "got {got:?} want {want:?}"
        );
    }

    #[test]
    fn a_box_through_a_quarter_turn_swaps_its_sides() {
        let rect = Rect { x: 0.0, y: 0.0, width: 10.0, height: 20.0 };
        close(rect.through(&turn(90.0)).unwrap(), (-20.0, 0.0, 20.0, 10.0));
    }

    #[test]
    fn a_box_through_an_eighth_turn_is_held_by_a_square_of_both_sides() {
        let rect = Rect { x: 0.0, y: 0.0, width: 10.0, height: 20.0 };
        let side = (10.0 + 20.0) / std::f32::consts::SQRT_2;
        let turned = rect.through(&turn(45.0)).unwrap();
        close(turned, (turned.x, turned.y, side, side));
    }

    #[test]
    fn a_box_through_a_turn_and_back_is_the_larger_box_that_held_it() {
        // What Chrome does from scroller to scroller: the box that holds a turned box, turned back, holds that.
        let rect = Rect { x: 5.0, y: 7.0, width: 10.0, height: 20.0 };
        let loose = rect.through(&turn(45.0)).unwrap().through(&turn(-45.0)).unwrap();
        assert!(loose.width > rect.width + 1.0 && loose.height > rect.height + 1.0);
        // About the same centre.
        close(Rect { x: loose.x + loose.width / 2.0, y: loose.y + loose.height / 2.0, width: 0.0, height: 0.0 }, (10.0, 17.0, 0.0, 0.0));
    }

    #[test]
    fn a_box_through_a_scale_and_a_move_is_scaled_then_moved() {
        let matrix = gpui::TransformationMatrix::affine([[2.0, 0.0], [0.0, 0.5]], [3.0, -4.0]);
        let rect = Rect { x: 1.0, y: 2.0, width: 10.0, height: 20.0 };
        close(rect.through(&matrix).unwrap(), (5.0, -3.0, 20.0, 10.0));
    }

    #[test]
    fn a_box_through_a_flip_keeps_its_size() {
        let matrix = gpui::TransformationMatrix::affine([[-1.0, 0.0], [0.0, 1.0]], [0.0, 0.0]);
        let rect = Rect { x: 1.0, y: 2.0, width: 10.0, height: 20.0 };
        close(rect.through(&matrix).unwrap(), (-11.0, 2.0, 10.0, 20.0));
    }

    #[test]
    fn a_client_size_rounds_half_up_like_chromes() {
        assert_eq!(round_half_up(10.5), 11.0);
        assert_eq!(round_half_up(10.4375), 10.0);
        assert_eq!(round_half_up(31.328125), 31.0);
    }

    #[test]
    fn a_collapsed_tables_client_size_is_its_border_box_and_a_cells_leaves_its_halves() {
        let halves = crate::automation::ElementBounds {
            client_left: 1.5,
            client_top: 1.5,
            border_right: 1.5,
            border_bottom: 1.5,
            ..crate::automation::ElementBounds::plain(0.0, 0.0, 43.0, 23.0)
        };
        let cell = metrics(None, Some(halves)).unwrap();
        assert_eq!((cell[4], cell[5]), (40.0, 20.0));
        let table = crate::automation::ElementBounds { collapsed_table: true, ..halves };
        let table = metrics(None, Some(table)).unwrap();
        assert_eq!((table[4], table[5]), (43.0, 23.0));
    }

    #[test]
    fn virtual_list_rows_align_like_scroll_container_targets() {
        // A 20px row at y=120 in a viewport at y=20 that is 80 tall.
        let row = Some((120.0, 20.0));
        assert_eq!(virtual_list_offset(Align::Start, row, (20.0, 80.0)), Some(0.0));
        assert_eq!(virtual_list_offset(Align::End, row, (20.0, 80.0)), Some(-60.0));
        assert_eq!(virtual_list_offset(Align::Nearest, Some((40.0, 20.0)), (20.0, 80.0)), None);
        assert_eq!(virtual_list_offset(Align::Start, None, (20.0, 80.0)), Some(0.0));
    }

    #[test]
    fn nearest_is_what_an_explicit_nearest_asks_for() {
        let asked = IntoView::parse(Some("nearest"), Some("nearest"), None).unwrap();
        assert_eq!(format!("{:?}", IntoView::NEAREST), format!("{asked:?}"));
    }

    #[test]
    fn a_dom_scroll_position_is_the_negated_gpui_offset_and_back() {
        let offset = gpui_offset(12.0, 80.0);
        assert_eq!((f32::from(offset.x), f32::from(offset.y)), (-12.0, -80.0));
        assert_eq!(dom_position(offset, Some(1.0)), [12.0, 80.0]);
        let origin = dom_position(gpui_offset(0.0, 0.0), Some(2.0));
        assert!(origin.iter().all(|value| value.is_sign_positive() && *value == 0.0));
    }

    #[test]
    fn a_scroll_position_is_rounded_half_up_to_a_device_pixel() {
        let position = |top: f64, scale: f32| dom_position(gpui_offset(0.0, top), Some(scale))[1];
        assert_eq!(position(10.5, 1.0), 11.0);
        assert_eq!(position(10.4, 1.0), 10.0);
        assert_eq!(position(10.3, 2.0), 10.5);
        assert_eq!(position(10.25, 2.0), 10.5);
        assert_eq!(position(10.75, 2.0), 11.0);
        assert_eq!(position(0.25, 1.0), 0.0);
        assert!(position(0.25, 1.0).is_sign_positive());
        // A scroller that has not been laid out has no scale to snap to.
        assert_eq!(dom_position(gpui_offset(0.0, 10.5), None)[1], 10.5);
    }

    #[test]
    fn a_written_offset_is_the_one_that_reads_back() {
        let written = snapped_offset(gpui_offset(12.5, 7.25), Some(1.0));
        assert_eq!(dom_position(written, Some(1.0)), [13.0, 7.0]);
        let written = snapped_offset(gpui_offset(12.5, 7.25), Some(2.0));
        assert_eq!(dom_position(written, Some(2.0)), [12.5, 7.5]);
    }

    #[test]
    fn an_offset_stored_beyond_the_range_reads_clamped_and_is_kept_as_stored() {
        let handle = gpui::ScrollHandle::new();
        handle.set_offset(gpui_offset(0.0, 500.0));
        assert_eq!(stored_position(&handle), [0.0, 500.0]);
        assert_eq!(handle_position(&handle), [0.0, 0.0]);
    }

    fn style(overflow: Option<&str>, x: Option<&str>, y: Option<&str>) -> StyleDesc {
        StyleDesc {
            overflow: overflow.map(str::to_string),
            overflow_x: x.map(str::to_string),
            overflow_y: y.map(str::to_string),
            ..Default::default()
        }
    }

    #[test]
    fn auto_scrolls_like_scroll_and_hidden_is_a_scroll_container_the_wheel_ignores() {
        assert_eq!(Overflow::parse(Some("auto")), Overflow::Auto);
        assert!(Overflow::Auto.has_offset() && Overflow::Auto.scrolls_for_user());
        assert!(!Overflow::Hidden.scrolls_for_user());
        assert_eq!(Overflow::parse(Some("scroll")), Overflow::Scroll);
        assert_eq!(Overflow::parse(Some("clip")), Overflow::Clip);
        assert_eq!(Overflow::parse(Some("hidden")), Overflow::Hidden);
        assert!(Overflow::Hidden.has_offset());
        assert!(!Overflow::Clip.has_offset());
        assert_eq!(Overflow::parse(Some("visible")), Overflow::Visible);
        assert_eq!(Overflow::parse(None), Overflow::Visible);
    }

    #[test]
    fn axis_overflow_overrides_the_shorthand() {
        let axes = Axes::of(&style(Some("scroll"), None, Some("hidden")));
        assert_eq!((axes.x, axes.y), (Overflow::Scroll, Overflow::Hidden));
        assert!(axes.scrolls());
        assert!(Axes::of(&style(Some("hidden"), None, None)).scrolls());
        assert!(!Axes::of(&style(Some("clip"), None, None)).scrolls());
    }

    #[test]
    fn visible_beside_a_scroll_container_axis_computes_to_auto() {
        for scrolling in ["hidden", "scroll", "auto"] {
            let axes = Axes::of(&style(None, Some(scrolling), Some("visible")));
            assert_eq!(axes.x, Overflow::parse(Some(scrolling)));
            assert_eq!(axes.y, Overflow::Auto);
            let axes = Axes::of(&style(None, None, Some(scrolling)));
            assert_eq!(axes.x, Overflow::Auto);
            assert_eq!(axes.y, Overflow::parse(Some(scrolling)));
        }
        let declared = Axes::declared(&style(None, Some("hidden"), None));
        assert_eq!((declared.x, declared.y), (Overflow::Hidden, Overflow::Visible));
    }

    #[test]
    fn visible_beside_clip_stays_visible() {
        let axes = Axes::of(&style(None, Some("clip"), Some("visible")));
        assert_eq!((axes.x, axes.y), (Overflow::Clip, Overflow::Visible));
        assert!(!axes.scrolls());
        let axes = Axes::of(&style(None, Some("visible"), Some("clip")));
        assert_eq!((axes.x, axes.y), (Overflow::Visible, Overflow::Clip));
    }

    #[test]
    fn nearest_does_nothing_for_a_target_in_view_or_covering_the_port() {
        assert_eq!(align_delta(Align::Nearest, 20.0, 40.0, 0.0, 100.0), 0.0);
        assert_eq!(align_delta(Align::Nearest, -10.0, 150.0, 0.0, 100.0), 0.0);
    }

    #[test]
    fn nearest_scrolls_the_shortest_way() {
        assert_eq!(align_delta(Align::Nearest, 130.0, 150.0, 0.0, 100.0), 50.0);
        assert_eq!(align_delta(Align::Nearest, -30.0, -10.0, 0.0, 100.0), -30.0);
        // A target taller than the port lines up with the edge it crossed last.
        assert_eq!(align_delta(Align::Nearest, 50.0, 250.0, 0.0, 100.0), 50.0);
    }

    #[test]
    fn start_center_end_align_the_target() {
        assert_eq!(align_delta(Align::Start, 120.0, 140.0, 20.0, 100.0), 100.0);
        assert_eq!(align_delta(Align::End, 120.0, 140.0, 20.0, 100.0), 40.0);
        assert_eq!(align_delta(Align::Center, 120.0, 140.0, 20.0, 100.0), 70.0);
    }
}
