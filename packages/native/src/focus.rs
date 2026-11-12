//! DOM focus model: what is focusable, tab order, `:focus-visible`, and the
//! four focus events.
//!
//! GPUI owns who has focus. This module owns what the DOM says about it. The
//! window's focus is observed from one place (`GpuixView::observe_focus`)
//! instead of one gpui subscription per element: gpui runs focus listeners in
//! subscription order, so per-element listeners fired in whatever order the
//! elements were created rather than blur(old) before focus(new).

use std::cell::Cell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{App, Window};

mod skipped;

use crate::element_tree::EventPayload;
use crate::events::keyboard::{path_to_root, InputRouting};
use crate::events::state_styles::PointerStates;
use crate::events::sync_dispatch;
use crate::renderer::GpuixView;
use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;

pub(crate) fn is_text_control(element_type: &str) -> bool {
    matches!(element_type, "input" | "textarea")
}

/// Largest `tabIndex` the DOM distinguishes.
const MAX_DOM_TAB_INDEX: isize = 32767;

/// gpui's `(tab_index, tab_stop)` for a DOM `tabIndex`.
///
/// gpui sorts tab stops by signed index, so a negative index comes before 0.
/// DOM puts positive indices first, in ascending order, and then the 0s. Shifting
/// every positive index below zero keeps their order and puts them ahead of the
/// 0s. A negative `tabIndex` is focusable but not a tab stop.
pub(crate) fn gpui_tab_stop(dom_tab_index: isize) -> (isize, bool) {
    if dom_tab_index > 0 {
        (
            dom_tab_index.min(MAX_DOM_TAB_INDEX) - (MAX_DOM_TAB_INDEX + 1),
            true,
        )
    } else {
        (0, dom_tab_index == 0)
    }
}

/// Calls `$each!` with the field of each focus variant of a style: the ones
/// `FocusStyles::applying` lays over an element. Whatever has to reach all of them (the
/// substitution of a `var()` in `css::var_substitution`) is written over this list.
macro_rules! focus_variant_fields {
    ($each:ident) => {
        $each!(focus, focus_within, has_focus_visible, focus_visible)
    };
}
pub(crate) use focus_variant_fields;

/// A style with the focus variants laid over it, or the style itself when none applies. Not a
/// `Cow<StyleDesc>`: that is a `StyleDesc` wide (~13 KB) even when borrowed, and moves as one.
pub(crate) enum FocusFolded<'a> {
    Borrowed(&'a StyleDesc),
    Owned(Box<StyleDesc>),
}

impl std::ops::Deref for FocusFolded<'_> {
    type Target = StyleDesc;

    fn deref(&self) -> &StyleDesc {
        match self {
            FocusFolded::Borrowed(style) => style,
            FocusFolded::Owned(style) => style,
        }
    }
}

/// How the DOM focus state is read by the style pass.
#[derive(Clone, Default)]
pub(crate) struct FocusStyles {
    /// The focused control and its ancestors while it is focus-visible and not a
    /// text control, or `None`. Every other focusable dims while this is set.
    pub dim_path: Option<Arc<[u64]>>,
    /// The element matching `:focus-visible`.
    pub visible: Option<u64>,
    /// The focused element and its ancestors, which match `:focus-within`.
    pub within: Arc<[u64]>,
}

impl FocusStyles {
    /// `style` with the focus variants that apply to element `id` laid over it, as
    /// `apply_focus_variants` applies them to the element: `focus`, `focusWithin`, `hasFocusVisible`,
    /// `focusVisible` (which needs a `focusable` element), weakest first. `style` already has the
    /// pointer states folded in.
    pub fn folded<'a>(&self, id: u64, style: &'a StyleDesc, focusable: bool) -> FocusFolded<'a> {
        let mut folded = FocusFolded::Borrowed(style);
        for declared in self.applying(id, style, focusable) {
            folded = FocusFolded::Owned(Box::new(crate::events::state_styles::overlay(&folded, declared)));
        }
        folded
    }

    /// The custom properties element `id` computes to below `parent`: the ones `style` declares
    /// with those of the focus variants that apply laid over them, the later variant winning. A
    /// custom property a variant sets is the element's, as in CSS, so its base, its other
    /// variants and its descendants read it.
    pub fn custom_of(
        &self,
        id: u64,
        style: &StyleDesc,
        focusable: bool,
        parent: &crate::css::custom_properties::CustomProperties,
    ) -> crate::css::custom_properties::CustomProperties {
        let mut declared = style.custom_properties.clone();
        for variant in self.applying(id, style, focusable) {
            declared = crate::css::custom_properties::CustomProperties::layered(
                declared.as_ref(),
                variant.custom_properties.as_ref(),
            );
        }
        match declared.as_ref() {
            Some(declared) => parent.descend(declared),
            None => parent.clone(),
        }
    }

    /// The focus variants of `style` that apply to element `id`, weakest first.
    fn applying<'a>(&self, id: u64, style: &'a StyleDesc, focusable: bool) -> impl Iterator<Item = &'a StyleDesc> {
        self.layers(id, focusable).over(style)
    }

    /// Which focus variants apply to element `id`. `focusVisible` needs a `focusable` element.
    pub fn layers(&self, id: u64, focusable: bool) -> FocusLayers {
        FocusLayers {
            focused: self.is_focused(id),
            within: self.within.contains(&id),
            has_visible: self.has_focus_visible(id),
            visible: focusable && self.visible == Some(id),
        }
    }

    /// `:has(:focus)`: a strict descendant of `id` is focused. `within` starts
    /// with the focused element.
    pub fn has_focus(&self, id: u64) -> bool {
        self.within.first().is_some_and(|focused| *focused != id) && self.within.contains(&id)
    }

    /// Whether `id` is the focused element, which `within` starts with.
    pub fn is_focused(&self, id: u64) -> bool {
        self.within.first() == Some(&id)
    }

    /// `:has(:focus-visible)`: a strict descendant of `id` matches `:focus-visible`.
    pub fn has_focus_visible(&self, id: u64) -> bool {
        self.visible.is_some_and(|visible| visible != id) && self.within.contains(&id)
    }

    /// Whether `id` is the element that matches `:focus-visible`.
    pub fn is_focus_visible(&self, id: u64) -> bool {
        self.visible == Some(id)
    }

    /// `states` with the focus variants of `style` that apply to element `id`.
    /// For an inline box, which has no element to apply them to.
    pub fn states_of(&self, id: u64, style: &StyleDesc, states: PointerStates) -> PointerStates {
        let declared = FocusLayers {
            visible: self.is_focus_visible(id),
            ..self.layers(id, false)
        }
        .declared_by(style);
        PointerStates {
            focused: declared.focused,
            focus_within: declared.within,
            has_focus_visible: declared.has_visible,
            focus_visible: declared.visible,
            ..states
        }
    }
}

