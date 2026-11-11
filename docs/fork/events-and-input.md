# Events and input

How pointer, focus, keyboard and form input reach JS as DOM events, and how hover, press and focus state turn into styles. It also covers the inline-span side of the same machinery (listeners, cursor, focus on text spans).

## Pointer events

GPUI decides hover per element and hands gpuix one listener per node. That gave gpuix-only rules: a filled or absolute box blocked hover and clicks to its ancestors, an element with both `onMouseDown` and `onMouseMove` silently captured the pointer, `click` was synthesised from mouse-up with no press-origin check, `pointerEvents: "auto"` meant "block the wheel", and a popup could not tell whether a press was inside its trigger. There was no capture phase, no `target`, no pointer events and no drag and drop. The design replaces those rules with the DOM's.

### One hit test per pointer event

zed gets an opt-in DOM hit-testing mode per window (`Window::set_dom_hit_testing`, default off, so other GPUI users are unaffected). Each hitbox records its parent. The hit is the topmost hitbox that is not `HitboxBehavior::PassThrough`, plus its parent chain. `PassThrough` is `pointer-events: none`: never a target, but still in the chain when a descendant is hit. A deferred (anchored) layer is its own hitbox root, so hover, focus and wheel over a popup follow layout, as a portal does in `body`.

Rules that feed the hit test:

