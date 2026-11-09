//! The mutation batch: the typed ops one `applyBatch` call carries.
//!
//! `wire` is the binary format JS writes (`packages/native/js/wire.ts`);
//! `docs/reference.md` ("Wire format") is its spec.

pub mod wire;

#[cfg(test)]
pub(crate) mod test_json;

#[cfg(all(
    feature = "test-support",
    any(target_os = "macos", target_os = "windows")
))]
mod test_hooks;

/// Parsed batch operation — typed enum for atomic validation.
/// All ops are parsed and validated BEFORE any tree mutation occurs.
/// This prevents partial application on malformed batches.
#[derive(Debug)]
pub enum BatchOp<'a> {
    CreateElement {
        id: u64,
        element_type: String,
    },
    DestroyElement {
        id: u64,
    },
    DetachChild {
        id: u64,
    },
    AppendChild {
        parent_id: u64,
        child_id: u64,
    },
    InsertBefore {
        parent_id: u64,
        child_id: u64,
        before_id: u64,
    },
    /// The payload stays as JSON text until apply time.
    ///
    /// Two reasons. A parsed `StyleDesc` is ~1.4 KB, and a `Vec<BatchOp>` is as
    /// wide as its widest variant, so inlining one made a 220k-op mount reserve
    /// over 300 MB before it parsed a single op. And the tree hash-conses
    /// styles by content, so it needs the bytes: hashing ~110 bytes is far
    /// cheaper than building 80 `Option` fields and throwing 99.8% of them away.
    SetStyle {
        id: u64,
        style: &'a str,
    },
    SetText {
        id: u64,
        content: String,
    },
    SetEventListener {
        id: u64,
        event_type: String,
        has_handler: bool,
    },
    SetRoot {
        id: u64,
    },
    SetKeyboardFocusDim {
        enabled: bool,
    },
    /// Text for the same reasons as `SetStyle`. `None` clears the layer.
    SetUniversalStyle {
        style: Option<&'a str>,
    },
    SetCustomProp {
        id: u64,
        key: String,
        value: serde_json::Value,
    },
}
