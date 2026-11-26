//! `::before` and `::after` rules (`css::sheet::pseudo`): which element a box belongs to, what it
//! cascades to, and what marks it to be matched again. Nothing is drawn: the tests read the
//! style and the content the element holds for each box.

use std::sync::Arc;

use super::{counts, Doc, ROOT};
use crate::color::Scheme;
use crate::css::content::{ComputedItem, Content};
use crate::css::media_query::MediaEnvironment;
use crate::css::sheet::{LiveInputs, Pseudo, PseudoStyle};
use crate::style::StyleDesc;

fn pseudo_style(doc: &Doc, id: u64, pseudo: Pseudo) -> Option<Arc<StyleDesc>> {
    doc.tree.elements[&id].pseudo_style(pseudo).cloned()
}

fn color(doc: &Doc, id: u64, pseudo: Pseudo) -> Option<String> {
    pseudo_style(doc, id, pseudo)?.color.clone()
}

/// What the box holds as the rules declare it, `None` for no box.
fn text(doc: &Doc, id: u64, pseudo: Pseudo) -> Option<String> {
    let made = doc.tree.elements[&id].pseudo_box(pseudo)?;
    Some(
        made.content
            .iter()
            .map(|item| match item {
                ComputedItem::Text(text) => text.clone(),
                ComputedItem::Unsupported(text) => format!("<{text}>"),
            })
            .collect(),
    )
}

fn revision(doc: &Doc, id: u64) -> u64 {
    doc.tree.elements[&id].subtree_revision
}

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

const BEFORE: Pseudo = Pseudo::Before;
const AFTER: Pseudo = Pseudo::After;

#[test]
fn a_box_rule_styles_the_box_and_an_element_rule_the_element() {
    let mut doc = Doc::new();
    let tagged = doc.classed("div", ROOT, "a");
    let plain = doc.classed("div", ROOT, "b");
    doc.style_element(
        ROOT,
        ".a { color: blue } .a::before { content: \"x\"; color: red } .a::after { content: \"y\"; opacity: 0.5 } .c::before { content: \"z\" }",
    );
    doc.flush();

    assert_eq!(doc.color(tagged), Some("blue"));
    assert!(doc.style(tagged).is_some_and(|style| style.content.is_none()), "a box rule leaves the element's style alone");
    assert_eq!(color(&doc, tagged, BEFORE).as_deref(), Some("red"));
    assert_eq!(color(&doc, tagged, AFTER), None);
    assert_eq!(pseudo_style(&doc, tagged, AFTER).and_then(|style| style.opacity), Some(0.5));
    assert_eq!(text(&doc, tagged, BEFORE).as_deref(), Some("x"));
    assert_eq!(text(&doc, tagged, AFTER).as_deref(), Some("y"));
    assert!(doc.tree.elements[&plain].pseudo_matches().is_none());
    assert_eq!(text(&doc, plain, BEFORE), None);
}

#[test]
fn an_element_rule_that_sets_content_does_not_make_a_box() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { content: \"x\"; color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert!(doc.tree.elements[&div].pseudo_matches().is_none());
    assert_eq!(text(&doc, div, BEFORE), None);
    assert_eq!(text(&doc, div, AFTER), None);
}

#[test]
fn the_cascade_of_a_box_follows_specificity_order_important_and_layers() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a b");
    let other = doc.classed("p", ROOT, "a");
    doc.style_element(
        ROOT,
        "div::before { content: \"t\"; color: green } .a::before { color: red } .a.b::before { background-color: blue } \
         .b::before { background-color: red } p::before { content: \"p\"; color: green } p.a::before { color: purple } \
         .a::before { content: \"later\" }",
    );
    doc.flush();
    // The pseudo-element counts as a type: `.a::before` (0,1,1) beats `div::before` (0,0,2).
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("red"));
    assert_eq!(pseudo_style(&doc, div, BEFORE).and_then(|style| style.background_color.clone()).as_deref(), Some("blue"));
    assert_eq!(color(&doc, other, BEFORE).as_deref(), Some("purple"));
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("later"), "the later rule of equal specificity");

    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(
        ROOT,
        "@layer base, theme; @layer theme { .a::before { content: \"t\"; color: red !important } } \
         @layer base { .a::before { color: blue !important; background-color: blue } } .a::before { background-color: red; color: green !important }",
    );
    doc.flush();
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("blue"), "an !important declaration of an earlier layer wins");
    assert_eq!(pseudo_style(&doc, div, BEFORE).and_then(|style| style.background_color.clone()).as_deref(), Some("red"));
}