- **`pointerEvents: "none"` is inherited** (a descendant sets `auto` to restore it), and an element with `none` is never a target even if it has listeners. `auto` no longer blocks the wheel.
- **`inert` behaves like inherited `pointer-events: none`**, and a descendant's `auto` does not undo it. A pass-through or inert scroller never claims the wheel, including a latched gesture.
- **`clipPath` clips hit testing** (zed `Hitbox.clip`): a point outside the clip falls through to what is below, and the clip cuts the element's subtree with it. See [paint-and-transforms.md](paint-and-transforms.md) for the clip itself.
- **`borderRadius` cuts the hit area of the box itself** (zed `Hitbox.corner_radii`), whatever its `overflow`: a pointer over a rounded-away corner reaches what is below, as in a browser. A child covering the corner is still hit through its own box.
- **Text with no element of its own has no hitbox**; the element that holds it is the target. Spans with listeners are the exception, see [inline spans](#inline-span-listeners-cursor-and-focus).

`clipPath` and `borderRadius` apply to every host element whose hitbox comes from a styled box. `<virtual-list>` inserts its own shaped hitbox, and its scrollbar sits inside the clip. A hitbox a custom element inserts itself with `Window::insert_hitbox` has no clip and square corners; use `insert_hitbox_shaped` to get both.

### The dispatcher

A native dispatcher in `packages/native/src/events/` owns the events. One set of window-level GPUI listeners per view turns each input into a path (target first, then logical ancestors; an anchored layer continues to its tree parent) and emits DOM events. Per-view `PointerState` (`events/state.rs`) holds the hovered and active chains, press targets, click count and pointer capture.

A type is emitted only if some element on the path, or `window` or `document`, listens to it. JS keeps the window and document listeners, so it tells native which types they hear (`syncWindowEventListeners`). A pointer move over bare background therefore reaches them, with `body` (which fills the window) as its target. A `window` or `document` listener hears every event of its type, not only those an element on the path listens for. A new event type therefore needs its prop in `packages/native/js/events/event-props.ts`, which is what sets the native listener; without it the type is never emitted.

Every element needs a host-derived GPUI id (`events::ids::host_element_id`, `host_id_of`; the parts inside a native element take a `__gpuix_<kind>` id built from it). gpui keys `InteractiveElementState` by `GlobalElementId`, so an element without an `.id(..)` silently loses its hover state, its scroll offset, its accessibility node and every state gpui keeps for it. `<img>` once had none, which is why an animated GIF never left frame zero: `ImgState` holds the frame index.

JS propagation is `dispatchDomEvent` in `packages/native/js/events/dispatch.ts`: capture, target, bubble along `payload.path`, with `stopPropagation`, `stopImmediatePropagation`, `preventDefault` and `on<Event>Capture` props. Native sends element ids; JS resolves them through the adapter's element source, so `target`, `currentTarget` and `relatedTarget` are the objects a `ref` gives (`null` for an event aimed at the window). `path` is `composedPath()`, `elementId` keeps the numeric id, and window-level callbacks get the same resolution. The raw `onEvent` tap keeps ids.

### Event classes and delivered events

`createDomEvent` (`dispatch.ts`) builds the event a handler gets. It is an instance of the class of its type (`delivered-events.ts` holds the type to class table: `click` is a `PointerEvent` as in Chrome, `change` an `InputEvent`, an unknown type a plain `Event`), made as `Object.create` of a prototype that is built once per type string and carries what is the same for every event of the type (`type`, `bubbles`, `cancelable`, `isTrusted`, the DOM's defaults for fields native does not send). The payload's fields are own properties, and `timeStamp`, `currentTarget`, `eventPhase` and `defaultPrevented` are too from the start, so the walk's writes replace a property and do not add one. Every accessor of `Event.prototype` is shadowed on that prototype by a data property or by Ghia's own accessor (`srcElement`, `cancelBubble`, `returnValue`), because the runtime's accessors throw on an object its constructor did not make; the stop and `preventDefault` methods read and write the per-dispatch state (`event-state.ts`, kept under the `STATE` symbol). The constructor of the runtime's `Event` is not run because Bun defines `isTrusted` as an own, unconfigurable accessor that is `false` for any constructed event, and because the constructor with the shadowing an app's event needs costs several times the literal this replaced: 10k events and their dispatch cost 8.5 ms against 9.2 ms with the literal for a realistic mix of pointer, mouse, key, focus and wheel events, and 6.6 ms against 9.1 ms for `pointermove` alone, under Bun with the release addon. A delivered event is therefore not a runtime event inside (see [deviations](deviations.md#events-and-input)).

Mouse and keyboard events get `shiftKey`, `ctrlKey`, `altKey` and `metaKey`, from the payload's `modifiers` (pointer and mouse events) or its booleans (keys). `getModifierState` is on the `MouseEvent` and `KeyboardEvent` prototypes of `classes.ts`, which are the DOM classes as runtime `Event` subclasses (`dom-globals.ts` installs them where the runtime has none, the pattern of `MediaQueryListEvent`).

### `dispatchEvent`

`dispatchEvent` is on the shared elements through `defineDomMembers` and on `GpuixDocument`; both end in `walkDomEvent` (`dispatch.ts`), the capture, target and bubble loop `dispatchDomEvent` also runs, so a delivered event and an app's event take one walk. The walk takes the path (elements, target first), a `HandlersAt` (the root's id keyed map for a delivered event, each element's `ElementListeners` for an app's, which has `get(key)` for that), and the hooks of `window` and `document` (`propagationHooks` in `window-target.ts`, which `dispatchPropagating` uses too).

The state of a dispatch is `DispatchState` (`event-state.ts`): the stop flags, `dispatching` (what makes a second `dispatchEvent` throw) and the path. A delivered event keeps it under the `STATE` symbol. An event an app built is a real runtime `Event`, whose `target`, `currentTarget`, `eventPhase`, `srcElement`, `cancelBubble` and `composedPath` belong to the runtime, so the first dispatch defines own accessors for them on that instance (`installShadow`, once per event, reading and writing the state, setters included so the walk assigns `event.currentTarget = x` as it does for a delivered event) and own `stopPropagation` and `stopImmediatePropagation` that record into the state and call the runtime's. `defaultPrevented` and `preventDefault` stay the runtime's, and the walk reads `event.defaultPrevented` the same way for both kinds. When the dispatch ends the stop flags and path are cleared, `currentTarget` is `null`, `eventPhase` 0 and `target` stays.

After the walk an uncanceled `click` that is a `MouseEvent` asks native for its activation behaviour (`activateAfterClick`, `events/activation.ts`; napi `activateElement`, which runs `Activation::activate` of `events/activation.rs` for the element's path and delivers no click of its own). Native owns what has an activation behaviour (label, button, checkbox, radio). A checkbox or radio is toggled before the click's listeners run, so `dispatchEvent` first asks native for that (`preActivateClick`, napi `preActivateElement`), and after the walk either puts the toggle back (`cancelActivation`, a listener canceled the click) or runs the rest (`activateAfterClick`: `input` and `change`).

### Listener lists (`addEventListener` on an element)

An element has `addEventListener` and `removeEventListener` for any type, in `packages/native/js/events/element-listeners.ts` (`ElementListeners`, kept on the element for its life; `defineDomMembers` in `dom-members.ts` puts the members on a Solid `HostElement` and a React instance, as `defineScrollMembers` does the scroll ones). For one type and phase the element has one list, and the `on*` prop is an entry of it, placed where it was first set, replaced in place and taken out when unset, which is how the DOM orders an event handler attribute. The dispatch visit loop (`dispatchDomEvent`) is the only place that calls them: the handler map (`EventHandlerMap`) holds, under the key of the prop (`click`, `clickCapture`), either the prop's handler itself, while it is the only entry (an element with no listener costs what it did before), or a runner (`LISTENER_RUNNER`) the loop calls with the state of the dispatch, so `stopImmediatePropagation` ends the list, a throw of one entry goes to `onError` and the rest run, an entry removed during the dispatch is not called and one added during it waits. A runner is also callable as a plain handler, for the callers that read the map by key (`keyboard-defaults.ts`). `once` takes the entry out before it runs, `passive` makes `preventDefault()` a no-op while it runs, `signal` removes it when it aborts (an aborted signal adds nothing), and the same function in the same phase is added once. Any type is accepted: one native never emits (`touchstart`) is stored and never fires.

Selectors (`matches`, `closest`, `querySelector`, `querySelectorAll`) are on the shared `Element`, `Document` and `DocumentFragment` classes (`js/dom/nodes.ts`, wiring only), and run in `js/dom/selectors.ts`: `css-select` with an adapter over the nodes' `[DOM_BINDING]()` (parent, children, `getAttribute`), a plain depth-first walk of the descendants (not `css-select`'s own `selectAll`, which would add the next siblings for `:scope + x`), and each selector compiled once and kept by its text (at most 1000, the oldest dropped; a selector that failed to compile is kept too, so a `try`/`catch` caller pays one parse). `relativeSelector` is off (a leading combinator is a `SyntaxError`), `cacheResults` is off (a compiled selector outlives the tree it ran on), and an attribute name (which `css-select` always lower-cases) is looked up without case on an SVG element, where `getAttribute` is exact. `:scope` is a user pseudo that reads the scoping element set around the call, so the compiled query does not depend on where it runs. `:focus`, `:focus-visible`, `:focus-within`, `:hover` and `:active` are the only native calls: user pseudos that read `ElementBinding.native` (the renderer and id of a mounted element, which the two adapters fill in) and call `FocusState::matches` / `matches_focus`, which keeps its `Err` for any other selector and is reached with exactly those five. `selectors.test.ts` (native) pins the engine over fake nodes; the adapters' `selectors.test.tsx` run it on real elements after a real focus.

Native's listened set is the types whose list is not empty, in either phase (`registerEventListener`'s refcount), so adding the first listener of a type is what turns it on, as it is for a prop. A Solid element is created natively on every insertion, so it `attach`es its lists to the root's map and native on mount and drops them on unmount; the lists stay on the element. Because a React root sends its batch at the end of a commit and a listener is usually added after it (a ref, an effect), `addEventListener` and `removeEventListener` send the pending batch themselves.

