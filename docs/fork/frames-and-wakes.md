# Frames and wakes

When a frame is drawn, what wakes JS to run it, and what an idle or quiet window costs. GPUI runs on the JavaScript
thread on macOS, so every rule here is about sharing that thread between frames, input and the app's own tasks. Two
fork patches carry it: no inline draws in real windows (patch 1) and a frame pump driven by the main run loop
(patch 2, with #77, #93, #78 and #79).

## No inline draws in real windows (patch 1)

**Problem.** The macOS addon is built with GPUI's `test-support` feature. It is the crate's default feature
(`packages/native/Cargo.toml:99`), and the release artifact is built with `bun run build`, not `build:release`
(`packages/native/package.json`). With that feature, `App::flush_effects` in `zed/crates/gpui/src/app.rs` draws every
dirty window synchronously at the end of every `App::update`. Test contexts need that because they never run a display
link. A real window does not, but the feature is a Cargo feature, so the check was compiled in for it too.

**Evidence.** Each wheel event cost a full draw, about 3 ms, inline in the input handler, and every `applyBatch` and
`scrollTo` drew synchronously as well. Timed in a real (non-offscreen) window with the demo's 2.7k-node diff, 300 calls
each:

| Call | Unguarded `test-support` | Guarded (this fork) | Addon built without `test-support` |
|---|---|---|---|
| `simulateScrollWheel` | 2.34 ms p50 (2.52 p95) | 0.001 ms p50 | 0.03 ms |
| `scrollTo` | 2.33 ms p50 (2.47 p95) | 0.000 ms p50 | 0.01 ms |

The last column was measured with a different method (the wheel path through the real event handler, 2.7 ms down to
0.03 ms), so compare it only loosely. It is the floor: the guarded build is as cheap as a build with no `test-support`
at all.

**Design.** `flush_effects` draws inline only when `App::mode` is `GpuiMode::Test`. `App::new_app` starts in
`GpuiMode::Production`, and only the test contexts (`TestAppContext`, `VisualTestAppContext`, the headless one) switch
it. `TestGpuixRenderer` is built on `VisualTestAppContext`, so it keeps drawing inline and `flush()` still returns a
drawn frame. The real `GpuixRenderer` runs on `gpui_platform::application()`, stays in `Production`, and is drawn by the
display link. The change is one commit in `fdarian/zed` (`gpui: draw inline in flush_effects only for test-mode apps`)
and gpuix needs no change.

A bounds or scroll read in the same turn as a mutation does lay out synchronously, through `Window::draw_if_dirty`. That
is an explicit call, not the `flush_effects` path this patch guards, and it does not draw. Don't make a read draw: inside
input dispatch a draw swaps the frame the dispatch is reading, so a key's dispatch path indexes a different dispatch
tree, and mouse listeners the dispatch holds out of the frame are written back over the new one (scrollers stop
scrolling, bubble handlers see `is_hovered` false). How a layout-only pass avoids that is in
[forced-reads.md](forced-reads.md).

**Alternatives rejected.**

- **Dropping `test-support` from the release build.** It fixes the draw cost, but the feature also gates
  `TestGpuixRenderer`, `createTestRoot` and `captureScreenshot` on macOS (`packages/native/src/renderer.rs`,
  `capture_screenshot`), so a plain release addon loses them.
- **Two addons: a release addon without `test-support`, and a separate test addon with it, loaded only by
  `@ghia/native/testing`.** Built and tried; it cannot work in one process. Both addons embed GPUI, and a load-time
  constructor registers the Objective-C window class (`gpui_macos/src/window.rs:366`, `ClassDecl::new(name,
  superclass).unwrap()` in `build_window_class`, reached from `build_classes::__ctor_private`). The second `dlopen`
  finds the class already registered, `unwrap()` panics inside an `extern "C"` constructor, and the process aborts
  ("panic in a function that cannot unwind"). Minimal repro: `require` the two `.node` files in one `bun -e`. In the
  react suite, six test files abort their vitest worker: `styles`, `render`, `events`, `floating-controls`,
  `animate-presence` and `debug-frame-overlay`. Each imports the adapter's public entry (which loads the release addon
  through `@ghia/native`) and `@ghia/native/testing` (which loads the test addon). The other 21 files, 300 tests,
  passed. Making the two coexist needs either lazily loaded adapter addons or a zed change that tolerates an
  already-registered class, which would share Objective-C method implementations between two dylibs that each have
  their own statics. Neither was worth it, and the two-addon build also loses `captureScreenshot` in the release addon.

**Trade-offs.** The shipped addon still contains the `test-support` code, so it is larger than a build without it.
`TestGpuixRenderer` is also still part of the production binary. The guard trusts `GpuiMode`: an embedder that builds
its own `App` and sets the mode to `Test` gets the old behaviour, which is the point.

**Upstreaming.** Two routes. Land the guard in `remorses/zed` (one commit, no gpuix change), or build the release addon
without `test-support` and make the adapters load the addon lazily so a test process that also uses
`@ghia/native/testing` never loads two. The first is smaller. The second also shrinks the binary, but it needs the lazy
load and a decision about `captureScreenshot`, and CI would build and publish a second artifact for the test addon.

## How JS is woken (patch 2)

**Problem.** On macOS, GPUI runs on the JavaScript thread and was only serviced by an 8 ms `setTimeout` around
`renderer.tick()`. AppKit input and GPUI's display-link dispatch source therefore waited for the next JS timer: frames
were not paced by the display, and input could wait most of a timer period.