#[test]
fn a_box_ignores_the_inline_style_of_its_element() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r##"{"color":"red","content":"\"inline\""}"##);
    doc.style_element(ROOT, ".a::before { content: \"x\"; background-color: blue }");
    doc.flush();
    assert_eq!(color(&doc, div, BEFORE), None);
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("x"));
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn a_box_with_no_content_display_none_or_a_dropped_declaration_is_not_generated() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(
        ROOT,
        ".a::before { color: red } .a::after { content: \"x\"; display: none } .a::before { content: bogus } .a::before { content: none }",
    );
    doc.flush();
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("red"), "the rules matched, the box is not made");
    assert_eq!(text(&doc, div, BEFORE), None, "none is not a box, and an invalid value is dropped");
    assert!(pseudo_style(&doc, div, AFTER).is_some());
    assert_eq!(text(&doc, div, AFTER), None, "display: none is not a box");
    assert!(doc.tree.elements[&div].pseudo_candidate(AFTER).is_some(), "it may have one in a state");
    assert!(doc.tree.elements[&div].pseudo_candidate(BEFORE).is_none());
}

#[test]
fn a_rule_with_a_list_of_selectors_styles_each_target() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a, .a::before, .a::after { color: red } .a::before { content: \"x\" }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("red"));
    assert_eq!(color(&doc, div, AFTER).as_deref(), Some("red"));
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("x"));
}

#[test]
fn a_universal_box_rule_reaches_every_element_and_the_boxes_are_shared() {
    let mut doc = Doc::new();
    let elements: Vec<u64> = (0..5).map(|_| doc.classed("div", ROOT, "a")).collect();
    doc.style_element(ROOT, "*, ::before, ::after { box-sizing: border-box } ::before { content: \"x\" }");
    doc.flush();
    for id in &elements {
        assert_eq!(text(&doc, *id, BEFORE).as_deref(), Some("x"));
        assert_eq!(text(&doc, *id, AFTER), None);
    }
    let first = doc.tree.elements[&elements[0]].pseudo_matches().unwrap().clone();
    assert!(elements.iter().all(|id| Arc::ptr_eq(&first, doc.tree.elements[id].pseudo_matches().unwrap())), "one value for equal matches");
}

#[test]
fn content_attr_reads_the_attribute_of_the_element_and_follows_it() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_attribute(div, "data-x", Some("one".into()));
    let other = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a::after { content: \"[\" attr(data-x) \"]\" }");
    doc.flush();
    assert_eq!(text(&doc, div, AFTER).as_deref(), Some("[one]"));
    assert_eq!(text(&doc, other, AFTER).as_deref(), Some("[]"), "a missing attribute is empty text");

    let before = revision(&doc, div);
    doc.tree.set_attribute(div, "data-x", Some("two".into()));
    doc.flush();
    assert_eq!(text(&doc, div, AFTER).as_deref(), Some("[two]"));
    assert_ne!(revision(&doc, div), before, "the box shows another text, so the element is changed");

    let before = revision(&doc, div);
    doc.tree.set_attribute(div, "data-y", Some("z".into()));
    doc.tree.set_attribute(other, "data-x", Some("x".into()));
    doc.flush();
    assert_eq!(revision(&doc, div), before, "an attribute no content reads changes nothing");
    assert_eq!(text(&doc, other, AFTER).as_deref(), Some("[x]"));
}

#[test]
fn a_box_that_is_not_drawn_in_a_state_has_no_attribute_dependency() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a::before { color: red } .b::before { content: attr(data-x) }");
    doc.flush();
    let before = revision(&doc, div);
    doc.tree.set_attribute(div, "data-x", Some("two".into()));
    doc.flush();
    assert_eq!(revision(&doc, div), before);
}

#[test]
fn what_is_not_drawn_in_a_content_list_is_kept_beside_what_is() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a::before { content: counter(n) \". \" url(a.png) \"t\" }");
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("<counter(n)>. <url(a.png)>t"));
    assert_eq!(doc.tree.sheets.skip_warnings, 0, "what is not drawn is not a skipped rule");
}

