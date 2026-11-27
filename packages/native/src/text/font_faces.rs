//! The faces a sheet's `@font-face` rules declare, loaded into the App's text system and named by the
//! family the rule gives them.
//!
//! GPUI names a font by what the file says (the family record of its name table), not by what a page
//! calls it, so a rule `@font-face { font-family: Brand; src: url(Inter.ttf) }` is kept as an alias:
//! [`FaceState::family`] answers `Brand` with the file's own family, and `Fonts::resolve` hands that
//! to GPUI. The bytes are read the way the window's `fonts` option reads them (`js/fonts.ts`) and
//! registered the way `registerFont` does, once per address however often the sheets reload: a load
//! that changes nothing about the faces (`SheetFontFaces` keeps its `Arc`) costs a pointer compare.
//!
//! Loading is synchronous, as the `fonts` option is: a file is read in the frame that first builds
//! with the rule, and only `.ttf`, `.otf` and `.ttc` files, `data:` URLs and `local()` fonts are
//! sources. A face none of whose sources loads is left out, with one warning, and the family stays as
//! it was.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::css::sheet::{FaceSource, FaceStyle, FontFaceRule, SheetFontFaces, SUPPORTED_FORMATS};
use crate::custom_elements::img::{self, ImgSource};

/// A face that loaded: the family GPUI knows it as, and what the rule said it covers.
#[derive(Clone, Debug, PartialEq)]
struct Face {
    family: String,
    weight: (f32, f32),
    style: FaceStyle,
}

/// What loading a face needs of the text system, which `Fonts` answers.
pub(crate) trait Host {
    /// Registers the fonts in a file, as the `fonts` option does.
    fn add(&mut self, bytes: Vec<u8>) -> anyhow::Result<()>;
    /// Whether the system has a family of this name.
    fn is_installed(&mut self, name: &str) -> bool;
}

#[derive(Default)]
pub(crate) struct FaceState {
    applied: Option<Arc<SheetFontFaces>>,
    /// By the family of the rule, lowercased.
    table: HashMap<String, Vec<Face>>,
    /// What each source resolved to, by `url:<address>` and `local:<name>`, so a source is read once.
    sources: HashMap<String, Result<String, String>>,
    warned: HashSet<String>,
    /// Moves whenever [`FaceState::family`] could answer differently.
    version: u64,
}

impl FaceState {
    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        // Asked for every element's font-family: with no `@font-face` rule it must not allocate the lowercase name.
        !self.table.is_empty() && self.table.contains_key(&name.to_lowercase())
    }

    /// The family GPUI loads for the face a rule named `name` has, or `None` when no rule does. A
    /// request for the initial `font-weight` and `font-style` is what picks among faces that GPUI
    /// does not know under one family; faces of one family are told apart by GPUI itself.
    pub(crate) fn family(&self, name: &str) -> Option<String> {
        let faces = self.table.get(&name.to_lowercase())?;
        faces
            .iter()
            .min_by(|a, b| distance_from_initial(a).total_cmp(&distance_from_initial(b)))
            .map(|face| face.family.clone())
    }

    /// Loads what `sheet` declares that was not loaded before and rebuilds the table. Whether the table
    /// changed.
    pub(crate) fn sync(&mut self, sheet: &Arc<SheetFontFaces>, host: &mut dyn Host) -> bool {
        if self.applied.as_ref().is_some_and(|applied| Arc::ptr_eq(applied, sheet)) {
            return false;
        }
        self.applied = Some(sheet.clone());
        let mut table: HashMap<String, Vec<Face>> = HashMap::new();
        for rule in sheet.rules() {
            if let Some(face) = self.load(rule, host) {
                table.entry(rule.family.to_lowercase()).or_default().push(face);
            }
        }
        if table == self.table {
            return false;
        }
        self.table = table;
        self.version += 1;
        true
    }

    fn load(&mut self, rule: &FontFaceRule, host: &mut dyn Host) -> Option<Face> {
        let mut reasons = Vec::new();
        for source in &rule.sources {
            let key = match source {
                FaceSource::Url { format: Some(format), address } if !SUPPORTED_FORMATS.contains(&format.as_str()) => {
                    reasons.push(format!("{address}: format({format}) is not supported"));
                    continue;
                }
                FaceSource::Url { address, .. } => format!("url:{address}"),
                FaceSource::Local(name) => format!("local:{name}"),
            };
            if !self.sources.contains_key(&key) {
                let loaded = match source {
                    FaceSource::Url { address, .. } => read_font(address).and_then(|bytes| register(bytes, host)),
                    FaceSource::Local(name) => host.is_installed(name).then(|| name.clone()).ok_or_else(|| "no such font is installed".to_owned()),
                };
                self.sources.insert(key.clone(), loaded);
            }
            match &self.sources[&key] {
                Ok(family) => return Some(Face { family: family.clone(), weight: rule.weight, style: rule.style }),
                Err(reason) => reasons.push(format!("{}: {reason}", key.split_once(':').map_or(key.as_str(), |(_, rest)| rest))),
            }
        }
        if self.warned.insert(rule.identity.clone()) {
            log::warn!("@font-face {}: no source could be loaded ({})", rule.family, reasons.join("; "));
        }
        None
    }
}

