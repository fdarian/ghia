//! Decoder for the binary mutation batch. The writer is `packages/native/js/wire.ts`;
//! the format is specified in `docs/reference.md` ("Wire format"), and both files
//! name the same opcodes and tags, so change them together.
//!
//! Decoding never panics and never repairs: input that is truncated, names an
//! opcode or tag this version does not know, or carries an id outside the safe
//! integer range is an error naming the op and the byte. A batch is atomic, so
//! the caller applies nothing when this returns `Err`.

use std::fmt;

use super::BatchOp;

pub const FORMAT_VERSION: u8 = 1;

/// Element ids are JS numbers, so one above 2^53 - 1 cannot have been sent exactly.
const MAX_ELEMENT_ID: u64 = 9_007_199_254_740_991;

pub mod opcode {
    pub const CREATE_ELEMENT: u8 = 1;
    pub const DESTROY_ELEMENT: u8 = 2;
    pub const DETACH_CHILD: u8 = 3;
    pub const APPEND_CHILD: u8 = 4;
    pub const INSERT_BEFORE: u8 = 5;
    pub const SET_STYLE: u8 = 6;
    pub const SET_TEXT: u8 = 7;
    pub const SET_EVENT_LISTENER: u8 = 8;
    pub const SET_ROOT: u8 = 9;
    pub const SET_KEYBOARD_FOCUS_DIM: u8 = 10;
    pub const SET_UNIVERSAL_STYLE: u8 = 11;
    pub const SET_CUSTOM_PROP: u8 = 12;
    pub const SET_ATTRIBUTE: u8 = 13;
}

/// The tag in front of a `setCustomProp` value.
pub mod value_tag {
    pub const NULL: u8 = 0;
    pub const FALSE: u8 = 1;
    pub const TRUE: u8 = 2;
    /// A varint, a non-negative integer.
    pub const UINT: u8 = 3;
    /// A varint magnitude, the value is its negation.
    pub const NEGATIVE_INT: u8 = 4;
    /// Eight bytes, little endian IEEE 754, finite.
    pub const FLOAT: u8 = 5;
    pub const STRING: u8 = 6;
    /// A string holding the JSON text of an object or array.
    pub const JSON: u8 = 7;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireErrorKind {
    /// The input ended inside what it was reading.
    Truncated,
    UnsupportedVersion(u8),
    UnknownOpcode(u8),
    UnknownValueTag(u8),
    /// A varint longer than ten bytes or above 2^64 - 1.
    VarintOverflow,
    InvalidId(u64),
    /// A boolean byte that is neither 0 nor 1.
    InvalidBool(u8),
    InvalidUtf8,
    /// A float tag carrying NaN or an infinity, which JSON cannot hold.
    NonFiniteFloat,
    InvalidJson(String),
    /// Bytes remain after the last op the header counted.
    TrailingBytes(usize),
}

impl fmt::Display for WireErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => f.write_str("input ends early"),
            Self::UnsupportedVersion(version) => write!(
                f,
                "format version {version}, this build reads version {FORMAT_VERSION}"
            ),
            Self::UnknownOpcode(code) => write!(f, "unknown operation {code}"),
            Self::UnknownValueTag(tag) => write!(f, "unknown value tag {tag}"),
            Self::VarintOverflow => f.write_str("varint does not fit in 64 bits"),
            Self::InvalidId(id) => write!(f, "Invalid element id: {id}"),
            Self::InvalidBool(byte) => write!(f, "boolean byte {byte} is not 0 or 1"),
            Self::InvalidUtf8 => f.write_str("string is not valid UTF-8"),
            Self::NonFiniteFloat => f.write_str("float is not finite"),
            Self::InvalidJson(message) => write!(f, "invalid JSON value: {message}"),
            Self::TrailingBytes(count) => {
                write!(f, "{count} bytes remain after the last op")
            }
        }
    }
}

/// A decode failure. `op` is the index of the op being read (`None` in the
/// header, or after the last op) and `offset` the byte the reader had reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    pub op: Option<usize>,
    pub offset: usize,
    pub kind: WireErrorKind,
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.op {
            Some(op) => write!(f, "Batch op {op}: {} (at byte {})", self.kind, self.offset),
            None => write!(
                f,
                "Failed to decode batch: {} (at byte {})",
                self.kind, self.offset
            ),
        }
    }
}

