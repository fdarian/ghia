//! `:has()` (`css::sheet::has`): that an anchor follows what comes, goes, moves and changes below,
//! after and around it, that the document an edit leaves is the one a fresh match of the same tree
//! makes, and that a change marks only the anchors that can have changed.

use serde_json::json;

use super::positions::same_as_fresh_in;
use super::{counts, Doc, ROOT};

fn red(doc: &Doc, id: u64) -> bool {
    doc.color(id) == Some("red")
}

fn blue(doc: &Doc, id: u64) -> bool {
    doc.background(id) == Some("blue")
}

fn faded(doc: &Doc, id: u64) -> bool {
    doc.style(id).and_then(|style| style.opacity) == Some(0.5)
}

fn raised(doc: &Doc, id: u64) -> bool {
    doc.style(id).is_some_and(|style| style.top.is_some())
}

fn searches() -> usize {
    crate::css::sheet::has::SEARCHES.with(|count| count.get())
}

fn reset_searches() {
    crate::css::sheet::has::SEARCHES.with(|count| count.set(0));
}

// Correctness.

#[test]
fn a_child_that_matches_comes_goes_and_moves() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".btn:has(> svg) { color: red }");
    let btn = doc.classed("button", ROOT, "btn");
    let other = doc.classed("button", ROOT, "btn");
    doc.flush();
    assert!(!red(&doc, btn));

    let svg = doc.element("svg", btn);
    doc.flush();
    assert!(red(&doc, btn) && !red(&doc, other));

    let span = doc.element("span", btn);
    doc.flush();
    assert!(red(&doc, btn), "a child that does not match changes nothing");
    doc.tree.destroy_element(svg);
    doc.flush();
    assert!(!red(&doc, btn));

    let deep = doc.element("svg", span);
    doc.flush();
    assert!(!red(&doc, btn), "a grandchild is not a child");
    doc.tree.append_child(btn, deep);
    doc.flush();
    assert!(red(&doc, btn), "moved up to be a child");
    doc.tree.append_child(other, deep);
    doc.flush();
    assert!(!red(&doc, btn) && red(&doc, other), "moved to the other");
    doc.tree.detach_child(deep);
    doc.flush();
    assert!(!red(&doc, other), "taken out of the document");
    doc.tree.append_child(btn, deep);
    doc.flush();
    assert!(red(&doc, btn) && !red(&doc, other), "and put back");
}

#[test]
fn a_subtree_built_apart_and_put_in_makes_its_anchors_match() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".btn:has(> svg) { color: red } .card:has(.err) .title { background-color: blue }");
    let outer = doc.make("div");
    let btn = doc.make("button");
    doc.class(btn, "btn");
    let svg = doc.make("svg");
    doc.tree.append_child(btn, svg);
    doc.tree.append_child(outer, btn);
    let card = doc.make("div");
    doc.class(card, "card");
    let title = doc.make("h2");
    doc.class(title, "title");
    let err = doc.make("i");
    doc.class(err, "err");
    doc.tree.append_child(card, title);
    doc.tree.append_child(card, err);
    doc.tree.append_child(outer, card);
    doc.tree.append_child(ROOT, outer);
    doc.flush();
    assert!(red(&doc, btn));
    assert!(blue(&doc, title));
}

#[test]
fn a_class_that_changes_deep_inside_marks_the_ancestors_that_read_it() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:has(.err) .title { background-color: blue }");
    let card = doc.classed("div", ROOT, "card");
    let title = doc.classed("h2", card, "title");
    let section = doc.element("section", card);
    let inner = doc.element("div", section);
    let target = doc.classed("p", inner, "plain");
    let outside = doc.classed("h2", ROOT, "title");
    doc.flush();
    assert!(!blue(&doc, title) && !blue(&doc, outside));

    doc.class(target, "plain err");
    doc.flush();
    assert!(blue(&doc, title) && !blue(&doc, outside));
    doc.class(target, "plain");
    doc.flush();
    assert!(!blue(&doc, title));

    doc.class(card, "card err");
    doc.flush();
    assert!(!blue(&doc, title), "the anchor is not its own descendant");

    doc.class(card, "card");
    let inner_card = doc.classed("div", section, "card");
    let inner_title = doc.classed("h2", inner_card, "title");
    doc.classed("i", inner_card, "err");
    doc.flush();
    assert!(blue(&doc, inner_title) && blue(&doc, title), "the outer card has it below, at any depth");
}

