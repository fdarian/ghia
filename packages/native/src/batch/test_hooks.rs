//! Napi hook for the round-trip tests of the wire format: what native's decoder reads
//! from the bytes JS wrote, one JSON array per op in the tuple shape of the old JSON batch.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::{wire, BatchOp};

/// The ops the binary decoder reads from `bytes`, each as `["name", ...args]` JSON.
/// Style payloads are the exact text native interns by.
#[napi]
pub fn debug_decode_wire_batch(bytes: Uint8Array) -> Result<Vec<String>> {
    let ops = wire::decode(&bytes).map_err(|error| Error::from_reason(error.to_string()))?;
    Ok(ops.iter().map(op_json).collect())
}

fn text(value: &str) -> String {
    serde_json::to_string(value).expect("a string is JSON")
}

fn op_json(op: &BatchOp<'_>) -> String {
    match op {
        BatchOp::CreateElement { id, element_type } => {
            format!(r#"["createElement",{id},{}]"#, text(element_type))
        }
        BatchOp::DestroyElement { id } => format!(r#"["destroyElement",{id}]"#),
        BatchOp::DetachChild { id } => format!(r#"["detachChild",{id}]"#),
        BatchOp::AppendChild {
            parent_id,
            child_id,
        } => format!(r#"["appendChild",{parent_id},{child_id}]"#),
        BatchOp::InsertBefore {
            parent_id,
            child_id,
            before_id,
        } => format!(r#"["insertBefore",{parent_id},{child_id},{before_id}]"#),
        BatchOp::SetStyle { id, style } => format!(r#"["setStyle",{id},{style}]"#),
        BatchOp::SetText { id, content } => format!(r#"["setText",{id},{}]"#, text(content)),
        BatchOp::SetEventListener {
            id,
            event_type,
            has_handler,
        } => format!(
            r#"["setEventListener",{id},{},{has_handler}]"#,
            text(event_type)
        ),
        BatchOp::SetRoot { id } => format!(r#"["setRoot",{id}]"#),
        BatchOp::SetKeyboardFocusDim { enabled } => {
            format!(r#"["setKeyboardFocusDim",{enabled}]"#)
        }
        BatchOp::SetUniversalStyle { style } => {
            format!(r#"["setUniversalStyle",{}]"#, style.unwrap_or("null"))
        }
        BatchOp::SetCustomProp { id, key, value } => {
            format!(r#"["setCustomProp",{id},{},{value}]"#, text(key))
        }
    }
}
