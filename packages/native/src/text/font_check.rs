//! Which font files GPUI's text system can take.

/// Rejects fonts GPUI's text system cannot load. It unwraps the family, full and
/// PostScript name records and aborts the whole process when one is missing, and
/// skips a font without an "m" glyph, which would leave the family unresolvable.
pub(crate) fn check_font(bytes: &[u8]) -> std::result::Result<(), String> {
    use ttf_parser::name_id::{FAMILY, FULL_NAME, POST_SCRIPT_NAME};

    let face = ttf_parser::Face::parse(bytes, 0)
        .map_err(|error| format!("not a TrueType or OpenType font: {error}"))?;
    for (id, what) in [
        (FAMILY, "family"),
        (FULL_NAME, "full"),
        (POST_SCRIPT_NAME, "PostScript"),
    ] {
        let named = face
            .names()
            .into_iter()
            .any(|name| name.name_id == id && name.to_string().is_some());
        if !named {
            return Err(format!("font has no {what} name"));
        }
    }
    if face.glyph_index('m').is_none() {
        return Err("font has no glyph for \"m\"".to_string());
    }
    Ok(())
}