/// How far the face is from `font-weight: 400`, with an italic or oblique face counted as farther than any weight.
fn distance_from_initial(face: &Face) -> f32 {
    let weight = if face.weight.0 > 400.0 {
        face.weight.0 - 400.0
    } else if face.weight.1 < 400.0 {
        400.0 - face.weight.1
    } else {
        0.0
    };
    if face.style == FaceStyle::Normal { weight } else { weight + 1000.0 }
}

fn read_font(address: &str) -> Result<Vec<u8>, String> {
    if address.starts_with("data:") {
        return img::decode_data_url(address).map(|(_, bytes)| bytes).ok_or_else(|| "invalid data URL".to_owned());
    }
    match img::resolve_src(address) {
        ImgSource::Path(path) => std::fs::read(&path).map_err(|error| format!("cannot read {}: {error}", path.display())),
        ImgSource::Uri(_) => Err("http(s) fonts are not loaded".to_owned()),
        ImgSource::Failed(message) => Err(message),
        _ => Err("not a font file or data URL".to_owned()),
    }
}

fn register(bytes: Vec<u8>, host: &mut dyn Host) -> Result<String, String> {
    if bytes.starts_with(b"wOFF") || bytes.starts_with(b"wOF2") {
        return Err("WOFF and WOFF2 are not supported, list a TrueType or OpenType file".to_owned());
    }
    crate::renderer::check_font(&bytes)?;
    let family = family_of(&bytes)?;
    host.add(bytes).map_err(|error| error.to_string())?;
    Ok(family)
}