#[test]
fn a_state_of_the_subject_is_a_block_of_the_box_and_folds_with_the_state_of_the_element() {
    use crate::events::state_styles::{resolve_pointer_states, PointerStates};
    let mut doc = Doc::new();
    let button = doc.classed("button", ROOT, "btn");
    doc.style_element(ROOT, ".btn::before { content: \"b\"; color: blue } .btn:hover::before { color: red } .btn:hover::after { content: \"h\" }");
    doc.flush();
    let style = pseudo_style(&doc, button, BEFORE).unwrap();
    assert_eq!(style.color.as_deref(), Some("blue"));
    assert_eq!(style.hover.as_deref().and_then(|block| block.color.as_deref()), Some("red"));
    let hovered = resolve_pointer_states(&style, PointerStates { hovered: true, ..Default::default() });
    assert_eq!(hovered.color.as_deref(), Some("red"));

    assert_eq!(text(&doc, button, AFTER), None, "no content until the state");
    let candidate = doc.tree.elements[&button].pseudo_candidate(AFTER).expect("the box has content when hovered").clone();
    let folded = Arc::new(resolve_pointer_states(&candidate, PointerStates { hovered: true, ..Default::default() }));
    let made = PseudoStyle::generate(&folded, &doc.tree.elements[&button]).expect("the folded style makes the box");
    assert_eq!(made.content, [ComputedItem::Text("h".into())]);
    let unfolded = Arc::new(resolve_pointer_states(&candidate, PointerStates::default()));
    assert!(PseudoStyle::generate(&unfolded, &doc.tree.elements[&button]).is_none());
}

#[test]
fn a_state_elsewhere_in_the_selector_is_read_live() {
    let mut doc = Doc::new();
    let card = doc.classed("div", ROOT, "card");
    let icon = doc.classed("span", card, "icon");
    let other = doc.classed("span", ROOT, "icon");
    doc.style_element(ROOT, ".card:hover .icon::after { content: \"!\" }");
    doc.flush();
    assert_eq!(text(&doc, icon, AFTER), None);

    let chain = vec![card, ROOT];
    doc.tree.sync_live_states(&LiveInputs::pointer(&chain, &[]));
    assert_eq!(text(&doc, icon, AFTER).as_deref(), Some("!"));
    assert_eq!(text(&doc, other, AFTER), None, "an icon outside the card");

    crate::perf_counters::reset();
    doc.tree.sync_live_states(&LiveInputs::pointer(&[], &[]));
    assert_eq!(text(&doc, icon, AFTER), None);
    assert!(counts().elements_rematched <= 2, "only what the state reaches is matched again");
}

#[test]
fn a_class_or_id_or_attribute_change_matches_the_boxes_again() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "off");
    doc.tree.set_attribute(div, "id", Some("i".into()));
    doc.style_element(ROOT, ".on::before { content: \"c\" } #j::after { content: \"i\" } [data-k]::before { content: \"a\"; color: red }");
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE), None);

    let before = revision(&doc, div);
    doc.tree.set_attribute(div, "class", Some("on".into()));
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("c"));
    assert_ne!(revision(&doc, div), before);
    doc.tree.set_attribute(div, "class", Some("off".into()));
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE), None);

    doc.tree.set_attribute(div, "id", Some("j".into()));
    doc.flush();
    assert_eq!(text(&doc, div, AFTER).as_deref(), Some("i"));
    doc.tree.set_attribute(div, "id", Some("k".into()));
    doc.flush();
    assert_eq!(text(&doc, div, AFTER), None);

    doc.tree.set_attribute(div, "data-k", Some("".into()));
    doc.flush();
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("red"));
    doc.tree.set_attribute(div, "data-k", None);
    doc.flush();
    assert!(pseudo_style(&doc, div, BEFORE).is_none());
}

#[test]
fn a_change_above_the_element_matches_its_boxes_again() {
    let mut doc = Doc::new();
    let group = doc.classed("div", ROOT, "g");
    let inner = doc.classed("div", group, "x");
    let later = doc.classed("div", ROOT, "y");
    doc.style_element(ROOT, ".on .x::before { content: \"d\" } .on > .x::after { content: \"c\" } .on ~ .y::before { content: \"s\" }");
    doc.flush();
    assert_eq!(text(&doc, inner, BEFORE), None);
    doc.tree.set_attribute(group, "class", Some("g on".into()));
    doc.flush();
    assert_eq!(text(&doc, inner, BEFORE).as_deref(), Some("d"));
    assert_eq!(text(&doc, inner, AFTER).as_deref(), Some("c"));
    assert_eq!(text(&doc, later, BEFORE).as_deref(), Some("s"));
    doc.tree.set_attribute(group, "class", Some("g".into()));
    doc.flush();
    assert_eq!(text(&doc, inner, BEFORE), None);
    assert_eq!(text(&doc, later, BEFORE), None);
}