impl std::error::Error for WireError {}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

type Read<T> = std::result::Result<T, WireErrorKind>;

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    fn byte(&mut self) -> Read<u8> {
        let byte = *self
            .bytes
            .get(self.position)
            .ok_or(WireErrorKind::Truncated)?;
        self.position += 1;
        Ok(byte)
    }

    /// Unsigned LEB128. A writer may pad one with zero continuation bytes to
    /// the width it reserved, so a non-minimal encoding is accepted.
    fn varint(&mut self) -> Read<u64> {
        let start = self.position;
        let mut value: u64 = 0;
        for index in 0..10u32 {
            let byte = match self.byte() {
                Ok(byte) => byte,
                Err(error) => {
                    self.position = start;
                    return Err(error);
                }
            };
            let low = u64::from(byte & 0x7f);
            if index == 9 && low > 1 {
                return Err(WireErrorKind::VarintOverflow);
            }
            value |= low << (index * 7);
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(WireErrorKind::VarintOverflow)
    }

    fn id(&mut self) -> Read<u64> {
        let id = self.varint()?;
        if id > MAX_ELEMENT_ID {
            return Err(WireErrorKind::InvalidId(id));
        }
        Ok(id)
    }

    fn bool(&mut self) -> Read<bool> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(WireErrorKind::InvalidBool(other)),
        }
    }

    fn bytes(&mut self, length: u64) -> Read<&'a [u8]> {
        if length > self.remaining() as u64 {
            return Err(WireErrorKind::Truncated);
        }
        let end = self.position + length as usize;
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    /// A varint byte length, then that many bytes of UTF-8.
    fn str(&mut self) -> Read<&'a str> {
        let length = self.varint()?;
        let bytes = self.bytes(length)?;
        std::str::from_utf8(bytes).map_err(|_| WireErrorKind::InvalidUtf8)
    }

    fn custom_prop_value(&mut self) -> Read<serde_json::Value> {
        use serde_json::Value;
        match self.byte()? {
            value_tag::NULL => Ok(Value::Null),
            value_tag::FALSE => Ok(Value::Bool(false)),
            value_tag::TRUE => Ok(Value::Bool(true)),
            value_tag::UINT => Ok(Value::from(self.varint()?)),
            value_tag::NEGATIVE_INT => {
                let magnitude = self.varint()?;
                let negative = i64::try_from(magnitude)
                    .map(|magnitude| -magnitude)
                    .map_err(|_| WireErrorKind::VarintOverflow)?;
                Ok(Value::from(negative))
            }
            value_tag::FLOAT => {
                let mut raw = [0u8; 8];
                raw.copy_from_slice(self.bytes(8)?);
                serde_json::Number::from_f64(f64::from_le_bytes(raw))
                    .map(Value::Number)
                    .ok_or(WireErrorKind::NonFiniteFloat)
            }
            value_tag::STRING => Ok(Value::String(self.str()?.to_owned())),
            value_tag::JSON => {
                let length = self.varint()?;
                let text = self.bytes(length)?;
                serde_json::from_slice(text)
                    .map_err(|error| WireErrorKind::InvalidJson(error.to_string()))
            }
            other => Err(WireErrorKind::UnknownValueTag(other)),
        }
    }

    fn op(&mut self) -> Read<BatchOp<'a>> {
        Ok(match self.byte()? {
            opcode::CREATE_ELEMENT => BatchOp::CreateElement {
                id: self.id()?,
                element_type: self.str()?.to_owned(),
            },
            opcode::DESTROY_ELEMENT => BatchOp::DestroyElement { id: self.id()? },
            opcode::DETACH_CHILD => BatchOp::DetachChild { id: self.id()? },
            opcode::APPEND_CHILD => BatchOp::AppendChild {
                parent_id: self.id()?,
                child_id: self.id()?,
            },
            opcode::INSERT_BEFORE => BatchOp::InsertBefore {
                parent_id: self.id()?,
                child_id: self.id()?,
                before_id: self.id()?,
            },
            opcode::SET_STYLE => BatchOp::SetStyle {
                id: self.id()?,
                style: self.str()?,
            },
            opcode::SET_TEXT => BatchOp::SetText {
                id: self.id()?,
                content: self.str()?.to_owned(),
            },
            opcode::SET_EVENT_LISTENER => BatchOp::SetEventListener {
                id: self.id()?,
                event_type: self.str()?.to_owned(),
                has_handler: self.bool()?,
            },
            opcode::SET_ROOT => BatchOp::SetRoot { id: self.id()? },
            opcode::SET_KEYBOARD_FOCUS_DIM => BatchOp::SetKeyboardFocusDim {
                enabled: self.bool()?,
            },
            // A style is never the empty string, so an empty one is the `null` that clears the layer.
            opcode::SET_UNIVERSAL_STYLE => BatchOp::SetUniversalStyle {
                style: Some(self.str()?).filter(|style| !style.is_empty()),
            },
            opcode::SET_CUSTOM_PROP => BatchOp::SetCustomProp {
                id: self.id()?,
                key: self.str()?.to_owned(),
                value: self.custom_prop_value()?,
            },
            opcode::SET_ATTRIBUTE => BatchOp::SetAttribute {
                id: self.id()?,
                name: self.str()?,
                value: if self.bool()? { Some(self.str()?) } else { None },
            },
            other => return Err(WireErrorKind::UnknownOpcode(other)),
        })
    }
}