#[test]
fn an_id_an_attribute_and_a_style_read_inside_an_argument_are_followed() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "div:has(#hit) { color: red } div:has([data-k=v]) { opacity: 0.5 } div:has([style*=\"width\"]) { top: 1px }");
    let host = doc.element("div", ROOT);
    let inner = doc.element("span", host);
    doc.flush();
    assert!(!red(&doc, host) && !faded(&doc, host) && !raised(&doc, host));

    doc.tree.set_attribute(inner, "id", Some("hit".into()));
    doc.flush();
    assert!(red(&doc, host));
    doc.tree.set_attribute(inner, "id", Some("miss".into()));
    doc.flush();
    assert!(!red(&doc, host));

    doc.tree.set_attribute(inner, "data-k", Some("v".into()));
    doc.flush();
    assert!(faded(&doc, host));
    doc.tree.set_attribute(inner, "data-k", Some("w".into()));
    doc.flush();
    assert!(!faded(&doc, host));

    let style = doc.tree.styles.intern(br#"{"width":10}"#).unwrap();
    doc.tree.set_style(inner, style);
    doc.flush();
    assert!(raised(&doc, host), "[style] inside :has() reads the own style");
}

#[test]
fn a_sibling_search_follows_what_comes_between_and_after() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "h1:has(+ p) { opacity: 0.5 } h2:has(~ .go) { color: red }");
    let h1 = doc.element("h1", ROOT);
    let p = doc.element("p", ROOT);
    doc.flush();
    assert!(faded(&doc, h1));

    let between = doc.make("div");
    doc.tree.insert_before(ROOT, between, p);
    doc.flush();
    assert!(!faded(&doc, h1), "something came between");
    doc.tree.destroy_element(between);
    doc.flush();
    assert!(faded(&doc, h1), "and went");
    doc.tree.destroy_element(p);
    doc.flush();
    assert!(!faded(&doc, h1));
    let again = doc.element("p", ROOT);
    doc.flush();
    assert!(faded(&doc, h1));
    doc.tree.append_child(h1, again);
    doc.flush();
    assert!(!faded(&doc, h1), "moved away");

    let h2 = doc.element("h2", ROOT);
    let middle = doc.element("div", ROOT);
    let later = doc.element("div", ROOT);
    doc.flush();
    assert!(!red(&doc, h2));
    doc.class(later, "go");
    doc.flush();
    assert!(red(&doc, h2), "a following sibling, not the next");
    doc.tree.destroy_element(middle);
    doc.flush();
    assert!(red(&doc, h2));
    doc.tree.set_attribute(later, "class", None);
    doc.flush();
    assert!(!red(&doc, h2));
}

#[test]
fn a_sibling_that_comes_or_goes_in_the_middle_of_a_run_changes_the_anchor() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:has(+ .b + .c) { color: red }");
    let a = doc.classed("div", ROOT, "a");
    let b = doc.classed("div", ROOT, "b");
    let c = doc.classed("div", ROOT, "c");
    doc.flush();
    assert!(red(&doc, a));
    let between = doc.make("div");
    doc.tree.insert_before(ROOT, between, c);
    doc.flush();
    assert!(!red(&doc, a), "in the way between the second and the third");
    doc.tree.destroy_element(between);
    doc.flush();
    assert!(red(&doc, a));
    let before_b = doc.make("div");
    doc.tree.insert_before(ROOT, before_b, b);
    doc.flush();
    assert!(!red(&doc, a), "in the way between the anchor and the second");
    doc.tree.destroy_element(before_b);
    doc.flush();
    assert!(red(&doc, a));
}

