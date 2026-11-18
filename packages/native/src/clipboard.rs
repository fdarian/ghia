//! The typed clipboard: `DataTransfer`-shaped entries, how they lay out on a pasteboard, and the
//! test window's in-memory copy of it.
//!
//! GPUI's `ClipboardItem` writes one type, so the pasteboard is Ghia's own
//! (`platform/pasteboard_macos.rs`). A pasteboard has a few native types for the web's common MIME
//! types and no place for the rest, so every other type goes into one `org.chromium.web-custom-data`
//! entry in the pickle Chromium writes and reads there. A page in Chrome and a page here then
//! exchange `application/x-lexical-editor` and its like through the system clipboard.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use napi_derive::napi;

/// One entry of a clipboard: a MIME type and its `DOMString` data, as `DataTransfer.getData` has them.
#[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(object))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardData {
    #[cfg_attr(not(all(target_arch = "wasm32", target_os = "unknown")), napi(js_name = "type"))]
    pub mime_type: String,
    pub data: String,
}

impl ClipboardData {
    pub fn new(mime_type: &str, data: &str) -> Self {
        Self {
            mime_type: mime_type.to_string(),
            data: data.to_string(),
        }
    }
}

pub(crate) const TEXT_PLAIN: &str = "text/plain";
pub(crate) const TEXT_HTML: &str = "text/html";
pub(crate) const TEXT_URI_LIST: &str = "text/uri-list";

/// `NSPasteboardTypeString`
pub(crate) const UTI_PLAIN_TEXT: &str = "public.utf8-plain-text";
/// `NSPasteboardTypeHTML`
pub(crate) const UTI_HTML: &str = "public.html";
/// `NSPasteboardTypeURL`: one URL, where `text/uri-list` is a list.
pub(crate) const UTI_URL: &str = "public.url";
/// Chromium's `kUTTypeChromiumWebCustomData` (`ui/base/clipboard/clipboard_constants`).
pub(crate) const UTI_CUSTOM_DATA: &str = "org.chromium.web-custom-data";

fn is_mapped(mime_type: &str) -> bool {
    [TEXT_PLAIN, TEXT_HTML, TEXT_URI_LIST]
        .iter()
        .any(|mapped| mime_type.eq_ignore_ascii_case(mapped))
}

/// What a write puts on a pasteboard.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PasteboardLayout {
    /// Native types, in the order they are declared.
    pub typed: Vec<(&'static str, String)>,
    /// The pairs of the custom-data pickle, empty when there is no such entry.
    pub custom: Vec<(String, String)>,
}

/// Splits `entries` across the native types and the custom-data pairs. The last entry of a type
/// wins, as `setData` replaces.
///
/// `text/uri-list` goes to both: `public.url` (its first URL, for native apps) and the custom
/// data, which is where Chrome writes and reads it, and which keeps the whole list.
pub(crate) fn layout(entries: &[ClipboardData]) -> PasteboardLayout {
    let mut plain = None;
    let mut html = None;
    let mut uri_list = None;
    let mut custom: Vec<(String, String)> = Vec::new();
    for entry in entries {
        let mime_type = entry.mime_type.to_ascii_lowercase();
        match mime_type.as_str() {
            TEXT_PLAIN => plain = Some(entry.data.clone()),
            TEXT_HTML => html = Some(entry.data.clone()),
            TEXT_URI_LIST => uri_list = Some(entry.data.clone()),
            _ => match custom.iter_mut().find(|(existing, _)| *existing == mime_type) {
                Some(pair) => pair.1 = entry.data.clone(),
                None => custom.push((mime_type, entry.data.clone())),
            },
        }
    }
    let mut typed = Vec::new();
    if let Some(plain) = plain {
        typed.push((UTI_PLAIN_TEXT, plain));
    }
    if let Some(html) = html {
        typed.push((UTI_HTML, html));
    }
    if let Some(list) = uri_list {
        if let Some(first) = first_url(&list) {
            typed.push((UTI_URL, first.to_string()));
        }
        custom.push((TEXT_URI_LIST.to_string(), list));
    }
    PasteboardLayout { typed, custom }
}