/// Which focus variants of an element apply to it: the ones it applies where it tracks focus (an
/// inline box has them in its `PointerStates` instead). The one place the order they are laid over
/// the element in is written.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FocusLayers {
    /// The element is focused: `focus`.
    pub focused: bool,
    /// The element or a descendant is focused: `focusWithin`.
    pub within: bool,
    /// A strict descendant matches `:focus-visible`: `hasFocusVisible`.
    pub has_visible: bool,
    /// The element itself matches `:focus-visible`: `focusVisible`.
    pub visible: bool,
}

impl FocusLayers {
    /// The variants `style` declares, each with whether it applies, weakest first.
    fn declared<'a>(self, style: &'a StyleDesc) -> [(Option<&'a StyleDesc>, bool); 4] {
        [
            (style.focus.as_deref(), self.focused),
            (style.focus_within.as_deref(), self.within),
            (style.has_focus_visible.as_deref(), self.has_visible),
            (style.focus_visible.as_deref(), self.visible),
        ]
    }

    /// The focus variants of `style` that apply, weakest first: `focus`, `focusWithin`,
    /// `hasFocusVisible`, `focusVisible`.
    pub fn over<'a>(self, style: &'a StyleDesc) -> impl Iterator<Item = &'a StyleDesc> {
        self.declared(style)
            .into_iter()
            .filter_map(|(declared, applies)| declared.filter(|_| applies))
    }

    /// The layers that apply and that `style` declares a variant for.
    pub fn declared_by(self, style: &StyleDesc) -> FocusLayers {
        let [focused, within, has_visible, visible] = self.declared(style).map(|(declared, applies)| declared.is_some() && applies);
        FocusLayers { focused, within, has_visible, visible }
    }
}

pub(crate) struct FocusChange {
    pub from: Option<u64>,
    pub to: Option<u64>,
    from_visible: bool,
    to_visible: bool,
}

/// What Chrome keeps for the document to decide `:focus-visible`, not per
/// element: whether the last focus a mouse press gave an element is still the
/// last one, and whether a key went down since a press last moved focus. The
/// key and mouse listeners write it from inside input dispatch, which is why it
/// is shared (`InputRouting`) instead of living in the view.
///
/// A script focus reads these and changes neither, so it matches only when the
/// mouse has not been the last to focus something, or a key has been pressed
/// since. A text control matches whatever they say.
#[derive(Clone, Default)]
pub(crate) struct FocusModality(Rc<ModalityCells>);

#[derive(Default)]
struct ModalityCells {
    /// The last non-script focus change to an element was a mouse press's.
    mouse_focused: Cell<bool>,
    /// A key went down, and no press has moved focus since.
    key_down: Cell<bool>,
    /// A press `mousedown` did not cancel, waiting for the focus change it causes.
    press: Cell<bool>,
    shift: Cell<bool>,
}

impl FocusModality {
    /// A keydown. Chrome ignores one with Ctrl, Alt or Meta held, so a shortcut
    /// does not make focus visible. Returns whether it made the key newly down,
    /// which can change what matches without any focus change to draw for.
    pub fn note_key_down(&self, modifiers: &gpui::Modifiers) -> bool {
        self.0.press.set(false);
        !(modifiers.control || modifiers.alt || modifiers.platform) && !self.0.key_down.replace(true)
    }

    /// Shift on its own is a keydown in Chrome, though gpui reports it only as a modifier change.
    /// Returns whether it made the key newly down.
    pub fn note_modifiers(&self, modifiers: &gpui::Modifiers) -> bool {
        let was_down = self.0.shift.replace(modifiers.shift);
        modifiers.shift && !was_down && self.note_key_down(modifiers)
    }

    /// A press whose `mousedown` was not cancelled: whatever focus change it
    /// causes is a mouse one.
    pub fn note_press(&self) {
        self.0.press.set(true);
    }
}

#[derive(Default)]
pub(crate) struct FocusState {
    focused: Option<u64>,
    modality: FocusModality,
    /// The next focus change is a script call (`focus()`, `autoFocus`), which
    /// leaves the modality as it is.
    programmatic: bool,
    /// The element that held focus when the window went inactive. Window focus
    /// comes back to it with the modality it had.
    suspended: Option<u64>,
    /// Focus events noticed but not yet sent. See `settle_focus`.
    outbox: VecDeque<EventPayload>,
    /// Keyboard handoffs to and from the page of a `<webview>` that a noticed move calls for,
    /// done by `settle_focus` before the events go out.
    #[cfg(not(target_family = "wasm"))]
    page_moves: VecDeque<PageMove>,
    /// Set while `step_focus` settles Tab: whether it was backwards.
    #[cfg(not(target_family = "wasm"))]
    tab_step: Option<bool>,
}

/// The keyboard of a `<webview>` goes to its page (`focused`) or back to the window's view.
#[cfg(not(target_family = "wasm"))]
pub(crate) struct PageMove {
    pub id: u64,
    pub focused: bool,
    /// For a focus that Tab moved: whether it was Shift+Tab.
    pub tab: Option<bool>,
}

impl FocusState {
    pub fn with_modality(modality: FocusModality) -> Self {
        Self { modality, ..Self::default() }
    }

    #[cfg(test)]
    fn modality(&self) -> &FocusModality {
        &self.modality
    }

    pub fn focused(&self) -> Option<u64> {
        self.focused
    }

    pub fn note_programmatic(&mut self) {
        self.programmatic = true;
    }

    fn push_change(&mut self, tree: &RetainedTree, change: &FocusChange) {
        self.outbox.extend(change_events(tree, change));
    }

    fn pop_event(&mut self) -> Option<EventPayload> {
        self.outbox.pop_front()
    }