#[test]
fn a_chain_of_children_marks_the_ancestor_at_its_length_and_no_other() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:has(> .b > .c) { top: 1px }");
    let wrapper = doc.element("div", ROOT);
    let a = doc.classed("div", wrapper, "a");
    let b = doc.classed("div", a, "b");
    let c = doc.classed("div", b, "x");
    doc.flush();
    assert!(!raised(&doc, a));

    assert_eq!(doc.rematched(|doc| doc.class(c, "c")), 1, "the grandparent");
    assert!(raised(&doc, a));
    assert_eq!(doc.rematched(|doc| doc.class(b, "x")), 1, "the parent of `.b`");
    assert!(!raised(&doc, a));
    assert_eq!(doc.rematched(|doc| doc.class(b, "b")), 1);
    assert!(raised(&doc, a));
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(c).clear()), 1);
    assert!(!raised(&doc, a));
}

#[test]
fn a_sibling_followed_by_a_descendant_reads_the_siblings_of_the_ancestors() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".x:has(+ .y .z) { top: 1px }");
    let x = doc.classed("div", ROOT, "x");
    let y = doc.classed("div", ROOT, "y");
    let wrap = doc.element("div", y);
    doc.flush();
    assert!(!raised(&doc, x));

    let z = doc.classed("span", wrap, "z");
    doc.flush();
    assert!(raised(&doc, x));
    assert_eq!(doc.rematched(|doc| doc.class(z, "w")), 1, "the anchor only");
    assert!(!raised(&doc, x));
    assert_eq!(doc.rematched(|doc| doc.class(z, "z")), 1);
    assert!(raised(&doc, x));

    doc.tree.destroy_element(z);
    doc.flush();
    assert!(!raised(&doc, x));
    let sub = doc.make("div");
    let z2 = doc.make("span");
    doc.class(z2, "z");
    doc.tree.append_child(sub, z2);
    doc.tree.append_child(y, sub);
    doc.flush();
    assert!(raised(&doc, x), "a subtree that holds it came into the sibling");

    let between = doc.make("div");
    doc.tree.insert_before(ROOT, between, y);
    doc.flush();
    assert!(!raised(&doc, x), "it is no longer the next sibling");
}

#[test]
fn an_anchor_that_is_not_the_subject_restyles_what_the_rest_of_the_selector_leads_to() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:has(.k) + .b { color: red } .a:has(.k) .t { opacity: 0.5 }");
    let a = doc.classed("div", ROOT, "a");
    let t = doc.classed("span", a, "t");
    let deep = doc.classed("span", t, "q");
    let b = doc.classed("div", ROOT, "b");
    doc.flush();
    assert!(!red(&doc, b) && !faded(&doc, t));

    assert_eq!(doc.rematched(|doc| doc.class(deep, "k")), 3, "the next sibling and the two below the anchor");
    assert!(red(&doc, b) && faded(&doc, t));
    doc.class(deep, "q");
    doc.flush();
    assert!(!red(&doc, b) && !faded(&doc, t));
}

#[test]
fn a_tree_state_inside_an_argument_follows_a_click_and_a_prop() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".field:has(input:checked) .label { top: 1px } .group:has(:disabled) { color: red }");
    let field = doc.classed("div", ROOT, "field");
    let label = doc.classed("span", field, "label");
    let input = doc.element("input", field);
    doc.tree.set_custom_prop(input, "type".into(), json!("checkbox"));
    let group = doc.classed("div", ROOT, "group");
    let button = doc.element("button", group);
    doc.flush();
    assert!(!raised(&doc, label) && !red(&doc, group));

    crate::perf_counters::reset();
    assert!(doc.tree.pre_activate(input));
    doc.tree.take_dirty_restyled();
    doc.tree.finish_activation(input);
    assert!(raised(&doc, label));
    assert_eq!(counts().elements_rematched, 2, "what is below the field");
    assert!(doc.tree.pre_activate(input));
    doc.tree.take_dirty_restyled();
    doc.tree.finish_activation(input);
    assert!(!raised(&doc, label));

    assert_eq!(doc.rematched(|doc| doc.tree.set_custom_prop(button, "disabled".into(), json!(true))), 1);
    assert!(red(&doc, group));
    doc.tree.set_custom_prop(button, "disabled".into(), serde_json::Value::Null);
    doc.flush();
    assert!(!red(&doc, group));
}

