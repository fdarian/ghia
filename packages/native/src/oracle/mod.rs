//! A row-cost oracle: what the same rows cost as plain GPUI elements, with no Ghia tree.
//!
//! Measurement only (`test-support`). `RowOracle` opens a window like the test renderer's (same
//! offscreen platform, same `to_gpui_window_options`) whose root view is [`RawRows`]: a flex
//! column of message rows copied from the `render_row` of ghia-bench's `apps/gpui`, with the
//! same divs, styles and texts. It is a plain column and not a `uniform_list`, so every row is
//! built, laid out, prepainted and painted on every frame, which is what a `cx.notify` of the
//! bench's single `Mailbox` view does to its visible rows. The fork's per-window options that
//! Ghia turns on are switches here, so their cost on raw GPUI elements can be priced.
//!
//! `setRowKind("direct")` swaps the divs for one custom element per row (`direct.rs`), which lays
//! out and paints the same nodes without a `Div` each; `setDecorations` puts what Ghia puts on its
//! host divs on the raw ones, one at a time.
//!
//! Use it from a script that reads the process's instruction counter around `drawWholeFrame()`
//! and `simulateMouseMove()` + `drawFrame()`, see `examples/solid/row-cost/profile.tsx`.

mod direct;
mod rows;

use std::cell::RefCell;

use gpui::AppContext as _;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::renderer::WindowOptions;
use direct::DirectKnobs;
use rows::{Decorations, RawRows, RowKind};

#[napi(object)]
pub struct RowOracleOptions {
    pub width: f64,
    pub height: f64,
    pub scale_factor: Option<f64>,
    /// `Window::set_dom_hit_testing`, which Ghia turns on for every window. Off here unless asked.
    pub dom_hit_testing: Option<bool>,
    /// `Window::set_max_draw_passes`; Ghia allows 4 (container queries). 1 is GPUI's.
    pub max_draw_passes: Option<u32>,
    /// `Window::set_a11y_active_for_tests`: the test window starts with a pretend screen reader.
    #[napi(js_name = "a11yActive")]
    pub a11y_active: Option<bool>,
    /// `Window::set_active_for_tests`: the test window is made key.
    pub window_active: Option<bool>,
}

/// `view` before `cx`: gpui panics at teardown if an `Entity` handle outlives its `App`.
struct OracleState {
    view: gpui::Entity<RawRows>,
    window: gpui::AnyWindowHandle,
    cx: gpui::VisualTestAppContext,
}

thread_local! {
    static ORACLE: RefCell<std::mem::ManuallyDrop<Option<OracleState>>> =
        const { RefCell::new(std::mem::ManuallyDrop::new(None)) };
}

fn with_oracle<R>(
    f: impl FnOnce(&mut gpui::VisualTestAppContext, gpui::AnyWindowHandle, &gpui::Entity<RawRows>) -> Result<R>,
) -> Result<R> {
    ORACLE.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let state = borrow
            .as_mut()
            .ok_or_else(|| Error::from_reason("RowOracle is disposed or was never created"))?;
        f(&mut state.cx, state.window, &state.view)
    })
}

fn in_window<R>(update: impl FnOnce(&mut gpui::Window, &mut gpui::App) -> R) -> Result<R> {
    with_oracle(|cx, window, _view| {
        let result = cx
            .update_window(window, |_, window, app| update(window, app))
            .map_err(|error| Error::from_reason(error.to_string()))?;
        cx.run_until_parked();
        Ok(result)
    })
}

#[napi]
pub struct RowOracle {
    _private: (),
}

