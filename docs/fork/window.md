# Window

What an app sets on the window itself: the system appearance, bundled fonts, `appRegion` drag regions for a frameless
window, where a window opens (`x` / `y` and the `screen` displays) and the panel kind. All five are small, independent of
the rest of the fork, and exist because the apps this fork ports already use Electron's equivalents.

## Appearance

The `appearance` window option follows the macOS system appearance by default, with `getAppearance()`,
`setAppearance()` and an `appearanceChange` event. `light-dark()` ([paint-and-transforms.md](paint-and-transforms.md))
and `prefers-color-scheme` ([motion.md](motion.md)) read it.

The test renderer applies it too: it opens its window from the same `WindowOptions` through `to_gpui_window_options`, and
a zed commit makes `VisualTestPlatform` forward `set_window_appearance` to the real platform (the trait default was a
no-op), so a headless window follows the override and delivers the change. Conflicts live in
`packages/native/js/host.ts`, `src/renderer.rs` and `src/test_renderer.rs`.

## The window title

`setWindowTitle()` and the `title` option write the view's `window_title`, and `GpuixView::render` gives it to the platform
window. It does so only when it differs from the title the view last gave the window (`applied_window_title`, empty until
the first render): `Window::set_window_title` is an AppKit `setTitle` (with the window-list update behind it) and an a11y
update, and it used to run on every frame of a scroll. A window has one view and a reopened window gets a new one, so the
record cannot outlive the window it describes.

## The `fonts` option