#[test]
fn a_position_read_inside_an_argument_follows_the_children_and_the_text() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".l:has(> .m:first-child) { color: red } .e:has(> :empty) { opacity: 0.5 }");
    let l = doc.classed("div", ROOT, "l");
    let first = doc.classed("div", l, "x");
    let m = doc.classed("div", l, "m");
    doc.flush();
    assert!(!red(&doc, l));

    doc.tree.destroy_element(first);
    doc.flush();
    assert!(red(&doc, l), "the `.m` is the first child now");
    let before = doc.make("div");
    doc.tree.insert_before(l, before, m);
    doc.flush();
    assert!(!red(&doc, l));

    let e = doc.classed("div", ROOT, "e");
    let leaf = doc.element("span", e);
    doc.flush();
    assert!(faded(&doc, e));
    let text = doc.element("#text", leaf);
    doc.tree.set_text(text, "hi".into());
    doc.flush();
    assert!(!faded(&doc, e), "the child is not empty any more");
    doc.tree.set_text(text, String::new());
    doc.flush();
    assert!(faded(&doc, e));
}

#[test]
fn a_has_in_a_nested_rule_and_under_not_names_its_anchor_by_the_enclosing_compound() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card { &:has(> .err) { color: red } } div:not(:has(> p)) { opacity: 0.5 }");
    let card = doc.classed("div", ROOT, "card");
    let host = doc.element("div", ROOT);
    doc.flush();
    assert!(!red(&doc, card));
    assert!(faded(&doc, card) && faded(&doc, host));

    doc.classed("i", card, "err");
    let p = doc.element("p", host);
    doc.flush();
    assert!(red(&doc, card));
    assert!(!faded(&doc, host) && faded(&doc, card));
    doc.tree.destroy_element(p);
    doc.flush();
    assert!(faded(&doc, host));
}

#[test]
fn a_combinator_inside_is_in_an_argument_is_followed_from_wherever_its_feature_changes() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a:has(:is(.b .c)) { color: red }");
    let a = doc.classed("div", ROOT, "a");
    let mid = doc.classed("div", a, "m");
    doc.classed("div", mid, "c");
    doc.flush();
    assert!(!red(&doc, a));

    doc.class(mid, "m b");
    doc.flush();
    assert!(red(&doc, a));
    doc.class(mid, "m");
    doc.flush();
    assert!(!red(&doc, a));
    doc.class(ROOT, "b");
    doc.flush();
    assert!(red(&doc, a), "`.b` above the anchor");
}

#[test]
fn a_has_with_a_universal_anchor_is_followed() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ":has(> .big) { color: red }");
    let host = doc.element("div", ROOT);
    let child = doc.element("span", host);
    doc.flush();
    assert!(!red(&doc, host));
    doc.class(child, "big");
    doc.flush();
    assert!(red(&doc, host));
    let sibling_host = doc.element("section", ROOT);
    doc.tree.append_child(sibling_host, child);
    doc.flush();
    assert!(!red(&doc, host) && red(&doc, sibling_host));
}

// Cost: what a change marks.

#[test]
fn a_has_asked_of_one_element_by_many_subjects_is_searched_once() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:has(.err) .title { background-color: blue }");
    let card = doc.classed("div", ROOT, "card");
    let titles: Vec<u64> = (0..100).map(|_| doc.classed("h2", card, "title")).collect();
    doc.classed("i", card, "err");
    reset_searches();
    doc.flush();
    assert_eq!(searches(), 1, "one card, one answer");
    assert!(titles.iter().all(|title| blue(&doc, *title)));
}

#[test]
fn appending_a_row_to_a_long_list_of_other_things_matches_only_the_row() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".btn:has(> svg) { color: red }");
    let ul = doc.element("ul", ROOT);
    doc.run(1000, "li", ul, "x");
    doc.flush();
    assert_eq!(doc.rematched(|doc| _ = doc.classed("li", ul, "x")), 1);
}