#[napi]
impl RowOracle {
    #[napi(constructor)]
    pub fn new(options: RowOracleOptions) -> Result<Self> {
        let _ = env_logger::try_init();
        let scale_factor = crate::test_renderer::window_scale_factor(options.scale_factor.unwrap_or(1.))?;
        let window_options = WindowOptions {
            width: Some(options.width),
            height: Some(options.height),
            ..crate::test_renderer::unset_window_options()
        };
        let window_kind = crate::window_kind::window_kind(&window_options).map_err(Error::from_reason)?;
        let bounds = gpui::Bounds {
            origin: gpui::point(gpui::px(-10000.0), gpui::px(-10000.0)),
            size: gpui::size(gpui::px(options.width as f32), gpui::px(options.height as f32)),
        };
        let gpui_options = crate::renderer::to_gpui_window_options(
            &WindowOptions { fullscreen: Some(false), focus: Some(false), x: None, y: None, ..window_options },
            window_kind,
            bounds,
            &[],
        );

        let platform = gpui_platform::current_offscreen_platform();
        let mut cx = gpui::VisualTestAppContext::new(platform);
        let dom_hit_testing = options.dom_hit_testing.unwrap_or(false);
        let max_draw_passes = options.max_draw_passes.unwrap_or(1) as usize;
        let window_handle = cx
            .update(|app| {
                app.open_window(gpui_options, |window, app| {
                    window.set_scale_factor(scale_factor);
                    window.set_dom_hit_testing(dom_hit_testing);
                    window.set_max_draw_passes(max_draw_passes);
                    app.new(|_| RawRows::new())
                })
            })
            .map_err(|error| Error::from_reason(format!("Failed to open the oracle window: {error}")))?;
        let view = window_handle
            .entity(&cx)
            .map_err(|error| Error::from_reason(format!("Failed to get the root view: {error}")))?;
        let window: gpui::AnyWindowHandle = window_handle.into();
        let a11y_active = options.a11y_active.unwrap_or(false);
        let window_active = options.window_active.unwrap_or(false);
        cx.update_window(window, |_, window, cx| {
            window.set_a11y_active_for_tests(a11y_active);
            window.set_active_for_tests(window_active, cx);
        })
        .map_err(|error| Error::from_reason(error.to_string()))?;
        cx.run_until_parked();

        // One oracle per thread.
        let previous = ORACLE.with(|cell| cell.borrow_mut().take());
        drop(previous);
        ORACLE.with(|cell| **cell.borrow_mut() = Some(OracleState { view, window, cx }));
        Ok(Self { _private: () })
    }

    /// Tears the window down. Every other call throws afterwards.
    #[napi]
    pub fn dispose(&self) {
        let state = ORACLE.with(|cell| cell.borrow_mut().take());
        drop(state);
    }

    /// The rows to draw: JSON `[{fromName, subject, snippet, time, unread}]`, with the row at
    /// `selected` (-1 for none) drawn selected. Marks the view dirty.
    #[napi]
    pub fn set_rows(&self, json: String, selected: i32) -> Result<()> {
        let rows = rows::parse(&json).map_err(Error::from_reason)?;
        with_oracle(|cx, _window, view| {
            cx.update(|app| {
                view.update(app, |view, cx| {
                    view.set_rows(rows, usize::try_from(selected).ok());
                    cx.notify();
                })
            });
            cx.run_until_parked();
            Ok(())
        })
    }

    /// Whether the test window is drawn whenever an input flushes. Off, a frame is drawn by
    /// `drawFrame` and `drawWholeFrame` only, as a display link ends one.
    #[napi]
    pub fn set_inline_draws(&self, enabled: bool) -> Result<()> {
        with_oracle(|cx, _window, _view| {
            cx.update(|app| app.set_draws_inline(enabled));
            Ok(())
        })
    }

    #[napi]
    pub fn set_dom_hit_testing(&self, enabled: bool) -> Result<()> {
        in_window(|window, _app| window.set_dom_hit_testing(enabled))
    }

    #[napi]
    pub fn set_max_draw_passes(&self, passes: u32) -> Result<()> {
        in_window(|window, _app| window.set_max_draw_passes(passes as usize))
    }

    #[napi(js_name = "setA11yActive")]
    pub fn set_a11y_active(&self, active: bool) -> Result<()> {
        in_window(|window, _app| window.set_a11y_active_for_tests(active))
    }

    #[napi]
    pub fn set_window_active(&self, active: bool) -> Result<()> {
        in_window(|window, app| window.set_active_for_tests(active, app))
    }

    /// How a row is built: `"div"` (the bench's divs) or `"direct"` (one element per row, no `Div`
    /// per node, see `direct.rs`). Marks the view dirty.
    #[napi]
    pub fn set_row_kind(&self, kind: String) -> Result<()> {
        let kind = match kind.as_str() {
            "div" => RowKind::Div,
            "direct" => RowKind::Direct,
            other => return Err(Error::from_reason(format!("unknown row kind {other:?}"))),
        };
        with_oracle(|cx, _window, view| {
            cx.update(|app| {
                view.update(app, |view, cx| {
                    view.kind = kind;
                    cx.notify();
                })
            });
            cx.run_until_parked();
            Ok(())
        })
    }

