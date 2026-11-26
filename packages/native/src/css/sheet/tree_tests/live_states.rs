//! The pointer and focus states a selector reads outside its subject (`css::sheet::live_states`):
//! that the elements a state reaches match as the state moves, that only they are matched again, and
//! that a document with no such selector does nothing for a move of the pointer or the focus.

use super::{counts, Doc, ROOT};
use crate::color::Scheme;
use crate::css::media_query::MediaEnvironment;
use crate::css::sheet::LiveInputs;
use crate::retained_tree::Dirty;

fn red(doc: &Doc, id: u64) -> bool {
    doc.color(id) == Some("red")
}

fn pixels(value: Option<&crate::style::DimensionValue>) -> Option<f64> {
    match value? {
        crate::style::DimensionValue::Pixels(pixels) => Some(*pixels),
        other => panic!("{other:?}"),
    }
}

fn top(doc: &Doc, id: u64) -> Option<f64> {
    pixels(doc.style(id)?.top.as_ref())
}

fn left(doc: &Doc, id: u64) -> Option<f64> {
    pixels(doc.style(id)?.left.as_ref())
}

/// The element and its ancestors, as the dispatcher reports a chain.
fn chain(doc: &Doc, id: u64) -> Vec<u64> {
    std::iter::successors(Some(id), |id| doc.tree.elements[id].parent).collect()
}

/// Moves the pointer to `target` (none: out of the window) and says how many elements matched again.
fn hover(doc: &mut Doc, target: Option<u64>) -> u64 {
    let chain = target.map(|target| chain(doc, target)).unwrap_or_default();
    crate::perf_counters::reset();
    doc.tree.sync_live_states(&LiveInputs::pointer(&chain, &[]));
    counts().elements_rematched
}

fn press(doc: &mut Doc, target: Option<u64>) {
    let chain = target.map(|target| chain(doc, target)).unwrap_or_default();
    doc.tree.sync_live_states(&LiveInputs::pointer(&[], &chain));
}

fn focus(doc: &mut Doc, target: Option<u64>, visible: bool) -> u64 {
    let chain = target.map(|target| chain(doc, target)).unwrap_or_default();
    crate::perf_counters::reset();
    doc.tree.sync_live_states(&LiveInputs::focus(&chain, target.filter(|_| visible)));
    counts().elements_rematched
}

#[test]
fn an_ancestor_under_the_pointer_styles_its_descendants() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:hover .title { color: red }");
    let first = doc.classed("div", ROOT, "card");
    let title = doc.classed("p", first, "title");
    let nested = doc.classed("div", first, "inner");
    let deep = doc.classed("p", nested, "title");
    let second = doc.classed("div", ROOT, "card");
    let other = doc.classed("p", second, "title");
    doc.flush();
    assert!(!red(&doc, title) && !red(&doc, deep) && !red(&doc, other));

    hover(&mut doc, Some(title));
    assert!(red(&doc, title) && red(&doc, deep), "the card is in the hover chain of its child");
    assert!(!red(&doc, other));

    let rematched = hover(&mut doc, Some(other));
    assert!(!red(&doc, title) && !red(&doc, deep) && red(&doc, other));
    assert_eq!(rematched, 3 + 1, "the first card's descendants, which left, and the second card's, which entered");

    hover(&mut doc, None);
    assert!(!red(&doc, other));
}

#[test]
fn moving_between_the_children_of_a_hovered_card_matches_nothing_again() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:hover .title { color: red }");
    let card = doc.classed("div", ROOT, "card");
    let rows: Vec<u64> = doc.run(50, "div", card, "row");
    let titles: Vec<u64> = rows.iter().map(|row| doc.classed("p", *row, "title")).collect();
    doc.flush();
    hover(&mut doc, Some(rows[0]));
    assert!(titles.iter().all(|title| red(&doc, *title)));
    assert_eq!(hover(&mut doc, Some(rows[1])), 2, "row 0's `p` leaves, row 1's `p` enters; the card stays");
    assert_eq!(hover(&mut doc, Some(titles[1])), 0, "a leaf has no descendant to reach");
}

#[test]
fn a_child_combinator_reaches_the_children_and_no_deeper() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".group:hover > .x { color: red }");
    let group = doc.classed("div", ROOT, "group");
    let child = doc.classed("p", group, "x");
    let grandchild = doc.classed("span", child, "x");
    doc.flush();
    hover(&mut doc, Some(group));
    assert!(red(&doc, child) && !red(&doc, grandchild));
}