/// The family GPUI files the font under: the typographic family of the name table if it has one, else the family.
fn family_of(bytes: &[u8]) -> Result<String, String> {
    use ttf_parser::name_id::{FAMILY, TYPOGRAPHIC_FAMILY};

    let face = ttf_parser::Face::parse(bytes, 0).map_err(|error| error.to_string())?;
    let named = |id: u16| face.names().into_iter().filter(|name| name.name_id == id).find_map(|name| name.to_string());
    named(TYPOGRAPHIC_FAMILY).or_else(|| named(FAMILY)).ok_or_else(|| "font has no family name".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::css::sheet::faces_for_tests as faces;

    const SQUARE: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-square.ttf");
    const NAMELESS: &[u8] = include_bytes!("../../../react/src/__tests__/fixtures/gpuix-test-nameless.ttf");

    #[derive(Default)]
    struct Recording {
        added: usize,
        installed: Vec<&'static str>,
    }

    impl Host for Recording {
        fn add(&mut self, _: Vec<u8>) -> anyhow::Result<()> {
            self.added += 1;
            Ok(())
        }

        fn is_installed(&mut self, name: &str) -> bool {
            self.installed.contains(&name)
        }
    }

    fn data_url(bytes: &[u8]) -> String {
        use base64::Engine as _;
        format!("data:font/ttf;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[test]
    fn a_data_url_registers_the_file_and_names_it_by_the_family_the_file_declares() {
        let mut state = FaceState::default();
        let mut host = Recording::default();
        let sheet = faces(&format!("@font-face {{ font-family: Brand; src: url({}) }}", data_url(SQUARE)), 1);
        assert!(state.sync(&sheet, &mut host));
        assert_eq!(host.added, 1);
        assert_eq!(state.family("brand").as_deref(), Some("GpuixTestSquare"));
        assert_eq!(state.family("Other"), None);
        assert!(state.has("BRAND"));
    }

    #[test]
    fn the_same_sheet_or_the_same_source_is_not_loaded_again() {
        let mut state = FaceState::default();
        let mut host = Recording::default();
        let css = format!("@font-face {{ font-family: Brand; src: url({}) }}", data_url(SQUARE));
        let sheet = faces(&css, 1);
        assert!(state.sync(&sheet, &mut host));
        assert!(!state.sync(&sheet, &mut host), "the same set");
        let version = state.version();
        assert!(!state.sync(&faces(&css, 2), &mut host), "an equal set under a new epoch changes no answer");
        assert_eq!((host.added, state.version()), (1, version));
        let more = format!("{css} @font-face {{ font-family: Bold; font-weight: 700; src: url({}) }}", data_url(SQUARE));
        assert!(state.sync(&faces(&more, 3), &mut host));
        assert_eq!(host.added, 1, "the address was read before");
        assert_eq!(state.family("bold").as_deref(), Some("GpuixTestSquare"));
    }

    #[test]
    fn a_source_that_cannot_load_gives_way_to_the_next() {
        let mut state = FaceState::default();
        let mut host = Recording { installed: vec!["Helvetica"], ..Recording::default() };
        let woff = format!("{}", data_url(b"wOFF0000"));
        let css = format!(
            "@font-face {{ font-family: A; src: url(x.woff2) format(\"woff2\"), url({woff}), url(/no/such/file.ttf), url({nameless}), local(Missing), local(Helvetica), url({good}) }}",
            nameless = data_url(NAMELESS),
            good = data_url(SQUARE)
        );
        assert!(state.sync(&faces(&css, 1), &mut host));
        assert_eq!(state.family("a").as_deref(), Some("Helvetica"));
        assert_eq!(host.added, 0, "nothing before the installed font registered");
    }

    #[test]
    fn a_rule_none_of_whose_sources_loads_leaves_the_family_alone() {
        let mut state = FaceState::default();
        let mut host = Recording::default();
        let css = "@font-face { font-family: A; src: url(a.woff2) format(woff2), url(/no/such/file.otf), local(Missing) }";
        assert!(!state.sync(&faces(css, 1), &mut host));
        assert_eq!(state.family("a"), None);
        assert_eq!(state.version(), 0);
    }

    #[test]
    fn woff_and_woff2_files_are_refused_with_a_reason() {
        assert!(register(b"wOFF....".to_vec(), &mut Recording::default()).unwrap_err().contains("WOFF"));
        assert!(register(b"wOF2....".to_vec(), &mut Recording::default()).unwrap_err().contains("WOFF"));
    }

    #[test]
    fn faces_of_one_name_answer_with_the_one_nearest_the_initial_weight_and_style() {
        let mut state = FaceState::default();
        let mut host = Recording::default();
        let url = data_url(SQUARE);
        let css = format!(
            "@font-face {{ font-family: F; font-weight: 700; src: url({url}) }} \
             @font-face {{ font-family: F; font-style: italic; src: url({url}) }} \
             @font-face {{ font-family: F; font-weight: 300 500; src: local(Helvetica) }}"
        );
        host.installed.push("Helvetica");
        state.sync(&faces(&css, 1), &mut host);
        assert_eq!(state.family("f").as_deref(), Some("Helvetica"), "400 lies in 300 to 500");
    }

    #[test]
    fn a_file_url_is_read_from_disk() {
        let directory = std::env::temp_dir().join(format!("ghia-font-face-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("square.ttf"), SQUARE).unwrap();
        let mut state = FaceState::default();
        let mut host = Recording::default();
        let css = format!("@font-face {{ font-family: P; src: url(\"file://{}\") }}", directory.join("square.ttf").display());
        assert!(state.sync(&faces(&css, 1), &mut host));
        assert_eq!(state.family("p").as_deref(), Some("GpuixTestSquare"));
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_face_named_like_a_family_comes_before_what_the_list_names_after_it() {
        let resolved = super::super::font_family::pick_for_tests("Brand, Helvetica", &["GpuixTestSquare", "Helvetica"], &[("brand", "GpuixTestSquare")]);
        assert_eq!(resolved, ("GpuixTestSquare".to_owned(), vec!["Helvetica".to_owned()]));
    }
}