#[test]
fn adding_to_one_button_matches_that_button_and_what_was_added() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".btn:has(> svg) { color: red }");
    let list = doc.element("div", ROOT);
    let buttons = doc.run(100, "button", list, "btn");
    doc.run(100, "li", list, "x");
    doc.flush();
    let mut svg = 0;
    assert_eq!(doc.rematched(|doc| svg = doc.element("svg", buttons[40])), 2);
    assert!(red(&doc, buttons[40]) && !red(&doc, buttons[41]));
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(svg).clear()), 1, "only the button, the svg is gone");
    assert!(!red(&doc, buttons[40]));
}

#[test]
fn a_sheet_without_has_marks_nothing_for_what_comes_and_goes_below() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".btn { color: red }");
    let button = doc.classed("button", ROOT, "btn");
    doc.flush();
    assert!(!doc.tree.sheets.index.invalidation.has.is_used());
    let mut svg = 0;
    assert_eq!(doc.rematched(|doc| svg = doc.element("svg", button)), 1);
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(svg).clear()), 0);
}

#[test]
fn a_class_change_below_an_anchor_that_does_not_hold_its_key_marks_nothing() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".card:has(.err) .title { background-color: blue }");
    let list = doc.element("div", ROOT);
    let rows = doc.run(1000, "div", list, "row");
    let cards = doc.run(50, "div", list, "card");
    let section = doc.element("section", cards[7]);
    let title = doc.classed("h2", cards[7], "title");
    let target = doc.classed("p", section, "plain");
    doc.flush();
    assert_eq!(doc.rematched(|doc| doc.class(rows[500], "row err")), 0, "no card above it");
    assert_eq!(doc.rematched(|doc| doc.class(target, "plain err")), 3, "what is below its card");
    assert!(blue(&doc, title));
}

// Reload.

#[test]
fn a_rule_with_a_has_and_a_key_reloads_by_its_key_and_a_has_alone_reloads_everything() {
    let scoped = || crate::css::sheet::reload::SCOPED_RELOADS.with(|count| count.get());
    let mut doc = Doc::new();
    let items: Vec<u64> = (0..60).map(|index| doc.classed("div", ROOT, if index < 3 { "item mark" } else { "item" })).collect();
    doc.element("svg", items[1]);
    let base = ".item { color: red }";
    doc.set_adopted(base);
    doc.flush();

    let before = scoped();
    crate::perf_counters::reset();
    doc.set_adopted(&format!("{base} .mark:has(> svg) {{ top: 1px }}"));
    doc.flush();
    assert_eq!(scoped(), before + 1, "scoped, by `.mark`");
    assert_eq!(counts().elements_rematched, 3);
    assert!(raised(&doc, items[1]) && !raised(&doc, items[0]));

    let before = scoped();
    crate::perf_counters::reset();
    doc.set_adopted(&format!("{base} .mark:has(> svg) {{ top: 1px }} :has(> svg) {{ opacity: 0.5 }}"));
    doc.flush();
    assert_eq!(scoped(), before, "a subject with nothing but a `:has()` cannot be found by a feature");
    assert!(counts().elements_rematched > 60);
    assert!(faded(&doc, items[1]) && !faded(&doc, items[0]));
}

// What a fresh match makes.

const EVERY_SHAPE: &str = "
.btn:has(> svg) { color: red }
.card:has(.err) .title { background-color: blue }
h1:has(+ p) { opacity: 0.5 }
.row:has(~ .done) { padding-top: 1px }
.a:has(> .b > .c) { margin-left: 1px }
.x:has(+ .y .z) { margin-right: 2px }
.l:has(> .m:first-child) { margin-bottom: 1px }
.card:has(> .err, + .done) { margin-top: 1px }
div:not(:has(> p)) { padding-left: 2px }
:is(.row, .btn):has(~ h1 + p) { padding-right: 1px }
.card:has(.err) + .row { padding-bottom: 1px }
:has(> .big) { right: 1px }
.a:has(+ .b + .c) { bottom: 1px }
li:has(:empty) { top: 1px }
";

const TAGS: [&str; 6] = ["div", "p", "svg", "span", "h1", "li"];
const CLASSES: [&str; 14] = ["btn", "card", "err", "title", "row", "done", "a", "b", "c", "x", "y", "z", "m", "big"];

struct Random(u64);

