//! Which font files GPUI's text system can take, and the family it files them under.

use gpui::TextSystem;

/// Rejects fonts GPUI's text system cannot load, and answers the family it files the font under. It
/// refuses a font without the family, full and PostScript name records, which abort the whole process
/// when GPUI loads it, and one without an "m" glyph, which would leave the family unresolvable.
///
/// TrueType and OpenType files are read here. A WOFF or WOFF2 file keeps its name table compressed, so
/// the platform's font loader (Core Text) says what it makes of it: the family it answers is the one
/// GPUI files the font under, because GPUI asks the same loader.
pub(crate) fn check_font(bytes: &[u8], text_system: &TextSystem) -> std::result::Result<String, String> {
    if bytes.starts_with(b"wOFF") || bytes.starts_with(b"wOF2") {
        return check_woff(bytes, text_system);
    }
    check_sfnt(bytes)
}

fn check_woff(bytes: &[u8], text_system: &TextSystem) -> std::result::Result<String, String> {
    let info = text_system.font_file_info(bytes).map_err(|error| format!("not a usable WOFF or WOFF2 font: {error}"))?;
    if !info.has_glyph_for_m {
        return Err("font has no glyph for \"m\"".to_string());
    }
    Ok(info.family_name)
}

fn check_sfnt(bytes: &[u8]) -> std::result::Result<String, String> {
    use ttf_parser::name_id::{FAMILY, FULL_NAME, POST_SCRIPT_NAME, TYPOGRAPHIC_FAMILY};

    let face = ttf_parser::Face::parse(bytes, 0)
        .map_err(|error| format!("not a TrueType, OpenType, WOFF or WOFF2 font: {error}"))?;
    let named = |id: u16| face.names().into_iter().filter(|name| name.name_id == id).find_map(|name| name.to_string());
    for (id, what) in [(FAMILY, "family"), (FULL_NAME, "full"), (POST_SCRIPT_NAME, "PostScript")] {
        if named(id).is_none() {
            return Err(format!("font has no {what} name"));
        }
    }
    if face.glyph_index('m').is_none() {
        return Err("font has no glyph for \"m\"".to_string());
    }
    // The typographic family if the font has one, else the family: the one GPUI files the font under.
    Ok(named(TYPOGRAPHIC_FAMILY).or_else(|| named(FAMILY)).expect("the family was checked above"))
}

/// A text system over the platform's font loader, which reads WOFF and WOFF2.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn platform_text_system_for_tests() -> std::sync::Arc<TextSystem> {
    std::sync::Arc::new(TextSystem::new(std::sync::Arc::new(gpui_macos::MacTextSystem::new())))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const SQUARE: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-square.ttf");
    const SQUARE_WOFF: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-square.woff");
    const SQUARE_WOFF2: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-square.woff2");
    const NAMELESS: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-nameless.ttf");
    const NAMELESS_WOFF: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-nameless.woff");
    const NAMELESS_WOFF2: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-nameless.woff2");

    fn check(bytes: &[u8]) -> Result<String, String> {
        check_font(bytes, &platform_text_system_for_tests())
    }

    #[test]
    fn a_woff_and_a_woff2_font_answer_the_family_their_name_table_declares() {
        for bytes in [SQUARE, SQUARE_WOFF, SQUARE_WOFF2] {
            assert_eq!(check(bytes).as_deref(), Ok("GpuixTestSquare"));
        }
    }

    #[test]
    fn a_font_without_the_names_gpui_unwraps_is_refused_in_every_container() {
        for bytes in [NAMELESS, NAMELESS_WOFF, NAMELESS_WOFF2] {
            let error = check(bytes).unwrap_err();
            assert!(error.contains("no full name") || error.contains("full name"), "{error}");
        }
    }

    #[test]
    fn a_broken_woff_is_refused_where_it_breaks() {
        let mut flipped = SQUARE_WOFF2.to_vec();
        for byte in &mut flipped[48..] {
            *byte ^= 0xA5;
        }
        let mut bad_length = SQUARE_WOFF.to_vec();
        bad_length[8..12].copy_from_slice(&(SQUARE_WOFF.len() as u32 + 100).to_be_bytes());
        let mut bad_table = SQUARE_WOFF.to_vec();
        let last = bad_table.len() - 1;
        for byte in &mut bad_table[last - 60..=last] {
            *byte ^= 0xFF;
        }
        for (what, bytes) in [
            ("signature only", b"wOFF".to_vec()),
            ("signature only", b"wOF2".to_vec()),
            ("empty tables", b"wOF2\0\0\0\0\0\0\0\0\0\0\0\0".to_vec()),
            ("cut WOFF", SQUARE_WOFF[..SQUARE_WOFF.len() / 2].to_vec()),
            ("cut WOFF2", SQUARE_WOFF2[..SQUARE_WOFF2.len() / 2].to_vec()),
            ("scrambled WOFF2 stream", flipped),
            ("length that does not match", bad_length),
            ("scrambled WOFF tables", bad_table),
        ] {
            assert!(check(&bytes).is_err(), "{what} was taken");
        }
    }

    #[test]
    fn a_font_file_that_is_no_font_names_the_formats_it_would_take() {
        let error = check(b"plain text").unwrap_err();
        assert!(error.contains("WOFF2"), "{error}");
    }
}
