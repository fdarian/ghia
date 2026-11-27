//! `GHIA_TEST_INVISIBLE_WINDOWS=1`: a test build opens every live window fully transparent and deaf
//! to the mouse, so a suite that opens real windows does not put them in front of the person
//! running it. A window on no screen would not do: its display link needs a display and AppKit
//! calls it occluded, so no frame would tick. It is an environment switch read by the `test-support`
//! feature, which is a default feature and is on in the published addon, so nothing but the
//! variable keeps a shipped app's windows visible: only `bindTestRendererScope` sets it.

#[cfg(feature = "test-support")]
pub(crate) fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("GHIA_TEST_INVISIBLE_WINDOWS").is_some_and(|value| value == "1")
    })
}

#[cfg(not(feature = "test-support"))]
pub(crate) fn enabled() -> bool {
    false
}