/// Decode a whole batch. Style payloads borrow from `bytes`; every other string
/// is copied once, into the op.
pub fn decode(bytes: &[u8]) -> Result<Vec<BatchOp<'_>>, WireError> {
    let mut reader = Reader { bytes, position: 0 };
    let header = |reader: &mut Reader<'_>| -> Read<u64> {
        let version = reader.byte()?;
        if version != FORMAT_VERSION {
            return Err(WireErrorKind::UnsupportedVersion(version));
        }
        reader.varint()
    };
    let count = header(&mut reader).map_err(|kind| WireError {
        op: None,
        offset: reader.position,
        kind,
    })?;

    // The count is untrusted: every op takes at least one byte, so no input
    // holds more ops than it has bytes left.
    let mut ops = Vec::with_capacity(count.min(reader.remaining() as u64) as usize);
    for index in 0..count {
        match reader.op() {
            Ok(op) => ops.push(op),
            Err(kind) => {
                return Err(WireError {
                    op: Some(index as usize),
                    offset: reader.position,
                    kind,
                })
            }
        }
    }
    if reader.remaining() != 0 {
        return Err(WireError {
            op: None,
            offset: reader.position,
            kind: WireErrorKind::TrailingBytes(reader.remaining()),
        });
    }
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn batch(count: u64, ops: &[u8]) -> Vec<u8> {
        let mut out = vec![FORMAT_VERSION];
        varint(&mut out, count);
        out.extend_from_slice(ops);
        out
    }

    /// One op of each kind, written by this file's own minimal writer.
    fn every_op() -> Vec<u8> {
        let mut ops = Vec::new();
        ops.push(opcode::CREATE_ELEMENT);
        varint(&mut ops, 1);
        string(&mut ops, "div");
        ops.push(opcode::DESTROY_ELEMENT);
        varint(&mut ops, 2);
        ops.push(opcode::DETACH_CHILD);
        varint(&mut ops, 3);
        ops.push(opcode::APPEND_CHILD);
        varint(&mut ops, 1);
        varint(&mut ops, 4_294_967_296);
        ops.push(opcode::INSERT_BEFORE);
        varint(&mut ops, 1);
        varint(&mut ops, 5);
        varint(&mut ops, MAX_ELEMENT_ID);
        ops.push(opcode::SET_STYLE);
        varint(&mut ops, 1);
        string(&mut ops, r#"{"width":10}"#);
        ops.push(opcode::SET_TEXT);
        varint(&mut ops, 1);
        string(&mut ops, "héllo 😀");
        ops.push(opcode::SET_EVENT_LISTENER);
        varint(&mut ops, 1);
        string(&mut ops, "pointerdown");
        ops.push(1);
        ops.push(opcode::SET_ROOT);
        varint(&mut ops, 1);
        ops.push(opcode::SET_KEYBOARD_FOCUS_DIM);
        ops.push(0);
        ops.push(opcode::SET_UNIVERSAL_STYLE);
        string(&mut ops, "");
        ops.push(opcode::SET_CUSTOM_PROP);
        varint(&mut ops, 1);
        string(&mut ops, "testId");
        ops.push(value_tag::STRING);
        string(&mut ops, "x");
        ops.push(opcode::SET_ATTRIBUTE);
        varint(&mut ops, 1);
        string(&mut ops, "data-x");
        ops.push(1);
        string(&mut ops, "v");
        batch(13, &ops)
    }

    #[test]
    fn decodes_every_op_kind() {
        let bytes = every_op();
        let ops = decode(&bytes).unwrap();
        assert_eq!(ops.len(), 13);
        assert!(
            matches!(&ops[0], BatchOp::CreateElement { id: 1, element_type } if element_type == "div")
        );
        assert!(matches!(
            &ops[3],
            BatchOp::AppendChild {
                parent_id: 1,
                child_id: 4_294_967_296
            }
        ));
        assert!(matches!(
            &ops[4],
            BatchOp::InsertBefore {
                before_id: MAX_ELEMENT_ID,
                ..
            }
        ));
        assert!(matches!(
            &ops[5],
            BatchOp::SetStyle {
                id: 1,
                style: r#"{"width":10}"#
            }
        ));
        assert!(matches!(&ops[6], BatchOp::SetText { content, .. } if content == "héllo 😀"));
        assert!(matches!(
            &ops[7],
            BatchOp::SetEventListener {
                has_handler: true,
                ..
            }
        ));
        assert!(matches!(
            &ops[9],
            BatchOp::SetKeyboardFocusDim { enabled: false }
        ));
        assert!(matches!(
            &ops[10],
            BatchOp::SetUniversalStyle { style: None }
        ));
        assert!(matches!(&ops[11], BatchOp::SetCustomProp { value, .. } if value == "x"));
        assert!(matches!(
            &ops[12],
            BatchOp::SetAttribute {
                id: 1,
                name: "data-x",
                value: Some("v")
            }
        ));
    }

    #[test]
    fn style_borrows_the_input_bytes() {
        let bytes = every_op();
        let ops = decode(&bytes).unwrap();
        let BatchOp::SetStyle { style, .. } = &ops[5] else {
            panic!("expected setStyle");
        };
        let range = bytes.as_ptr_range();
        assert!(range.contains(&style.as_ptr()));
    }

    /// A one-op batch: `setCustomProp(7, "k", <tag, payload>)`.
    fn custom_prop(tag: u8, payload: &[u8]) -> Vec<u8> {
        let mut ops = vec![opcode::SET_CUSTOM_PROP];
        varint(&mut ops, 7);
        string(&mut ops, "k");
        ops.push(tag);
        ops.extend_from_slice(payload);
        batch(1, &ops)
    }

    fn custom_prop_value(tag: u8, payload: &[u8]) -> Result<serde_json::Value, WireError> {
        let bytes = custom_prop(tag, payload);
        decode(&bytes).map(|mut ops| match ops.remove(0) {
            BatchOp::SetCustomProp { value, .. } => value,
            other => panic!("unexpected {other:?}"),
        })
    }

    fn varint_bytes(value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(&mut out, value);
        out
    }

    #[test]
    fn custom_prop_values() {
        use serde_json::Value;
        assert_eq!(
            custom_prop_value(value_tag::NULL, &[]).unwrap(),
            Value::Null
        );
        assert_eq!(
            custom_prop_value(value_tag::FALSE, &[]).unwrap(),
            Value::Bool(false)
        );
        assert_eq!(
            custom_prop_value(value_tag::TRUE, &[]).unwrap(),
            Value::Bool(true)
        );
        let uint =
            custom_prop_value(value_tag::UINT, &varint_bytes(9_007_199_254_740_991)).unwrap();
        assert_eq!(uint.as_u64(), Some(9_007_199_254_740_991));
        let negative = custom_prop_value(value_tag::NEGATIVE_INT, &varint_bytes(3)).unwrap();
        assert_eq!(negative.as_i64(), Some(-3));
        let float = custom_prop_value(value_tag::FLOAT, &1.5f64.to_le_bytes()).unwrap();
        assert_eq!(float.as_f64(), Some(1.5));
        let mut text = Vec::new();
        string(&mut text, r#"{"b":1,"a":[true,null]}"#);
        let json = custom_prop_value(value_tag::JSON, &text).unwrap();
        // Key order survives, as it does on the JSON path (`preserve_order`).
        assert_eq!(json.to_string(), r#"{"b":1,"a":[true,null]}"#);
    }

    fn kind(bytes: &[u8]) -> WireErrorKind {
        decode(bytes).unwrap_err().kind
    }

    #[test]
    fn empty_batch() {
        assert!(decode(&batch(0, &[])).unwrap().is_empty());
    }

    #[test]
    fn empty_input_and_wrong_version_are_errors() {
        assert_eq!(kind(&[]), WireErrorKind::Truncated);
        assert_eq!(kind(&[FORMAT_VERSION]), WireErrorKind::Truncated);
        assert_eq!(kind(&[0, 0]), WireErrorKind::UnsupportedVersion(0));
        assert_eq!(
            kind(&[FORMAT_VERSION + 1, 0]),
            WireErrorKind::UnsupportedVersion(FORMAT_VERSION + 1)
        );
    }

    #[test]
    fn every_proper_prefix_of_a_valid_batch_is_an_error() {
        let bytes = every_op();
        for end in 0..bytes.len() {
            assert!(
                decode(&bytes[..end]).is_err(),
                "prefix of {end} bytes decoded"
            );
        }
    }

    #[test]
    fn truncation_names_the_op() {
        let bytes = every_op();
        let error = decode(&bytes[..bytes.len() - 1]).unwrap_err();
        assert_eq!(error.op, Some(12));
        assert_eq!(error.kind, WireErrorKind::Truncated);
        assert!(error.to_string().starts_with("Batch op 12:"), "{error}");
    }

    #[test]
    fn unknown_opcode_is_an_error_not_a_skip() {
        for code in [0u8, 14, 255] {
            assert_eq!(kind(&batch(1, &[code])), WireErrorKind::UnknownOpcode(code));
        }
    }

    #[test]
    fn trailing_bytes_are_an_error() {
        let mut bytes = every_op();
        bytes.push(0);
        assert_eq!(kind(&bytes), WireErrorKind::TrailingBytes(1));
    }

    #[test]
    fn a_count_above_the_ops_present_is_an_error_without_a_huge_allocation() {
        let bytes = batch(u64::MAX >> 1, &[opcode::SET_ROOT, 1]);
        let error = decode(&bytes).unwrap_err();
        assert_eq!(error.op, Some(1));
        assert_eq!(error.kind, WireErrorKind::Truncated);
    }

    #[test]
    fn a_count_below_the_ops_present_leaves_trailing_bytes() {
        let bytes = batch(1, &[opcode::SET_ROOT, 1, opcode::SET_ROOT, 2]);
        assert_eq!(kind(&bytes), WireErrorKind::TrailingBytes(2));
    }

    #[test]
    fn ids_above_the_safe_integer_range_are_rejected() {
        let mut ops = vec![opcode::DESTROY_ELEMENT];
        varint(&mut ops, MAX_ELEMENT_ID + 1);
        assert_eq!(
            kind(&batch(1, &ops)),
            WireErrorKind::InvalidId(MAX_ELEMENT_ID + 1)
        );
        let mut ops = vec![opcode::DESTROY_ELEMENT];
        varint(&mut ops, u64::MAX);
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::InvalidId(u64::MAX));
    }

    /// Every opcode that carries ids, with `ids` ids and the bytes that follow the last one.
    fn id_ops() -> Vec<(u8, usize, Vec<u8>)> {
        let mut text = Vec::new();
        string(&mut text, "x");
        let mut text_then_bool = text.clone();
        text_then_bool.push(1);
        vec![
            (opcode::CREATE_ELEMENT, 1, text.clone()),
            (opcode::DESTROY_ELEMENT, 1, vec![]),
            (opcode::DETACH_CHILD, 1, vec![]),
            (opcode::APPEND_CHILD, 2, vec![]),
            (opcode::INSERT_BEFORE, 3, vec![]),
            (opcode::SET_STYLE, 1, {
                let mut style = Vec::new();
                string(&mut style, "{}");
                style
            }),
            (opcode::SET_TEXT, 1, text.clone()),
            (opcode::SET_EVENT_LISTENER, 1, text_then_bool),
            (opcode::SET_ROOT, 1, vec![]),
            (opcode::SET_CUSTOM_PROP, 1, {
                let mut prop = Vec::new();
                string(&mut prop, "key");
                prop.push(value_tag::NULL);
                prop
            }),
            (opcode::SET_ATTRIBUTE, 1, {
                let mut attribute = Vec::new();
                string(&mut attribute, "name");
                attribute.push(1);
                string(&mut attribute, "value");
                attribute
            }),
        ]
    }

    #[test]
    fn an_invalid_id_is_rejected_at_every_id_position_of_every_opcode() {
        // Ids always lead an op, so the bad id goes in each leading position in turn; the rest of the op is valid.
        for (opcode, ids, rest) in id_ops() {
            for bad_position in 0..ids {
                let mut ops = vec![opcode];
                for position in 0..ids {
                    varint(
                        &mut ops,
                        if position == bad_position {
                            MAX_ELEMENT_ID + 1
                        } else {
                            1
                        },
                    );
                }
                ops.extend_from_slice(&rest);
                let error = decode(&batch(1, &ops)).unwrap_err();
                assert_eq!(
                    error.kind,
                    WireErrorKind::InvalidId(MAX_ELEMENT_ID + 1),
                    "opcode {opcode}, id {bad_position}"
                );
                assert_eq!(error.op, Some(0), "opcode {opcode}, id {bad_position}");

                // The same op with every id valid decodes, so the bad id is the only fault.
                let mut valid = vec![opcode];
                for _ in 0..ids {
                    varint(&mut valid, MAX_ELEMENT_ID);
                }
                valid.extend_from_slice(&rest);
                assert_eq!(decode(&batch(1, &valid)).unwrap().len(), 1, "opcode {opcode}");
            }
        }
    }

    #[test]
    fn varints_may_be_padded_but_not_overflow() {
        // 5 as a three byte varint.
        let padded = batch(1, &[opcode::SET_ROOT, 0x85, 0x80, 0x00]);
        assert!(matches!(
            decode(&padded).unwrap()[0],
            BatchOp::SetRoot { id: 5 }
        ));
        // Ten bytes whose last holds a bit above 2^64.
        let mut ops = vec![opcode::SET_ROOT];
        ops.extend_from_slice(&[0xff; 9]);
        ops.push(0x02);
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::VarintOverflow);
        // Eleven bytes.
        let mut ops = vec![opcode::SET_ROOT];
        ops.extend_from_slice(&[0x80; 10]);
        ops.push(0x00);
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::VarintOverflow);
        // A varint cut off mid-way.
        assert_eq!(
            kind(&batch(1, &[opcode::SET_ROOT, 0x80])),
            WireErrorKind::Truncated
        );
    }

    #[test]
    fn a_string_longer_than_the_input_is_truncated() {
        let mut ops = vec![opcode::SET_TEXT];
        varint(&mut ops, 1);
        varint(&mut ops, 1 << 40);
        ops.extend_from_slice(b"abc");
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::Truncated);
    }

    #[test]
    fn invalid_utf8_is_an_error() {
        let mut ops = vec![opcode::SET_TEXT];
        varint(&mut ops, 1);
        varint(&mut ops, 2);
        ops.extend_from_slice(&[0xc3, 0x28]);
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::InvalidUtf8);
        // A lone surrogate encoded as UTF-8 (CESU style) is invalid too.
        let mut ops = vec![opcode::SET_TEXT];
        varint(&mut ops, 1);
        varint(&mut ops, 3);
        ops.extend_from_slice(&[0xed, 0xa0, 0x80]);
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::InvalidUtf8);
    }

    #[test]
    fn booleans_are_zero_or_one() {
        assert_eq!(
            kind(&batch(1, &[opcode::SET_KEYBOARD_FOCUS_DIM, 2])),
            WireErrorKind::InvalidBool(2)
        );
    }

    #[test]
    fn has_handler_is_zero_or_one() {
        let listener = |has_handler: u8| {
            let mut ops = vec![opcode::SET_EVENT_LISTENER];
            varint(&mut ops, 1);
            string(&mut ops, "click");
            ops.push(has_handler);
            batch(1, &ops)
        };
        assert!(matches!(
            decode(&listener(0)).unwrap()[0],
            BatchOp::SetEventListener {
                has_handler: false,
                ..
            }
        ));
        assert!(matches!(
            decode(&listener(1)).unwrap()[0],
            BatchOp::SetEventListener {
                has_handler: true,
                ..
            }
        ));
        for byte in [2, 3, 0x80, 0xff] {
            let error = decode(&listener(byte)).unwrap_err();
            assert_eq!(error.kind, WireErrorKind::InvalidBool(byte));
            assert_eq!(error.op, Some(0));
        }
        // A bool byte that is missing is truncation, not false.
        let mut ops = vec![opcode::SET_EVENT_LISTENER];
        varint(&mut ops, 1);
        string(&mut ops, "click");
        assert_eq!(kind(&batch(1, &ops)), WireErrorKind::Truncated);
    }

    #[test]
    fn set_attribute_carries_a_value_or_removes() {
        let attribute = |present: &[u8]| {
            let mut ops = vec![opcode::SET_ATTRIBUTE];
            varint(&mut ops, 7);
            string(&mut ops, "class");
            ops.extend_from_slice(present);
            batch(1, &ops)
        };
        let mut present = vec![1];
        string(&mut present, "a b");
        assert!(matches!(
            decode(&attribute(&present)).unwrap()[0],
            BatchOp::SetAttribute {
                id: 7,
                name: "class",
                value: Some("a b")
            }
        ));
        // A present empty value is not a removal.
        let mut empty = vec![1];
        string(&mut empty, "");
        assert!(matches!(
            decode(&attribute(&empty)).unwrap()[0],
            BatchOp::SetAttribute {
                value: Some(""),
                ..
            }
        ));
        assert!(matches!(
            decode(&attribute(&[0])).unwrap()[0],
            BatchOp::SetAttribute { value: None, .. }
        ));
        assert_eq!(kind(&attribute(&[2])), WireErrorKind::InvalidBool(2));
        assert_eq!(kind(&attribute(&[])), WireErrorKind::Truncated);
    }

    #[test]
    fn bad_custom_prop_values_are_errors() {
        assert_eq!(
            custom_prop_value(8, &[]).unwrap_err().kind,
            WireErrorKind::UnknownValueTag(8)
        );
        assert_eq!(
            custom_prop_value(value_tag::FLOAT, &f64::NAN.to_le_bytes())
                .unwrap_err()
                .kind,
            WireErrorKind::NonFiniteFloat
        );
        assert_eq!(
            custom_prop_value(value_tag::FLOAT, &f64::INFINITY.to_le_bytes())
                .unwrap_err()
                .kind,
            WireErrorKind::NonFiniteFloat
        );
        assert_eq!(
            custom_prop_value(value_tag::FLOAT, &[0; 7])
                .unwrap_err()
                .kind,
            WireErrorKind::Truncated
        );
        assert_eq!(
            custom_prop_value(value_tag::NEGATIVE_INT, &varint_bytes(u64::MAX))
                .unwrap_err()
                .kind,
            WireErrorKind::VarintOverflow
        );
        let mut text = Vec::new();
        string(&mut text, "{not json");
        assert!(matches!(
            custom_prop_value(value_tag::JSON, &text).unwrap_err().kind,
            WireErrorKind::InvalidJson(_)
        ));
    }
}
