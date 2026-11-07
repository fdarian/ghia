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
as before for `PopUp`, `Floating` and `Dialog`. gpuix has one window and does not read either.

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

- **No Edit menu with `⌘C` / `⌘V` / `⌘X` / `⌘A`.** AppKit consumes a key equivalent before the window sees the key event, so those items would take the keystroke away from the selection listener in `text::paint` and from the per-focus clipboard handling in `custom_elements::input`. An Edit menu needs those handlers moved into GPUI actions first.
- **The system menu bar is outside the window,** so the automation API cannot see it. Verify it through the accessibility tree of the app you launched, by its pid, and not with a screenshot:
  ```bash
  osascript -e 'tell application "System Events" to tell (first process whose unix id is PID) to get name of every menu bar item of menu bar 1'
  ```

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