    #[cfg(not(target_family = "wasm"))]
    fn push_page_moves(&mut self, tree: &RetainedTree, change: &FocusChange) {
        let is_webview = |id: &u64| tree.elements.get(id).is_some_and(|element| element.element_type == "webview");
        if let Some(id) = change.from.filter(is_webview) {
            self.page_moves.push_back(PageMove { id, focused: false, tab: None });
        }
        if let Some(id) = change.to.filter(is_webview) {
            self.page_moves.push_back(PageMove { id, focused: true, tab: self.tab_step });
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn pop_page_move(&mut self) -> Option<PageMove> {
        self.page_moves.pop_front()
    }

    pub fn has_unsent_events(&self) -> bool {
        !self.outbox.is_empty()
    }

    /// Record where window focus is now, and report the move if there was one.
    ///
    /// `:focus-visible` follows Chrome. A text control always matches. Any other
    /// element matches unless the mouse was the last to focus an element
    /// (`FocusModality`), and a key pressed since makes it match again, whatever
    /// element has focus. What moved focus decides those two facts: a mouse press
    /// sets the first and clears the second, a Tab sets neither, a script focus
    /// leaves both. A press that moves focus to nothing clears the second too.
    ///
    /// While the window is inactive nothing is focused, but the element that was
    /// keeps its `:focus-visible` for when the window comes back, and a script
    /// focus issued meanwhile stays a script focus until it is seen.
    pub fn observe(
        &mut self,
        current: Option<u64>,
        tree: &RetainedTree,
        keyboard_modality: bool,
        window_active: bool,
    ) -> Option<FocusChange> {
        let programmatic = if window_active {
            std::mem::take(&mut self.programmatic)
        } else {
            self.programmatic
        };
        if current == self.focused {
            if window_active {
                self.suspended = None;
                self.modality.0.press.set(false);
            }
            return None;
        }
        let from = self.focused;
        let from_visible = self.is_visible(from, tree);
        if !window_active {
            self.suspended = from.or(self.suspended);
        }
        let resumed = window_active && current.is_some() && current == self.suspended;
        if window_active {
            self.suspended = None;
        }
        let cells = &self.modality.0;
        let by_press = cells.press.replace(false);
        if !programmatic {
            if by_press {
                cells.key_down.set(false);
                if current.is_some() {
                    cells.mouse_focused.set(true);
                }
            } else if !resumed && current.is_some() {
                cells.mouse_focused.set(!keyboard_modality);
            }
        }
        self.focused = current;
        // A removed element loses focus without an event, like a removed DOM node.
        let from_alive = from.is_some_and(|id| tree.elements.contains_key(&id));
        Some(FocusChange {
            from: from.filter(|_| from_alive),
            to: current,
            from_visible,
            to_visible: self.is_visible(current, tree),
        })
    }

    fn is_visible(&self, element: Option<u64>, tree: &RetainedTree) -> bool {
        let Some(element) = element else {
            return false;
        };
        let is_text_control = tree
            .elements
            .get(&element)
            .is_some_and(|element| is_text_control(&element.element_type));
        is_text_control || !self.modality.0.mouse_focused.get() || self.modality.0.key_down.get()
    }

    pub fn styles(&self, tree: &RetainedTree, keyboard_focus_dim: bool) -> FocusStyles {
        let Some(focused) = self.focused else {
            return FocusStyles::default();
        };
        let within: Arc<[u64]> = std::iter::successors(Some(focused), |id| {
            tree.elements.get(id).and_then(|element| element.parent)
        })
        .collect();
        let is_text_control = tree
            .elements
            .get(&focused)
            .is_some_and(|element| is_text_control(&element.element_type));
        let visible = self.is_visible(Some(focused), tree);
        FocusStyles {
            // Typing is keyboard input too, and dimming the window while someone
            // types is noise.
            dim_path: (visible && keyboard_focus_dim && !is_text_control).then(|| within.clone()),
            visible: visible.then_some(focused),
            within,
        }
    }

    /// `element.matches(selector)` for the focus pseudo-classes.
    pub fn matches(&self, tree: &RetainedTree, id: u64, selector: &str) -> Result<bool, String> {
        match selector.trim() {
            ":focus" => Ok(self.focused == Some(id)),
            ":focus-visible" => Ok(self.focused == Some(id) && self.is_visible(Some(id), tree)),
            ":focus-within" => Ok(std::iter::successors(self.focused, |id| {
                tree.elements.get(id).and_then(|element| element.parent)
            })
            .any(|ancestor| ancestor == id)),
            other => Err(format!(
                "matches() supports only :focus, :focus-visible, :focus-within, :hover and :active, got `{other}`"
            )),
        }
    }
}

#[derive(Clone, Copy)]
enum FocusEventKind {
    Blur,
    FocusOut,
    Focus,
    FocusIn,
}

impl FocusEventKind {
    fn event_type(self) -> &'static str {
        match self {
            Self::Blur => "blur",
            Self::FocusOut => "focusout",
            Self::Focus => "focus",
            Self::FocusIn => "focusin",
        }
    }
}

/// blur(old), focusout(old), focus(new), focusin(new), in that order.
///
/// Each carries its `target`, the propagation `path` from it to the root, and
/// the element on the other side of the move as `relatedTarget`. JS decides
/// which of them bubble.
fn change_events(tree: &RetainedTree, change: &FocusChange) -> Vec<EventPayload> {
    let mut events = Vec::new();
    if let Some(from) = change.from {
        for kind in [FocusEventKind::Blur, FocusEventKind::FocusOut] {
            events.push(event_payload(tree, kind, from, change.to, change.from_visible));
        }
    }
    if let Some(to) = change.to {
        for kind in [FocusEventKind::Focus, FocusEventKind::FocusIn] {
            events.push(event_payload(tree, kind, to, change.from, change.to_visible));
        }
    }
    events
}

/// The one place a focus event payload is built.
fn event_payload(
    tree: &RetainedTree,
    kind: FocusEventKind,
    target: u64,
    related: Option<u64>,
    visible: bool,
) -> EventPayload {
    EventPayload {
        element_id: target as f64,
        event_type: kind.event_type().to_string(),
        focus_visible: Some(visible),
        target: Some(target as f64),
        path: Some(
            path_to_root(tree, target)
                .into_iter()
                .map(|id| id as f64)
                .collect(),
        ),
        related_target: related.map(|id| id as f64),
        ..Default::default()
    }
}

/// Runs a focus change a script asked for (`focus()`, `blur()`, the `within`
/// moves), then tells JS about it before returning. When the root view is being
/// updated it waits for that update, like every state change a handler makes.
pub(crate) fn change_focus(
    window: &mut Window,
    cx: &mut App,
    change: impl FnOnce(&mut GpuixView, &mut Window, &mut gpui::Context<GpuixView>) + 'static,
) -> Result<(), String> {
    let view = sync_dispatch::root_view(window)?;
    if view.is_updating(cx) {
        window.defer(cx, move |window, cx| {
            if let Err(error) = change_focus(window, cx, change) {
                sync_dispatch::report_deferred_error(error);
            }
        });
        return Ok(());
    }
    view.update(cx, |view, cx| change(view, window, cx));
    window.refresh();
    settle_focus(window, cx)
}

/// Tab's move along the tab order, for the renderer's `focusNext()` and `focusPrevious()`: moves
/// focus, tells JS, then scrolls the new focus to its nearest edge like `focus()` does. Done here
/// rather than by the caller so the methods scroll however they are called.
pub(crate) fn step_focus(
    window: &mut Window,
    cx: &mut App,
    backwards: bool,
) -> Result<(), String> {
    if let Some(id) = skipped::target(window, cx, backwards)? {
        return skipped::enter(window, cx, id);
    }
    if backwards {
        window.focus_prev(cx);
    } else {
        window.focus_next(cx);
    }
    settle_focus_after_tab(window, cx, backwards)?;
    scroll_focus_into_view(window, cx)
}

fn scroll_focus_into_view(window: &mut Window, cx: &mut App) -> Result<(), String> {
    let view = sync_dispatch::root_view(window)?;
    if view.is_updating(cx) {
        window.defer(cx, |window, cx| {
            if let Err(error) = scroll_focus_into_view(window, cx) {
                sync_dispatch::report_deferred_error(error);
            }
        });
        return Ok(());
    }
    view.update(cx, |view, cx| view.scroll_focus_into_view(window, cx));
    Ok(())
}

/// Notices where focus is and sends the events of every move not yet sent.
///
/// The events go through `sync_dispatch::emit`, so a handler of `focus` or
/// `blur` runs before the call that moved focus returns, as in the DOM, and a
/// handler of the keystroke that moved it sees them before it ends. They are
/// sent with the root view released, so a handler may read it.
///
/// A move nobody asked JS's call for is settled by whoever made it: the default
/// of a press (`defer_mouse_down_default`) and `autoFocus` at commit
/// (`GpuixView::commit_auto_focus`). What is left, GPUI moving focus on its
/// own, is noticed by the next frame, which schedules this
/// (`GpuixView::sync_focus_handles`).
pub(crate) fn settle_focus(window: &mut Window, cx: &mut App) -> Result<(), String> {
    settle(window, cx, None)
}

/// `settle_focus` for the move that Tab (`backwards`: Shift+Tab) just made, which a `<webview>`
/// it lands on needs to know to focus its first or last tabbable element.
fn settle_focus_after_tab(window: &mut Window, cx: &mut App, backwards: bool) -> Result<(), String> {
    settle(window, cx, Some(backwards))
}

fn settle(window: &mut Window, cx: &mut App, tab: Option<bool>) -> Result<(), String> {
    let view = sync_dispatch::root_view(window)?;
    if view.is_updating(cx) {
        window.defer(cx, move |window, cx| {
            if let Err(error) = settle(window, cx, tab) {
                sync_dispatch::report_deferred_error(error);
            }
        });
        return Ok(());
    }
    view.update(cx, |view, _| {
        #[cfg(not(target_family = "wasm"))]
        {
            view.focus.tab_step = tab;
        }
        view.observe_focus(window);
        #[cfg(not(target_family = "wasm"))]
        {
            view.focus.tab_step = None;
        }
    });
    #[cfg(not(target_family = "wasm"))]
    let handoff = hand_off_to_pages(&view, cx);
    // A handler may move focus again, and its own settle sends what it finds
    // from this queue, so this loop re-reads it every time.
    while let Some((payload, callback)) = view.update(cx, |view, _| {
        view.focus
            .pop_event()
            .map(|payload| (payload, view.event_callback.clone()))
    }) {
        sync_dispatch::emit(window, cx, &callback, payload);
    }
    #[cfg(not(target_family = "wasm"))]
    handoff?;
    Ok(())
}

/// Moves the keyboard to or from the pages of the `<webview>`s whose focus changed, before JS
/// hears of it. Every move is tried; the first failure is the result.
#[cfg(not(target_family = "wasm"))]
fn hand_off_to_pages(view: &gpui::Entity<GpuixView>, cx: &mut App) -> Result<(), String> {
    let mut first_error = Ok(());
    while let Some(page_move) = view.update(cx, |view, _| view.focus.pop_page_move()) {
        let moved = view.update(cx, |view, _| view.webview_set_focused(page_move));
        if first_error.is_ok() {
            first_error = moved;
        }
    }
    first_error
}

/// The DOM default of a mouse press: focus the nearest focusable element at or
/// above the target of the press, or nothing.
///
/// `target_path` is the one the pointer dispatcher gave the press, so this and
/// the `mousedown` JS heard agree on it. Only the topmost element is the
/// target: what it covers is not pressed, and a click on a modal backdrop must
/// not focus an input under it.
///
/// A focusable element under a bare pointer does that itself and calls
/// `prevent_default`, which is also what a JS `preventDefault()` on `mousedown`
/// maps to (`events::listeners`). What is left is a press gpui's own transfer
/// did not take: the pointer is over something that does not block it from the
/// ancestors (a filled box does), or over nothing focusable at all. It waits
/// until the dispatch is over: every listener, however deep, has had its say
/// by then, and stopping propagation does not skip it.
///
/// Queue it before the press reaches JS. A focus change JS makes during the
/// press (a closing layer giving focus back) is deferred too, and has to land
/// after this, the way a DOM default action runs before a `setTimeout(0)`.
///
/// The focus events are delivered before the deferred step returns, also when
/// the default was cancelled: the element's own focus transfer may have moved
/// focus already, and nothing else would report it before the next frame.
pub(crate) fn defer_mouse_down_default(
    window: &mut gpui::Window,
    cx: &mut gpui::App,
    routing: &InputRouting,
    target_path: Vec<u64>,
) {
    let routing = routing.clone();
    window.defer(cx, move |window, cx| {
        if !window.default_prevented() {
            match routing.first_focusable(&target_path) {
                Some(handle) => window.focus(&handle, cx),
                None => window.blur(),
            }
        }
        // A focusable span under the press wins over the focusable element around its paragraph,
        // which took the press first.
        if let Some(handle) = crate::text::inline_focus::take_press_focus(window.window_handle().window_id()) {
            window.focus(&handle, cx);
        }
        if let Err(error) = settle_focus(window, cx) {
            sync_dispatch::report_deferred_error(error);
        }
    });
}

/// Opacity multiplier for every other focusable element while a control has
/// keyboard focus. Paint only, so it moves nothing.
const KEYBOARD_FOCUS_DIM: f32 = 0.4;

/// `focusWithin` and `hasFocusVisible`, for any element: an ancestor of the
/// focused element is not focusable itself, so this cannot wait for
/// `apply_focus_styles`.
pub(crate) fn apply_focus_within<E: gpui::Styled>(
    el: E,
    id: u64,
    style: Option<&crate::style::StyleDesc>,
    colors: &crate::color::ColorContext,
    lengths: &crate::css::length::LengthContext,
    focus: &crate::focus::FocusStyles,
) -> E {
    apply_focus_variants(el, id, false, style, colors, lengths, focus)
}

/// The focus variants of `style` that apply to `id`, weakest first: `focus`, `focusWithin`,
/// `hasFocusVisible`, `focusVisible` (which needs a focusable element). Each is
/// applied over the base with the ones before it, so a border it declared is part
/// of what the next sits on.
fn apply_focus_variants<E: gpui::Styled>(
    mut el: E,
    id: u64,
    focusable: bool,
    style: Option<&crate::style::StyleDesc>,
    colors: &crate::color::ColorContext,
    lengths: &crate::css::length::LengthContext,
    focus: &crate::focus::FocusStyles,
) -> E {
    let Some(base) = style else { return el };
    let mut beneath = std::borrow::Cow::Borrowed(base);
    for declared in focus.applying(id, base, focusable) {
        el = crate::renderer::apply_state_styles(
            el,
            &beneath,
            declared,
            &colors.for_state(declared),
            &lengths.for_state(declared.font_size.as_ref()),
        );
        let folded = crate::events::state_styles::overlay(&beneath, declared);
        el = crate::layout::stacking::apply_folded_lift(el, &folded, colors, lengths);
        beneath = std::borrow::Cow::Owned(folded);
    }
    el
}

/// Focus look for a focusable element, applied right after `track_focus`.
///
/// `focus`, `focusWithin`, `hasFocusVisible` and `focusVisible` follow the DOM focus state in
/// `crate::focus`, not gpui's live input modality: gpui's `.focus_visible()`
/// would hide the ring on a text field focused by a click. While a control is
/// focus-visible, every other element dims unless its style sets
/// `keyboardFocusDim: false`; that also shows at a glance where Tab can go.
pub(crate) fn apply_focus_styles<E: gpui::Styled>(
    el: E,
    id: u64,
    style: Option<&crate::style::StyleDesc>,
    colors: &crate::color::ColorContext,
    lengths: &crate::css::length::LengthContext,
    focus: &crate::focus::FocusStyles,
) -> E {
    let el = apply_focus_variants(el, id, true, style, colors, lengths, focus);
    let opted_out = style.and_then(|style| style.keyboard_focus_dim) == Some(false);
    match focus.dim_path.as_deref() {
        // Opacity applies to the subtree, so the focused element's own
        // focusable ancestors must stay at full opacity too.
        Some(path) if !opted_out && !path.contains(&id) => {
            let base = style.and_then(|style| style.opacity).unwrap_or(1.0) as f32;
            el.opacity(base * KEYBOARD_FOCUS_DIM)
        }
        _ => el,
    }
}

impl GpuixView {
    /// `element.blur()`: a no-op unless `id` is the focused element.
    pub(crate) fn blur_element(&mut self, id: u64, window: &mut gpui::Window, cx: &mut gpui::Context<Self>) {
        self.observe_focus(window);
        if self.focus.focused() == Some(id) {
            window.blur();
            self.observe_focus(window);
        }
        cx.notify();
    }

