//! Direct paint: a plain subtree of the retained tree drawn by one gpui element that owns its nodes,
//! where each host would be a `Div`.
//!
//! The build still resolves every node's style the way `build_host_container` does, in the same
//! order and with the same inherited state, but the result goes into an arena ([`node`]) instead of
//! a `Div` per node, and [`element::DirectRoot`] lays out, prepaints and paints it with the calls a
//! `Div` makes. Which subtrees are drawn this way is [`eligible`]'s decision: a subtree whose nodes
//! need nothing from a `Div` that the arena does not give (no listener, focus, scroller the user scrolls,
//! sticky or fixed box, stacking context or accessibility node). Behind `GPUIX_DIRECT_PAINT=1`; see
//! `docs/fork/direct-paint.md`.

mod build;
mod eligible;
mod element;
mod node;

use std::sync::{
    LazyLock,
    atomic::{AtomicBool, Ordering},
};

pub(crate) use build::build_direct;
pub(crate) use eligible::is_direct_root;

static ENABLED: LazyLock<AtomicBool> =
    LazyLock::new(|| AtomicBool::new(std::env::var("GPUIX_DIRECT_PAINT").is_ok_and(|value| value == "1")));

/// Whether plain subtrees are drawn direct. Read at every build, so a change takes the next one; a
/// subtree that was recorded before it changed is replayed as it was recorded.
pub(crate) fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}