Handler errors go to `onError` if the renderer has one, else `reportError`, for element, window and document listeners alike. Dispatch continues after a throw, and simulate calls no longer rethrow.

### Events and payload

- Pointer and mouse events (pointer first). `over`/`out` bubble; `enter`/`leave` fire per element in DOM order.
- `click` fires on the nearest common ancestor of the press and release targets, with `auxclick`, `dblclick`, `detail` and `contextmenu`.
- `wheel`. `onWheel` and `onWheelCapture` are pointer-event props (`HostWheelEvent`: the payload fields plus `deltaX/Y` and `deltaMode`). The wheel goes only to scrollers that are ancestors of the target, so a modal or popup no longer scrolls the container it was declared in. Routing and latching are in [scroll.md](scroll.md).
- `mousedownoutside` fires for every listener whose logical subtree does not contain the press target. Popups and submenus in anchored layers count as inside their trigger.
- Payload: `target`, `currentTarget`, `relatedTarget` (elements), `composedPath()`, `elementId`, `clientX/Y`, `offsetX/Y` (from the target's padding edge, set by the dispatcher in `dispatcher.rs`), `button`, `buttons`, modifiers, `detail`, `pointerId`, `pointerType`, and `movementX/Y` (the motion on a move, 0 on every other event).
- A `pointerdown` a handler cancelled suppresses the press's compatibility events: its `mousedown`, the `mousemove`s while it is held and its `mouseup`. `click` still fires, as in the DOM.
- Disabled controls get no `click`, `auxclick` or `dblclick` (HTML), and `element.click()` and accessibility clicks skip them too. Pointer and mouse move events still reach them. See [state styles](#state-styles-from-pointer-and-focus) for how a control counts as disabled.
- Clicks from the keyboard or VoiceOver are DOM clicks with `detail` 0, `pointerId` -1 and `pointerType` `""`.
- Transition and animation events go through this dispatcher with `target` and `path`, and bubble (they are not cancelable). Native emits the lowercase DOM names (`transitionrun`, `animationend`, ...) and each has an `on…Capture` twin. See [motion.md](motion.md).

### Synchronous dispatch

A press, a wheel and the file-drag events reach JS synchronously. On macOS and in the test renderer, `mousedown`/`pointerdown`, `mouseup`/`pointerup`/`click` and `wheel` run in the capture phase through `events/sync_dispatch.rs`, as key handlers do. This is how an event handler gets to veto GPUI's native defaults:

- `preventDefault` on a `mousedown` cancels the focus default and the input editor's focus (it calls `window.prevent_default()`). `pointerdown` does not, as in Chrome.
- `preventDefault` on a wheel cancels that input's scroll.

A move is not on that list: it is deferred past the input and queued to JS like any other event, so it arrives on a later turn of the event loop than the press before it and the release after it. Input from the OS has time between events and keeps its order. A driver that simulates a whole drag in one synchronous burst would deliver the release before the moves, so `liveRendererAsTest` waits one event-loop turn after every input it simulates (the in-process `dragBy`, `dragTo` and `mouse.drag` on a live window). The test renderer delivers everything inside the call and needs no wait.

The input does not lease the root view (GPUI's input callback is `AnyWindowHandle::update`, and the test renderer dispatches the same way), so every renderer call works from a handler and reads current values, and `document.activeElement` is the focused element. Only a call that starts another input or drives the test app (`simulate*`, `advanceTime`, `captureScreenshot`) cannot run from a handler. A new napi method goes through `sync_dispatch::route` and the `update_*` helpers. See [frames-and-wakes.md](frames-and-wakes.md) for how JS is woken on the other path.

### Pointer capture

Capture is explicit: `setPointerCapture` / `releasePointerCapture` / `hasPointerCapture` with `gotpointercapture` and `lostpointercapture`. Implicit capture is gone. A call is in force when it returns (`PointerRequests`): the next pointer input reads it and fires `gotpointercapture` first. `cancelDrag` works the same way.

`Reorder` (React and Solid) calls `setPointerCapture` on `pointerdown` and ends the drag on `pointerup`, `pointercancel` or `lostpointercapture`. On macOS the press is dispatched synchronously, so no move is lost.

### Drag and drop

File drags fire `dragenter`/`dragover`/`dragleave`/`drop` with `dataTransfer.files` (`path`, `name`, `size`, `type`, `lastModified`). `draggable` elements start a session after 4 px of movement and fire `dragstart`, `drag`, `dragend` and in-app drops through the same code. `dataTransfer` is a JS object per session. During a drag no pointer or mouse events fire, as in the DOM. Escape during an element drag cancels it and reaches no `keydown` listener (`events/keyboard.rs` does not send it), as in Chrome.

On macOS the OS drop operation of dragged-in files follows `dragover`. A `dragover` that calls `preventDefault` with a `dropEffect` of `copy`, `move` or `link` sets the drag cursor through `Window::set_drag_operation` (a zed commit; `gpui_macos` answers `draggingEntered` and `draggingUpdated` with it, within what the source allows). Anything else refuses the drop at the OS, and a window with no `dragover` listener refuses file drops. The file-drag events are delivered synchronously for this, from inside the OS drag callback.

### `cursor: "none"` and pointer lock

`cursor: "none"` and `requestPointerLock` / `exitPointerLock` (macOS) are backed by zed commits for `CursorStyle::None` and pointer lock. The lock is taken in the call, from an input handler too (`GpuixRenderer::settle_pointer_lock`), so `pointerLockElement` is current and the next pointer event is aimed at the lock element. `pointerlockchange` and `pointerlockerror` are events at `document` (`event.target` is `document`, they bubble to `window`, the element is `document.pointerLockElement`).

`cursor: none` hides the cursor per window (`CursorHide` in `gpui_macos`). It ends when the pointer leaves the window, the window stops being key or it closes.

## Focus

- **Order and events.** DOM order: `blur`, `focusout`, `focus`, `focusin`. `focusin`/`focusout` bubble and carry `relatedTarget`.
- **`:focus-visible`** follows Chrome's document-level flags, not the element focus left, and is readable with `matches(':focus-visible')`. `FocusModality` (`focus.rs`) holds two facts that the key and mouse listeners write from inside input dispatch (so it is shared through `InputRouting`, as the focusables are): whether the last focus a mouse press gave an element is still the last (`mouse_focused`) and whether a key went down since a press moved focus (`key_down`). `FocusState::observe` recomputes `visible` from them: a text control, or not `mouse_focused`, or `key_down`. What decides them is where the change came from. A keydown without Ctrl, Alt or Meta sets `key_down`; Shift on its own does too, which gpui reports only as a modifier change, so `keyboard::note_modifiers` listens on the root element. `PointerDispatch::press` notes a press whose `mousedown` was not cancelled, and the focus change it causes then clears `key_down` and sets `mouse_focused` (a press that moves focus to nothing clears `key_down` only). A press that moves nothing, an already-focused element or blank body with nothing focused, changes neither. Any other move (Tab, gpui's own) sets `mouse_focused` to the input device gpui last saw. A script focus (`note_programmatic`) leaves both facts alone, so it matches before any input, after Tab, after a key and after a press on blank body, and not after a click until a key, whatever element focus left. Window deactivation does not touch them either; the element that held focus comes back with the same answer (`suspended`). The table of cases is Chrome's, run by `~/.cache/ghia-round48/fv2.py` against `focus.rs` (`focus_visible_follows_chromes_document_flags`) and `focus-visible-heuristic.test.tsx` (by pixel, with and without a transition). Not matched: CapsLock, which Chrome counts as a key and gpui reports with the modifiers. A `focusWithin` state style exists too. Whether it matches never depends on `transition`.
- **`tabIndex` as in the DOM.** `-1` is focusable by script only, positive values follow DOM order. A listener for a key or focus event no longer makes an element focusable; give it a `tabIndex`. A disabled input or button is never focusable. An enabled `<button>` and an `<a>` with an `href` are tab stops without a `tabIndex` (`html::is_focusable_by_default`).
- **`focus({ preventScroll })` and `blur()`.** `focusNext()` and `focusPrevious()` scroll the new focus into view with `nearest`, as Tab does.
- **Timing.** The focus events of a press, of `autoFocus` and of a frame reach JS before the call that caused them returns (`settle_focus`, macOS and the test renderer), so `document.activeElement` is current in the next handler. `autoFocus` focuses in the commit that mounts the element.

### An inactive window and focus emulation

A window that is not active fires no focus events, as in Chrome: gpui reports no focus path for it (`next_frame.window_active`), the caret is not drawn (`shows_caret`) and `observe_focus_in` sees nothing focused, so `onFocus`, `:focus-visible` and `focusElement` do nothing visible until the window is activated (the element keeps its `:focus-visible` for when it returns). Typed text still arrives, because the editor takes keys by GPUI's focus handle, which does not depend on the window being active, and that looked inconsistent next to the missing `onFocus`.

An agent that drives a window behind the user's work cannot activate it, so `GPUIX_BACKGROUND=1` emulates focus, on the model of CDP's `Emulation.setFocusEmulationEnabled` (Chrome's own answer to the same problem: DevTools makes `document.hasFocus()` and focus events behave as in a focused page without focusing the browser). `focus_emulation.rs` reads the variable once, when `renderer.rs` or `test_renderer.rs` opens the window, and calls `Window::set_focus_emulation`. That flag is the single place: `Window::is_window_active()` is the platform's value OR the flag, and a frame records it as `window_active`, which decides the focus path (so `on_focus`/`on_blur`, `focusWithin` and `:focus-visible`) and what `observe_focus_in` and `shows_caret` ask. `focusElement` needs nothing of its own.

What it does not change: the window is still not key and the app is not activated; frame throttling, `is_window_hovered` (and so `reset_cursor_style`, which would otherwise set the system cursor from a window the pointer is not over) and the profiler read the platform's `active`; nothing that follows the key state (glass, accent colours, `NSTrackingActiveInKeyWindow`) is touched. A real activation change while emulating notifies nothing and fires no second focus (the frame's `window_active` is already true), and the activation observers run only when the effective state changes. The page has no window-level `focus`/`blur` event, so the emulated activation is seen by an element focused before the first frame as one `focus`, as in a page loaded with focus emulation on. `blur()` still blurs the focused element. The test renderer's window is active for focus by default (`set_active_for_tests(true)`); with the variable set, `setWindowActive(false)` cannot make it inactive for focus.

### Focus on mousedown

The focus default (`focus.rs`, `defer_mouse_down_default`) uses the dispatcher's target path, not the topmost hit, and blurs when nothing on the path is focusable. A `preventDefault` from any `mousedown` handler on the path cancels both the focus move and the blur, including an input editor's own focus; `pointerdown` does not cancel it, as in Chrome. The order is `pointerdown`, `mousedown`, `blur`, `focusout`, `focus`, `focusin`, pinned in `focus.test.tsx`. There is no second mousedown emission.

Because `autoFocus` focuses in the commit, a `mousedown` handler that mounts an `autoFocus` popup must call `preventDefault()` to keep focus there; the press takes focus after the handlers, as on the web.

### The keyboard of a `<webview>`

A `<webview>` is focusable like a text control, and its page holds the keyboard exactly while the element is focused: `observe_focus_in` queues a `PageMove`, `settle_focus` moves the first responder before the focus events reach JS, and Tab and Shift+Tab enter the page at its first or last tabbable element and leave it when WebKit runs out. A press on the page reaches GPUI first (through the window's `sendEvent:`), so it takes focus like a press on any element. While the page has the keyboard, GPUI's key dispatch does not run. How each piece works, with the deviations (a page with nothing tabbable takes one stop; keys do not reach the parent) is in [webview.md](webview.md#focus).

### Label activation

`<label htmlFor>` names and activates its control. After a `click` whose activation target is a label (the first element on its path with an activation behaviour, see below; so not a click on an `<a href>`, a `<button>`, an `<input>`, a `<textarea>` or a `<select>` inside the label, and not one inside the labelled control), if it was not default-prevented, gpuix focuses the control and dispatches a `click` on it; a `<button>` is labelable, so that click submits its form as a click on the button does, with the button as the `submitter`. A pointer release, `element.click()` and the VoiceOver Press all run it (`events/activation.rs`). The release goes through the synchronous dispatch from a deferred step, so queued focus handlers run first. A disabled control gets no activation.

### Checkbox and radio activation

`<input type="checkbox">` and `type="radio"` follow HTML's activation algorithm (`custom_elements/input_choice.rs`). The state (checkedness, the dirty flag, `indeterminate`, the activations in progress) lives in the retained tree (`RetainedTree::choices`), so the activation, `FormData`, the accessibility node and the JS properties read it with the tree lock and never lease the view. A write of the `checked`, `defaultChecked` or `indeterminate` prop is applied when it is written, even if the value is the one the prop had (`RetainedTree::set_custom_prop`), because it stands for React DOM's property assignment and the user may have toggled the control since.

`Activation::deliver_click` is the one path for a click native makes (a pointer release, `click()`, Space, the VoiceOver Press): `pre_activate` toggles the activation target (the checkbox or radio, or a radio's group is unchecked) and invalidates, the click is emitted, and then either `cancel_activation` restores the previous state or `choice_activated` emits `input` and `change` (`sync_dispatch::emit`, so a handler has run when `click()` returns) when the checkedness changed (a radio that was checked does not). A label's activation does the same for the click it sends its control. After the events a control that has a `checked` prop is restored to it (`restore_controlled`, React DOM's `restoreControlledState`). A dispatched click goes through the same three steps, split across JS and native calls (`preActivateElement`, `cancelActivation`, `activateElement`). Space clicks on key up (`html::activation_keys`), Enter does not.

`<input>` is one custom element (`InputElement`) that builds the text editor, a choice control or nothing by `type`, and builds again with the stored props when `type` changes. The user agent style of an input follows its type (`html::ua_style_of`), so `type` restyles it.

### Button and link activation

A click no handler cancelled runs the activation behaviour of one element, its activation target: the first element on its path that has one, an `<a href>`, a `<label>` or a `<button>` (`html::activation_target`, picked once in `Activation::activate`). The behaviour of the others on the path does not run: a link inside a button does not submit the form, and a label inside a button focuses its field and submits nothing. A button's activation is this: in a `<form>`, a `type` of `submit` (or none, or one HTML does not know) submits it with that button as `event.submitter`. `type="button"` does nothing, and so does `type="reset"`, because gpuix does not reset controls. An `<a href>` does nothing on click: Ghia has no navigation.

A focused `<button>` is clicked by Enter on key down (repeating while held) and by Space on key up; a focused `<a href>` by Enter on key down, once per press (a repeat does not click again, as Blink's `IsEnterKeyKeydownEvent` needs `!repeat`) and with any modifier, the click carrying Shift, Ctrl, Alt and Cmd as it does in Chrome (`events/key_activation.rs`, which the tag table in `html/semantics.rs` feeds). A button takes Enter without Ctrl, Alt or Cmd. Space arms the button on key down and clicks on key up only if that button still has focus. Every Space key down ends the press before it, so a cancelled one leaves nothing armed, and so does the armed button losing focus (`key_activation::blurred`, from `observe_focus_in`). A `keydown` or `keyup` a handler cancelled ends it too, and Space with ctrl, alt or cmd is not an activation. A held Space makes the button `:active` from the key down until the press ends, on the pointer's press chain (`PointerState::active`, set with `dispatcher::set_active`), so a pointer release or press takes the chain over. Space on a button does not scroll. A disabled button gets no click from the pointer, a key or `click()`. The click is the non-pointer one (`detail` 0). The React and Solid `Button` components are `div`s and keep their own JS key handling.

## Keyboard

- `event.key` and `event.code` are DOM values (`"Enter"`, `" "`, `"ArrowLeft"`), with `repeat` and modifier fields (zed reports key auto-repeat).
- On macOS `code` comes from the virtual key code (`NativeKey::key_code` through Chromium's table in `events/key_codes.rs`) and `key` is the layout's character with shift and option applied (`NativeKey::layout_char`), as in Chrome: `"ß"` for Option+s, `code` `"KeyC"` for the C position on a Cyrillic layout, `"NumpadEnter"`.
- `keydown` and `keyup` also carry the legacy `keyCode` and `which` with Chromium's macOS values (NumLock is 12, an input method's `Process` 229). There is no `keypress` and no `charCode`.
- An input method composing in an `<input>` or `<textarea>` gives `isComposing`, a `Process` `keydown` for a key it takes first (observe-only: an `ImeKeyDown` that `preventDefault` cannot stop) and `compositionstart`/`compositionupdate`/`compositionend`.
- Each keystroke is one `keydown` that goes through capture and bubble. Adapters export `window` and `document` objects for window-level listeners, and importing `@ghia/native/host` installs the web's globals on the native build (the `ghia()` Vite plugin also imports `@ghia/native/dom-globals` first in the app entry, see [web-renderer.md](web-renderer.md); `window === globalThis`, `document`, no-op `scrollTo` / `scroll` / `scrollBy`; see [`window` and `document`](../reference.md#window-and-document)). `globalThis.addEventListener` registers with Ghia's `window` and with the runtime's own target, so `keydown` reaches it and Bun's `error` and `message` events still do.
- In text editors, `keydown` runs before the built-in action, and `preventDefault` cancels both the action and the text insertion.

## Inputs and forms

- `<input type="checkbox">`, `"radio"` and `"hidden"` are covered in [Checkbox and radio activation](#checkbox-and-radio-activation) and [reference.md](../reference.md#checkbox-radio-and-hidden-inputs): a checkbox or radio is in `FormData` only when checked, and neither blocks implicit submission.
- `<input>` has `select()`, `setSelectionRange`, `selectionStart/End/Direction`, `disabled`, `type`, `maxLength` and number `min/max/step`.
- `<form onSubmit>`, `name`, `required`, `requestSubmit(submitter)` and `invalid` events. `requestSubmit(submitter)` sets the event's `submitter`, throws a `TypeError` when `submitter` is not a submit `<button>` and a `NotFoundError` `DOMException` when it belongs to another form (a disabled submit button is accepted, as in the DOM). Enter in an `<input>` follows HTML's implicit submission: with a submit button the first is the default button and gets a `click` (nothing happens if it is disabled); without one the form submits only if at most one `<input>` blocks it (every `<input>` does, a `<textarea>` does not).
- The per-edit event is `onChange` with `inputType`, `data` and `isComposing`, once per edit like the DOM `input`. A composition's last `change` comes before `compositionend`.
- In a textarea, Enter always inserts a newline.

## Accessibility

Every `aria-*` attribute is accepted and mapped to AccessKit where a mapping exists. `id` replaces `aria-id`. Relations resolve by author id (a zed commit). `<label htmlFor>` names its control (activation is above), and `inert` is supported.

An HTML tag has the implicit role Chrome gives it (`html/semantics.rs`, which also holds the tab stops, the activation keys and the `type` of a button; how a tag looks and lays out is in [layout.md](layout.md#html-tags)): `button`, `a` with an `href` (link), `h1`-`h6` (heading with the level as `aria-level`), lists, `nav`, `main`, `aside`, `article`, `hr` (separator), `blockquote`, `dialog`, `p`, `figure`, `fieldset` and `details` (group), the table family, and `dl`/`dt`/`dd`. A `header` or `footer` is the banner or content info only outside `article`, `aside`, `main`, `nav` and `section`, and a `section` is a region only with `aria-label` or `aria-labelledby`. An explicit `role` or `aria-level` wins. A `th` is always a column header (`scope` is not forwarded), and `<wbr>`'s zero width space is not read out. A `button` and an `a[href]` are tab stops without a `tabIndex` (a disabled button is not focusable at all). A `button` is named by its labels' text, then by its content (`aria-labelledby` and `aria-label` come first, as in Chrome); a label with no text leaves the content as the name.

The test renderer's tree dump reports a descendant of an `aria-hidden` or `inert` node as hidden (a zed commit: AccessKit's flag covers descendants, the dump read only the node that carries it). A referenced element with no role becomes a `group` node so `aria-labelledby` can name it from its text.

## Platform APIs

- `navigator.clipboard.writeText`/`readText`, attached to an existing `navigator` and never creating one. `@ghia/native` declares the global `Clipboard` type once for both adapters.
- File picker `accept` filters (a zed commit).
- `EyeDropper` on macOS.

The Solid `DialogPortal` used to build its children twice; that is fixed, along with the same pattern in the floating components.

## State styles from pointer and focus

State styles read the trackers above; they do not probe the tree themselves.

- **`:hover` and `:active`.** `:hover` applies to the target and every ancestor, `:active` to the primary press chain. `resolve_state_styles` (`events/state_styles.rs`) folds hover and active into the base style before motion runs, reading `PointerState` once. A hovered `color` reaches descendants' `currentColor`. There was a `StateSource` probe; it sat above an element's hitbox and hid it from hit testing, so it is gone. `overlay_fields!` in `events/state_styles.rs` lists every `StyleDesc` field that takes part in state styles.
- **Group state.** `group` with `groupHover`, `groupActive` and `groupFocusWithin`. `groupHover`/`groupActive` apply when the nearest ancestor with that `group` name is hovered or active. A group applies to descendants only, and the nearest same name wins. The group's focused-within state is read from the focus-within path (`FocusStyles::within`), the source `focusWithin` uses. GPUI's `.group()` and `.group_hover()` are no longer called on host elements. There is no group state inside an inert subtree.
- **`:has()` is relational state, not a selector.** `hasHover`, `hasActive`, `hasFocus` and `hasFocusVisible` are nested style objects like `hover`, true while a strict descendant (logical tree, as the hover chain and `focusWithin` use) is hovered, pressed, focused or `:focus-visible`. `hasDisabled` and `hasEnabled` are the other two (below). Each is read from the chain gpuix already keeps (the hover chain and the active chain minus their target, the focus-within set minus the focused element, the focus-visible element's strict ancestors), so it costs O(1) per element and no tree walk. The restyle gating that decides which elements a hover or focus change restyles counts the `has*` keys. Transitions, animations, `<UniversalStyle>`, `motion`, inert gating and inline spans treat them like their plain counterparts.
- **`:disabled` / `:enabled` and `hasDisabled` / `hasEnabled`.** The form controls are `<input>`, `<textarea>` and the `div`s that stand in for a `<button>` or `<select>` (`Button`, `buttonProps` users such as the dialog triggers, `SelectTrigger`, the `Select` root, `ComboboxTrigger`). Those `div`s say so with the internal `formControl` prop (`"enabled"` | `"disabled"`, forwarded for every host type), because `disabled` itself is not forwarded for a `div`, so a plain `<div disabled>` matches neither, as in React DOM. `RetainedElement::control_disabled` is the one reader, and `in_disabled_form_control` (click suppression) uses it too, so a disabled `Button` receives no `click()` or VoiceOver press. The strict ancestors of the controls are worked out the first time a style that declares `hasDisabled` or `hasEnabled` asks in a frame (`ControlStyles`, from the tree's `control_ids`, walking `parent`), not every frame. Unlike `hover` they are not pointer state: an `inert` subtree keeps them.

### Layer order

State layers fold in the order base, `groupHover`, `hasHover`, `hover`, `groupActive`, `hasActive`, `active`, `hasEnabled`, `hasDisabled`, `enabled`, `disabled`, `groupFocusWithin`, `hasFocus`. `focusWithin`, `hasFocusVisible` and `focusVisible` are applied to the element after that fold, so focus layers beat the pointer ones, `groupFocusWithin` included. An element's own state beats what its descendants cause, and that beats a group. The four disabled layers sit after `active` and before the focus ones, ordered as Tailwind orders its variants, so `disabled` wins a field over `hover`/`active` while the control still matches them, as in CSS.

A state style's shorthand resets the longhands it covers; that rule is in [paint-and-transforms.md](paint-and-transforms.md).

### Retention

The body of every state style is in the revision and `StyleDesc` equality, so editing one rebuilds. A hover on the element is a pointer delta. `:disabled`, `:enabled`, `:has(:disabled)` and `:has(:enabled)` read the tree (`RetainedElement::control_disabled`, `ControlStyles`, worked out once per frame). A flip is a prop mutation, which moves the revision of the control and of every ancestor, which are exactly the elements `:has()` can name, so there is no delta. Their `PointerStates` flags have bits in `pointer_bits`, which only attributes a rebuild in the counters. See [retention.md](retention.md).

## Inline span listeners, cursor and focus

A run with listeners or `hover`/`active`/`groupHover`/`groupActive` styles stays inline. The pointer is hit-tested by glyph (`text/inline_hit.rs`, which keeps each painted paragraph's `TextLayout`), and `events/inline_target.rs` puts the inline boxes under the glyph in front of the container's hit chain, so the span is the event target and the dispatcher needs no change. `run_styles` folds the pointer state into the run.

The hit registry and the painted text, start regions, highlights and match ordinals are keyed by window (`WindowId`), so a second window's frame reset keeps the first one's entries.

- `cursor` is a hitbox per fragment (`inline_cursor.rs`).
- `tabIndex` is a zero-size anchor div under the span's host id that tracks its focus handle (`inline_focus.rs`).
- `focusVisible` and `focusWithin` fold into the run and ring the fragments with `outline*` (`inline_decoration.rs`).

Span layout, bounds and decorations are in [text.md](text.md).

## Breaking changes

Against upstream gpuix.

Pointer events:

- A filled or positioned element no longer blocks hover or clicks to its ancestors. `click`, `mousedown`, `mousemove` and `mouseup` bubble, so code that relied on occlusion needs `stopPropagation`. The anchored `occlude` prop is removed; use `pointerEvents`.
- `pointerEvents: "none"` is inherited and `auto` no longer blocks the wheel.
- The wheel goes only to scrollers that are ancestors of the target, so a modal or popup no longer scrolls the container it was declared in. `onWheel` and `onWheelCapture` are pointer-event props.
- Implicit capture (a node with `onMouseDown` and `onMouseMove`) is removed. Call `setPointerCapture`. `createPointerCaptureMethods` is renamed `createElementMethods`.
- `onFileDrop` and the `paths` field are removed. Use `onDrop` with `dataTransfer.files`.
- Event type strings are lowercase DOM names (`mousemove`, not `mouseMove`).
- `pointerlockchange` and `pointerlockerror` are `document` events; the root `onPointerLockChange` and `onPointerLockError` are removed. `movementX/Y` are required fields of `HostMouseEvent` (0 on every event but a move), and `HostMouseMoveEvent` and `HostPointerMoveEvent` are removed.
- Escape during a `draggable` element drag no longer reaches `keydown` listeners or closes a dialog.
- On macOS a window with no `dragover` listener refuses files dragged in, and a `dragover` that does not call `preventDefault` refuses the drop.
- Clicks from the keyboard or VoiceOver are DOM clicks with `detail` 0, `pointerId` -1 and `pointerType` `""`. `buttonProps(behavior, renderer)` takes the renderer.
- A handler that throws no longer ends the dispatch, and nothing rethrows into the caller of a simulate method. Errors reach `onError`.
- `target`, `currentTarget` and `relatedTarget` are the elements a `ref` gives, not numeric ids; `path` is `composedPath()`, `elementId` keeps the id, and `target` is `null` for an event aimed at the window. A handler type is `DomEvent` / `HostMouseEvent`.
- A `window` or `document` listener hears every event of its type, not only those an element on the path listens for.
- A `mousedown`/`pointerdown`, `mouseup`/`pointerup`/`click` or `wheel` handler runs inside the synchronous dispatch on macOS (and in the test renderer).
- Disabled controls get no `click`/`auxclick`/`dblclick`.
- A press whose `pointerdown` was cancelled sends no `mousedown`, `mousemove` or `mouseup`; code that cancels `pointerdown` and still listens for `mousedown` stops hearing it.

Focus, keyboard and forms:

- Key, `onFocus` and `onBlur` listeners no longer make an element focusable; give it a `tabIndex`. A disabled input is never focusable.
- `event.key` uses DOM names (`"Enter"`, `" "`, `"ArrowLeft"`).
- `windowKeyDown`, `windowKeyUp` and `keystrokeId` are removed; one `keydown` per keystroke propagates.
- React `onFocus`/`onBlur` bubble, as in React DOM. Solid's do not, as on the web.
- `onSubmit` is removed from `<input>` and `<textarea>`; use `onKeyDown` or wrap the input in a `<form>`. In a textarea, Enter always inserts a newline. `TextareaProps` no longer extends `InputProps`.
- `aria-id` is replaced by `id`.
- Positive `tabIndex` follows DOM order instead of GPUI's raw ordering.
- Mousedown on content with no focusable ancestor now blurs the focused element.
- `autoFocus` focuses in the commit, not on the next frame, so a `mousedown` handler that mounts an `autoFocus` popup must call `preventDefault()` to keep focus there.
- On macOS `event.code` is the physical key and `event.key` the layout's character. `keydown` can carry key `"Process"`, and `isComposing` is true while text is marked.

## Upstreaming

Pointer events. The zed side is opt-in and independent: the DOM hit-testing mode, `CursorStyle::None`, pointer lock, the per-window cursor hide, the drag operation of dragged-in files (`Window::set_drag_operation`), `active_drag_value` and the pass-through hitbox can go to `remorses/zed` as separate commits. The gpuix side removes behaviour upstream apps depend on (occlusion, implicit capture, `onFileDrop`), so it is a major-version discussion, and `remorses/gpuix` wants an approved issue first.

Focus, keyboard and forms. The zed commits are small and independent (a11y relations by author id, `PathPromptOptions` accept filters, key auto-repeat on `KeystrokeEvent`, `Entity::is_updating`, the `NativeKey` (virtual key code and layout character) and `is_composing` of key events, the observe-only `ImeKeyDown` and `Window`'s input-method driving calls) and can go to `remorses/zed` one by one. The gpuix side depends on `dispatchDomEvent` and `sync_dispatch`, so it cannot land before the pointer-event work.

## Tests

- `focus.test.tsx` pins the focus order on a press.
- The keyboard handoff of a `<webview>` is pinned in the `webview.test.tsx` files of the adapters (scripted pages) and on real pages by the e2e ([testing.md](testing.md#the-webview-e2e)).
- `offsetX`/`offsetY` are tested through the React and Solid handlers, on a bordered target and a nested one (#40).
- `element-listeners.test.ts` (native) pins the list: order against the prop, phases, `once`, `signal`, `passive`, removal and addition during a dispatch, attach and detach. `dom-members.test.tsx` in both adapters runs it through a click, a scroll and `requestAnimationFrame` on the test renderer.

The Chrome oracles and test-renderer commands are in [testing.md](testing.md).

Deviations from Chrome and the DOM (asynchronous dispatch off macOS, input methods, drag images, pointer lock platforms, `:has()` limits) are in [deviations.md](deviations.md#events-and-input).
