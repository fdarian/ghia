//! `@keyframes` and `@property` in the sheets of a tree: which definition of a name stands, and what
//! a change of them does to the tree.

use super::{Doc, ROOT};
use crate::color::Scheme;
use crate::css::media_query::MediaEnvironment;
use crate::retained_tree::Dirty;

fn window(width: f64) -> MediaEnvironment {
    MediaEnvironment {
        width,
        height: 600.0,
        scale_factor: 2.0,
        color_scheme: Scheme::Light,
        reduced_motion: false,
        increased_contrast: false,
        forced_colors: false,
    }
}

/// The `top` each keyframes name resolves to, from the first declaration of its first block.
fn tops(doc: &Doc) -> Vec<(String, String)> {
    doc.tree
        .sheets
        .keyframes
        .rules()
        .iter()
        .map(|rule| (rule.name.clone(), rule.blocks[0].declarations[0].value.clone()))
        .collect()
}

fn named(entries: &[(&str, &str)]) -> Vec<(String, String)> {
    entries.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect()
}

#[test]
fn the_keyframes_of_the_sheets_are_one_set_per_name_ordered_by_name() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "@keyframes b { to { top: 1px } } @keyframes a { to { top: 2px } }");
    doc.flush();
    assert_eq!(tops(&doc), named(&[("a", r#""2px""#), ("b", r#""1px""#)]));
    assert_eq!(doc.tree.sheets.keyframes.epoch(), 1);
}

#[test]
fn for_a_name_the_last_definition_wins_and_an_unlayered_one_beats_a_layered_one() {
    let mut doc = Doc::new();
    doc.set_adopted(
        "@keyframes same { to { top: 1px } } @keyframes same { to { top: 2px } } \
         @layer a { @keyframes layered { to { top: 3px } } @keyframes later-layer { to { top: 5px } } } \
         @keyframes layered { to { top: 4px } } \
         @layer b { @keyframes later-layer { to { top: 6px } } } \
         @layer c { @keyframes inside { to { top: 7px } } @keyframes inside { to { top: 8px } } } \
         @layer a { @keyframes only-layered { to { top: 9px } } }",
    );
    doc.flush();
    assert_eq!(
        tops(&doc),
        named(&[
            ("inside", r#""8px""#),
            ("later-layer", r#""6px""#),
            ("layered", r#""4px""#),
            ("only-layered", r#""9px""#),
            ("same", r#""2px""#)
        ])
    );
}

#[test]
fn a_sheet_loaded_later_defines_over_an_earlier_one_in_the_same_layer() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "@keyframes k { to { top: 1px } }");
    let (_, text) = doc.style_element(ROOT, "@keyframes k { to { top: 2px } }");
    doc.flush();
    assert_eq!(tops(&doc), named(&[("k", r#""2px""#)]));
    doc.tree.set_text(text, "@keyframes other { to { top: 2px } }".into());
    doc.flush();
    assert_eq!(tops(&doc), named(&[("k", r#""1px""#), ("other", r#""2px""#)]));
}

#[test]
fn keyframes_under_a_media_query_are_there_only_while_it_holds() {
    let mut doc = Doc::new();
    doc.tree.set_media_environment(window(500.0));
    doc.set_adopted("@keyframes k { to { top: 1px } } @media (min-width: 600px) { @keyframes k { to { top: 2px } } @keyframes wide { to { top: 3px } } }");
    doc.flush();
    assert_eq!(tops(&doc), named(&[("k", r#""1px""#)]));
    let epoch = doc.tree.sheets.keyframes.epoch();

    assert!(doc.tree.set_media_environment(window(700.0)));
    doc.flush();
    assert_eq!(tops(&doc), named(&[("k", r#""2px""#), ("wide", r#""3px""#)]));
    assert_ne!(doc.tree.sheets.keyframes.epoch(), epoch);

    assert!(doc.tree.set_media_environment(window(500.0)));
    doc.flush();
    assert_eq!(tops(&doc), named(&[("k", r#""1px""#)]));
}

#[test]
fn a_media_query_only_a_definition_stands_under_is_watched() {
    let mut doc = Doc::new();
    doc.tree.set_media_environment(window(500.0));
    doc.set_adopted("@media (min-width: 600px) { @property --p { syntax: '*'; inherits: true; initial-value: 1 } }");
    doc.flush();
    assert!(doc.tree.sheets.registered.is_none());
    assert!(doc.tree.set_media_environment(window(700.0)), "the query flips");
    doc.flush();
    assert_eq!(doc.tree.sheets.registered.as_ref().and_then(|registered| registered.initial_of("--p")), Some("1"));
}

#[test]
fn a_load_that_leaves_the_definitions_alone_keeps_their_epoch_and_does_not_dirty_the_tree() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, "@keyframes k { to { top: 1px } } @property --p { syntax: '*'; inherits: true }");
    let (_, text) = doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    doc.tree.take_dirty();
    let epoch = doc.tree.sheets.keyframes.epoch();
    let registered = doc.tree.sheets.registered.clone().unwrap();

    doc.tree.set_text(text, ".a { color: blue }".into());
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.tree.sheets.keyframes.epoch(), epoch);
    assert!(std::sync::Arc::ptr_eq(&registered, doc.tree.sheets.registered.as_ref().unwrap()));
}

#[test]
fn a_change_of_the_definitions_builds_every_subtree_again() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (_, text) = doc.style_element(ROOT, "@keyframes k { to { top: 1px } }");
    doc.flush();
    doc.tree.take_dirty();
    let before = doc.tree.elements[&div].subtree_revision;

    doc.tree.set_text(text, "@keyframes k { to { top: 2px } }".into());
    doc.flush();
    assert_eq!(doc.tree.take_dirty(), Dirty::Layout);
    assert_ne!(doc.tree.elements[&div].subtree_revision, before);

    let before = doc.tree.elements[&div].subtree_revision;
    doc.tree.set_text(text, "@property --p { syntax: '*'; inherits: false }".into());
    doc.flush();
    assert!(doc.tree.sheets.registered.as_ref().is_some_and(|registered| registered.non_inheriting() == ["--p"]));
    assert_eq!(doc.tree.take_dirty(), Dirty::Layout);
    assert_ne!(doc.tree.elements[&div].subtree_revision, before);
}

#[test]
fn removing_the_sheets_removes_what_they_defined() {
    let mut doc = Doc::new();
    let (style, _) = doc.style_element(ROOT, "@keyframes k { to { top: 1px } } @property --p { syntax: '*'; inherits: true }");
    doc.flush();
    assert!(!doc.tree.sheets.keyframes.rules().is_empty());
    assert!(doc.tree.sheets.registered.is_some());
    doc.tree.destroy_element(style);
    doc.flush();
    assert!(doc.tree.sheets.keyframes.rules().is_empty());
    assert!(doc.tree.sheets.registered.is_none());
}

#[test]
fn for_a_name_the_last_registration_wins_with_layers_ranked_first() {
    let mut doc = Doc::new();
    doc.set_adopted(
        "@property --a { syntax: '*'; inherits: true; initial-value: 1 } @property --a { syntax: '*'; inherits: true; initial-value: 2 } \
         @property --b { syntax: '*'; inherits: true; initial-value: 3 } @layer l { @property --b { syntax: '*'; inherits: true; initial-value: 4 } } \
         @property --c { syntax: '*'; inherits: true; initial-value: 5 } @property --c { syntax: '<length>'; inherits: true }",
    );
    doc.flush();
    let registered = doc.tree.sheets.registered.as_ref().unwrap();
    assert_eq!(registered.initial_of("--a"), Some("2"));
    assert_eq!(registered.initial_of("--b"), Some("3"));
    assert_eq!(registered.initial_of("--c"), Some("5"), "an invalid rule is no registration, so it does not replace one");
}
