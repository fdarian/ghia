//! `@media` conditions on rules: which rules are indexed, what a change of the window reloads.

use super::{counts, Doc, ROOT};
use crate::color::Scheme;
use crate::css::media_query::MediaEnvironment;

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

fn scoped_reloads() -> usize {
    crate::css::sheet::reload::SCOPED_RELOADS.with(|count| count.get())
}

/// Sets the environment and flushes, as the window does when it changes.
fn resize(doc: &mut Doc, environment: MediaEnvironment) -> bool {
    let flipped = doc.tree.set_media_environment(environment);
    doc.flush();
    flipped
}

#[test]
fn a_rule_in_media_applies_while_its_query_matches() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_media_environment(window(500.0));
    doc.set_adopted(".a { color: red } @media (min-width: 600px) { .a { color: blue } }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(doc.tree.sheets.index.rules.len(), 1, "a rule whose query fails is not indexed");

    assert!(resize(&mut doc, window(700.0)));
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.tree.sheets.index.rules.len(), 2);

    assert!(resize(&mut doc, window(500.0)));
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn no_media_rule_applies_before_the_window_reports() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.set_adopted("@media all { .a { color: blue } } @media not all { .a { background-color: red } }");
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert!(resize(&mut doc, window(500.0)), "the first report flips what was held");
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.background(div), None);
}

#[test]
fn a_change_that_flips_no_query_matches_nothing_again() {
    let mut doc = Doc::new();
    let items: Vec<u64> = (0..20).map(|_| doc.classed("div", ROOT, "a")).collect();
    doc.tree.set_media_environment(window(500.0));
    doc.set_adopted("@media (min-width: 600px) { .a { color: blue } } @media (max-width: 400px) { .a { top: 1px } }");
    doc.flush();

    crate::perf_counters::reset();
    let before = scoped_reloads();
    for width in [510.0, 520.0, 599.0, 450.0, 401.0] {
        assert!(!resize(&mut doc, window(width)), "{width}");
    }
    assert_eq!(counts().elements_rematched, 0);
    assert_eq!(scoped_reloads(), before);

    assert!(resize(&mut doc, window(600.0)));
    assert_eq!(counts().elements_rematched, items.len() as u64 + 1, "a flip matches every element, the root too");
    assert!(items.iter().all(|id| doc.color(*id) == Some("blue")));
}

#[test]
fn media_nests_in_layers_in_media_and_in_style_rules() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_media_environment(window(700.0));
    doc.set_adopted(
        "@layer base { @media (min-width: 600px) { .a { color: red } } } \
         @media (min-width: 600px) { @media (max-width: 800px) { .a { background-color: blue } } } \
         .a { @media (min-width: 650px) { opacity: 0.5 } & > .b { top: 1px } @media (min-width: 900px) { padding-top: 4px } }",
    );
    doc.flush();
    let child = doc.classed("span", div, "b");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(doc.background(div), Some("blue"));
    assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.5));
    assert!(doc.style(div).is_some_and(|style| style.padding_top.is_none()));
    assert!(doc.style(child).is_some_and(|style| style.top.is_some()));

    resize(&mut doc, window(850.0));
    assert_eq!(doc.background(div), None, "every enclosing query has to hold");
    assert_eq!(doc.color(div), Some("red"));
    resize(&mut doc, window(950.0));
    assert!(doc.style(div).is_some_and(|style| style.padding_top.is_some()));
    resize(&mut doc, window(500.0));
    assert_eq!(doc.color(div), None);
    assert_eq!(doc.style(div).and_then(|style| style.opacity), None);
}

#[test]
fn a_sheet_change_under_a_media_rule_matches_a_fresh_load() {
    let mut doc = Doc::new();
    let items: Vec<u64> = (0..30).map(|index| doc.classed("div", ROOT, if index < 10 { "a x" } else { "a" })).collect();
    doc.tree.set_media_environment(window(700.0));
    let base = "@media (min-width: 600px) { .x { color: blue } }\n.a { top: 1px }\n@media print { .a { color: green } }";
    doc.set_adopted(base);
    doc.flush();
    let edited = format!("{base}\n.a {{ left: 2px }}\n@media (min-width: 600px) {{ .a {{ right: 3px }} }}");
    doc.set_adopted(&edited);
    doc.flush();

    let mut fresh = Doc::new();
    let fresh_items: Vec<u64> = (0..30).map(|index| fresh.classed("div", ROOT, if index < 10 { "a x" } else { "a" })).collect();
    fresh.tree.set_media_environment(window(700.0));
    fresh.set_adopted(&edited);
    fresh.flush();
    for (item, fresh_item) in items.iter().zip(&fresh_items) {
        assert_eq!(doc.style(*item), fresh.style(*fresh_item));
    }
    assert_eq!(doc.color(items[0]), Some("blue"));
    assert!(doc.style(items[0]).is_some_and(|style| style.right.is_some() && style.left.is_some()));
}

#[test]
fn the_environment_outlives_the_sheets() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_media_environment(window(700.0));
    let (style, _) = doc.style_element(ROOT, "@media (min-width: 600px) { .a { color: blue } }");
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    doc.tree.destroy_element(style);
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert!(!doc.tree.sheets.enabled);

    doc.style_element(ROOT, "@media (min-width: 600px) { .a { color: red } }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"), "the window still reports its size");
}

#[test]
fn appearance_and_preferences_flip_a_query() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_media_environment(window(700.0));
    doc.set_adopted(
        "@media (prefers-color-scheme: dark) { .a { color: white } } \
         @media (prefers-reduced-motion: reduce) { .a { background-color: red } }",
    );
    doc.flush();
    assert_eq!(doc.color(div), None);

    let mut dark = window(700.0);
    dark.color_scheme = Scheme::Dark;
    assert!(resize(&mut doc, dark));
    assert_eq!(doc.color(div), Some("white"));

    dark.reduced_motion = true;
    assert!(resize(&mut doc, dark));
    assert_eq!(doc.background(div), Some("red"));
}