    /// `element.matches(selector)` for the focus selectors, `:hover` and `:active`.
    pub(crate) fn matches_focus(
        &mut self,
        id: u64,
        selector: &str,
        window: &gpui::Window,
    ) -> std::result::Result<bool, String> {
        match selector.trim() {
            ":hover" => return Ok(self.pointer.borrow().is_hovered(id)),
            ":active" => return Ok(self.pointer.borrow().is_active(id)),
            _ => {}
        }
        self.observe_focus(window);
        let tree = self.tree.lock().unwrap();
        self.focus.matches(&tree, id, selector)
    }

    /// Record where window focus is now and emit the events for a move.
    ///
    /// The one place focus changes are noticed. Called every frame from
    /// `sync_focus_handles`, and right after anything that moves focus or asks
    /// about it, so `focus()` and `matches()` agree without waiting for a frame.
    /// Never call it from inside a build: it takes the tree lock.
    pub(crate) fn observe_focus(&mut self, window: &gpui::Window) {
        let tree_arc = self.tree.clone();
        let tree = tree_arc.lock().unwrap();
        self.observe_focus_in(&tree, window);
    }

    pub(crate) fn observe_focus_in(&mut self, tree: &RetainedTree, window: &gpui::Window) {
        // gpui reports no focus path while the window is inactive, and so does DOM
        // (the window's blur event blurs the active element).
        let current = if window.is_window_active() {
            self.focused_element_id(window)
                .filter(|id| tree.focusable_ids.contains(id))
        } else {
            None
        };
        if let Some(change) = self.focus.observe(
            current,
            tree,
            window.last_input_was_keyboard(),
            window.is_window_active(),
        ) {
            if let Some(from) = change.from {
                crate::events::key_activation::blurred(&self.routing, &self.pointer, tree, from);
            }
            self.focus.push_change(tree, &change);
            #[cfg(not(target_family = "wasm"))]
            self.focus.push_page_moves(tree, &change);
        }
    }

