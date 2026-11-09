//! Napi hooks for the round-trip tests of the wire format: both decoders, one debug line per op,
//! so a test compares what JS wrote in binary with what the JSON decoder makes of the same ops.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use super::wire;
use crate::renderer::parse_batch_ops;

/// `Debug` of every op the binary decoder reads from `bytes`.
#[napi]
pub fn debug_decode_wire_batch(bytes: Uint8Array) -> Result<Vec<String>> {
    let ops = wire::decode(&bytes).map_err(|error| Error::from_reason(error.to_string()))?;
    Ok(ops.iter().map(|op| format!("{op:?}")).collect())
}

/// `Debug` of every op the JSON decoder reads from `json`.
#[napi]
pub fn debug_decode_json_batch(json: String) -> Result<Vec<String>> {
    let ops = parse_batch_ops(json.as_bytes()).map_err(Error::from_reason)?;
    Ok(ops.iter().map(|op| format!("{op:?}")).collect())
}