The `fonts` window option takes a list of font files, reads them and passes them to upstream's `registerFont` right after
the renderer is created, so `fontFamily` resolves to them. It has no Rust (`js/fonts.ts`, `js/runtime.ts`,
`js/testing.ts`). If upstream grows its own font option, drop the fonts commit. How a registered font is held in memory is
in [frames-and-wakes.md](frames-and-wakes.md#memory-footprint-of-a-window-79).

A sheet's `@font-face` is the second way to add a face, and both end in `Fonts::register` (`check_font`, then `TextSystem::add_fonts`). They differ in who names the family and when the bytes are read: the option registers every file under the family it declares, before the first frame, and a path that cannot be read fails the window; a sheet rule names the family itself, can sit under `@media`, `@supports` and `@layer`, and is read in the frame that first builds with it, where a source that cannot load is logged and skipped (see [stylesheets.md](stylesheets.md#definitions-keyframes-property-and-font-face)). Both take TrueType, OpenType, WOFF and WOFF2 files.

## Window drag regions (`appRegion`)

A `titlebarTransparent` window has no titlebar, and nothing in gpuix said what moves it. AppKit dragged such a window
from a fixed strip at the top of the view and held clicks in that strip back to tell a double click apart, so an app's own
bar had to sit exactly under the strip and its buttons paid the delay. GPUI had the parts (`Window::start_window_move`,
`window_control_area(Drag)`, the `app_owns_titlebar_drag` window option) and nothing connected them to a page.
`appRegion: "drag" | "no-drag"` is Electron's `-webkit-app-region`.

`appRegion` is not a DOM or CSS property, and the standards-track `window-drag` has a different value set. It is the
exception to the DOM/CSS principle ([index.md](index.md#the-principle-dom-and-css-semantics)): a web port needs it and nothing in the DOM does the job.

### Why the press is handled natively

macOS `performWindowDragWithEvent:` needs the `NSEvent` of the mouse-down that is being dispatched, so the move has to
start inside that dispatch, and Windows only moves a window from `WM_NCHITTEST` answering `HTCAPTION`, which no JS round
trip can answer in time. A JS handler cannot do either.

### Regions are layout rectangles, not hit testing

This is Electron's model. Every box with a value contributes its border box in tree order and the last box that holds the
point wins: `drag` adds, `no-drag` cuts. Z-order, overlap, `pointerEvents`, `opacity`, `overflow` and `borderRadius` do
not take part, so an overlay with no value over a bar does not stop it dragging. The value inherits (Chromium has since
about 150, as `window-drag`, CSSWG #13101), so `drag`, a `no-drag` inside it and a `drag` inside that all work, and a
child that overflows a drag box drags.

`appRegion` is a `StyleDesc` field that inherits through `Inherited::descend`, and it is read only when the window is
frameless (`titlebarTransparent`, in a test window too). Each host element with an effective value registers its host
hitbox as a Drag area or a client area (`events/app_region.rs`, `mark`, called wherever `host_hitbox` is). An inline span
in a paragraph is covered by `text/inline_region.rs`. `app_owns_titlebar_drag` is set from the same option, so AppKit
stops dragging the top strip itself.

### The zed side

It is opt-in through DOM hit-testing mode, so other GPUI users are unchanged.

- A hitbox can be registered as a client area (`.window_client_area()`, `Window::insert_window_client_hitbox`). In DOM
  mode `Window::window_control_area_at(position)` takes the last registered entry, in paint order, whose unclipped
  hitbox bounds contain the point, and a client entry answers `None`; a fullscreen window has no areas. Outside DOM mode
  it keeps the old rule (the first area whose hitbox is under the mouse).
- The platform's own hook (what Windows asks on `WM_NCHITTEST`) calls it with the point:
  `PlatformWindow::on_hit_test_window_control`'s callback takes the position in window logical pixels (Windows converts
  the message's screen `lparam` with `ScreenToClient`), because `mouse_position` lags the hit test.
- The cursor is the arrow in a Drag area with no button held, and stays the arrow for a press that began in one. `Window`
  tracks the held buttons for that (`pressed_mouse_buttons`, private).
- `gpui_macos` `start_window_move` copies the native window and drops the state lock before calling AppKit. The call
  returns right away, but a `windowDidMove` could reach `window_did_move`, which locks the same mutex. It then clears the
  left-button bookkeeping, since Apple documents that the mouse-up of a window drag may not be sent.

### The press

The capture-phase mouse-down listener in `events/listeners.rs` asks `window_control_area_at` before the dispatcher sees
the press, and `press_outcome` (pure, per platform) decides.

- **macOS and Linux.** A left press (not ctrl on macOS, no other button down) is swallowed: no DOM event, no focus
  default, GPUI's propagation stopped. It starts the move, or on `click_count` 2 does `titlebar_double_click()` (macOS,
  which follows the user's "double-click a window's title bar" setting) or `zoom_window()` (Linux). A Linux right press
  opens the window menu. Right click and ctrl-click reach the page on macOS.
- **Windows.** gpuix asks for no action. GPUI receives the caption's `WM_NC*BUTTONDOWN` as a mouse down, and a stopped one
  makes `DefWindowProc` skip the drag, the maximise and the system menu, so the press is taken for the window
  (`PointerState::window_presses`) and never stopped. It only calls `Window::prevent_default()`, which keeps GPUI's focus,
  the active state, the input editor's caret and the text selection (`text/paint.rs` returns on a prevented mouse-down, as
  the DOM does for `preventDefault`) from running. A scrollbar skips a press inside a Drag area (Electron: the region
  covers the scrollbar).
- **The release.** `window_presses` also makes the release the window's, and until it comes a move is not the page's. A
  release that never arrives (the OS may not send one after a window move) cannot leave it stuck: a press of that button
  that reaches the page, a pointer exit or a move that reports no button held ends it.
- **The resync after a paint** (a layout that moved under a still pointer) is deferred until the draw has swapped frames,
  because `window_control_area_at` reads the rendered frame. A bar that appears under the pointer is a region from its
  first frame, and hover leaves once.
  Not after a frame that only a scroll caused: a scroll marks the hover dirty and it follows when the scroll ends
  ([scroll.md](scroll.md#the-hover-under-a-still-pointer)).

### What the page sees

No `pointerdown`, `mousedown`, `mouseup`, `click`, `dblclick`, focus change or `mousedownoutside` for a press in a region,
as in Electron. With no button held, a pointer over a Drag region is outside the window as far as the dispatcher is
concerned (`hides_pointer`): hover leaves with the usual leave events, no moves fire, and leaving the region brings hover
back. A button that went down outside the region keeps the pointer through it. The wheel is untouched.

The test renderer's offscreen window has no current mouse event to start a move from, so the actions (`move`,
`titlebarDoubleClick`, `zoom`, `showMenu`) are recorded and read with `takeSimulatedWindowActions()`. Nothing is recorded
for Windows, where the OS owns the region.

### Platform status

macOS is built and tested offscreen only: the test renderer's recorded actions, Rust unit tests for `press_outcome` and
`hides_pointer`, and zed's `gpui` tests for `window_control_area_at`. The real drag and the real double click were not
exercised in a live window. `performWindowDragWithEvent:` hands the drag to the WindowServer and returns right away
(Apple's `NSWindow.performDrag(with:)` docs: a mouse-up may not be sent; a probe here returned in about 0.1 ms), so
nothing runs nested inside GPUI's mouse dispatch, and starting the move there is what Chromium, winit, tao, Qt and Zed's
own title bar do. Whether the mouse-up arrives is unverified, and the bookkeeping reset is right either way. Windows and
Linux were written, not compiled.

## The panel kind

A window that is not key looks different (the traffic lights go grey, the title dims, glass tints and accent colours
lose their emphasis), and a window opened with `focus: false` is not key, so a capture of it never shows the key look.
`GPUIX_BACKGROUND=1` ([testing.md](testing.md#driving-a-live-window)) emulates focus for the page but changes none of that.
A `GPUIWindow` cannot be made key while the app is inactive (the report: `makeKeyWindow`, an `isKeyWindow` override and
`_setPreventsActivation:` had no effect, and swapping the class to `NSPanel` afterwards crashed Bun), so the window has to
be created as the right class: `kind: 'panel'` is `WindowKind::Panel` in zed.

### What it is

- **An `NSPanel` with `NSWindowStyleMaskNonactivatingPanel`,** gpui's own `GPUIPanel` class (the one `PopUp`, `Floating` and
  `Dialog` use), so it can be key while its application is not active, and clicking it does not activate the
  application. `window/kind.rs` in `gpui_macos` maps each `WindowKind` to its class, that style bit and its level (a pure
  function, unit tested).
- **The level is `NSNormalWindowLevel`.** It is not an overlay: it is not above other apps' windows, it has no popup level,
  and it is not `isFloatingPanel` (`false`, as `NSPanel`'s default).
- **Otherwise it is `WindowKind::Normal`:** the same titlebar, `resizable`, close and miniaturize buttons from the
  options, the same `NSTrackingActiveInKeyWindow` tracking area and `acceptsMouseMovedEvents`, and the same appearance,
  background, transparency and traffic-light handling, because those are all read from the same options.
- **`canBecomeKeyWindow` answers yes** (the class builder's method, shared by both classes), where `NSPanel` alone answers
  yes only for a titled or resizable window.
- **`hidesOnDeactivate` is set to `NO`.** `NSPanel`'s default is `YES`, which would hide the panel whenever its app is not
  active, and a panel exists to be shown while another app is the active one. `becomesKeyOnlyIfNeeded` stays at its
  default (`NO`).
- **No tabbing:** `tabbingMode` is disallowed and the tabbing identifier is not set, so a panel is never a tab of another
  window. The collection behaviour is the default, not the popup's `CanJoinAllSpaces` and full-screen auxiliary, so it stays
  on its own Space like a normal window; Mission Control was not driven (that needs input to another app).
- **The application is not activated.** `focus: true` makes the panel key (`makeKeyAndOrderFront:`), and the live renderer
  skips `cx.activate` for a panel (`window_kind::activates_application`), which is what would take the keyboard from the
  frontmost app. `activateWindow()` still activates the app, since it asks for that.
- **`focus: false` keeps it not key.** AppKit makes an ordered-front non-activating panel the key window of an inactive app
  by itself (measured: `isKeyWindow` was true after `orderFront:` alone, with `NSRunningApplication.isActive` false).
  `gpui_macos` refuses key through `canBecomeKeyWindow` for the length of that call (`REFUSES_KEY_IVAR`), so the option keeps
  its meaning.
- **On other platforms it is `Normal`:** Windows and Linux compare kinds with `==` and treat any other kind as a regular
  window, and the one exhaustive `match` in `gpui_web` lists it with `Normal`.
- **`GpuixRenderer.isWindowKey()`** (`src/window_key.rs`) reads `-[NSWindow isKeyWindow]` of the window, the platform's
  answer, which neither emulation nor `setWindowActive` changes.
- **The test renderer** validates `kind` and passes it to the same `to_gpui_window_options`; its window is real but
  offscreen and opened with `focus` false, so it is never key and nothing observable differs.

`active_window()` and `ordered_windows()` in `gpui_macos` still test `isKindOfClass: GPUIWindow`, so a panel is not in them,
as before for `PopUp`, `Floating` and `Dialog`. gpuix does not read either.

### Proving it

A panel receives whatever the owner types while it is key (see the hazard in [testing.md](testing.md#driving-a-live-window)),
so the proof is one short run: build and test everything else first, keep the key period under about 2 s, close the window
right after, and do not loop it. The recipe, in one process with the app's own window and nothing sent to any other app:

1. Read the frontmost application (`lsappinfo front`, a read) and `NSRunningApplication.currentApplication.isActive`.
2. `render(<App />, { kind: 'panel', focus: true, windowBackground: 'blurred', title })` and wait about 700 ms for a frame.
3. Read `renderer.isWindowKey()`, the window's class, style mask, level and `hidesOnDeactivate`, the frontmost application again
   and `isActive`.
4. Capture the composited window with `CGWindowListCreateImage` on the window's own number (needs no screen-recording
   permission; `captureScreenshot` is the Metal frame alone and shows no titlebar). Through `bun:ffi`, the window is
   `[NSApp windows]`'s visible one.
5. Make it not key by the window's own API: `orderOut:`, wait 100 ms, `orderFront:` (it is visible and not key again, since
   `orderFront:` does not make a window key). Capture again.
6. `close` the window.

Measured on macOS 27, a 420 x 260 window at scale 2, `windowBackground: 'blurred'`, with Helium frontmost:

| | before | while key | after not key |
|---|---|---|---|
| frontmost application | Helium | Helium | Helium |
| `NSRunningApplication.isActive` | false | false | false |
| `isWindowKey()` / `isKeyWindow` | n/a | true / true | false / false |

The window was a `GPUIPanel` with style mask `0x8f` (titled, closable, miniaturizable, resizable, non-activating), level 0,
`hidesOnDeactivate` false, `isFloatingPanel` false, `becomesKeyOnlyIfNeeded` false, `canBecomeKeyWindow` true. Key to not
key, in device pixels (840 x 584), a pixel counting as changed when a channel moved by more than 8:

| region (points) | changed | mean channel change | max |
|---|---|---|---|
| traffic lights (0..80 x 0..28) | 2267 of 8960 (25.3%) | 19.2 | 211 |
| the rest of the titlebar strip (title text) | 1538 of 38080 (4.0%) | 3.1 | 96 |
| below the titlebar | 0 of 443520 | 0 | 0 |

What differs is the titlebar: the red, yellow and green buttons become grey and the title goes from dark to light grey.
The accent block and the page below the titlebar do not move, because gpuix paints them itself; a `<nativeview>` holding a
control that follows the key state would show there too. The key period measured about 1.16 s from `render()` to
`orderOut:`.

## The macOS menu bar

[docs/reference.md](../reference.md#the-macos-menu-bar) describes the menus an app gets. The rules behind them are in `packages/native/src/app_menu.rs`; two are not visible from the API.

- **The key window sees a key equivalent first, and the menu second.** Measured (S0 of the clipboard work): `performKeyEquivalent:` on the key window runs GPUI's key handling (the interceptors, so the page's `keydown`, then the keybinding and its action) and returns YES when the key was handled or JS stopped it; AppKit offers the key to the main menu only when the window returns NO, and the menu item fires only if `validate_menu_item` finds its action available (`cx.is_action_available`: a listener on the focus path or a global one). So an Edit menu carrying `⌘C/X/V/A` does not take the keystroke from the page, from an `<input>` or from a `keydown` that calls `preventDefault`; it fires for a click, and for a key nothing handled. Not measured: no key window, and a native view that holds the keyboard (AppKit asks the view first, then the menu).
- **The Edit menu is Cut, Copy, Paste and Select All, bound to the actions of `events/clipboard.rs`.** The same actions are the keys' and `<input>`'s, and the window's root element listens for them (and an app-level listener when nothing is focused, which the root element is not on the path for), so an item is enabled whenever the window is key, whatever has focus. What they do is [editing.md](editing.md#clipboard-commands). Undo and Redo are not in it: an `<input>` has them as actions, an editing host has none.
- **The system menu bar is outside the window,** so the automation API cannot see it. Verify it through the accessibility tree of the app you launched, by its pid, and not with a screenshot:
  ```bash
  osascript -e 'tell application "System Events" to tell (first process whose unix id is PID) to get name of every menu bar item of menu bar 1'
  ```

## Quitting

The host, not AppKit, ends the process. In embedded mode (the JS thread pumps the run loop) AppKit's own termination
path is `terminate:` and ends in `exit()` inside the pump, so `onTerminated` never ran and a process with other work (a
`Bun.serve`) could outlive its window or ignore a quit. Every way of quitting now goes through
`MacPlatform::request_termination`, which runs GPUI's quit callback and, once the callback completes, marks the platform
`Terminated` and posts `NSApplicationWillTerminateNotification` (what `terminate:` posts before it exits, for in-process
observers such as WebKit's website-data flush and window restoration; the delegate's `applicationWillTerminate:` receives
it and finds the platform already `Terminated`). The callback declines (returns `false`, without shutting down) while
GPUI's `App` is borrowed, for instance a quit requested from inside an update: the platform then stays as it is and
retries from the main queue, and further requests during that wait do nothing. After `Terminated` the pump returns
within the same call, handling no queued event, source or display-link step. The next `tick()` returns `false`, and
`startFrameLoop` runs `onTerminated`, which the adapters set to `process.exit(0)`:

- **Quit** (⌘Q, the app menu's Quit item, or `cx.quit()`), dispatched to the main queue.
- **The last window closing** (GPUI's `LastWindowClosed` policy, which the macOS run uses).
- **The quit Apple Event**, which is what the Dock's Quit, logout, restart and `-[NSRunningApplication terminate]` send.
  A handler for `aevt`/`quit` is installed in `applicationWillFinishLaunching:` (AppKit does not replace it afterwards),
  so a logout during launch is not answered by AppKit's own handler, which would reach `NSTerminateCancel` and cancel it.
  The handler requests the termination and returns, so the event is answered with success and a logout or restart is not
  cancelled.
- **Any other `terminate:`**: `applicationShouldTerminate:` requests the termination and answers `NSTerminateCancel`, so
  AppKit never calls `exit()`; the host does.

A quit from another thread (the Apple Event) wakes an idle host through the run-loop watch:
[frames-and-wakes.md](frames-and-wakes.md#off-thread-wakes-an-apple-event-quit). The paths are checked by
[the quit e2e](testing.md#the-quit-e2e). The blocking `run()` mode is unchanged.

## Several windows

An app makes a window the way the first one is made: a `GpuixRenderer` and its `init()`. The thread has one GPUI App, which
the first renderer's `init` creates (`MAC_PLATFORM`, `GPUI_APP`, the quit mode, the menu bar); a renderer whose `init` finds it
opens another window on it with `cx.open_window` and the same `to_gpui_window_options` mapping (`open_gpuix_window` in
`renderer.rs`, called by `window_set::open_another`), and never throws "a GPUI application already exists". `app_menu::init` and `window_set::observe_closes` run
once, with the App.

**A window handle per renderer.** `GpuixRenderer::window` holds the `WindowHandle<GpuixView>` that `init` opened, and every
native call goes through it (`update_window`, `update_window_or_defer`, `update_window_without_view` and `invalidate_window`
are methods on the renderer, and the helpers they call live in `window_set.rs`): the `GPUI_WINDOW` thread-local is gone. The same call made while a sync handler is running has
two cases (`events/sync_dispatch.rs`): for the window being dispatched it uses the stashed window as before, and for another
window (a handler of one window that reads or writes another renderer) it updates that window through the app the dispatch
holds, which the window being dispatched is out of and every other is in (`update_view_of`, `update_window_of`). The sync
handler of each renderer is bound to its own `WindowId` (`bind_window`), so input on a window reaches that renderer's JS.

**State keyed by host element id is per window.** Host ids are allocated by each renderer, so the second window's `div` can
have the first window's id. What outlives a frame under an element id is kept in `WindowMap` (`window_map.rs`, per `WindowId`,
dropped when the window closes): the scroll handles, list states and `visibleRange` reporters that napi reads without an App,
their kept copies for a forced read, the virtual-list scrolls queued for the next render, the pixel writes pending a layout
(`scroll_write`), the smooth scrolls and `scrollBehavior` (`scroll`), the scrollbar states and their frame counter
(`scrollbar`: another window's frames in between do not age a bar) and the `anchor-size()` records (`layout/anchor_size`).
The a11y links are kept per `RetainedTree::id` (`accessibility/links`), and a `display` transition's hold is a flag on the
elements of the tree (`RetainedElement::display_held`), since `is_display_none(element)` has no window to ask. Bounds,
host nodes, the hit registry, painted text, carets and search ordinals were keyed by window before, and they are dropped
with the window too (`text::paint`'s frames, `text::inline_hit`'s paragraphs, `text::search`'s ordinals, `editing::caret`'s
blink anchor and empty-line box, `text::inline_focus`'s press focus: each has a `forget_window`). Still ambient, and fine
because the draws of two windows never interleave: the scrollbar's per-frame clock, scroller style and draw counter, and
the per-frame scratch of `tape` and `text`. The layout a window owes a read (`LAYOUT_PENDING`) and its quiet list writes (`LIST_WRITTEN`) are keyed by
window: a read settles the reading window's own entry (`settle_pending_layout`, `layout_awaits_a_read(window)`), so a read in one window
neither discards the patch another window prepared nor notifies its view, and a window that closes drops its entry.

**Closing.** A window closes when the user closes it, when `closeWindow()` does, or when the App quits. In each case GPUI
removes the window and calls `App::on_window_closed`, which `window_set` listens to: the window is no longer open
(`isWindowClosed()` says so), what is kept under its id is dropped and its sync handler route is unbound. The root view drops
with the window. The App goes on for the windows that are left, and the last window closing ends it as before
(`QuitMode::LastWindowClosed`, the quit path in [frames-and-wakes.md](frames-and-wakes.md#a-quit-ends-the-frame-loop): the Dock's
Quit, `⌘Q` and a logout still end the whole app through `onTerminated`, once). `tick()` keeps its meaning, false once the
platform quit, and pumps the whole platform whichever renderer calls it; a renderer is told its own window is gone by
`isWindowClosed()`, which the shared frame loop asks of every renderer and answers with the `onWindowClosed` option of
`startFrameLoop`.

**Thread-local order.** `init` decides whether an App exists from `MAC_PLATFORM` and touches `GPUI_APP` only once the first
window is open. Thread-locals are destroyed in the order they were first used, and the App in `GPUI_APP` drops its windows,
which write to GPUI's profiler journal (its own thread-local): a `GPUI_APP` registered before the journal makes
`process.exit()` abort with "thread local panicked on drop".

**One pump.** The platform is pumped once per iteration and the run-loop wake hook is shared:
[frames-and-wakes.md](frames-and-wakes.md#several-windows-one-loop).

**A JS `document` and `window` per window.** Each renderer's window has its own `GpuixDocument` and `GpuixWindow` in JS
(`documentOf(renderer)`, `windowOf(renderer)` in `@ghia/native/host`; `events/window-target.ts` and `events/window-targets.ts`):
the roots (`<html>`, `<head>`, `<body>`), `activeElement`, selection, `adoptedStyleSheets`, `elementFromPoint`, node makers,
and the window's size, `matchMedia`, `resize`, `requestAnimationFrame` list and the top of the event path.
`mountedRenderer()` is gone: nothing is answered from "the last window that mounted". The global `document` and `window` are
the first window's while its root is mounted, and a closed first window leaves them its own, empty. An event bubbles through
its own window's document and window target only. The model and the rules for nodes are in
[the reference](../reference.md#a-document-per-window); how it is built is in [events-and-input.md](events-and-input.md#the-event-path-of-each-window)
and [web-renderer.md](web-renderer.md#several-windows).

**`window.open`** (`js/window-open.ts`, `js/window-lifecycle.ts`; the behaviour is in
[the reference](../reference.md#windowopen-and-the-window-object)). A renderer knows how to open a sibling of itself
(`bindWindowOpener`): `createNativeRenderer` makes another `createNativeRenderer`, calls its `init` with the title, `fonts` and
`focus` of the opener's and the size and place of the features, and joins it to the frame loop with the opener's `onTerminated`,
`onError` and `frameMs` (only when the opener is in a loop; an app that ticks itself keeps ticking itself); the test
renderer makes another `TestRenderer` and activates it. The new window's root is the adapter's: `registerWindowFactory(renderer,
factory)` (`@ghia/native/host`) says how to mount an empty root (`html`, `head`, `body` and the node factory through
`installElementSource`) on a renderer, and what it returns is called once when the window closes. `window.open` checks that the
opener has an opener binding and a factory before it makes anything, and closes the window it made if the factory throws.
The Window object is the `GpuixWindow` of the renderer, which extends `Window` (`events/window-targets.ts`: the
members, the `on<event>` properties, and a prototype chain that falls through to the global object, so one realm's `fetch`,
`HTMLElement` and `localStorage` are a window's too); its calls that reach outside go through `installWindowHooks`, as `matchMedia`
does, because `window-lifecycle.ts` imports the registry that imports the window classes.

**`init` from an event handler.** A window opened by `window.open` in a click or key handler is made while GPUI holds the App for
the input. `init_macos` then opens the window on the App the dispatch holds (`with_active_window`, as `update_window_of` does for a
read of another window), and fails with a clear error when a native call holds none; outside a handler it uses `GPUI_APP`.

**Closing and the key window.** A window ends when `close()`, the user or the app's end closes it. The frame loop reports a
window that left it (`releaseClosedWindows`, or `terminate` for all) to `windowGone(renderer)`, which fires `pagehide` and
`unload` once (a script's `close()` already sent them with `beforeunload`), marks the window closed (`forgetWindowSource`)
and calls the disposer the adapter's factory returned. `windowGone` acts once for a renderer: a `close()` task that outlives the window's release (a test's `dispose()`, the frame
loop) finds it done and returns, so it cannot mark the global window closed again after a later window took it over. `close()` calls the disposer before `closeWindow()`, while the native
window is still there; for a window the user closed the disposer runs after, which is when a window is gone to native (below).
The first window is no exception: its root unmounts when it closes, as a later window's does, and a popup that stays open keeps
the app and the global `window` (`pagehide` and `unload` fire on it). Window disposers (`registerWindowDisposer`, from
`@ghia/native/host`) are how an adapter's root asks for that: a disposer runs once, from `windowGone`, with the window's document still the
root's, and `renderSlotFor` registers one for each slot so that a closed window's slot is dropped and a later `render()` opens a new
window (`ownRenderer()` is the renderer of the window `render()` opened itself, `undefined` once it is gone). `close()` is
asynchronous like a browser's: `closed` is `true` at once, and `beforeunload`, `pagehide`, `unload`, the root's unmount and the
platform close run in a later task, so the handler that called it never has its root unmounted under it.

**A window that is gone to native.** The disposers run after the platform removed the window, so a renderer whose GPUI window is
gone behaves as closed whichever way it went (the user, `closeWindow()`, the App quitting). `isWindowClosed()` is true as soon as
GPUI no longer has the window: `window_set::closed` runs from `on_window_closed`, `note_app_ended` runs it for every window left
when `tick()` sees the quit (GPUI's shutdown drops the windows without telling the observer), and an update that GPUI answers with
"window not found" marks the window closed too, but only when `App::windows()` no longer lists it: GPUI answers the same for a window
that is in the middle of its own update (it is taken out of its slot, its id stays listed), which is what a `focus` listener of
window B finds when it reads window A whose click focused B. That window is open, stays open, and the call throws "The window is being
updated by an input that is being dispatched ..." (`window_set::update_error`). From then on `applyBatch` only updates the tree (no invalidation, no focus), so
unmounting a root does not throw; a setter that only means something for a window that is there (the title, size, `activate`,
`minimize`, `zoom`, fullscreen, appearance, the `selectionChange`, `appearanceChange`, `mediaChange` and window key listeners, focus
stepping, `blur`, `blurElement`) does nothing and answers success, and a frame request or deferred update does nothing; a native call that needs the window
to answer (bounds reads, the window's size, scroll metrics, `captureScreenshot`, simulated input) throws "The window is closed",
not GPUI's "window not found". `closeWindow()` on a window that is gone does nothing. The key window is native's: a view
observes `observe_window_activation` and, while JS listens for `focus` or `blur` on `window` or `document` (the
`setWindowEventListeners` set), sends the `windowActive` event (`window_activity.rs`, `value` "true" or "false"), which
`renderer-state` turns into the `focus` or `blur` event of `windowOf(renderer)`. `document.hasFocus()` reads `isWindowKey()`.
A test window is active when it opens and `setWindowActive` changes it; `TestRenderer.activateWindow()` makes it the key window
and every other test window not. The Edit menu's command (`events/clipboard.rs`) goes to the active window, else the front window
of the app (`window_stack`), else the only window.

**Reads for the Window object.** `getScaleFactor()` (`devicePixelRatio`), `getWindowPosition()` (`screenX`, `screenY`: GPUI's
bounds are relative to the window's display, so the display's global origin from `screen.rs` is added) and `setWindowSize(width,
height)` (`resizeTo`, `Window::resize`, which `setContentSize`s the window) are live napi methods; the test renderer has
`getScaleFactor` and `isWindowKey` and its own `setWindowSize`. GPUI has no call to move a window after it opens, so `moveTo`
and `moveBy` do nothing.

**The adapters render into windows.** Each registers a window factory in its `createRoot(renderer)` (so `render()` has it too):
the factory makes a root of its own kind on the renderer `window.open` made (`createRoot(opened)`, which attaches an empty
`<html>`, `<head>` and `<body>` and the node makers) and returns its `unmount`. The rest is per adapter:

- **Solid** (`packages/solid/src/root.ts`, `renderer.ts`). `render(code, container)` is `renderIntoElement(code, element)`: the
  element's `root` (a `HostRoot`) is the window's; `elementMounters` maps it to the function its `createRoot` closure made, which
  runs `universalRender` into the element with `marker: null` and the window's `GpuixContext` around it, and tracks the dispose
  in `elementRenders`. The root's `clear` runs those first, so a closing window disposes what was rendered into it (cleanups
  run, nodes are removed). A dispose removes the children that appeared in the element while it was mounted. Solid binds a node to
  a root when it is mounted, so a `Portal` whose `mount` is another window's body needs nothing more. `render(code, options)`
  keeps one `RenderSlot` for each renderer (`slotFor` in `renderer.ts`; the window it opens itself is `own`), where it kept one
  global.
- **React** (`packages/react/src/reconciler/reconciler.ts`, `renderer.ts`). `createRoot(container)` is `createElementRoot`: a
  reconciler root whose container is a derived `Container` with `portalTarget` set to the element, the mechanism a portal uses,
  so it takes the window's ids, mutation queue and event map from the element's own container; its unmount is in the window
  container's `elementRoots`, which the window root's cleanup runs first. A portal gets the same: `portalContainerFor(target)`
  derives from the container that `target`'s state names, and React hands that container to `createInstance` as the root
  container inside the portal, so the nodes of `createPortal(children, w.document.body)` take the other window's ids and queue
  with no reconciler change. `resetAfterCommit` flushes the committing root's queue only, so a portal into another window is sent
  by the queue's scheduled microtask. `render()` keeps a `RenderSlot` for each renderer in `renderHosts` (the `own` slot has the
  frame loop and the process-level error handlers' overlay).

The frame loop is the app's: `window.open` joins the new renderer to the opener's loop (above), and neither adapter starts one
or an `onTerminated` for a window it did not open itself. The test renderer opens several windows at once:
[testing.md](testing.md#several-test-windows).
The
`appearance` option of a window after the first is the App's (`set_window_appearance` is the App's), and the menu bar is the
App's; both are the platform's single-App model, not a choice here.

Checked by `window_map`, `window_set` and `shared_wake` unit tests, `frame-loop.test.ts`, and
[the multi-window e2e](testing.md#the-multi-window-e2e).

## Window placement and displays

An app can put a window on a second monitor and learn where the monitors are. Electron's answer is `x` / `y` in the window
options and `screen.getAllDisplays()` / `getPrimaryDisplay()`.

### API

- `WindowOptions.x` and `.y` (CSS px) put the window's top-left there when both are set; with one missing the window is
  centred as before. The space is global: origin at the primary display's top-left, y down, so a display to the left of or
  above it is negative.
- `screen` (`packages/native/js/screen.ts`, `./screen` in `@ghia/native`, re-exported by `@ghia/react` and
  `@ghia/solid`) lists the displays with Electron's `Display` fields (`id`, `label`, `bounds`, `workArea`, `size`,
  `workAreaSize`, `scaleFactor`, `rotation`, `internal`).
- `fullscreen` with a point goes fullscreen on that display.
- The functions are read off the native namespace, as `validateKeyframes` is: the browser entry has none, and a named
  import would fail the adapters' browser bundles.

### What it maps to in gpui

- **GPUI reads a window's origin relative to its display, not globally.** `MacWindow::open` takes
  `WindowParams.bounds.origin` against the top-left of the display named by `WindowOptions.display_id` (points, y down).
  `to_gpui_window_options` is the only place that builds `window_bounds` and `display_id`: it picks the display for (x, y)
  and passes `DisplayId` and `(x - display.x, y - display.y)`. `WindowBounds::Fullscreen` wraps the same bounds, so a
  fullscreen window opens on that display.
- **The display comes first by containment, else by distance.** The point is in a display's bounds half-open, so a right
  or bottom edge belongs to the neighbour, as in a DOM rect. A point on no display takes the nearest, measured to the rect
  and not the origin, the first of equals. The window's size is the one asked for (or the centred size); it is not
  clamped to the display.
- **zed makes `MacDisplay` public** (`gpui_macos`, one commit). `PlatformDisplay` gives only local bounds (origin 0, 0)
  and no name, scale, rotation or built-in flag, and `MacDisplay` was crate-private. `MacDisplay::screen() ->
  Option<MacScreen>` returns the display's `NSScreen` data (`localized_name`, `frame`, `visible_frame`,
  `backing_scale_factor`) with frames in global points: Cocoa's y is flipped with the height of the first `NSScreen`,
  which is what `CGDisplayBounds` is. `rotation()` is `CGDisplayRotation`, `is_builtin()` is `CGDisplayIsBuiltin`. The
  trait is unchanged, and `bounds()`, `visible_bounds()` and the window's local placement are as they were (Zed relies on
  them). `screen()` is `None` for a display AppKit has no screen for (a mirrored one); `getAllDisplays()` leaves it out
  and `getPrimaryDisplay()` throws if the primary has none.
- **It works before the window opens.** On macOS no GPUI `App` exists until `init` opens the first window, so the screen
  API cannot go through `App::displays()`. `screen.rs` reads `MacDisplay` directly, and `init_macos` reads the displays
  before it builds the window options. `init_threaded` passes none: with no displays the window is placed at (x, y) with
  no `display_id`.

Multiple displays are not exercised in CI (the tests run on whatever displays the machine has); a window opened on a
second display, a rotated one and a mirrored one were not checked live.

## Breaking changes

- A `titlebarTransparent` window no longer drags from AppKit's top strip, and clicks there are no longer held back for
  double-click detection. An app puts `appRegion: "drag"` on its bar, and `"no-drag"` on the controls inside it.
- zed: `Window::start_window_move` takes `cx` (`start_window_move(cx)`), and in DOM mode `window_control_area_at` follows
  bounds and paint order, not hit testing.

## Upstreaming

- **Appearance and fonts.** Both are small and independent of everything else.
- **Drag regions.** The zed side is opt-in and small: client areas, `window_control_area_at`, the cursor rule and the
  macOS lock fix go to `remorses/zed` as separate commits (the lock fix is a deadlock fix that stands alone;
  `start_window_move(cx)` changes a public signature). The gpuix side needs the pointer dispatcher and `PointerState`
  ([events-and-input.md](events-and-input.md)), so it goes with them.
- **Placement.** The zed side is one commit that adds exports and accessors to `gpui_macos`, with no behaviour change, and
  can go alone. The gpuix side (`screen.rs`, the two options, `to_gpui_window_options`) is independent.

## Tests

- Placement is Rust unit tests with fake displays, so any layout runs on one machine: `window_options_tests` (18) and
  `screen.rs` (10) cover a point on a second display at (1512, -200), a point on the primary, a point on no display, one
  of `x` / `y` only, fullscreen with a point, no displays, and the edges of `display_for_point`. The real displays are
  read in `screen.test` (7) and the Rust `screen` tests on macOS, which hold what must be true for any setup: the primary
  is in the list and starts at (0, 0), ids are unique, each work area lies inside its bounds, `size` is the rectangle's,
  the scale factor is at least 1, the rotation is a quarter turn, the label is not empty. zed has `gpui_macos` `display`
  (2): `screen().frame` equals `CGDisplayBounds`.
- Drag regions: see Platform status above; the window tests are listed in [testing.md](testing.md).
- The title: `window_title_tests` in `renderer.rs` (3) cover the decision to set it (the first title, a changed one, an
  unchanged one, an empty one), and `window-options.test.tsx` retitles a test window with `setWindowTitle()` and reads
  `getWindowTitle()` back after a later frame. gpui's test window does not report its title, so a skipped set is only
  observable in the decision.

Deviations: [deviations.md#window](deviations.md#window).