#[test]
fn a_box_rule_under_a_media_query_follows_the_window() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_media_environment(window(500.0));
    doc.style_element(ROOT, "@media (min-width: 600px) { .a::before { content: \"wide\" } }");
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE), None);
    assert!(doc.tree.set_media_environment(window(700.0)));
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("wide"));
    assert!(doc.tree.set_media_environment(window(500.0)));
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE), None);
    assert!(doc.tree.elements[&div].pseudo_matches().is_none());
}

#[test]
fn loading_another_sheet_matches_the_boxes_again_and_removing_every_sheet_clears_them() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (style, text_node) = doc.style_element(ROOT, ".a::before { content: \"one\" }");
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("one"));

    doc.tree.set_text(text_node, ".a::before { content: \"two\" } .a::after { content: \"after\" }".into());
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE).as_deref(), Some("two"));
    assert_eq!(text(&doc, div, AFTER).as_deref(), Some("after"));

    let before = revision(&doc, div);
    doc.tree.destroy_element(style);
    doc.flush();
    assert_eq!(text(&doc, div, BEFORE), None);
    assert_eq!(text(&doc, div, AFTER), None);
    assert!(!doc.tree.sheets.enabled);
    assert!(doc.tree.elements[&div].pseudo_matches().is_none());
    assert_ne!(revision(&doc, div), before, "the boxes are gone, so the element is changed");
}

#[test]
fn a_rule_inserted_before_a_box_rule_renumbers_it_and_a_rule_removed_takes_its_boxes() {
    let scoped = || crate::css::sheet::reload::SCOPED_RELOADS.with(|count| count.get());
    let mut doc = Doc::new();
    let items: Vec<u64> = (0..40).map(|_| doc.classed("div", ROOT, "item")).collect();
    let marked = doc.classed("div", ROOT, "item mark");
    doc.set_adopted(".item::before { content: \"i\" } .mark::after { content: \"m\" } .item { color: red }");
    doc.flush();
    assert_eq!(text(&doc, marked, AFTER).as_deref(), Some("m"));

    let before = scoped();
    crate::perf_counters::reset();
    doc.set_adopted(".zzz { top: 1px } .item::before { content: \"i\" } .mark::after { content: \"m\" } .item { color: red }");
    doc.flush();
    assert!(scoped() > before, "the boxes of every item are renumbered, not matched again");
    assert!(counts().elements_rematched < 10, "{} elements matched again", counts().elements_rematched);
    assert_eq!(text(&doc, items[0], BEFORE).as_deref(), Some("i"));
    assert_eq!(text(&doc, marked, AFTER).as_deref(), Some("m"));
    assert_eq!(doc.color(marked), Some("red"));
    let shared = doc.tree.elements[&items[0]].pseudo_matches().unwrap().clone();
    assert!(Arc::ptr_eq(&shared, doc.tree.elements[&items[39]].pseudo_matches().unwrap()), "renumbered boxes are still shared");

    let before = scoped();
    doc.set_adopted(".zzz { top: 1px } .item::before { content: \"i\" } .item { color: red }");
    doc.flush();
    assert!(scoped() > before);
    assert_eq!(text(&doc, marked, AFTER), None, "the rule that made the box is gone");
    assert_eq!(text(&doc, marked, BEFORE).as_deref(), Some("i"));

    doc.set_adopted(".zzz { top: 1px } .item::before { content: \"i\" } .mark::before { content: \"added\" } .item { color: red }");
    doc.flush();
    assert_eq!(text(&doc, marked, BEFORE).as_deref(), Some("added"));
    assert_eq!(text(&doc, items[1], BEFORE).as_deref(), Some("i"));
}

#[test]
fn a_box_rule_without_content_marks_no_element_to_draw() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a::before { color: red } .on::before { color: blue }");
    doc.flush();
    let before = revision(&doc, div);
    doc.tree.set_attribute(div, "class", Some("a on".into()));
    doc.flush();
    assert_eq!(color(&doc, div, BEFORE).as_deref(), Some("blue"));
    assert_eq!(revision(&doc, div), before, "no box has content, so nothing is drawn differently");
}
