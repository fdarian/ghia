//! Test-only: write a batch given as JSON tuples (`[["createElement",1,"div"],...]`)
//! in the wire format, so Rust tests can keep stating a batch as readable text.
//! Production reads only the wire format.

use serde_json::value::RawValue;

use super::wire::{opcode, value_tag, FORMAT_VERSION};
use crate::renderer::BatchResult;
use crate::retained_tree::RetainedTree;

fn varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value & 0x7f) as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn string(out: &mut Vec<u8>, text: &str) {
    varint(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

fn id(out: &mut Vec<u8>, arg: &RawValue) {
    let value: u64 = serde_json::from_str(arg.get()).expect("an element id");
    varint(out, value);
}

fn arg_string(arg: &RawValue) -> String {
    serde_json::from_str(arg.get()).expect("a string argument")
}

/// The wire bytes of `json`. A style stays the exact text it has in `json`; a
/// `setUniversalStyle` of `null` is the empty string.
pub(crate) fn encode(json: &str) -> Vec<u8> {
    let ops: Vec<Vec<Box<RawValue>>> = serde_json::from_str(json).expect("a JSON array of tuples");
    let mut out = vec![FORMAT_VERSION];
    varint(&mut out, ops.len() as u64);
    for op in &ops {
        let name = arg_string(&op[0]);
        let args = &op[1..];
        match name.as_str() {
            "createElement" => {
                out.push(opcode::CREATE_ELEMENT);
                id(&mut out, &args[0]);
                string(&mut out, &arg_string(&args[1]));
            }
            "destroyElement" => {
                out.push(opcode::DESTROY_ELEMENT);
                id(&mut out, &args[0]);
            }
            "detachChild" => {
                out.push(opcode::DETACH_CHILD);
                id(&mut out, &args[0]);
            }
            "appendChild" => {
                out.push(opcode::APPEND_CHILD);
                id(&mut out, &args[0]);
                id(&mut out, &args[1]);
            }
            "insertBefore" => {
                out.push(opcode::INSERT_BEFORE);
                for arg in &args[..3] {
                    id(&mut out, arg);
                }
            }
            "setStyle" => {
                out.push(opcode::SET_STYLE);
                id(&mut out, &args[0]);
                string(&mut out, args[1].get());
            }
            "setText" => {
                out.push(opcode::SET_TEXT);
                id(&mut out, &args[0]);
                string(&mut out, &arg_string(&args[1]));
            }
            "setEventListener" => {
                out.push(opcode::SET_EVENT_LISTENER);
                id(&mut out, &args[0]);
                string(&mut out, &arg_string(&args[1]));
                out.push(serde_json::from_str::<bool>(args[2].get()).expect("a bool") as u8);
            }
            "setRoot" => {
                out.push(opcode::SET_ROOT);
                id(&mut out, &args[0]);
            }
            "setKeyboardFocusDim" => {
                out.push(opcode::SET_KEYBOARD_FOCUS_DIM);
                out.push(serde_json::from_str::<bool>(args[0].get()).expect("a bool") as u8);
            }
            "setUniversalStyle" => {
                out.push(opcode::SET_UNIVERSAL_STYLE);
                let style = args[0].get();
                string(&mut out, if style == "null" { "" } else { style });
            }
            "setCustomProp" => {
                out.push(opcode::SET_CUSTOM_PROP);
                id(&mut out, &args[0]);
                string(&mut out, &arg_string(&args[1]));
                let value: serde_json::Value =
                    serde_json::from_str(args[2].get()).expect("a JSON value");
                match &value {
                    serde_json::Value::Null => out.push(value_tag::NULL),
                    serde_json::Value::Bool(false) => out.push(value_tag::FALSE),
                    serde_json::Value::Bool(true) => out.push(value_tag::TRUE),
                    serde_json::Value::String(text) => {
                        out.push(value_tag::STRING);
                        string(&mut out, text);
                    }
                    serde_json::Value::Number(number) => {
                        if let Some(unsigned) = number.as_u64() {
                            out.push(value_tag::UINT);
                            varint(&mut out, unsigned);
                        } else if let Some(negative) = number.as_i64() {
                            out.push(value_tag::NEGATIVE_INT);
                            varint(&mut out, negative.unsigned_abs());
                        } else {
                            out.push(value_tag::FLOAT);
                            out.extend_from_slice(
                                &number.as_f64().expect("a float").to_le_bytes(),
                            );
                        }
                    }
                    serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                        out.push(value_tag::JSON);
                        string(&mut out, args[2].get());
                    }
                }
            }
            other => panic!("test batch names an op the format has no opcode for: {other}"),
        }
    }
    out
}

/// `apply_batch_to_tree` for a batch stated as JSON tuples.
pub(crate) fn apply(tree: &mut RetainedTree, json: &str) -> BatchResult<Vec<f64>> {
    crate::renderer::apply_batch_to_tree(tree, &encode(json))
}