    /// Sends the focus events a frame noticed once the frame is over. They
    /// cannot go out from inside `render`, which holds the root view and is
    /// part of a draw that a handler must not re-enter.
    pub(crate) fn settle_focus_after_frame(&self, window: &gpui::Window, cx: &mut gpui::App) {
        if !self.focus.has_unsent_events() {
            return;
        }
        window.defer(cx, |window, cx| {
            if let Err(error) = settle_focus(window, cx) {
                sync_dispatch::report_deferred_error(error);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_focus_variant_list_is_the_one_a_focused_element_lays_over_it() {
        // Element 1 is focus-visible and element 2 has it as a descendant.
        let focus = FocusStyles { visible: Some(1), within: Arc::from([1_u64, 2]), ..Default::default() };
        macro_rules! names {
            ($($field:ident),+) => { vec![$(stringify!($field)),+] };
        }
        // Every state style a `StyleDesc` has, each alone on a style.
        macro_rules! each_state_alone {
            ($($field:ident),+ $(,)?) => {
                vec![$((stringify!($field), StyleDesc { $field: Some(Box::new(StyleDesc::default())), ..Default::default() })),+]
            };
        }
        let states = each_state_alone!(
            hover, active, focus, focus_visible, focus_within, group_hover, group_active, group_focus_within,
            has_hover, has_active, has_focus, has_focus_visible, disabled, enabled, has_disabled, has_enabled,
        );
        let mut applied: Vec<&str> = states
            .iter()
            .filter(|(_, style)| [1_u64, 2].into_iter().any(|id| focus.applying(id, style, true).next().is_some()))
            .map(|(field, _)| *field)
            .collect();
        let mut listed: Vec<&str> = focus_variant_fields!(names);
        applied.sort_unstable();
        listed.sort_unstable();
        assert_eq!(applied, listed, "left: laid over an element by `applying`; right: in `focus_variant_fields!`");
    }

    fn custom(json: &str) -> crate::css::custom_properties::CustomProperties {
        let style = crate::css::var_substitution::parse(json.as_bytes()).expect("a style");
        style.custom_properties.expect("custom properties")
    }

    #[test]
    fn a_focus_variant_that_applies_sets_the_custom_properties_of_its_element() {
        let style = crate::css::var_substitution::parse(
            br#"{"--a":"base","--b":"base","focusWithin":{"--a":"within","--c":"within"},"focusVisible":{"--a":"visible"}}"#,
        )
        .expect("a style");
        let parent = custom(r#"{"--p":"parent"}"#);
        let get = |custom: &crate::css::custom_properties::CustomProperties, name: &str| {
            custom.get(name).map(str::to_owned)
        };

        let none = FocusStyles::default().custom_of(1, &style, true, &parent);
        assert_eq!(get(&none, "--a").as_deref(), Some("base"));
        assert_eq!(get(&none, "--c"), None);

        let both = FocusStyles { visible: Some(1), within: Arc::from([1_u64]), ..Default::default() }
            .custom_of(1, &style, true, &parent);
        assert_eq!(get(&both, "--a").as_deref(), Some("visible"));
        assert_eq!(get(&both, "--b").as_deref(), Some("base"));
        assert_eq!(get(&both, "--c").as_deref(), Some("within"));
        assert_eq!(get(&both, "--p").as_deref(), Some("parent"));

        let within = FocusStyles { within: Arc::from([1_u64]), ..Default::default() }.custom_of(1, &style, true, &parent);
        assert_eq!(get(&within, "--a").as_deref(), Some("within"));
    }

    fn tree_with(elements: &[(u64, &str)]) -> RetainedTree {
        let mut tree = RetainedTree::new();
        for (id, element_type) in elements {
            tree.create_element(*id, element_type.to_string());
        }
        tree
    }

    #[cfg(not(target_family = "wasm"))]
    fn page_moves(state: &mut FocusState) -> Vec<(u64, bool, Option<bool>)> {
        std::iter::from_fn(|| state.pop_page_move())
            .map(|page_move| (page_move.id, page_move.focused, page_move.tab))
            .collect()
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn a_move_onto_a_webview_hands_the_keyboard_to_its_page_and_a_move_off_it_takes_it_back() {
        let tree = tree_with(&[(1, "input"), (2, "webview"), (3, "webview")]);
        let mut state = FocusState::default();
        let change = |from, to| FocusChange { from, to, from_visible: false, to_visible: false };

        state.push_page_moves(&tree, &change(Some(1), Some(2)));
        assert_eq!(page_moves(&mut state), [(2, true, None)]);

        state.push_page_moves(&tree, &change(Some(2), Some(1)));
        assert_eq!(page_moves(&mut state), [(2, false, None)]);

        // Between two pages the first lets go before the second takes hold.
        state.push_page_moves(&tree, &change(Some(2), Some(3)));
        assert_eq!(page_moves(&mut state), [(2, false, None), (3, true, None)]);

        state.push_page_moves(&tree, &change(Some(1), None));
        state.push_page_moves(&tree, &change(None, Some(1)));
        assert_eq!(page_moves(&mut state), []);
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn tab_into_a_webview_says_which_way_and_leaving_it_does_not() {
        let tree = tree_with(&[(1, "input"), (2, "webview")]);
        let mut state = FocusState::default();
        let change = |from, to| FocusChange { from, to, from_visible: false, to_visible: false };

        state.tab_step = Some(true);
        state.push_page_moves(&tree, &change(Some(1), Some(2)));
        state.push_page_moves(&tree, &change(Some(2), Some(1)));
        assert_eq!(page_moves(&mut state), [(2, true, Some(true)), (2, false, None)]);
    }

    #[test]
    fn positive_tab_indices_sort_before_zero_in_ascending_order() {
        let mut order: Vec<(isize, isize)> = [3, 0, 1, 32767, 2, 0]
            .into_iter()
            .map(|dom| (gpui_tab_stop(dom).0, dom))
            .collect();
        order.sort_by_key(|(gpui, _)| *gpui);
        let dom_order: Vec<isize> = order.into_iter().map(|(_, dom)| dom).collect();
        assert_eq!(dom_order, [1, 2, 3, 32767, 0, 0]);
    }

    #[test]
    fn negative_tab_index_is_focusable_but_not_a_tab_stop() {
        assert!(!gpui_tab_stop(-1).1);
        assert!(gpui_tab_stop(0).1);
        assert!(gpui_tab_stop(5).1);
    }

    /// A page of `div`s 1 and 2, a text input 3 and a `div` 4 whose child a press may land on, driven
    /// the way the window drives `FocusState`.
    struct Page {
        state: FocusState,
        tree: RetainedTree,
    }

    #[derive(Clone, Copy)]
    enum Step {
        /// A keydown with no Ctrl, Alt or Meta held.
        Key,
        /// Ctrl+key.
        Shortcut,
        /// Tab lands on the element.
        Tab(u64),
        /// A mouse press whose target focuses the element, or nothing (`None`).
        Press(Option<u64>),
        /// `element.focus()`, or `blur()` for `None`.
        Script(Option<u64>),
        Check(u64, bool),
    }
    use Step::*;

    impl Page {
        fn new() -> Self {
            Self {
                state: FocusState::default(),
                tree: tree_with(&[(1, "div"), (2, "div"), (3, "input"), (4, "div")]),
            }
        }

        fn run(&mut self, steps: &[Step]) {
            for (index, step) in steps.iter().enumerate() {
                match *step {
                    Key => {
                        self.state.modality().note_key_down(&gpui::Modifiers::default());
                    }
                    Shortcut => {
                        self.state.modality().note_key_down(&gpui::Modifiers::command());
                    }
                    Tab(id) => {
                        self.state.modality().note_key_down(&gpui::Modifiers::default());
                        self.state.observe(Some(id), &self.tree, true, true);
                    }
                    Press(target) => {
                        self.state.modality().note_press();
                        self.state.observe(target, &self.tree, false, true);
                    }
                    Script(target) => {
                        self.state.note_programmatic();
                        self.state.observe(target, &self.tree, false, true);
                    }
                    Check(id, expected) => assert_eq!(
                        self.state.matches(&self.tree, id, ":focus-visible").unwrap(),
                        expected,
                        "step {index}: element {id}"
                    ),
                }
            }
        }
    }

    /// Chrome's answers, from `~/.cache/ghia-round48/fv2.py` (Playwright, headless shell, fresh
    /// profile), each sequence replayed here step for step.
    #[test]
    fn focus_visible_follows_chromes_document_flags() {
        let table: &[(&str, &[Step])] = &[
            ("script focus before any input", &[Script(Some(1)), Check(1, true)]),
            ("press on blank body, then script focus", &[Press(None), Script(Some(1)), Check(1, true)]),
            ("click, then script focus", &[Press(Some(1)), Check(1, false), Script(Some(2)), Check(2, false)]),
            ("Tab, then script focus", &[Tab(1), Check(1, true), Script(Some(2)), Check(2, true)]),
            ("Tab, click blank body, script focus", &[Tab(1), Press(None), Script(Some(2)), Check(2, true)]),
            ("Tab, click b, script focus a", &[Tab(1), Press(Some(2)), Check(2, false), Script(Some(1)), Check(1, false)]),
            ("click text", &[Press(Some(3)), Check(3, true)]),
            ("click, Shift (a key), script focus", &[Press(Some(2)), Key, Script(Some(1)), Check(1, true)]),
            ("click, Ctrl+key, script focus", &[Press(Some(2)), Shortcut, Script(Some(1)), Check(1, false)]),
            ("click, key, script focus", &[Press(Some(2)), Key, Script(Some(1)), Check(1, true)]),
            ("click, key: the clicked element itself", &[Press(Some(2)), Key, Check(2, true)]),
            (
                "click, script focus text, script focus b",
                &[Press(Some(1)), Script(Some(3)), Check(3, true), Script(Some(2)), Check(2, false)],
            ),
            ("click, key, click blank body, script focus", &[Press(Some(1)), Key, Press(None), Script(Some(2)), Check(2, false)]),
            ("Tab, click the focused element, script focus", &[Tab(1), Press(Some(1)), Check(1, true), Script(Some(2)), Check(2, true)]),
            ("click a child of a focusable element", &[Press(Some(4)), Check(4, false), Script(Some(2)), Check(2, false)]),
            ("Tab, click a disabled button (blur), script focus", &[Tab(1), Press(None), Script(Some(2)), Check(2, true)]),
            ("click, key, click a disabled button, script focus", &[Press(Some(1)), Key, Press(None), Script(Some(2)), Check(2, false)]),
            (
                "Tab, click text, script focus",
                &[Tab(1), Press(Some(3)), Check(3, true), Script(Some(2)), Check(2, false)],
            ),
            (
                "click, Tab, click blank body, script focus",
                &[Press(Some(1)), Tab(2), Check(2, true), Press(None), Script(Some(1)), Check(1, true)],
            ),
            ("click, key, click blank body, script focus, click", &[Press(Some(1)), Key, Press(None), Script(Some(2)), Check(2, false), Press(Some(2)), Check(2, false)]),
            ("click, key, click b, script focus a", &[Press(Some(1)), Key, Press(Some(2)), Check(2, false), Script(Some(1)), Check(1, false)]),
            ("click, script focus, key: the script-focused element", &[Press(Some(1)), Script(Some(2)), Check(2, false), Key, Check(2, true)]),
            ("click twice, key", &[Press(Some(1)), Press(Some(1)), Key, Check(1, true)]),
            ("click, click blank body, script focus", &[Press(Some(1)), Press(None), Script(Some(2)), Check(2, false)]),
            ("click, script blur, script focus", &[Press(Some(1)), Script(None), Script(Some(2)), Check(2, false)]),
            (
                "key, script focus, click b, script focus a",
                &[Key, Script(Some(1)), Press(Some(2)), Script(Some(1)), Check(1, false)],
            ),
            ("click, key, click the focused element, script focus", &[Press(Some(1)), Key, Press(Some(1)), Script(Some(2)), Check(2, true)]),
            ("click, key, blur, click blank body (nothing to blur), script focus", &[Press(Some(1)), Key, Script(None), Press(None), Script(Some(2)), Check(2, true)]),
            ("key, click blank body (nothing focused), script focus", &[Key, Press(None), Script(Some(2)), Check(2, true)]),
            ("click, key, click text, script focus", &[Press(Some(1)), Key, Press(Some(3)), Check(3, true), Script(Some(2)), Check(2, false)]),
            ("click text, key, click text, script focus", &[Press(Some(3)), Key, Press(Some(3)), Script(Some(2)), Check(2, true)]),
            ("click, key, click a child, script focus", &[Press(Some(1)), Key, Press(Some(4)), Script(Some(2)), Check(2, false)]),
            ("click a child, key, click it again, script focus", &[Press(Some(4)), Key, Press(Some(4)), Script(Some(2)), Check(2, true)]),
        ];
        for (name, steps) in table {
            let mut page = Page::new();
            println!("{name}");
            page.run(steps);
        }
    }

    #[test]
    fn shift_on_its_own_is_a_key_and_a_modifier_held_through_a_press_is_not() {
        let mut page = Page::new();
        let modality = page.state.modality().clone();
        let shift = gpui::Modifiers::shift();
        page.run(&[Press(Some(2))]);
        assert!(modality.note_modifiers(&shift));
        assert!(!modality.note_modifiers(&shift), "held, not pressed again");
        assert!(!modality.note_modifiers(&gpui::Modifiers::default()));
        assert!(!modality.note_modifiers(&shift), "pressed again, but the key is already down");
        page.run(&[Script(Some(1)), Check(1, true)]);

        // Shift stays down through a press, and the press clears the key.
        page.run(&[Press(Some(2)), Check(2, false)]);
        assert!(!modality.note_modifiers(&shift));
        page.run(&[Script(Some(1)), Check(1, false)]);

        assert!(!modality.note_modifiers(&gpui::Modifiers::default()));
        let mut chord = gpui::Modifiers::shift();
        chord.control = true;
        page.run(&[Press(Some(2))]);
        modality.note_modifiers(&chord);
        page.run(&[Script(Some(1)), Check(1, false)]);
    }

    #[test]
    fn focus_visible_survives_the_window_going_inactive() {
        let mut page = Page::new();
        page.run(&[Tab(1)]);
        let blurred = page.state.observe(None, &page.tree, false, false).unwrap();
        assert_eq!((blurred.from, blurred.to), (Some(1), None));
        let back = page.state.observe(Some(1), &page.tree, false, true).unwrap();
        assert!(back.to_visible);
        page.run(&[Check(1, true)]);
    }

    #[test]
    fn mouse_focus_stays_not_visible_across_inactivity() {
        let mut page = Page::new();
        page.run(&[Press(Some(1))]);
        page.state.observe(None, &page.tree, false, false);
        page.state.observe(Some(1), &page.tree, false, true);
        page.run(&[Check(1, false)]);
    }

    #[test]
    fn a_script_focus_requested_while_inactive_is_still_one_when_seen() {
        let mut page = Page::new();
        page.run(&[Press(Some(1)), Script(None)]);
        page.state.note_programmatic();
        // The request is observed while the window is still inactive.
        assert!(page.state.observe(None, &page.tree, false, false).is_none());
        page.state.observe(Some(2), &page.tree, false, true);
        page.run(&[Check(2, false)]);

        let mut page = Page::new();
        page.run(&[Press(Some(1)), Key]);
        page.state.observe(None, &page.tree, false, false);
        page.state.note_programmatic();
        assert!(page.state.observe(None, &page.tree, false, false).is_none());
        page.state.observe(Some(2), &page.tree, false, true);
        page.run(&[Check(2, true)]);
    }

    #[test]
    fn a_change_reports_both_ends_and_a_removed_element_is_silent() {
        let mut tree = tree_with(&[(1, "div"), (2, "div")]);
        let mut state = FocusState::default();
        state.observe(Some(1), &tree, false, true);
        let change = state.observe(Some(2), &tree, false, true).unwrap();
        assert_eq!((change.from, change.to), (Some(1), Some(2)));

        tree.destroy_element(2);
        let change = state.observe(None, &tree, false, true).unwrap();
        assert_eq!((change.from, change.to), (None, None));
    }

    #[test]
    fn focus_variants_apply_to_the_focused_box_and_focus_within_to_its_ancestors() {
        let styles = FocusStyles {
            visible: Some(3),
            within: Arc::from([3, 2, 1]),
            ..Default::default()
        };
        let declares = |json: &str| serde_json::from_str::<StyleDesc>(json).unwrap();
        let both = declares(r#"{"focusVisible":{"color":"red"},"focusWithin":{"color":"blue"}}"#);
        let none = declares(r#"{"color":"red"}"#);
        let of = |id, style: &StyleDesc| styles.states_of(id, style, PointerStates::default());

        let focused = of(3, &both);
        assert!(focused.focus_visible && focused.focus_within);
        let ancestor = of(2, &both);
        assert!(!ancestor.focus_visible && ancestor.focus_within);
        assert!(!of(9, &both).any());
        assert!(!of(3, &none).any(), "a style with no focus variant folds nothing");

        let hovered = PointerStates { hovered: true, ..Default::default() };
        assert!(styles.states_of(9, &none, hovered).hovered);
    }

    #[test]
    fn focus_applies_to_the_focused_element_whether_or_not_it_is_focus_visible_and_under_focus_within() {
        let declares = |json: &str| serde_json::from_str::<StyleDesc>(json).unwrap();
        let style = declares(r#"{"focus":{"color":"red"},"focusWithin":{"opacity":0.5}}"#);
        // Focused by the mouse: focused, not focus-visible.
        let clicked = FocusStyles { visible: None, within: Arc::from([3, 2, 1]), ..Default::default() };
        assert!(clicked.is_focused(3) && !clicked.is_focused(2) && !FocusStyles::default().is_focused(3));
        let focused = clicked.states_of(3, &style, PointerStates::default());
        assert!(focused.focused && focused.focus_within && !focused.focus_visible);
        let ancestor = clicked.states_of(2, &style, PointerStates::default());
        assert!(!ancestor.focused && ancestor.focus_within, "an ancestor is focus-within, not focused");

        let applied = |id: u64| -> Vec<Option<String>> {
            clicked.applying(id, &style, true).map(|variant| variant.color.clone()).collect()
        };
        assert_eq!(applied(3), [Some("red".to_owned()), None], "focus first, focusWithin over it");
        assert_eq!(applied(2), [None]);
        let folded = clicked.folded(3, &style, true);
        assert_eq!((folded.color.as_deref(), folded.opacity), (Some("red"), Some(0.5)));
    }

    #[test]
    fn the_has_focus_variants_apply_to_strict_ancestors_of_the_focused_box_only() {
        let styles = FocusStyles {
            visible: Some(3),
            within: Arc::from([3, 2, 1]),
            ..Default::default()
        };
        assert!(!styles.has_focus(3) && !styles.has_focus_visible(3), "the element itself does not count");
        assert!(styles.has_focus(2) && styles.has_focus_visible(2));
        assert!(styles.has_focus(1) && styles.has_focus_visible(1));
        assert!(!styles.has_focus(9) && !styles.has_focus_visible(9));

        // Focused by the mouse: focused, but not focus-visible.
        let clicked = FocusStyles { visible: None, ..styles.clone() };
        assert!(clicked.has_focus(2) && !clicked.has_focus_visible(2));
        assert!(!FocusStyles::default().has_focus(1));

        let declares = |json: &str| serde_json::from_str::<StyleDesc>(json).unwrap();
        let style = declares(r#"{"hasFocus":{"color":"red"},"hasFocusVisible":{"color":"blue"}}"#);
        let ancestor = styles.states_of(2, &style, PointerStates::default());
        assert!(ancestor.has_focus_visible, "an inline box folds hasFocusVisible");
        assert!(!ancestor.has_focused, "hasFocus is the pointer fold's, like groupFocusWithin");
        assert!(!styles.states_of(3, &style, PointerStates::default()).any());
        assert!(!styles.states_of(2, &declares(r#"{"color":"red"}"#), PointerStates::default()).any());
    }

    #[test]
    fn a_focus_variant_decides_a_field_where_it_applies_and_visible_wins_over_within() {
        let styles = FocusStyles {
            visible: Some(3),
            within: Arc::from([3, 2, 1]),
            ..Default::default()
        };
        let style = serde_json::from_str::<StyleDesc>(
            r#"{"position":"relative","focusWithin":{"position":"absolute","opacity":0.5},"focusVisible":{"position":"fixed"}}"#,
        )
        .unwrap();
        let position = |id, focusable| styles.folded(id, &style, focusable).position.clone();
        assert_eq!(position(3, true).as_deref(), Some("fixed"));
        // An element that does not track focus gets no focus-visible variant.
        assert_eq!(position(3, false).as_deref(), Some("absolute"));
        assert_eq!(position(2, true).as_deref(), Some("absolute"));
        assert_eq!(position(9, true).as_deref(), Some("relative"));
        // What a weaker variant sets and a stronger one leaves alone stays.
        assert_eq!(styles.folded(3, &style, true).opacity, Some(0.5));
        assert_eq!(styles.folded(9, &style, true).opacity, None);

        let relational = serde_json::from_str::<StyleDesc>(
            r#"{"focusWithin":{"position":"absolute"},"hasFocusVisible":{"position":"sticky"}}"#,
        )
        .unwrap();
        let position = |id| styles.folded(id, &relational, true).position.clone();
        assert_eq!(position(2).as_deref(), Some("sticky"), "hasFocusVisible beats focusWithin");
        assert_eq!(position(3).as_deref(), Some("absolute"), "and is not the element's own");
    }

    #[test]
    fn a_noticed_move_waits_in_the_outbox_until_sent() {
        let tree = tree_with(&[(1, "div"), (2, "div")]);
        let mut state = FocusState::default();
        assert!(!state.has_unsent_events());

        let change = state.observe(Some(1), &tree, false, true).unwrap();
        state.push_change(&tree, &change);
        assert!(state.has_unsent_events());

        // Noticing the same focus again adds nothing, so a later frame cannot
        // send a move twice.
        assert!(state.observe(Some(1), &tree, false, true).is_none());

        let change = state.observe(Some(2), &tree, false, true).unwrap();
        state.push_change(&tree, &change);
        let types: Vec<_> = std::iter::from_fn(|| state.pop_event())
            .map(|event| event.event_type)
            .collect();
        assert_eq!(
            types,
            ["focus", "focusin", "blur", "focusout", "focus", "focusin"]
        );
        assert!(!state.has_unsent_events());
    }

    #[test]
    fn matches_rejects_other_selectors() {
        let tree = tree_with(&[(1, "div")]);
        let state = FocusState::default();
        assert!(state.matches(&tree, 1, ":hover").is_err());
        assert!(state.matches(&tree, 1, "div").is_err());
    }
}
