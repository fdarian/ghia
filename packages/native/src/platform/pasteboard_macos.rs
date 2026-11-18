//! A typed read and write of an `NSPasteboard`, which GPUI's `ClipboardItem` cannot do: it writes
//! one type. How the web's types lay out on the pasteboard is in `crate::clipboard`.
//!
//! Nothing here needs the GPUI app, so it is safe inside a handler that holds it.
use std::ffi::{c_void, CStr};

use objc2::{
    class, msg_send,
    rc::{autoreleasepool, Allocated, Retained},
    runtime::AnyObject,
};

use crate::clipboard::{
    assemble, decode_custom_data, encode_custom_data, layout, ClipboardData, UTI_CUSTOM_DATA,
    UTI_HTML, UTI_PLAIN_TEXT, UTI_URL,
};

#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

/// `NSUTF8StringEncoding`
const UTF8: usize = 4;

pub(crate) type Pasteboard = Retained<AnyObject>;

pub(crate) fn general() -> Pasteboard {
    unsafe { msg_send![class!(NSPasteboard), generalPasteboard] }
}

#[cfg(any(test, feature = "test-support"))]
/// A pasteboard nothing else uses, and its name. Release it with `release`.
pub(crate) fn unique() -> (Pasteboard, String) {
    unsafe {
        let pasteboard: Pasteboard = msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
        let name: *mut AnyObject = msg_send![&*pasteboard, name];
        let name = string_of(name).expect("a pasteboard has a name");
        (pasteboard, name)
    }
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn release(pasteboard: &Pasteboard) {
    unsafe {
        let _: () = msg_send![&**pasteboard, releaseGlobally];
    }
}

fn ns_string(text: &str) -> Retained<AnyObject> {
    unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class!(NSString), alloc];
        let string: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithBytes: text.as_ptr().cast::<c_void>(),
            length: text.len(),
            encoding: UTF8
        ];
        string.expect("NSString takes any UTF-8")
    }
}

/// The text of an `NSString`, `None` for nil.
unsafe fn string_of(string: *mut AnyObject) -> Option<String> {
    if string.is_null() {
        return None;
    }
    let bytes: *const std::ffi::c_char = unsafe { msg_send![string, UTF8String] };
    Some(unsafe { CStr::from_ptr(bytes) }.to_string_lossy().into_owned())
}

fn ns_data(bytes: &[u8]) -> Retained<AnyObject> {
    unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class!(NSData), alloc];
        let data: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithBytes: bytes.as_ptr().cast::<c_void>(),
            length: bytes.len()
        ];
        data.expect("NSData takes any bytes")
    }
}

/// Replaces the contents of `pasteboard` with `entries`, all types declared before any is set.
pub(crate) fn write(pasteboard: &Pasteboard, entries: &[ClipboardData]) -> Result<(), String> {
    let layout = layout(entries);
    autoreleasepool(|_| unsafe {
        let mut types: Vec<Retained<AnyObject>> =
            layout.typed.iter().map(|(uti, _)| ns_string(uti)).collect();
        if !layout.custom.is_empty() {
            types.push(ns_string(UTI_CUSTOM_DATA));
        }
        let pointers: Vec<*const AnyObject> = types.iter().map(|ty| &**ty as *const AnyObject).collect();
        let declared: *mut AnyObject = msg_send![
            class!(NSArray),
            arrayWithObjects: pointers.as_ptr(),
            count: pointers.len()
        ];
        let _: isize = msg_send![
            &**pasteboard,
            declareTypes: declared,
            owner: std::ptr::null_mut::<AnyObject>()
        ];
        for (uti, value) in &layout.typed {
            let set: bool = msg_send![
                &**pasteboard,
                setString: &*ns_string(value),
                forType: &*ns_string(uti)
            ];
            if !set {
                return Err(format!("the pasteboard refused {uti}"));
            }
        }
        if !layout.custom.is_empty() {
            let pickle = encode_custom_data(&layout.custom);
            let set: bool = msg_send![
                &**pasteboard,
                setData: &*ns_data(&pickle),
                forType: &*ns_string(UTI_CUSTOM_DATA)
            ];
            if !set {
                return Err(format!("the pasteboard refused {UTI_CUSTOM_DATA}"));
            }
        }
        Ok(())
    })
}