    /// What Ghia puts on each of its host divs, put on the oracle's divs (`"div"` rows): a hitbox
    /// (`always_hitbox`, needs DOM hit testing), the `track_host_bounds` closures, an element id.
    #[napi]
    pub fn set_decorations(&self, hitbox: bool, bounds: bool, ids: bool) -> Result<()> {
        with_oracle(|cx, _window, view| {
            cx.update(|app| {
                view.update(app, |view, cx| {
                    view.decorations = Decorations { hitbox, bounds, ids };
                    cx.notify();
                })
            });
            cx.run_until_parked();
            Ok(())
        })
    }

    /// The parts of a direct row: a hitbox per node (off: the row's own, for its hover), a bounds
    /// write per node as `record_bounds` makes it, and the style of every node resolved from its
    /// refinement in every frame (off: cloned from the template).
    #[napi]
    pub fn set_direct_knobs(&self, hitboxes: bool, bounds: bool, style_each_frame: bool) -> Result<()> {
        with_oracle(|cx, _window, view| {
            cx.update(|app| {
                view.update(app, |view, cx| {
                    view.direct = DirectKnobs { hitboxes, bounds, style_each_frame };
                    cx.notify();
                })
            });
            cx.run_until_parked();
            Ok(())
        })
    }

    /// The hit chain under the pointer, target first, as `Debug` prints the element ids of its
    /// hitboxes (needs DOM hit testing and a pointer move first).
    #[napi]
    pub fn get_hit_chain(&self) -> Result<Vec<String>> {
        in_window(|window, _app| window.hit_chain().map(|(id, _)| format!("{id:?}")).collect())
    }

    /// A display-link frame: delivers the frame callbacks, then draws a pending change, once.
    /// Draws nothing on a clean window.
    #[napi]
    pub fn draw_frame(&self) -> Result<()> {
        in_window(|window, app| {
            window.simulate_next_frame(app);
            window.paint_if_dirty(app);
        })
    }

    /// Rebuilds, lays out, prepaints and paints every row: the view is notified, then one frame
    /// is drawn.
    #[napi]
    pub fn draw_whole_frame(&self) -> Result<()> {
        with_oracle(|cx, window, view| {
            cx.update(|app| view.update(app, |_, cx| cx.notify()));
            cx.update_window(window, |_, window, app| {
                window.simulate_next_frame(app);
                window.paint_if_dirty(app);
            })
            .map_err(|error| Error::from_reason(error.to_string()))?;
            cx.run_until_parked();
            Ok(())
        })
    }

    /// A pointer move to (x, y), dispatched like the test renderer's `simulateMouseMove`.
    #[napi]
    pub fn simulate_mouse_move(&self, x: f64, y: f64) -> Result<()> {
        with_oracle(|cx, window, _view| {
            cx.simulate_event(
                window,
                gpui::MouseMoveEvent {
                    position: gpui::point(gpui::px(x as f32), gpui::px(y as f32)),
                    modifiers: Default::default(),
                    pressed_button: None,
                },
            );
            Ok(())
        })
    }

    /// Saves the window as a PNG, as `TestGpuixRenderer.captureScreenshot` does, to compare what
    /// the oracle draws with what the same rows draw as Ghia elements.
    #[napi]
    pub fn capture_screenshot(&self, path: String) -> Result<()> {
        with_oracle(|cx, window, view| {
            cx.update(|app| view.update(app, |_, cx| cx.notify()));
            cx.update_window(window, |_, window, _app| window.refresh())
                .map_err(|error| Error::from_reason(error.to_string()))?;
            cx.run_until_parked();
            let image = cx
                .capture_screenshot(window)
                .map_err(|error| Error::from_reason(format!("Screenshot capture failed: {error}")))?;
            image
                .save(&path)
                .map_err(|error| Error::from_reason(format!("Failed to save screenshot: {error}")))?;
            Ok(())
        })
    }

    /// `[renders, divs, texts]`: how many times the view was rendered, and how many divs and
    /// text leaves those renders made.
    #[napi]
    pub fn get_counters(&self) -> Result<Vec<f64>> {
        with_oracle(|cx, _window, view| {
            Ok(cx.update(|app| {
                let view = view.read(app);
                vec![view.renders as f64, view.divs.get() as f64, view.texts.get() as f64]
            }))
        })
    }

    /// How many layout-only passes the window has run.
    #[napi]
    pub fn get_layout_pass_count(&self) -> Result<f64> {
        in_window(|window, _app| window.layout_pass_count() as f64)
    }
}