/// The first line of a `text/uri-list` that is not blank or a `#` comment.
fn first_url(list: &str) -> Option<&str> {
    list.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
}

/// What a pasteboard holds, as `DataTransfer` entries: `text/plain`, `text/html`, `text/uri-list`,
/// then each custom-data pair. A `text/uri-list` in the custom data is the Chrome-written one and
/// replaces `public.url`'s single URL. A custom pair that names one of the three is dropped.
pub(crate) fn assemble(
    typed: Vec<(&'static str, String)>,
    custom: Vec<(String, String)>,
) -> Vec<ClipboardData> {
    let typed_value = |uti: &str| {
        typed
            .iter()
            .find(|(name, _)| *name == uti)
            .map(|(_, value)| value.clone())
    };
    let custom_uri_list = custom
        .iter()
        .find(|(mime_type, _)| mime_type.eq_ignore_ascii_case(TEXT_URI_LIST))
        .map(|(_, data)| data.clone());

    let mut entries = Vec::new();
    if let Some(plain) = typed_value(UTI_PLAIN_TEXT) {
        entries.push(ClipboardData { mime_type: TEXT_PLAIN.into(), data: plain });
    }
    if let Some(html) = typed_value(UTI_HTML) {
        entries.push(ClipboardData { mime_type: TEXT_HTML.into(), data: html });
    }
    if let Some(list) = custom_uri_list.or_else(|| typed_value(UTI_URL)) {
        entries.push(ClipboardData { mime_type: TEXT_URI_LIST.into(), data: list });
    }
    for (mime_type, data) in custom {
        if !is_mapped(&mime_type) {
            entries.push(ClipboardData { mime_type, data });
        }
    }
    entries
}

// base::Pickle, as `ui::WriteCustomDataToPickle` (ui/base/clipboard/custom_data_helper.cc) uses
// it: a u32 payload size, then the payload. The payload is a u32 pair count and per pair two
// strings, each an i32 length in UTF-16 code units and the units as little-endian u16, padded with
// zeros to a multiple of 4. The padding is part of the payload size.

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum PickleError {
    #[error("the custom data pickle is shorter than its header")]
    NoHeader,
    #[error("the custom data pickle's payload size is larger than the pickle")]
    PayloadTooLarge,
    #[error("the custom data pickle ends inside a value")]
    Truncated,
    #[error("the custom data pickle has a string of negative length")]
    NegativeLength,
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_string16(out: &mut Vec<u8>, text: &str) {
    let units: Vec<u16> = text.encode_utf16().collect();
    put_u32(out, units.len() as u32);
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    while out.len() % 4 != 0 {
        out.push(0);
    }
}

pub(crate) fn encode_custom_data(pairs: &[(String, String)]) -> Vec<u8> {
    let mut payload = Vec::new();
    put_u32(&mut payload, pairs.len() as u32);
    for (mime_type, data) in pairs {
        put_string16(&mut payload, mime_type);
        put_string16(&mut payload, data);
    }
    let mut pickle = Vec::with_capacity(4 + payload.len());
    put_u32(&mut pickle, payload.len() as u32);
    pickle.extend_from_slice(&payload);
    pickle
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
    /// Where the payload starts, which alignment is counted from.
    origin: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8], PickleError> {
        let end = self.position.checked_add(count).ok_or(PickleError::Truncated)?;
        let slice = self.bytes.get(self.position..end).ok_or(PickleError::Truncated)?;
        self.position = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<u32, PickleError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn string16(&mut self) -> Result<String, PickleError> {
        let length = self.u32()? as i32;
        let length = usize::try_from(length).map_err(|_| PickleError::NegativeLength)?;
        let bytes = self.take(length.checked_mul(2).ok_or(PickleError::Truncated)?)?;
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        // Chrome reads the padding as part of the value; one that a writer cut short of the end
        // is not an error here.
        let padding = (4 - (self.position - self.origin) % 4) % 4;
        self.position = (self.position + padding).min(self.bytes.len());
        // A lone surrogate cannot be a `String`; the web's strings can hold one.
        Ok(String::from_utf16_lossy(&units))
    }
}

/// The pairs of a custom-data pickle, in order. As Chrome does, the header size is whatever the
/// payload size leaves of the buffer, so a pickle with a larger header still reads.
pub(crate) fn decode_custom_data(bytes: &[u8]) -> Result<Vec<(String, String)>, PickleError> {
    let payload_size = match bytes.get(..4) {
        Some(header) => u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize,
        None => return Err(PickleError::NoHeader),
    };
    let header_size = bytes
        .len()
        .checked_sub(payload_size)
        .ok_or(PickleError::PayloadTooLarge)?;
    if header_size < 4 || header_size % 4 != 0 {
        return Err(PickleError::PayloadTooLarge);
    }
    let mut reader = Reader { bytes, position: header_size, origin: header_size };
    let count = reader.u32()?;
    let mut pairs = Vec::new();
    for _ in 0..count {
        let mime_type = reader.string16()?;
        let data = reader.string16()?;
        pairs.push((mime_type, data));
    }
    Ok(pairs)
}

#[cfg(any(test, all(feature = "test-support", any(target_os = "macos", target_os = "windows"))))]
/// The test window's clipboard. `text` is what the window's GPUI clipboard held when `entries`
/// were written: a `<input>` that copies or cuts writes the GPUI clipboard directly, and then
/// `entries` is no longer what the clipboard holds.
#[derive(Default)]
pub(crate) struct TypedClipboard {
    entries: Vec<ClipboardData>,
    text: Option<String>,
}

#[cfg(any(test, all(feature = "test-support", any(target_os = "macos", target_os = "windows"))))]
impl gpui::Global for TypedClipboard {}

#[cfg(any(test, all(feature = "test-support", any(target_os = "macos", target_os = "windows"))))]
impl TypedClipboard {
    pub(crate) fn new(entries: Vec<ClipboardData>) -> Self {
        let text = text_of(&entries);
        Self { entries, text }
    }

    /// The text a write leaves on the GPUI clipboard.
    pub(crate) fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    /// `gpui_text` is the text the GPUI clipboard holds now.
    pub(crate) fn read(&self, gpui_text: Option<String>) -> Vec<ClipboardData> {
        if gpui_text == self.text {
            return self.entries.clone();
        }
        match gpui_text {
            Some(text) => vec![ClipboardData { mime_type: TEXT_PLAIN.into(), data: text }],
            None => Vec::new(),
        }
    }
}

#[cfg(any(test, all(feature = "test-support", any(target_os = "macos", target_os = "windows"))))]
fn text_of(entries: &[ClipboardData]) -> Option<String> {
    entries
        .iter()
        .rev()
        .find(|entry| entry.mime_type.eq_ignore_ascii_case(TEXT_PLAIN))
        .map(|entry| entry.data.clone())
}

/// The live round trip of `tests/clipboard.test.ts`, on pasteboards of their own: a test never
/// writes the system's clipboard. Only a pasteboard `createTestPasteboard` made can be used.
#[cfg(all(target_os = "macos", feature = "test-support"))]
mod test_pasteboards {
    use std::{cell::RefCell, collections::HashMap};

    use napi::{Error, Result};
    use napi_derive::napi;

    use super::ClipboardData;
    use crate::platform::pasteboard_macos::{self as pasteboard, Pasteboard};

    thread_local! {
        static PASTEBOARDS: RefCell<HashMap<String, Pasteboard>> = RefCell::new(HashMap::new());
    }

    fn with_pasteboard<R>(name: &str, use_it: impl FnOnce(&Pasteboard) -> R) -> Result<R> {
        PASTEBOARDS.with(|boards| {
            let boards = boards.borrow();
            let board = boards
                .get(name)
                .ok_or_else(|| Error::from_reason(format!("{name} is not a test pasteboard")))?;
            Ok(use_it(board))
        })
    }

    /// The name of a pasteboard nothing else uses.
    #[napi]
    pub fn create_test_pasteboard() -> String {
        let (board, name) = pasteboard::unique();
        PASTEBOARDS.with(|boards| boards.borrow_mut().insert(name.clone(), board));
        name
    }

    /// `writeClipboard` on the pasteboard `createTestPasteboard` made under `name`.
    #[napi]
    pub fn write_clipboard_to(name: String, items: Vec<ClipboardData>) -> Result<()> {
        with_pasteboard(&name, |board| pasteboard::write(board, &items))?
            .map_err(Error::from_reason)
    }

    /// `readClipboard` of the pasteboard `createTestPasteboard` made under `name`.
    #[napi]
    pub fn read_clipboard_from(name: String) -> Result<Vec<ClipboardData>> {
        with_pasteboard(&name, pasteboard::read)
    }

    /// Frees the pasteboard `createTestPasteboard` made under `name`.
    #[napi]
    pub fn release_test_pasteboard(name: String) -> Result<()> {
        let board = PASTEBOARDS
            .with(|boards| boards.borrow_mut().remove(&name))
            .ok_or_else(|| Error::from_reason(format!("{name} is not a test pasteboard")))?;
        pasteboard::release(&board);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(mime_type: &str, data: &str) -> (String, String) {
        (mime_type.to_string(), data.to_string())
    }

    #[test]
    fn pickle_round_trips_with_astral_and_empty_values() {
        let pairs = vec![
            pair("application/x-lexical-editor", r#"{"namespace":"x","nodes":[]}"#),
            pair("text/x-empty", ""),
            pair("text/x-emoji", "a\u{1F30D}é"),
            pair("odd", "abc"),
        ];
        assert_eq!(decode_custom_data(&encode_custom_data(&pairs)), Ok(pairs));
    }

    #[test]
    fn pickle_matches_chromiums_bytes() {
        // WriteCustomDataToPickle of {"a": "bc"}: payload = count 1, "a" (len 1 + 2 bytes + 2
        // padding), "bc" (len 2 + 4 bytes) = 4 + 8 + 8 = 20; header = payload size.
        let expected: Vec<u8> = vec![
            20, 0, 0, 0, //
            1, 0, 0, 0, //
            1, 0, 0, 0, b'a', 0, 0, 0, //
            2, 0, 0, 0, b'b', 0, b'c', 0,
        ];
        assert_eq!(encode_custom_data(&[pair("a", "bc")]), expected);
        assert_eq!(decode_custom_data(&expected), Ok(vec![pair("a", "bc")]));
    }

    #[test]
    fn pickle_reads_a_larger_header() {
        // Chrome takes the header to be what the payload size leaves of the buffer.
        let encoded = encode_custom_data(&[pair("a", "b")]);
        let mut bytes = encoded[..4].to_vec();
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&encoded[4..]);
        assert_eq!(decode_custom_data(&bytes), Ok(vec![pair("a", "b")]));
    }

    #[test]
    fn pickle_reads_a_writer_that_left_out_the_last_padding() {
        let mut bytes = encode_custom_data(&[pair("a", "b")]);
        bytes.truncate(bytes.len() - 2);
        bytes[0] -= 2;
        assert_eq!(decode_custom_data(&bytes), Ok(vec![pair("a", "b")]));
    }

    #[test]
    fn corrupt_pickles_are_errors() {
        assert_eq!(decode_custom_data(&[]), Err(PickleError::NoHeader));
        assert_eq!(decode_custom_data(&[9, 0, 0, 0, 1]), Err(PickleError::PayloadTooLarge));
        // A string that claims more units than the pickle has.
        let mut bytes = encode_custom_data(&[pair("a", "b")]);
        bytes[8] = 200;
        assert_eq!(decode_custom_data(&bytes), Err(PickleError::Truncated));
        // A negative length.
        let mut bytes = encode_custom_data(&[pair("a", "b")]);
        bytes[11] = 0xff;
        assert_eq!(decode_custom_data(&bytes), Err(PickleError::NegativeLength));
    }

    #[test]
    fn lone_surrogates_decode_lossily() {
        let mut bytes = Vec::new();
        let mut payload = Vec::new();
        put_u32(&mut payload, 1);
        put_string16(&mut payload, "t");
        put_u32(&mut payload, 1);
        payload.extend_from_slice(&0xD800u16.to_le_bytes());
        payload.extend_from_slice(&[0, 0]);
        put_u32(&mut bytes, payload.len() as u32);
        bytes.extend_from_slice(&payload);
        assert_eq!(decode_custom_data(&bytes), Ok(vec![pair("t", "\u{FFFD}")]));
    }

    #[test]
    fn layout_maps_the_web_types_and_collects_the_rest() {
        let entries = vec![
            ClipboardData::new("text/plain", "hello"),
            ClipboardData::new("TEXT/HTML", "<b>hello</b>"),
            ClipboardData::new("application/x-lexical-editor", "{}"),
            ClipboardData::new("text/uri-list", "# c\n\nhttps://a.test/\nhttps://b.test/"),
            ClipboardData::new("application/x-lexical-editor", "{1}"),
        ];
        let layout = layout(&entries);
        assert_eq!(
            layout.typed,
            vec![
                (UTI_PLAIN_TEXT, "hello".to_string()),
                (UTI_HTML, "<b>hello</b>".to_string()),
                (UTI_URL, "https://a.test/".to_string()),
            ]
        );
        assert_eq!(
            layout.custom,
            vec![
                pair("application/x-lexical-editor", "{1}"),
                pair("text/uri-list", "# c\n\nhttps://a.test/\nhttps://b.test/"),
            ]
        );
    }

    #[test]
    fn a_uri_list_without_a_url_has_no_native_type() {
        let layout = layout(&[ClipboardData::new("text/uri-list", "# only a comment")]);
        assert!(layout.typed.is_empty());
        assert_eq!(layout.custom.len(), 1);
    }

    #[test]
    fn assemble_prefers_the_custom_uri_list_and_orders_the_types() {
        let entries = assemble(
            vec![
                (UTI_URL, "https://a.test/".to_string()),
                (UTI_HTML, "<i>x</i>".to_string()),
                (UTI_PLAIN_TEXT, "x".to_string()),
            ],
            vec![
                pair("application/x-lexical-editor", "{}"),
                pair("text/plain", "ignored"),
                pair("text/uri-list", "https://a.test/\nhttps://b.test/"),
            ],
        );
        assert_eq!(
            entries,
            vec![
                ClipboardData::new("text/plain", "x"),
                ClipboardData::new("text/html", "<i>x</i>"),
                ClipboardData::new("text/uri-list", "https://a.test/\nhttps://b.test/"),
                ClipboardData::new("application/x-lexical-editor", "{}"),
            ]
        );
    }

    #[test]
    fn assemble_of_a_foreign_url_alone_is_a_uri_list() {
        let entries = assemble(vec![(UTI_URL, "https://a.test/".to_string())], Vec::new());
        assert_eq!(entries, vec![ClipboardData::new("text/uri-list", "https://a.test/")]);
    }

    #[test]
    fn typed_clipboard_follows_a_write_the_gpui_clipboard_made() {
        let store = TypedClipboard::new(vec![
            ClipboardData::new("text/html", "<b>a</b>"),
            ClipboardData::new("text/plain", "a"),
        ]);
        assert_eq!(store.text(), Some("a"));
        assert_eq!(store.read(Some("a".into())).len(), 2);
        assert_eq!(store.read(Some("b".into())), vec![ClipboardData::new("text/plain", "b")]);
        assert_eq!(store.read(None), Vec::new());

        let no_text = TypedClipboard::new(vec![ClipboardData::new("application/x-a", "1")]);
        assert_eq!(no_text.text(), None);
        assert_eq!(no_text.read(None).len(), 1);
    }
}