**Why upstream used a timer.** It was deliberate. Bun owns the event loop, and an earlier blocking pump starved Bun's
I/O ([remorses/gpuix#39](https://github.com/remorses/gpuix/issues/39)). Latency was not what the timer was chosen for.

**Alternatives rejected.**

- **Keep the 8 ms timer.** It is the baseline column below: 2 skipped refreshes, a 16.7 ms worst gap between frames on
  screen, 77% of scroll steps drawn.
- **Block in the run loop** (`CFRunLoopRunInMode` for up to `waitMs` inside `tick`, the first version of this patch).
  Input delay dropped to about 0.2 ms, but Bun's I/O ran up to `waitMs` late on every tick: 100 sequential awaited file
  reads took 810 ms, against 3.8 ms with the timer. That is the regression #39 fixed, so the blocking wait was dropped.

**The comparison that settled it.** 120 Hz display, every column built so that scrolling does not draw inline (patch 1
or no `test-support`). The display-link column is a per-vsync wake, which the run-loop wake below replaced; it is the
design the other two were weighed against.

| | 8 ms timer | Blocking wait | Display link |
|---|---|---|---|
| Skipped refreshes while scrolling | 2 | 0 | 0 |
| Worst gap between frames on screen | 16.7 ms | 8.33 ms | 8.33 ms |
| Scroll steps that got drawn | 77% | 99% | 100% |
| Input delay, p50 | 4.1 ms | 0.24 ms | 3.9 ms |
| 100 file reads awaited one at a time | 3.8 ms | 810 ms | 8.7 ms |
| Idle CPU (20 s runs) | 4.42% | not measured | 4.46% |

Waking from the display is the only version that is good on every row, and it costs no extra idle CPU (4.42% against 4.46%). Its lead over the timer is small; patch 1 is the
large practical win. What it left is idle cost (a link that runs whenever a window is visible) and input latency up to a
vsync, which the next sections remove.

### The run-loop watch (#77)

The wake is "the main run loop has work". A per-vsync wake meant an idle one-text window woke JS 75 times a second (FF
measured 120 on a 120 Hz display, about 2.3% CPU), `tick()` ran each time, input waited for the next vsync because
AppKit events are only drained inside `tick()`, and a 100 ms fallback timer ticked an idle app besides.

- **The watch (zed, `gpui_macos/src/run_loop_wake.rs`).** `gpui_macos::set_run_loop_wake_hook` starts a helper thread
  with its own kqueue that holds two `EVFILT_MACHPORT` knotes (no message is received; `EV_DISPATCH`) on the ports the
  main run loop waits on: the main dispatch queue's (`_dispatch_get_main_queue_port_4CF`; CF puts it in the run loop's
  set only while inside `CFRunLoopRun`) and the port set of `kCFRunLoopDefaultMode`. That set is found once on the main
  thread by adding a sentinel `CFMachPort` source to that mode alone, taking the port set that holds it and removing the
  sentinel (a panic if there is not exactly one). When a knote fires the helper calls the hook, so a wake is input (see
  [below](#input-to-an-idle-window-93)), a main-queue block (the display link's frame step included) or a run-loop timer.
  `run_loop_pumped()` enables both knotes again in one `kevent` call (it runs at the end of every tick), and a message still pending fires at once, so nothing is lost.
  `set_run_loop_wake_hook(None)` stops the thread through an `EVFILT_USER` knote and joins it.
- **gpuix.** `renderer.setFrameWakeCallback(fn)` registers a non-blocking, weak N-API threadsafe function behind the hook
  and returns whether the platform has one (`true` on macOS); dropping the renderer clears the hook, and clearing the
  callback passes `None`. A wake that arrives while one is still pending, or while `tick()` runs, is dropped. `tick()`
  stays non-blocking: it clears `pending` and calls `run_loop_pumped()` on every path. `startFrameLoop`
  (`packages/native/js/runtime.ts`) schedules `tick()` from the callback and arms no fallback timer on the wake path
  (an idle window arms no timer and gets no wakes). `frameMs` opts into the timer loop, and Windows and Linux use it,
  because only macOS has a display link in GPUI's path.
- **The display link runs on frame demand.** `MacWindow` implements `schedule_frame` and `frame_waker`, which start the
  link for a visible window; it stops after `IDLE_STEPS_BEFORE_STOP` = 2 steps in which nobody asked for a frame (about
  17 ms at 120 Hz). An occluded window never starts it. The occlusion, screen and key-status starts stay, and the idle
  count stops them again.
- **A draw outside a frame request asks for a frame** (`Window::draw` calls `schedule_frame`). It leaves `needs_present`
  for the next request to present, and a stopped link had nothing to wake it for that request. Not covered:
  `needs_present` set by `patch_frame` in a draw outside a frame request (`patch.rs`, left as it is).

**Measured** (75 Hz display, one-text window, live window with the release addon):

| | before (per-vsync wake) | after |
|---|---|---|
| Idle: JS wakes per second | 75 | 0 |
| Idle: `tick()` ms per second | 6.9 | 0 |
| Idle: CPU | 1.45% | 0.29% |
| A DOM write after idle | | first draw 20 to 25 ms after the write, 3 wakes |
| Focused input, caret blinking | | 2 draws/s, 8 wakes/s |
| Colour animation, draws and presents | 75/s | 75/s |

For comparison, Chrome with an idle one-text window has the renderer and the GPU process at 0% (its browser process was
about 9.5% on a fresh profile, which is not frame production).

**Known.**

- Input wakes JS once per event batch; batches are not coalesced to the vsync. A tick costs an estimated 0.2 to 0.3 ms of
  CPU, so a stream of input costs a tick per batch.
- The watch alone does not see input; the observer below is what makes an idle window answer it.
- Apple's app-launch measurement (`libapp_launch_measurement`) polls the main queue every 3 ms, for up to about 500 polls
  after the first present when the startup frames are slow. Each poll is main-queue work and wakes JS, so a few seconds
  after launch cost extra ticks (it still wakes JS about 2.5 s and 5.3 s after start).

### Input to an idle window (#93)

With only the watch, an idle window did not wake on input: a key down, a mouse move, a click or a scroll sat in AppKit's
queue until something else pumped, and FF's Command Menu looked frozen after about 4 s idle (15 of 15 trials without a
wake in 600 ms). AppKit receives every WindowServer event on `com.apple.NSEventThread` (a source1 into HIToolbox
`MessageHandler`, `PullEventsFromWindowServerOnConnection` and `PushToCGEventQueue`, or SkyLight
`CGSSnarfAndDispatchDatagrams`) and hands it to the main thread with `CFRunLoopPerformBlock(mainRL,
kCFRunLoopCommonModes)` and `CFRunLoopWakeUp(mainRL)`. Nothing runs the main run loop under gpuix (the main thread sits
in libuv), so its `ignoreWakeUps` is set and CoreFoundation sends no message. Neither port the watch holds gets one, and
the event enters AppKit's queue only when a pump runs the loop. The 100 ms fallback timer hid this until #77 removed it.

A `kCFRunLoopBeforeWaiting` observer in the common modes on NSEventThread's run loop (found by its name, with
`task_threads` and `_CFRunLoopGet0`) calls `dispatch_async_f` with a no-op on the main queue. That is a message on a port
the watch already holds, sent after the source callout that queued the event. It is level-triggered, so a wake that lands
while a tick has the knotes disabled is not lost. It is not a timer: NSEventThread ran 0 iterations over 5 to 15 s idle.
Don't remove the observer: input to an idle window stops waking JS, and nothing else hides it any more.

Post to the wake of JS, and post to its handler:

| | wake (ms) | handler (ms) |
|---|---|---|
| keyDown | 0.5 to 1.2 | 4.1 to 7.7 |
| mouseMove | 0.4 to 0.9 | 3.3 to 6.2 |
| click | 0.1 to 1.4 | 0.7 to 5.1 |
| scroll | 0.1 to 0.5 | 0.4 to 1.2 |

**Known.**

- An event posted with `-[NSApp postEvent:atStart:]` from a thread that is neither NSEventThread nor the main thread
  still does not wake. It queues a block on the main run loop with an ignored wake-up and never touches NSEventThread. No
  real input takes that path; FF's `poster.ts` Worker trials do.
- The observer uses the private `_CFRunLoopGet0` and the thread name `com.apple.NSEventThread`.

### One wake per event: the commit of `sendEvent:`

**Problem.** A stream of input woke JS about twice per event: once for the event, and once 1 to 8 ms later for a tick
that dequeued nothing and handled no source. Scrolling ghia-bench's Mailbox, Ghia had about 215 wakeups a second against
about 120 for raw GPUI.

**Cause.** `-[NSApplication sendEvent:]` begins an implicit Core Animation transaction for every event
(`+[CATransaction activateBackground:]`, `CA::Transaction::ensure_implicit`). From macOS 26, AppKit's update cycle
(the private `UpdateCycle` framework) commits it: its next pass of the run loop reads the time against the next frame
boundary of the display, commits at once if the boundary has passed, and otherwise arms a timer for the boundary
(`UC::LoopTapCFRunLoop::onTimer`, a `CFMachPort` source in the default mode). The timer's message is on a port of the
default-mode set, so the run-loop watch wakes JS for it, and that tick only commits. A blocking AppKit app wakes for the
same timer, but its wake is a return from `mach_msg`; here it is a hop to JS and a tick. Whether an event lands before
or after the boundary is its phase to the display, so with moves posted at a steady 120 Hz the share of events with a
second wake went from 5% to nearly all between runs of the same build. `-NSUpdateCycleDebugLoggingEnabled YES` on the command line logs every step of the cycle
(`log stream --level debug --predicate 'processID == <pid>'`, category `UpdateCycle`).

**Design.** `pump_app_nonblocking` calls `[CATransaction flush]` after each `sendEvent:`. The update cycle's next pass
then finds no transaction to commit and arms nothing. Nothing else in the pump changed: the run-until-unhandled loop
stays as it is and nothing blocks (#39).

**What the pump does not do.** `pump_app_nonblocking` does not call `[NSApplication updateWindows]`. `sendEvent:` sets
`windowsNeedUpdate`, which installs a one-shot run loop observer that calls `updateWindows` in the next pass of the loop;
the polls of `nextEventMatchingMask:` and the run-until-unhandled loop are passes, so the windows are updated once per
event, as in `[NSApplication run]` (the GPUI samples show that observer, not a call of the loop's own). The pump's own call
made 2.6 updates per mouse move (`NSApplicationDidUpdateNotification`, `tests/pump_window_updates.rs`: 100 for 100 moves
now). The flush stays once per event: with one event in a tick it is also once per tick, and it has to come before the poll
that follows `sendEvent:`, because that poll's pass is the one that arms the update cycle's timer (see the first alternative
below).

**Alternatives rejected.**

- **One flush at the end of the pump.** It halves the extra wakes (jittered moves, 1.22 to 1.31 wakes per move against
  1.42 to 1.75) but does not end them: the pass after `sendEvent:` has already armed the timer by then.
- **A pass through `kCFRunLoopBeforeWaiting`** (a 0-byte message to a private `CFMachPort` in the default mode, then
  `CFRunLoopRunInMode(default, 1e10, true)`, which is past `TIMER_INTERVAL_LIMIT` and arms no timeout timer, so the pass
  waits, receives the message and returns). The pass reached `BeforeWaiting` every time and changed nothing: the update
  cycle observes only `kCFRunLoopEntry` in the main run loop, and Core Animation's own `BeforeWaiting | Exit` observer
  leaves the commit to it.
- **Turning the update cycle off.** `-NSUpdateCycleEnabled NO` does not; there is no other switch, and it would change how
  AppKit paces its own views.

**Measured** (the Mailbox app of ghia-bench in a real window that is not key, 1280 x 800, release addon, mouse moves or
wheel events posted from NSEventThread at 120 Hz for 4 s, each at a random point of its 8.3 ms period; three runs each,
back to back, before and after; wakeups are `ri_interrupt_wkups` + `ri_pkg_idle_wkups` of `proc_pid_rusage`):

| | before | after |
|---|---|---|
| Moves inside one row: wakes per move | 1.46 to 1.64 | 1.03 to 1.04 |
| wakeups/s | 190 to 208 | 139 to 141 |
| instructions per move | 911K to 946K | 831K to 840K |
| CPU ms | 251 to 261 | 216 to 219 |
| context switches/s | 1143 to 1285 | 904 to 954 |
| Moves across rows (hover changes): wakes per move | 1.47 to 1.88 | 1.07 to 1.09 |
| wakeups/s | 185 to 231 | 143 to 145 |
| instructions per move | 899K to 962K | 850K to 889K |
| Wheel events: wakes per event | 1.73 to 1.98 | 1.69 to 1.74 |
| wakeups/s | 225 to 256 | 192 to 200 |
| instructions per event | 14.2M to 14.6M | 14.0M to 14.2M |
| Ticks woken by the update cycle's timer, per 480 events (moves in a row / across / wheel) | 136-173 / 154-184 / 31-104 | 0-2 / 0 / 0 |
| Post to the end of the tick that handled it, p50 | 0.3 to 0.9 ms | 0.3 to 0.4 ms |
| 100 file reads awaited one at a time during the moves | 4.2, 4.4, 4.4, 50.2 ms | 3.4, 4.2, 4.8, 8.0 ms |
| Idle 2 s: wakes | 0 | 0 |

The ticks that are still empty (about 20 per 480 moves in a row, 50 across rows) are woken by the main queue's port, not
by the update cycle. A wheel event still wakes JS a second time for the display link's frame, which is the frame of the
scroll. The cost of the flush is not seen in the pump: the median time of a pump that dequeued events is 205 to 230 µs
before and after. A `<webview>` app at rest (`examples/webview-wake/measure.tsx`, two runs each) woke 2 and 2 times in
15 s after, 642 (a burst, see [Bursts](#waking-js-for-a-webview)) and 10 before, and its events arrived as fast.

### One frame per JS task

A frame is one task of the JS event loop, as a rendering update is in the HTML event loop: every task that was queued
while it ran gets its turn before the next frame starts. The wake reaches JS as a threadsafe-function call whose callback
only schedules `tick()` with `setImmediate`. The tick runs in the immediates phase, and Bun then polls I/O and runs due
timers before it takes the next wake (in Node, the check phase is followed by timers and poll). The renderer's pending
flag stays set from the wake until `tick()` returns, so wakes that arrive during a long frame are dropped, not queued.

Work that arrived meanwhile is not dropped: the frame step the display link merged into the main queue during a long tick
is still there when `tick()` returns and `run_loop_pumped()` re-arms the watch, so it fires at once and the step runs in
the next tick, right after the JS tasks that were queued. Two steps can run in one pump when a step outlasts a vsync. A
frame that ends before the next vsync takes every wake, so fast frames keep the display rate.

Don't tick inline from the wake callback or clear the flag before the tick (#56). Bun's `ThreadSafeFunction::on_dispatch`
drains its queue without yielding, so once a frame outlasted a vsync each wake queued the next, and timers, promises
waiting on I/O and IPC stopped for as long as an animation ran.

What the frame of a running animation costs is not the pump's, but it decides how long the task is. A tick of a
paint-only animation is offered to gpuix's patcher before gpui builds anything and costs what the changed units cost; a
tick the patcher declines is drawn whole, and an animation whose content is culled draws and presents nothing. A scroll
animation is always asked for as `request_animation_frame` and drawn whole. See [patch-frames.md](patch-frames.md).

### The steps before a frame (`Window::set_frame_steps`)

The HTML "update the rendering" steps run before the frame they affect, so what they change is painted by that frame. gpui has
no such point: its first hook is the commit survey inside `Window::draw`. The window takes one from the owner,
`Window::set_frame_steps` (None by default, so other GPUI apps are unchanged), and `Window::draw` runs it first, before the
commit survey and before anything is built or patched. It does not run in a layout pass, nor in a draw nested in another, and
Ghia's steps (`frame_steps.rs`, installed by `GpuixView::render`) skip a draw that a JS handler's own call makes
(`sync_dispatch::in_sync_call`), which leaves them to the next draw. The display link, `paint_if_dirty` and the test
renderer's inline draws all go through `draw`.

In order, the steps:

1. make the scroll writes recorded since the last render (`settle_scroll_writes`; a render makes them too, for a pass a read
   forces);
2. advance smooth scrolls (`scroll::advance_animations`), so the offset an animation frame paints is reported before that paint;
3. send `scroll` for every scroller whose offset is not the one it last reported ([scroll.md](scroll.md#onscroll)),
   synchronously through the sync-dispatch path that input uses, so the handler's mutations (a Solid write, an `applyBatch`,
   a React commit) are in the tree the draw builds.

4. run the `requestAnimationFrame` callbacks, if JS asked (below).

Nothing to do is no JS call. Smooth scrolls sample the clock at the steps, a little before the render's own instant.

#### `requestAnimationFrame`

The callback list is global JS state in `@ghia/native` (`animation-frame.ts`), like the DOM's one per window. `requestAnimationFrame(cb)` adds to it and asks each mounted renderer, once until its frame runs, for the next frame's steps (`renderer.requestAnimationFrame()`). Native (`frame_steps::AnimationFrame`) sets a flag for the window and registers `Window::on_next_frame` with the same steps, so a window nothing else draws still gets a frame; JS also asks a renderer again after `init()`, and a renderer that mounts after the request, so a callback requested before the window exists waits for it. Step 4 clears the flag and sends the `animationframe` event through the sync-dispatch path (not an element event: `renderer-state.ts` takes it before any handler map, runs it through the root's `schedule` like a handler, so a React commit or a Solid flush lands before the draw builds). JS takes the list before it runs the callbacks, in order, with one `performance.now()` for all, so what a callback requests waits for the next frame, and `cancelAnimationFrame` reaches a callback of the running frame that has not run yet. The callbacks run after the scroll events of the same steps, as in HTML. With several windows there is still one list: the first window whose steps run takes it (a deviation, [deviations.md](deviations.md#events-and-input)). A frame that comes by `on_next_frame` runs the steps before the draw and the draw's own steps then find nothing left; where JS cannot be called synchronously the event goes through the event queue and the callbacks run a turn later. The test renderer runs them in the next `flush`, `drawFrame` or any draw that comes first.

### Windows that are not key (#78)

gpui throttles a window that is visible but not key with `inactive_frame_interval`, 30 fps by default. A window of this
fork animates at the display rate, so `to_gpui_window_options` sets it to `None`: 75 to 76 draws/s were measured with
another app frontmost, where gpui capped the same window at about 30 (FF saw about 26).

A window AppKit reports as occluded draws nothing: its link stops on the occlusion notification (`start_display_link`
refuses a window that is not visible) and nothing else asks it for a frame. Under a cover that was 0 draws, presents and
wakes, and the display rate again within about 1 s after the cover left. Animations keep time with the clock and catch up
when the window shows, as the animations of Chrome's hidden pages do. AppKit counts a window whose shadow is uncovered as
visible, so a cover that matches the window's top-left edge does not occlude it; Chrome on macOS, which reads the same
`occlusionState`, behaves the same.

### Waking JS for a webview

WebKit answers the UI process from its IPC thread with `CFRunLoopWakeUp(CFRunLoopGetMain())`. CoreFoundation returns from that without sending the wake message while the main run loop is not inside a run, which is always the case here (JS owns the main thread and the loop is only pumped), so the run-loop watch above never hears of it. `did-start-loading`, `did-navigate`, `did-stop-loading`, `page-title-updated`, `did-fail-load` and the result of `executeJavaScript` of a `<webview>` then wait for the next input or frame.

`CFRunLoopWakeUp` reads the run depth `d` (a byte of the `__CFRunLoop` object) and sends only if the byte at `run_loop + d + 0x153` is zero. CoreFoundation sets the depth-0 byte (the loop's "ignore wake-ups") when it makes the loop and never clears it at depth 0; the byte of depth 1 is set on every run exit. `gpui_macos::main_run_loop_wakeups::enable` clears the depth-0 byte while a page exists (`webview_pulse.rs` calls it for the first page and `disable` for the last), so the wake sends its message to the loop's wake port, which the watch's knote on the default-mode port set already sees.

Memory layout that is not API, so `enable` refuses (an `Error`, and nothing is written) unless all of these hold:

- aarch64;
- the two offsets are read from the machine code of this machine's `CFRunLoopWakeUp` (`decode_wake_up_layout`: `ldrb Wd,[Xrl,#depth]; add Xa,Xrl,Xd; ldrb Wf,[Xa,#flag]; cbz Wf` in its first 100 instructions, exactly one match, both offsets inside the object);
- the object is that large, and the byte is 0 or 1;
- on a run loop of its own that no thread has run (the check cannot be made on the main loop, because `enable` is called while a frame is drawn, inside a run, where the byte that decides is the one of depth 1), a wake from another thread sends no message, and does send one once that loop's byte is cleared. The messages are counted on its port set (`mach_port_get_attributes`), not received.

Where it refuses, `webview_pulse.rs` logs the reason once and keeps the repeating `CFRunLoopTimer` it used before (16 ms for 1.5 s after anything asked a page for work, 250 ms otherwise); that timer exists only as this fallback.

A run of the loop that returns after one source (`CFRunLoopRunInMode(.., 0.0, returnAfterSourceHandled)`) handles one source and receives the wake message in the same iteration, so another source that is signalled stays signalled and nothing wakes for it. `pump_app_nonblocking` therefore runs it until an iteration handles nothing. With one source per run, a `reload()` after a few idle seconds delivered `did-start-loading` and then nothing for seconds.

**Numbers** (release addon, one machine, runs of the two addons back to back in one lock hold; load average 3 to 7 unless noted; `examples/webview-wake/`):

| | timer (before) | wake byte (now) |
|---|---|---|
| wakes in 15 s at rest, loaded page, 2 s after the load | 62 to 65 (6 runs), 4 Hz | 2 to 5 (5 of 6 runs) |
| same, 20 s after the load | 63, 63, 64 | 2, 2, 2, 3 |
| `reload()`: `did-start-loading` / `did-navigate` / `did-stop-loading`, median | 52 to 54 / 70 to 74 / 70 to 74 ms | 4 to 5 / 6 to 8 / 7 to 8 ms |
| `executeJavaScript("1 + 1")`, median | 17 ms | 0.7 to 0.9 ms |
| `did-fail-load` of `loadURL`, median | 70 to 72 ms | 5 to 8 ms |
| title the page sets by itself, median | 5 to 16 ms | 1 to 3 ms |
| bare window, wakes in 15 s | 0 to 1 (3 runs) | 0 to 5 (3 runs) |

The bare window enables nothing, so it is the same code; the 5 are the first half second of one run.

**Bursts.** Some runs of either addon see a burst: 100 to 550 wakes at about 100 a second for 0.6 to 2.8 s, at any time from 3 to 36 s after launch (2 of 12 runs of the wake byte, 3 of 12 of the timer, and a bare window too, 45 wakes in 15 s once; the instrumented build of the wake byte saw them in 5 of 12). Each wake there is a message on the main dispatch queue's port, on the loop's wake port or on a third port of the default-mode set, in about equal parts. They are not the page's (a bare window has them) and not the timer's; the source was not found. Apple's launch measurement (see Known above) explains the ones in the first seconds, not those 20 s and more after launch.

## Memory footprint of a window (#79)

One window and one text, 1x display, footprint: 70 to 65 MB with fonts, 68 to 63 MB without.

**Cut.**

- **gpui's profiler journal ring** (4 MiB). Every `App` allocated it and wrote to it on each task poll, draw and present,
  though only Zed's hang detection and `bench_context` read it. Its slots are now allocated by the first collector, and
  nothing is recorded before one exists. gpuix never reads it. Zed asks at startup, so its behaviour is unchanged.
- **A registered font is held once.** font-kit's `Handle::from_memory` kept the bytes in an `Arc` and copied them into a
  `CFData` for the validation and again for every `load()`, so a font was held two to three times. `add_fonts` now builds
  the `CTFont` for an owned single TrueType or OpenType file from a no-copy `CFData::from_arc` over the bytes.
  Collections and resource-fork fonts keep font-kit's path, which unpacks them into a new buffer. On Arial Unicode.ttf
  (23.3 MB), registering it and laying out a line added 47.9 MB before and 1.1 MB now.

**Left, and why.**

- **`CAMetalLayer` drawables**: 2 at rest, 3 while animating. At 1280 x 780 BGRA each is 3.9 MB at 1x and 15.2 MiB at 2x,
  so about 30 MB on a Retina display. The window's layer keeps a `maximumDrawableCount` of 3, because with 2
  `nextDrawable` blocks when the GPU and the compositor together take longer than a vsync. An overlay layer keeps 2
  (see [round 51](#overlay-layers-and-the-composition-record-round-51)).
- **The JavaScriptCore heap** (App-Specific Tag 1, 17 to 20 MB). It is there with no window: it is the JS that was loaded.
- **ColorSync transform tables**, about 11 MB in Malloc Small, from AppKit and CoreAnimation colour matching (the Dock
  icon draw, `CGColor` conversion on commit).
- **gpui's instance buffers**, one per frame in flight, 2 MiB each as in gpui (the pool grows when a frame needs more),
  and the **A8 glyph atlas** (1 MB). A 256 KiB start was tried in round 49 and
  [reverted](#engine-tweaks-tried-in-round-49-and-reverted).
- **The Objective-C and AppKit runtime**, under 4 MB.

Floors measured for comparison: a bare `bun` 4.4 MB, with the addon loaded 7.8 MB, a compiled app with its JS and no
window 26 MB.


### Where a session's memory goes after a tour (#112)

FF's demo in a real 1280 x 780 window on a 1x display, started on the introduction, then every page visited once through
the app's own `navigate` and back (`footprint.tsx --window --tour`, two rounds). `phys_footprint` is read through
`proc_pid_rusage` (`/usr/bin/footprint` hangs on this machine), and beside it the bytes the system malloc zones hold live
(`malloc_zone_statistics`), which is where the addon allocates. The footprint swings 40 to 50 MB between runs of one build
(it counts the allocator's fragmentation, which depends on timing); the live bytes move by 1 to 2.

| MB, mean of 4 runs (range) | start | showcase | end of tour | end of 2nd tour | at rest |
| --- | --- | --- | --- | --- | --- |
| poc (2a7ee180), footprint | 100 (95-104) | 184 (178-188) | 266 (257-282) | 300 (294-309) | 293 (270-309) |
| poc, malloc live | 40 | 76 | 100 | 103 | 103 |
| round 36, footprint | 102 (101-105) | 186 (183-189) | 241 (209-267) | 236 (212-248) | 236 (212-247) |
| round 36, malloc live | 39 | 68 | 68 | 69 | 69 |

A page that is left and entered again does not grow: the live bytes of poc go from 100 at the end of the first tour to
103 at the end of the second, those of this branch from 68 to 69.

The footprint gap at the end of the first tour (266 against 241) is inside the swing between runs; at the end of the
second tour and at rest the ranges do not overlap (300 against 236, 293 against 236).

**What each cut saves**, in live MB at the end of one tour, one cut turned off at a time in a probe build (the shrinks
gated by an environment variable, never committed), two runs each; all on is 81, the node store move is on top of that:

| cut | live MB |
| --- | --- |
| CSS transition and animation states boxed (an empty slot costs 8 bytes, not 15.5 KB) | 15 (poc 96 to 104, every shrink off 89) |
| the layout engine's node store, moved into a store of its own size | 14 (81 to 67) |
| element arena chunks past what a frame used (gpui) | 4 |
| the bounds registry, and the retained tree's element table and id sets | 1.5 each |
| the scene's primitive vectors, and the hitboxes, listeners and element states of a frame (gpui) | 1 each |

Three further tables (the retain records, the motion state table, the measurements and paint statics) gave back
nothing on the demo in two runs each, and their cuts are not in the tree. The CSS transition shrink itself reads 0 on the
demo too; the boxing in the same commit is where its 15 MB is.

**A page that swaps between sizes does not thrash.** The tables shrink only once they are over four times the use, to
twice the use, and only at the point where the entries left, so there is no timer and no wake. `examples/page-swap.perf.test.tsx`
(`bun run test:perf:swap`) swaps a 2500-row page with a 60-row one, which is over the ratio and reallocates on every
swap, and with a 900-row one, which is under it and never does. CPU of the frame that follows the swap, poc against this
branch, two runs each, p50: over the ratio, the frame that goes from the big page to the small one 24.3 and 24.3 ms against 23.7 and 24.0, the one back 189.5 and 186.7 against 188.7 and 191.7; under the ratio 72.2 and 71.9 against 71.7 and 72.6, and 182.9 and 181.9 against 185.0 and 185.7; a steady frame 0.78 against 0.76 ms on the big page and 0.13 against 0.14 on the small one. The cost of a swap is the build of the page that comes in; the shrink is not
seen in it. `test:perf` (chat, timeline, rerender) reads the same on both within run to run noise (chat idle flush
1.59 and 1.68 ms against 1.70 and 1.67, rerender frame 9.9 against 9.8 ms), and the two `timeline.perf` pan budgets fail on both.

**The node store and ids.** Moving the layout engine's nodes gives each a new id. `HostBox` kept the layout node a host
was painted with, and `Window::box_stamp` of an old id could read another node's stamp, so a host that had moved could
pass for unmoved. A `HostBox` now keeps `Window::layout_engine_id()` beside the node and is not unmoved once it differs
(`automation/host_box_tests.rs` fails without it: the first host of a page widens in the frame that moves the store).

**Left, and why.** Footprint at rest after the tour, 245 MB in the run `vmmap` was read on: malloc small 118 MB dirty
(the zones hold 69 MB live and 84 MB of fragmentation), the JavaScriptCore heap 55 MB dirty, large allocations 19 MB,
IOSurface 11 MB, graphics 11 MB, stacks 7.5 MB, JIT 6 MB. Ranked:

1. **Malloc fragmentation**, about 84 MB at rest. `malloc_zone_pressure_relief(NULL, 0)` called after the tour freed
   nothing the footprint shows (285 to 285 MB and 254 to 254 MB in two runs), so it is not a call to add. What would
   is fewer, larger or longer-lived allocations in the addon, which is a survey of the allocation sites, not a cut.
2. **The JavaScriptCore heap**, 55 MB dirty and 52 MB reclaimable after the tour, 16 MB after a GC: JS garbage that
   collects late. A `Bun.gc()` after a page unmounts would take most of it; it is the app's call, not gpuix's.
3. **Live native data that is not a table**: 39 MB at the start and 68 MB at the end of a tour. The glyph and shape
   caches, `StyleTable` (about 3000 distinct styles at 1.6 KB each at the showcase) and the interned strings hold most of
   it, and none of it shrinks. About 5 MB of the showcase's is the style table, whose `Arc<StyleDesc>` and raw JSON kept for collision
   checks could be one.
4. **A transition state's before-change style** is an `Arc<StyleDesc>` shared with the style table when
   `fold_state_styles` has nothing to fold (no state style applies and the style holds none), so it costs a pointer.
   An element that declares a `:hover`, `:active` or other state style, or `@container` rules, still gets a 6.3 KB
   cleaned copy on every build, applied or not: handing on the table's style would carry the state styles' boxes into
   every animated frame's clones. A cleaned `Arc` cached in the style table would remove it.
5. **`CAMetalLayer` drawables** (11 MB of IOSurface at 1x, about 30 MB on a Retina display) and ColorSync tables: the floor
   listed above.

### Where an app's memory goes (round 49)

Three apps built on Ghia, measured in November 2026: the ghia-swiftui demo (960 x 640), its Apple Music clone (1298 x 838,
15 album covers) and the ghia-fluid-functionalism gallery (1236 x 778), each from a copy of its checkout, on a 1x display
(an LG 1920 x 1080, the only one attached: IOSurface is an exact multiple of width x height x 4), window opened in the
background (`GPUIX_BACKGROUND=1`). On a Retina display every drawable is four times the size, so the IOSurface row below
would read about 76 / 250 / 46 MB. Footprint is `phys_footprint` through `proc_pid_rusage` 15 s after
the first window shows; buckets are dirty + swapped MB from `vmmap --summary`; the malloc split is `MallocStackLogging=lite`
with `malloc_history -allBySize`, grouped by the first addon or framework frame. Builds are compared back to back in one
session: the footprint of one build moves by 1 to 5 MB between runs, and IOSurface by one drawable (2 at rest, 3 while
animating).

| footprint MB (two runs) | demo | music | fluid |
| --- | --- | --- | --- |
| published 0.11.1 (Babel loaded at every launch) | 186, 192 | 316, 315 | 259, 256 |
| main's addon, Solid transform cache warm | 131, 131 | 261, 260 | 195, 195 |
| round 49 (measured with the two tweaks [reverted below](#engine-tweaks-tried-in-round-49-and-reverted); not measured again) | 116, 116 | 211, 212 | 178, 178 |

| dirty + swapped MB, round 49 | demo | music | fluid |
| --- | --- | --- | --- |
| App-Specific Tag 1 (Bun's mimalloc: JavaScriptCore's heap is 13 / 11 / 30 MB of it, capacity plus extra memory, 8 / 7 / 20 MB of that live objects; the rest is Bun's own) | 30 | 26 | 53 |
| Malloc Small (the addon and the system frameworks) | 36 | 42 | 78 |
| Malloc Small (empty) | 0 | 25 | 0 |
| IOSurface (`CAMetalLayer` drawables: 4, 5 and 1 layers) | 19 | 65 | 11 |
| IOAccelerator (atlas textures, instance buffers, driver state) | 9 | 31 | 9 |
| owned unmapped (graphics), Metal driver | 8 | 8 | 4 |
| stacks, `__DATA`, page tables and the rest | 15 | 14 | 25 |

What each item is, largest first:

- **Babel** (55 to 73 MB per app, all in Tag 1). The rows above were measured with the Bun preload, which loaded Babel
  into the app's process for every file that missed its transform cache. Under `ghia dev` the compiler is
  vite-plugin-solid's Babel, in the same process, so a dev run carries it; a `ghia build` bundle carries none. Not
  measured under Vite.
- **Album covers in the atlas** (music: IOAccelerator 73.7 to 30.9 MB, -42.8, nearly all of the music clone's
  -50 MB). A tile wider or taller than 512 px gets a texture of exactly its size (zed `metal_atlas.rs`), so the 15
  covers take the 21.6 MB their pixels need; a padded 1024 x 1024 texture each is 60.5 MB. This one stays, as an
  [engine patch we carry](syncing-upstream.md#engine-patches-we-carry).
- **Drawables are noise in the demo's -15 MB.** Its IOSurface went from 25.8 to 18.8 MB, three drawables of 2.3 MB,
  and nothing in the round touches drawables: a layer holds 2 at rest and 3 after an animation, so about half of the
  demo's drop is when the window last animated. The rest is instance buffers (IOAccelerator 13.2 to 9.3, from the
  reverted 256 KiB start) and malloc.
- **`StyleDesc`** (fluid: 8 MB of the style table, transition states and stacks). A `LinearLength` is one
  `(unit, value)` term or a shared array for a mixed `calc()`, as Chrome's `Length` is, so a style is 6.3 KB (16 KB
  with twelve `f64` terms per length). A build keeps styles on the main thread's stack, which is 2.5 to 3.5 MB smaller
  for it.
- **Motion tracks** (fluid: 1.7 MB). A `MotionState`'s tracks are boxed, so a state with one track holds a small
  B-tree node, not an eleven-slot 16 KB one.

**Left, and why.** In malloc allocated MB (demo / music / fluid) the addon's share is 15 / 15 / 42 and the system's 18 /
22 / 14:

1. **`CAMetalLayer` drawables**, 19 / 65 / 11 MB at 1x (76 / 250 / 46 on Retina), up to three times width x height x 4
   per layer. Every overlay layer (a layer above a native view) has its own; the music clone has four. Round 51 cuts
   an overlay to two drawables and an overlay with nothing to draw to none
   ([below](#overlay-layers-and-the-composition-record-round-51)); fewer or smaller overlay layers is the layer model's
   call.
2. **The JS heap and Bun's allocator**, 26 to 53 MB: the app's own modules and data (Solid, base-ui, the app). Ghia's JS
   per element is about 0.45 KB. JavaScriptCore's heap is about half of it (13 / 11 / 30 MB). zod (1.8 MB, 95 modules)
   and eventsource-parser, which the automation protocol needs, load only when automation is on (the client is a
   dynamic import in `runtime.ts`). Automation is on only when the environment has `GPUIX_AUTOMATION=1` (`launch()` sets it), so an app started
   from a terminal, from Finder or by a harness with a pipe for stdin loads neither.
3. **The addon's live data**, in fluid: the layout engine's node store (6.4 MB allocated, one `SlotMap` of taffy
   `NodeData`, plus its keyed-layout tables), motion and transition state (6.3 MB, 2 MB of it transition states at about
   7 KB each, see item 4 of the list above), the style table (5.4 MB), scene and frame arenas (4.4 MB), element frame
   state, text shaping and retain records (3.3 to 3.6 MB each). The demo and the music clone hold 15 MB in all, a third
   of it gpui's arenas.
4. **ColorSync tables** (5 to 7 MB), from CoreAnimation colour-matching AppKit's layer contents on commit, and AppKit,
   Metal and CoreText (5 to 8 MB together): the same in any AppKit app.
5. **Metal driver memory**, 4 to 8 MB of owned unmapped graphics: per device and pipeline, not per frame.
6. **The polychrome atlas** starts at 1024 x 1024 (4 MiB) and the glyph atlas at 1 MiB. A smaller first texture would
   split sprites across textures and break batching, for 3 MB.
7. **Malloc fragmentation**, (dirty + swapped) - allocated in the default zone: about 34 MB on music (the decoded images
   gpui's asset cache keeps) and 28 on fluid, 4.5 on the demo. Sending blocks of 256 KiB or more to `mach_vm_allocate`, so that a
   free unmaps them, was tried in round 51 and is not in the tree: it cost 7 to 30 % on the layout- and mount-heavy perf
   rows (`layout-idle` tick 0.51 to 0.64 ms, `css-values` p50 13.6 to 15.1 ms, `cq` container flip 124 to 132 ms, in
   every one of three rotated rounds), since a frame's large vectors then take a system call and fresh zero pages each
   time. Its footprint gain was not measured. mimalloc for the addon was not tried.

#### Engine tweaks tried in round 49 and reverted

The `zed/` fork carries only what Ghia needs. Two round 49 changes were general GPUI tweaks and were reverted:

- **Image pixels kept only in the atlas.** A single-frame image handed its pixels to the atlas it was first uploaded to
  and read them back on demand (`as_bytes` returned an `ImageBytes`). It was reverted because it saved no footprint: on
  the music clone the default zone's allocated bytes went from 56.8 to 34.8 MB, but the freed frames stayed in the
  process as dirty pages (footprint 0 MB), which the system allocator gives back only under memory pressure. It was
  also not something Ghia needed. An image is kept as CPU frames again, in the asset cache for the life of the app.
- **Instance buffer pool starting at 256 KiB.** Reverted as a general engine tweak; the pool starts at 2 MiB, as in
  gpui. It had saved 3 to 5 MB of IOAccelerator per app.

The footprint rows above were measured with both in the tree and were not measured again, so the music clone is up to
5 MB above its row.

### Overlay layers and the composition record (round 51)

Same apps, display and method as round 49. Most runs of this round could not complete: the app's window is parked at
the edge of the display, and once another window covers that strip AppKit reports the window occluded, gpui stops its
display link and the app draws nothing, so its drawables are not resident. The numbers below are the runs whose window
drew.

- **A window keeps its last composed frame and a count.** A test-support build (the published addon is one) recorded
  a `CompositionFrame`, with the overlay hitboxes cloned, for every composed frame, for the life of the window. With
  the music clone's list scrolled by stdio automation at 75 Hz for 120 s (about 372 presents a second over five
  layers), main's addon grew 52 MB/min (228 to 334 MB footprint, 2.4 MB per 1000 presents; the default zone held 135 MB
  allocated at the end, 36 with the fix); with the fix it stays within 186 to 200 MB (+2.7 and -3.3 MB/min in two runs).
- **Overlays share the window renderer's device state**: its pipelines, command queue, `CVMetalTextureCache`, unit
  vertices, atlas and path intermediate (zed `gpui_apple/src/metal_renderer/device_state.rs`). Owned unmapped graphics
  memory goes from 8.3 to 5.0 MB on the demo and 8.2 to 3.8 on the music clone at rest, 16.7 to 7.7 after the scroll.
  The one queue is also what makes the atlas's wait for the last submission cover every layer before it writes a tile.
- **An overlay layer keeps two drawables**, the window's layer three. After the scroll the music clone held 15
  drawables (64.5 MB IOSurface at 1x) and holds 11 (47.3 MB); at rest the demo holds 8 or 9 (18.8 to 21.1 MB) instead of
  12 (28.1). Over the 120 s scroll, slots with no present (a gap over 1.5 x 13.3 ms) were 50 on main and 27 and 11 with
  two drawables, of about 8960; a `nextDrawable` wait over 1 ms went from 9.5 % to 19.5 % of layer draws, over 5 ms
  from 248 to 391 and 130, over a vsync from 29 to 20 and 12. The waits are longer more often but short, and fewer
  slots went without a present.
- **An overlay with nothing to draw** in its order range (`Scene::is_empty_in`) is not drawn: its `CAMetalLayer` is
  hidden and gives its drawables back (`MetalRenderer::release_drawables`: a 1 x 1 drawable presented, then another
  taken, since neither hiding nor shrinking frees the one on screen or the idle one in the pool). Its view stays, so
  AppKit's hit test still reaches its hitboxes and the stack order does not change. Not measured on the three apps.
- Fluid has no overlay, so none of this moves it (180 / 166 MB on main, 168 / 182 with the round, at rest).

## API

- `FrameLoopOptions` is exported from `@ghia/native/runtime`.
- Solid's `render()` takes `frameLoop: { frameMs }` and passes it to `startFrameLoop`.
- `GPUIX_PRESENT_LOG` (a zed commit) logs when each `MTLDrawable` is presented; it is how the present gaps in the tables
  above were measured.

## Tests

- gpuix `packages/native/js/__tests__/frame-loop.test.ts` (10) runs the loop against a fake renderer: the tick at start
  and on every wake, teardown, termination, tick errors, and timer polling. An idle wake loop ticks once at start and then
  never, and ticks once per wake and not in between. `frame-loop-yields.test.ts` (2) runs the real loop against a hidden
  window with synthetic wakes from a Rust thread (`simulateFrameWakes`, `setTickDelay`, test-support builds only) and
  checks that timers and file reads keep running when every frame outlasts a vsync.
- react `events.test.tsx` "wakes JS once per mouse move, not again when the frame boundary comes" opens a visible window
  with `focus: false`, posts 240 mouse moves from NSEventThread at random points of 120 Hz periods and allows 1.15 wakes
  per move. Without the flush after `sendEvent:` it saw 352 and 339 wakes for 240 moves (1.47 and 1.41).
- zed `gpui_macos` `tests/pump_window_updates.rs` (`harness = false`): 100 mouse moves posted to a window through
  `pump_app_nonblocking` make 100 `NSApplicationDidUpdateNotification`, not 260 as with a `updateWindows` call in the pump.
- zed `gpui_macos` `run_loop_wake` lib (1: the set is found twice alike, is not the main queue's port and has members)
  and `tests/run_loop_wake.rs` (`harness = false`, it pumps the main run loop on the main thread): a `dispatch_async` from
  another thread and a `CFRunLoopTimer` each wake the hook while nothing runs the loop, neither runs before the pump, the
  hook stays quiet for 300 ms after a pump, work that arrives while the knotes are disabled wakes at the re-arm, and
  `None` stops the wakes. With an NSApplication and a window that are never active: 2 s idle with no call of the hook; a
  key down, a mouse move, a click and a scroll posted on NSEventThread each wake the hook within 20 ms (0.1 to 3.5 ms) and
  are dequeued; a window moved with `setFrameOrigin:` comes back from WindowServer as an AppKitDefined event that wakes
  the hook. Without the observer it fails at `key down: no wake within 20ms`.
- zed gpui `window::tests`: a draw outside a frame request schedules a frame before `flush_effects` can, and
  `on_next_frame` schedules and wakes. The idle count of the link is not tested (a window needs a display); the
  measurements above cover it.
- gpuix `window_options_tests` has the unfocused case (an unfocused window is not throttled).
- Round 51: gpui `composition::tests` `the_window_counts_composed_frames_and_holds_only_the_last` (5 frames, count 5, the
  last held) and `a_range_is_empty_when_no_order_of_any_kind_is_in_it`; gpui_apple `composition.rs` tests (an overlay
  shares the base's device state, queue, atlas, pipelines and path intermediate, both render a scene, an overlay layer
  has 2 drawables and the window's 3); zed `gpui_macos/tests/native_surface_present.rs` (an overlay with only a hitbox
  claims it and never draws, painted content shows and draws its layer, gone content hides it and stops its draws while
  the hit test still claims); gpuix `motion/style_ref.rs` and `state_styles.rs` tests (the no-fold path is the table's
  `Arc`, a state style that applies or not still folds or cleans in a copy, the fixed-point check matches `overlay`);
  `packages/native/js/__tests__/lazy-automation.test.ts` (zod and eventsource-parser are not statically reachable from
  the runtime, host, screen, testing, cpu-throttle or idle-gc entries; the client entry reaches them).
- The webview wake timer is checked by the e2e only (events of a real page arriving at an idle app, [testing.md](testing.md#the-webview-e2e)); the test renderer's pages report from the test.
- Input wakes need a way to post events without the OS: the test-support `GpuixRenderer.postNativeEvent(kind, x?, y?)`
  (`packages/native/src/native_event.rs`) builds the NSEvent for the window and posts it from NSEventThread with
  `gpui_macos::post_event_on_event_thread`; nothing reaches the OS and the app is not activated. A scroll has no NSEvent
  factory, so it is a CGEvent that needs the window number in field 51 and the private `CGEventSetWindowLocation` (test
  only). The react `events.test.tsx` frame-loop test opens a visible window with `focus: false` on the wake path: 0 wakes
  over 2 s idle once the launch measurement ends, then each kind wakes JS 0.1 to 1.4 ms after the post and reaches its
  handler 0.4 to 7.7 ms after it (keyDown through the window-level `onKeyDown`, nothing focused). It fails at `keyDown
  woke` without the observer. The test renderer's own wake support is in [testing.md](testing.md).
- zed `gpui_macos` lib with font-kit (45: an owned TTF gives a native handle and a collection a memory one, and the opsz
  test, Chrome's advances for the Inter subset registered as owned bytes, passes on the new path); gpui journal tests (3:
  no slots, no offered entries and no sequence before a collector; entries offered after one are collected; a writer
  without a collector records nothing, then records once one exists).
