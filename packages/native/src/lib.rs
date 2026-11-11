#![deny(clippy::all)]

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    not(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "windows")
    ))
))]
use napi::bindgen_prelude::*;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi_derive::napi;

mod accessibility;
#[cfg(target_os = "macos")]
mod app_menu;
mod automation;
mod background_images;
pub mod batch;
mod color;
mod css;
mod custom_elements;
mod diff;
mod dormant_wake;
mod element_tree;
pub mod events;
mod focus;
mod frame_steps;
mod focus_emulation;
mod forms;
mod html;
mod layout;
mod list_resize;
mod list_sizes;
mod markdown;
mod media;
mod motion;
#[cfg(all(feature = "test-support", target_os = "macos"))]
mod native_event;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
mod platform;
mod observers;
pub mod perf_counters;
mod renderer;
mod retain;
mod resolved_style;
mod screen;
mod scroll;
mod scroll_write;
mod scrollbar;
mod shrink;
mod slot;
mod tape;
// The data model is public so `examples/bench_serde.rs` measures the real
// types instead of a copy that silently drifts from them.
pub mod retained_tree;
pub mod style;
mod syntax;
mod text;
mod theme;
mod style_memo;
mod universal_style;
mod visible_range;
mod window_kind;
mod window_title;
#[cfg(target_os = "macos")]
mod window_key;
// Desktop only. HTTP goes through reqwest_client, not crates.io reqwest.
#[cfg(not(target_family = "wasm"))]
mod updater;

#[cfg(all(
    feature = "test-support",
    any(target_os = "macos", target_os = "windows")
))]
mod test_renderer;

/// Raw GPUI rows for measuring what an element costs without a Ghia tree, see `oracle/mod.rs`.
#[cfg(all(feature = "test-support", target_os = "macos"))]
mod oracle;

/// Runs a real `WKWebView` through a load, a title, history and scripts, on the main thread
/// (`cargo run --example webview_smoke`). Panics if the page misbehaves.
#[cfg(all(target_os = "macos", feature = "test-support"))]
#[doc(hidden)]
pub fn webview_smoke() {
    platform::webview_macos::smoke()
}

pub use element_tree::*;
pub use observers::Observation;
pub use media::MediaFeatures;
pub use renderer::*;
pub use style::*;

#[cfg(any(
    test,
    not(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "windows")
    ))
))]
const TEST_GPUIX_RENDERER_UNAVAILABLE: &str = concat!(
    "TestGpuixRenderer is macOS and Windows only. ",
    "Linux builds have no test-support because wgpu cannot read a rendered image back yet. ",
    "GpuixRenderer still works on Linux."
);

/// True only when this binary compiled the real GPU test renderer.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
pub fn has_test_gpuix_renderer() -> bool {
    cfg!(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "windows")
    ))
}

/// Checks a keyframes definition the way `GpuixRenderer.defineKeyframes` does,
/// without a renderer. `defineKeyframes` from `@ghia/native/host` runs it
/// first so a bad definition throws where it is written.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
pub fn validate_keyframes(name: String, frames_json: String) -> napi::Result<()> {
    motion::validate_keyframes(&name, &frames_json).map_err(napi::Error::from_reason)
}

/// How long an animation of a motion value lasts, found without a renderer from the transition
/// and keyframes the renderer would run, so the controls can say before the value is bound.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi(object)]
pub struct MotionAnimationLength {
    /// One iteration, without the delay or the repeats.
    pub duration: f64,
    /// `duration` plus the delay.
    pub iteration_duration: f64,
}

/// `animateMotionValue` of a value that holds `from`, measured. Throws what it would.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[napi]
pub fn measure_motion_animation(
    from: serde_json::Value,
    target: serde_json::Value,
    transition: Option<serde_json::Value>,
) -> napi::Result<MotionAnimationLength> {
    let (duration, iteration_duration) = motion::measure_motion_animation(&from, &target, transition.as_ref())
        .map_err(napi::Error::from_reason)?;
    Ok(MotionAnimationLength { duration, iteration_duration })
}

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    not(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "windows")
    ))
))]
#[napi]
pub struct TestGpuixRenderer;

#[cfg(all(
    not(all(target_arch = "wasm32", target_os = "unknown")),
    not(all(
        feature = "test-support",
        any(target_os = "macos", target_os = "windows")
    ))
))]
#[napi]
impl TestGpuixRenderer {
    #[napi(constructor)]
    pub fn new(_width: Option<f64>, _height: Option<f64>) -> Result<Self> {
        Err(Error::from_reason(TEST_GPUIX_RENDERER_UNAVAILABLE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_message_explains_linux() {
        assert!(TEST_GPUIX_RENDERER_UNAVAILABLE.contains("macOS and Windows only"));
        assert!(TEST_GPUIX_RENDERER_UNAVAILABLE.contains(
            "Linux builds have no test-support because wgpu cannot read a rendered image back yet"
        ));
        assert!(TEST_GPUIX_RENDERER_UNAVAILABLE.contains("GpuixRenderer still works on Linux"));
    }

    #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
    #[test]
    fn has_test_gpuix_renderer_matches_real_impl() {
        assert_eq!(
            has_test_gpuix_renderer(),
            cfg!(all(
                feature = "test-support",
                any(target_os = "macos", target_os = "windows")
            ))
        );
    }

    #[cfg(all(
        not(all(target_arch = "wasm32", target_os = "unknown")),
        not(all(
            feature = "test-support",
            any(target_os = "macos", target_os = "windows")
        ))
    ))]
    #[test]
    fn stub_constructor_explains_why() {
        match TestGpuixRenderer::new(None, None) {
            Ok(_) => panic!("stub constructor must fail"),
            Err(err) => assert!(
                err.to_string().contains(TEST_GPUIX_RENDERER_UNAVAILABLE),
                "{err}"
            ),
        }
    }
}