#[test]
fn a_focused_sibling_styles_the_ones_after_it() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".peer:focus ~ .y { color: red } .peer:focus + .z { top: 1px }");
    let before = doc.classed("p", ROOT, "y");
    let peer = doc.classed("input", ROOT, "peer");
    let next = doc.classed("p", ROOT, "z");
    let after = doc.classed("p", ROOT, "y");
    let inside = doc.classed("span", after, "y");
    doc.flush();
    focus(&mut doc, Some(peer), false);
    assert!(!red(&doc, before) && red(&doc, after) && !red(&doc, inside), "`~` is the siblings, not what is below them");
    assert_eq!(top(&doc, next), Some(1.0));
    focus(&mut doc, None, false);
    assert!(!red(&doc, after));
    assert_eq!(top(&doc, next), None);
}

#[test]
fn focus_within_is_the_chain_of_the_focused_element() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".menu:focus-within .item { color: red } .menu:focus .item { top: 1px } .menu:focus-visible .item { left: 2px }");
    let menu = doc.classed("div", ROOT, "menu");
    let row = doc.classed("div", menu, "row");
    let button = doc.classed("button", row, "btn");
    let item = doc.classed("p", menu, "item");
    doc.flush();
    focus(&mut doc, Some(button), true);
    assert!(red(&doc, item));
    assert_eq!(top(&doc, item), None, "the menu is not the focused element");
    assert_eq!(left(&doc, item), None, "nor the one that is focus-visible");
    focus(&mut doc, Some(menu), true);
    assert!(red(&doc, item));
    assert_eq!(top(&doc, item), Some(1.0));
    assert_eq!(left(&doc, item), Some(2.0));
    focus(&mut doc, Some(menu), false);
    assert_eq!(left(&doc, item), None, "focused by the pointer");
    focus(&mut doc, None, false);
    assert!(!red(&doc, item));
}

#[test]
fn the_hovered_item_styles_the_next_one() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "li:hover + li { color: red }");
    let items: Vec<u64> = doc.run(100, "li", ROOT, "i");
    doc.flush();
    hover(&mut doc, Some(items[10]));
    assert!(red(&doc, items[11]) && !red(&doc, items[10]) && !red(&doc, items[12]));
    assert_eq!(hover(&mut doc, Some(items[40])), 2, "the next sibling of each of the two");
    assert!(!red(&doc, items[11]) && red(&doc, items[41]));
}

#[test]
fn a_press_styles_what_an_active_ancestor_reaches() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:active .b { color: red }");
    let a = doc.classed("div", ROOT, "a");
    let b = doc.classed("p", a, "b");
    doc.flush();
    press(&mut doc, Some(b));
    assert!(red(&doc, b));
    press(&mut doc, None);
    assert!(!red(&doc, b));
}

#[test]
fn a_state_inside_not_and_is_is_live_outside_the_subject() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":not(.off:hover) > .a { color: red } :is(.x:hover, .y) .b { top: 1px }");
    let parent = doc.classed("div", ROOT, "off");
    let a = doc.classed("p", parent, "a");
    let host = doc.classed("div", ROOT, "x");
    let b = doc.classed("p", host, "b");
    doc.flush();
    assert!(red(&doc, a));
    assert_eq!(top(&doc, b), None);
    hover(&mut doc, Some(a));
    assert!(!red(&doc, a), "the parent is hovered");
    hover(&mut doc, Some(b));
    assert!(red(&doc, a));
    assert_eq!(top(&doc, b), Some(1.0));
}

#[test]
fn tailwinds_group_hover_matches_inside_a_hover_media_query() {
    let mut doc = Doc::new();
    doc.tree.set_media_environment(MediaEnvironment {
        width: 800.0,
        height: 600.0,
        scale_factor: 2.0,
        color_scheme: Scheme::Light,
        reduced_motion: false,
        increased_contrast: false,
        forced_colors: false,
    });
    doc.style_element(
        ROOT,
        r"@layer utilities {
            .group-hover\:text-red-500 {
                &:is(:where(.group):hover *) {
                    @media (hover: hover) { color: red }
                }
            }
            .peer-focus\:top-4 { &:is(:where(.peer):focus ~ *) { top: 4px } }
        }
        @media (hover: hover) { .group-hover\:left-2:is(:where(.group):hover *) { left: 2px } }",
    );
    let group = doc.classed("div", ROOT, "group");
    let inner = doc.classed("div", group, "");
    let text = doc.classed("p", inner, "group-hover:text-red-500 group-hover:left-2");
    let outside = doc.classed("p", ROOT, "group-hover:text-red-500 group-hover:left-2");
    let peer = doc.classed("input", ROOT, "peer");
    let sibling = doc.classed("p", ROOT, "peer-focus:top-4");
    doc.flush();
    assert!(!red(&doc, text));
    hover(&mut doc, Some(inner));
    assert!(red(&doc, text) && !red(&doc, outside));
    assert_eq!(left(&doc, text), Some(2.0));
    hover(&mut doc, None);
    assert!(!red(&doc, text));
    focus(&mut doc, Some(peer), true);
    assert_eq!(top(&doc, sibling), Some(4.0));
}