fn string_for(pasteboard: &Pasteboard, uti: &'static str) -> Option<(&'static str, String)> {
    unsafe {
        let string: *mut AnyObject =
            msg_send![&**pasteboard, stringForType: &*ns_string(uti)];
        string_of(string).map(|text| (uti, text))
    }
}

fn custom_pairs(pasteboard: &Pasteboard) -> Vec<(String, String)> {
    unsafe {
        let data: *mut AnyObject =
            msg_send![&**pasteboard, dataForType: &*ns_string(UTI_CUSTOM_DATA)];
        if data.is_null() {
            return Vec::new();
        }
        let length: usize = msg_send![data, length];
        let bytes: *const c_void = msg_send![data, bytes];
        let slice = if length == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(bytes.cast::<u8>(), length)
        };
        // Another app's corrupt entry hides its custom data, not the text beside it.
        decode_custom_data(slice).unwrap_or_else(|error| {
            log::warn!("ignoring the pasteboard's web custom data: {error}");
            Vec::new()
        })
    }
}

/// Every type of `pasteboard` that the web has a name for, and the pairs of its custom data.
pub(crate) fn read(pasteboard: &Pasteboard) -> Vec<ClipboardData> {
    autoreleasepool(|_| {
        let typed = [UTI_PLAIN_TEXT, UTI_HTML, UTI_URL]
            .into_iter()
            .filter_map(|uti| string_for(pasteboard, uti))
            .collect();
        assemble(typed, custom_pairs(pasteboard))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Never the general pasteboard: a test must not replace what the person copied.
    fn with_pasteboard(test: impl FnOnce(&Pasteboard)) {
        let (pasteboard, _) = unique();
        test(&pasteboard);
        release(&pasteboard);
    }

    #[test]
    fn a_write_reads_back_as_written() {
        with_pasteboard(|pasteboard| {
            let entries = vec![
                ClipboardData::new("text/plain", "héllo \u{1F30D}"),
                ClipboardData::new("text/html", "<b>héllo</b>"),
                ClipboardData::new("text/uri-list", "https://a.test/\nhttps://b.test/"),
                ClipboardData::new("application/x-lexical-editor", r#"{"nodes":[]}"#),
            ];
            write(pasteboard, &entries).unwrap();
            assert_eq!(read(pasteboard), entries);
        });
    }

    #[test]
    fn a_write_replaces_what_was_there() {
        with_pasteboard(|pasteboard| {
            write(
                pasteboard,
                &[
                    ClipboardData::new("text/html", "<i>a</i>"),
                    ClipboardData::new("application/x-a", "1"),
                ],
            )
            .unwrap();
            write(pasteboard, &[ClipboardData::new("text/plain", "b")]).unwrap();
            assert_eq!(read(pasteboard), vec![ClipboardData::new("text/plain", "b")]);
            write(pasteboard, &[]).unwrap();
            assert_eq!(read(pasteboard), Vec::new());
        });
    }

    #[test]
    fn a_url_another_app_wrote_is_a_uri_list() {
        with_pasteboard(|pasteboard| unsafe {
            let _: isize = msg_send![&**pasteboard, clearContents];
            let set: bool = msg_send![
                &**pasteboard,
                setString: &*ns_string("https://a.test/"),
                forType: &*ns_string(UTI_URL)
            ];
            assert!(set);
            assert_eq!(
                read(pasteboard),
                vec![ClipboardData::new("text/uri-list", "https://a.test/")]
            );
        });
    }
}