impl Random {
    fn next(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % bound as u64) as usize
    }

    fn classes(&mut self) -> String {
        let count = self.next(3);
        (0..count).map(|_| CLASSES[self.next(CLASSES.len())]).collect::<Vec<_>>().join(" ")
    }
}

fn is_inside(doc: &Doc, mut at: u64, ancestor: u64) -> bool {
    loop {
        if at == ancestor {
            return true;
        }
        match doc.tree.elements.get(&at).and_then(|element| element.parent) {
            Some(parent) => at = parent,
            None => return false,
        }
    }
}

fn place(doc: &mut Doc, random: &mut Random, parent: u64, id: u64) {
    let children = doc.tree.elements[&parent].children.clone();
    match children.get(random.next(children.len() + 1)) {
        Some(before) if *before != id => doc.tree.insert_before(parent, id, *before),
        _ => doc.tree.append_child(parent, id),
    }
}

/// Pseudo-random edits of a nested tree, each checked against a fresh match: under each rule alone,
/// which tells which one a failure is of, and under all of them.
#[test]
fn random_edits_leave_what_a_fresh_match_makes() {
    for rule in EVERY_SHAPE.lines().filter(|rule| !rule.is_empty()).chain([EVERY_SHAPE]) {
        for seed in [0x2545_f491_4f6c_dd1du64, 0x9e37_79b9_7f4a_7c15, 0x1234_5678_9abc_def1] {
            random_edits(rule, seed);
        }
    }
}

fn random_edits(css: &str, seed: u64) {
    {
        let mut random = Random(seed);
        let mut doc = Doc::new();
        doc.style_element(ROOT, css);
        // Below the `<style>`, which would otherwise shift the elements it is among against a fresh build.
        let host = doc.element("div", ROOT);
        let mut live: Vec<u64> = Vec::new();
        for _ in 0..12 {
            let id = doc.make(TAGS[random.next(TAGS.len())]);
            let classes = random.classes();
            doc.class(id, &classes);
            let parent = if live.is_empty() || random.next(3) == 0 { host } else { live[random.next(live.len())] };
            place(&mut doc, &mut random, parent, id);
            live.push(id);
        }
        doc.flush();
        for round in 0..70 {
            for _ in 0..1 + random.next(3) {
                match random.next(6) {
                    0 | 1 if live.len() < 45 => {
                        let id = doc.make(TAGS[random.next(TAGS.len())]);
                        let classes = random.classes();
                        doc.class(id, &classes);
                        let parent = if live.is_empty() || random.next(4) == 0 { host } else { live[random.next(live.len())] };
                        place(&mut doc, &mut random, parent, id);
                        live.push(id);
                    }
                    2 if live.len() > 2 => {
                        let id = live[random.next(live.len())];
                        doc.tree.destroy_element(id);
                        live.retain(|id| doc.tree.elements.contains_key(id));
                    }
                    3 if live.len() > 2 => {
                        let id = live[random.next(live.len())];
                        let parent = if random.next(4) == 0 { host } else { live[random.next(live.len())] };
                        if !is_inside(&doc, parent, id) {
                            place(&mut doc, &mut random, parent, id);
                        }
                    }
                    4 if !live.is_empty() => {
                        let id = live[random.next(live.len())];
                        let classes = random.classes();
                        doc.class(id, &classes);
                    }
                    5 if live.len() < 45 => {
                        // A subtree built apart, then put in.
                        let top = doc.make(TAGS[random.next(TAGS.len())]);
                        let classes = random.classes();
                        doc.class(top, &classes);
                        let mut made = vec![top];
                        for _ in 0..1 + random.next(3) {
                            let id = doc.make(TAGS[random.next(TAGS.len())]);
                            let classes = random.classes();
                            doc.class(id, &classes);
                            doc.tree.append_child(made[random.next(made.len())], id);
                            made.push(id);
                        }
                        let parent = if live.is_empty() || random.next(3) == 0 { host } else { live[random.next(live.len())] };
                        place(&mut doc, &mut random, parent, top);
                        live.extend(made);
                    }
                    _ => {}
                }
            }
            doc.flush();
            same_as_fresh_in(&doc, css, &format!("{}, seed {seed:x}, round {round}", css.trim()), false);
        }
    }
}