#[test]
fn a_subject_state_stays_a_style_block_beside_a_live_one() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:hover .title:hover { color: red }");
    let card = doc.classed("div", ROOT, "card");
    let title = doc.classed("p", card, "title");
    doc.flush();
    let hover_color = |doc: &Doc| doc.style(title).and_then(|style| style.hover.as_ref()).and_then(|hover| hover.color.clone());
    assert_eq!(hover_color(&doc), None);
    hover(&mut doc, Some(title));
    assert_eq!(hover_color(&doc).as_deref(), Some("red"), "the title's own `:hover` is the `hover` block");
    assert_eq!(doc.color(title), None, "and is not applied by the sheets");
    hover(&mut doc, None);
    assert_eq!(hover_color(&doc), None);
}

#[test]
fn a_document_without_a_live_state_does_nothing_for_the_pointer_and_the_focus() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:hover { color: red } .a:focus-within { top: 1px } .b:hover { opacity: 0.5 }");
    let a = doc.classed("div", ROOT, "a");
    let inner = doc.classed("p", a, "b");
    doc.flush();
    assert!(!doc.tree.live_states_wanted());
    crate::perf_counters::reset();
    assert_eq!(doc.tree.sync_live_states(&LiveInputs::pointer(&chain(&doc, inner), &chain(&doc, inner))), Dirty::Clean);
    assert_eq!(doc.tree.sync_live_states(&LiveInputs::focus(&chain(&doc, inner), Some(inner))), Dirty::Clean);
    assert_eq!(counts().elements_rematched, 0);
    assert!(doc.tree.sheets.live.is_empty(), "nothing is held");
}

#[test]
fn a_state_no_rule_reads_live_is_not_held_or_matched() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:hover .title { color: red } .card:focus { top: 1px }");
    let card = doc.classed("div", ROOT, "card");
    let title = doc.classed("p", card, "title");
    doc.flush();
    assert_eq!(focus(&mut doc, Some(title), true), 0, "no selector reads `:focus` outside its subject");
    assert!(doc.tree.sheets.live.is_empty());
    press(&mut doc, Some(title));
    assert!(doc.tree.sheets.live.is_empty());
    hover(&mut doc, Some(title));
    assert!(!doc.tree.sheets.live.is_empty());
}

#[test]
fn the_bits_go_when_the_last_live_rule_does() {
    let mut doc = Doc::new();
    let (_, text) = doc.style_element(ROOT, ".card:hover .title { color: red }");
    let card = doc.classed("div", ROOT, "card");
    let title = doc.classed("p", card, "title");
    doc.flush();
    hover(&mut doc, Some(title));
    assert!(red(&doc, title));
    doc.tree.set_text(text, ".title { top: 1px }".to_owned());
    doc.flush();
    assert!(!red(&doc, title));
    assert!(!doc.tree.live_states_wanted());
    hover(&mut doc, Some(card));
    assert!(doc.tree.sheets.live.is_empty());
}

#[test]
fn a_sheet_loaded_under_the_pointer_applies_at_the_next_report() {
    let mut doc = Doc::new();
    let card = doc.classed("div", ROOT, "card");
    let title = doc.classed("p", card, "title");
    doc.flush();
    doc.style_element(ROOT, ".card:hover .title { color: red }");
    doc.flush();
    assert!(!red(&doc, title), "the sheets have not been told where the pointer is");
    hover(&mut doc, Some(title));
    assert!(red(&doc, title));
}

#[test]
fn a_tree_change_while_hovered_matches_as_the_state_says() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:hover .title { color: red }");
    let card = doc.classed("div", ROOT, "card");
    doc.flush();
    hover(&mut doc, Some(card));
    let late = doc.classed("p", card, "title");
    doc.flush();
    assert!(red(&doc, late), "an element that mounts under a hovered card matches at once");
}
