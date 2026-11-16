//! The structural pseudo-classes (`css::sheet::positions`): what a child coming, going or moving
//! marks, and that the document it leaves is the one a fresh match of the same tree makes.

use super::{counts, reset_sibling_work, sibling_work, Doc, ROOT};

/// A `<ul>` of `count` classed `<li>` under a sheet, flushed.
fn list(css: &str, count: usize) -> (Doc, u64, Vec<u64>) {
    let mut doc = Doc::new();
    doc.style_element(ROOT, css);
    let ul = doc.element("ul", ROOT);
    let items = doc.run(count, "li", ul, "x");
    doc.flush();
    (doc, ul, items)
}

/// Whether the property a rule sets reads as set: `color` for the first of a rule list and so on.
fn red(doc: &Doc, id: u64) -> bool {
    doc.color(id) == Some("red")
}

// A document as a tree of what a selector reads, to build again from nothing.

struct Node {
    tag: String,
    class: Option<String>,
    text: Option<String>,
    children: Vec<Node>,
}

fn snapshot(doc: &Doc, id: u64) -> Node {
    let element = &doc.tree.elements[&id];
    Node {
        tag: element.element_type.clone(),
        class: element.attribute("class").map(|class| class.into_owned()),
        text: element.content.clone(),
        children: element.children.iter().map(|child| snapshot(doc, *child)).collect(),
    }
}

fn rebuild(doc: &mut Doc, node: &Node, parent: u64) {
    let id = doc.make(&node.tag);
    if let Some(class) = &node.class {
        doc.class(id, class);
    }
    if let Some(text) = &node.text {
        doc.tree.set_text(id, text.clone());
    }
    doc.tree.append_child(parent, id);
    for child in &node.children {
        rebuild(doc, child, id);
    }
}

fn in_order(doc: &Doc, id: u64, out: &mut Vec<u64>) {
    out.push(id);
    for child in &doc.tree.elements[&id].children {
        in_order(doc, *child, out);
    }
}

/// Panics unless every element of `doc` has the style and the matched rules a fresh match of the
/// same tree gives it.
fn same_as_fresh(doc: &Doc, css: &str, step: &str) {
    let mut fresh = Doc::new();
    fresh.style_element(ROOT, css);
    for child in &doc.tree.elements[&ROOT].children {
        if doc.tree.elements[child].element_type != "style" {
            rebuild(&mut fresh, &snapshot(doc, *child), ROOT);
        }
    }
    fresh.flush();
    let (mut mine, mut theirs) = (Vec::new(), Vec::new());
    in_order(doc, ROOT, &mut mine);
    in_order(&fresh, ROOT, &mut theirs);
    assert_eq!(mine.len(), theirs.len(), "{step}");
    for (position, (mine, theirs)) in mine.iter().zip(&theirs).enumerate() {
        let (mine, theirs) = (&doc.tree.elements[mine], &fresh.tree.elements[theirs]);
        let describe = || format!("{step}: element {position} ({}, {:?})", mine.element_type, mine.attribute("class"));
        assert_eq!(mine.style.as_deref(), theirs.style.as_deref(), "{}", describe());
        let matched = |element: &crate::retained_tree::RetainedElement| {
            element.css().and_then(|css| css.matched.as_ref()).map(|matched| (matched.normal.clone(), matched.important.clone()))
        };
        assert_eq!(matched(mine), matched(theirs), "{}", describe());
    }
}

/// One rule for each kind of pseudo-class, each setting its own property so a missed element shows.
const EVERY_KIND: &str = "
li:first-child { color: red }
li:last-child { background-color: blue }
li:only-child { opacity: 0.5 }
li:nth-child(odd) { padding-top: 1px }
li:nth-last-child(3n+1) { padding-left: 2px }
li:first-of-type { margin-top: 1px }
li:last-of-type { margin-left: 3px }
p:only-of-type { margin-right: 2px }
:is(li, p):nth-of-type(2) { top: 1px }
li:nth-last-of-type(2) { left: 1px }
li:empty { right: 1px }
li:first-child .label { bottom: 1px }
li:first-child + li { width: 1px }
li:not(:last-child):not(:empty) { height: 1px }
";

#[test]
fn first_and_last_child_follow_inserts_and_removals() {
    let (mut doc, ul, items) = list("li:first-child { color: red } li:last-child { background-color: blue }", 3);
    assert!(red(&doc, items[0]) && !red(&doc, items[1]) && !red(&doc, items[2]));
    assert_eq!(doc.background(items[2]), Some("blue"));

    let appended = doc.classed("li", ul, "x");
    doc.flush();
    assert_eq!(doc.background(items[2]), None, "no longer last");
    assert_eq!(doc.background(appended), Some("blue"));

    let prepended = doc.make("li");
    doc.tree.insert_before(ul, prepended, items[0]);
    doc.flush();
    assert!(!red(&doc, items[0]), "no longer first");
    assert!(red(&doc, prepended));

    doc.tree.destroy_element(prepended);
    doc.flush();
    assert!(red(&doc, items[0]), "first again");
    doc.tree.destroy_element(appended);
    doc.flush();
    assert_eq!(doc.background(items[2]), Some("blue"), "last again");
    doc.tree.destroy_element(items[1]);
    doc.flush();
    assert!(red(&doc, items[0]) && doc.background(items[2]) == Some("blue"));
}

#[test]
fn only_child_follows_the_second_child_coming_and_going() {
    let (mut doc, ul, items) = list("li:only-child { color: red }", 1);
    assert!(red(&doc, items[0]));
    let second = doc.classed("li", ul, "x");
    doc.flush();
    assert!(!red(&doc, items[0]) && !red(&doc, second));
    doc.tree.destroy_element(items[0]);
    doc.flush();
    assert!(red(&doc, second));
}

#[test]
fn nth_child_follows_every_sibling_after_a_change() {
    let (mut doc, ul, items) = list("li:nth-child(odd) { color: red }", 5);
    let colored = |doc: &Doc, items: &[u64]| items.iter().map(|id| red(doc, *id)).collect::<Vec<_>>();
    assert_eq!(colored(&doc, &items), [true, false, true, false, true]);
    let first = doc.make("li");
    doc.tree.insert_before(ul, first, items[0]);
    doc.flush();
    assert_eq!(colored(&doc, &items), [false, true, false, true, false]);
    assert!(red(&doc, first));
    doc.tree.destroy_element(items[1]);
    doc.flush();
    assert_eq!(colored(&doc, &[items[0], items[2], items[3], items[4]]), [false, true, false, true]);
}

#[test]
fn nth_last_child_follows_every_sibling_before_a_change() {
    let (mut doc, ul, items) = list("li:nth-last-child(odd) { color: red }", 5);
    let colored = |doc: &Doc, items: &[u64]| items.iter().map(|id| red(doc, *id)).collect::<Vec<_>>();
    assert_eq!(colored(&doc, &items), [true, false, true, false, true]);
    let last = doc.classed("li", ul, "x");
    doc.flush();
    assert_eq!(colored(&doc, &items), [false, true, false, true, false]);
    assert!(red(&doc, last));
    doc.tree.destroy_element(items[3]);
    doc.flush();
    assert_eq!(colored(&doc, &[items[0], items[1], items[2], items[4], last]), [true, false, true, false, true]);
}

#[test]
fn of_type_pseudo_classes_count_only_their_type() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "li:first-of-type { color: red } li:last-of-type { background-color: blue } p:only-of-type { opacity: 0.5 }");
    let ul = doc.element("ul", ROOT);
    let heading = doc.element("p", ul);
    let first = doc.element("li", ul);
    let middle = doc.element("li", ul);
    let last = doc.element("li", ul);
    doc.flush();
    assert!(red(&doc, first) && !red(&doc, middle));
    assert_eq!(doc.background(last), Some("blue"));
    assert_eq!(doc.style(heading).and_then(|style| style.opacity), Some(0.5));

    let before = doc.make("li");
    doc.tree.insert_before(ul, before, heading);
    doc.flush();
    assert!(red(&doc, before) && !red(&doc, first), "an li before the p is now the first li, whatever sits between");
    let second_p = doc.element("p", ul);
    doc.flush();
    assert_eq!(doc.style(heading).and_then(|style| style.opacity), None);
    assert_eq!(doc.style(second_p).and_then(|style| style.opacity), None);
    doc.tree.destroy_element(heading);
    doc.flush();
    assert_eq!(doc.style(second_p).and_then(|style| style.opacity), Some(0.5), "no p before it any more");
}

#[test]
fn an_html_type_compares_without_case() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, "li:first-of-type { color: red }");
    let ul = doc.element("ul", ROOT);
    let upper = doc.element("LI", ul);
    let lower = doc.element("li", ul);
    doc.flush();
    assert!(red(&doc, upper) && !red(&doc, lower), "`LI` and `li` are one type");
}

#[test]
fn empty_follows_children_and_text() {
    let (mut doc, _, items) = list("li:empty { color: red }", 2);
    assert!(red(&doc, items[0]) && red(&doc, items[1]));

    let child = doc.element("span", items[0]);
    doc.flush();
    assert!(!red(&doc, items[0]), "an element child");
    doc.tree.destroy_element(child);
    doc.flush();
    assert!(red(&doc, items[0]), "and gone");

    let text = doc.element("#text", items[1]);
    doc.flush();
    assert!(red(&doc, items[1]), "a text node with no text is nothing");
    doc.tree.set_text(text, " ".into());
    doc.flush();
    assert!(!red(&doc, items[1]), "whitespace is text");
    doc.tree.set_text(text, String::new());
    doc.flush();
    assert!(red(&doc, items[1]), "emptied");
    doc.tree.set_text(text, "a".into());
    doc.flush();
    assert!(!red(&doc, items[1]));
    doc.tree.set_text(text, "b".into());
    doc.flush();
    assert!(!red(&doc, items[1]), "changed, still text");
    doc.tree.destroy_element(text);
    doc.flush();
    assert!(red(&doc, items[1]), "the text node is gone");
}

#[test]
fn a_text_node_that_comes_with_its_text_makes_the_parent_not_empty() {
    let (mut doc, _, items) = list("li:empty { color: red }", 1);
    let text = doc.make("#text");
    doc.tree.set_text(text, "hello".into());
    doc.tree.append_child(items[0], text);
    doc.flush();
    assert!(!red(&doc, items[0]));
}

#[test]
fn empty_is_read_through_not_and_below() {
    let (mut doc, _, items) = list("li:not(:empty) { color: red } li:empty .label { background-color: blue }", 2);
    let label = doc.classed("span", items[0], "label");
    let loose = doc.classed("span", items[1], "label");
    doc.tree.destroy_element(loose);
    doc.flush();
    assert!(red(&doc, items[0]) && !red(&doc, items[1]));
    assert_eq!(doc.background(label), None, "its parent is not empty");
    doc.tree.destroy_element(label);
    doc.flush();
    assert!(!red(&doc, items[0]));
}

#[test]
fn a_position_read_in_an_ancestor_compound_matches_the_descendants_again() {
    let (mut doc, ul, items) = list("li:first-child .label { color: red }", 3);
    let labels: Vec<u64> = items.iter().map(|item| doc.classed("span", *item, "label")).collect();
    doc.flush();
    assert!(red(&doc, labels[0]) && !red(&doc, labels[1]));

    let first = doc.make("li");
    let label = doc.classed("span", first, "label");
    doc.tree.insert_before(ul, first, items[0]);
    doc.flush();
    assert!(red(&doc, label));
    assert!(!red(&doc, labels[0]), "its li is no longer the first child");
}

#[test]
fn a_position_in_a_compound_before_a_sibling_combinator_reaches_the_siblings() {
    let (mut doc, ul, items) = list("li:first-child + li { color: red } li:last-child ~ li { background-color: blue }", 3);
    assert!(red(&doc, items[1]) && !red(&doc, items[2]));
    let first = doc.make("li");
    doc.tree.insert_before(ul, first, items[0]);
    doc.flush();
    assert!(red(&doc, items[0]), "the new first's next sibling");
    assert!(!red(&doc, items[1]), "no longer next to the first");
}

#[test]
fn a_move_marks_where_the_element_was_and_where_it_went() {
    let (mut doc, ul, items) = list(EVERY_KIND, 6);
    doc.tree.append_child(ul, items[0]);
    doc.flush();
    same_as_fresh(&doc, EVERY_KIND, "first moved to the end");
    doc.tree.insert_before(ul, items[5], items[1]);
    doc.flush();
    same_as_fresh(&doc, EVERY_KIND, "last moved to the front");
    doc.tree.insert_before(ul, items[2], items[4]);
    doc.flush();
    same_as_fresh(&doc, EVERY_KIND, "moved within the middle");
}

/// Edits of a list, each checked against a fresh match of the document it leaves.
#[test]
fn every_edit_of_a_list_leaves_what_a_fresh_match_makes() {
    let (mut doc, ul, items) = list(EVERY_KIND, 7);
    for item in &items {
        doc.classed("span", *item, "label");
    }
    doc.flush();
    same_as_fresh(&doc, EVERY_KIND, "the start");
    let mut live = items.clone();

    let mut step = |doc: &mut Doc, name: &str, edit: &mut dyn FnMut(&mut Doc, &mut Vec<u64>)| {
        edit(doc, &mut live);
        doc.flush();
        same_as_fresh(doc, EVERY_KIND, name);
    };
    step(&mut doc, "append", &mut |doc, live| live.push(doc.classed("li", ul, "x")));
    step(&mut doc, "append a p", &mut |doc, live| live.push(doc.element("p", ul)));
    step(&mut doc, "prepend", &mut |doc, live| {
        let id = doc.make("li");
        doc.tree.insert_before(ul, id, live[0]);
        live.insert(0, id);
    });
    step(&mut doc, "insert in the middle", &mut |doc, live| {
        let id = doc.make("p");
        doc.tree.insert_before(ul, id, live[4]);
        live.insert(4, id);
    });
    step(&mut doc, "remove the first", &mut |doc, live| drop(doc.tree.destroy_element(live.remove(0))));
    step(&mut doc, "remove the last", &mut |doc, live| drop(doc.tree.destroy_element(live.pop().unwrap())));
    step(&mut doc, "remove from the middle", &mut |doc, live| drop(doc.tree.destroy_element(live.remove(3))));
    step(&mut doc, "move the first to the end", &mut |doc, live| {
        let id = live.remove(0);
        doc.tree.append_child(ul, id);
        live.push(id);
    });
    step(&mut doc, "move the last to the front", &mut |doc, live| {
        let id = live.pop().unwrap();
        doc.tree.insert_before(ul, id, live[0]);
        live.insert(0, id);
    });
    step(&mut doc, "move one down the middle", &mut |doc, live| {
        let id = live.remove(1);
        doc.tree.insert_before(ul, id, live[4]);
        live.insert(4, id);
    });
    step(&mut doc, "detach the first", &mut |doc, live| doc.tree.detach_child(live.remove(0)));
    step(&mut doc, "text in an li", &mut |doc, live| {
        let text = doc.element("#text", live[1]);
        doc.tree.set_text(text, "x".into());
    });
    step(&mut doc, "an element in an li", &mut |doc, live| drop(doc.element("b", live[2])));
    step(&mut doc, "a text node between the items", &mut |doc, live| {
        let text = doc.make("#text");
        doc.tree.set_text(text, "gap".into());
        doc.tree.insert_before(ul, text, live[2]);
    });
    step(&mut doc, "remove everything", &mut |doc, live| {
        for id in live.drain(..) {
            doc.tree.destroy_element(id);
        }
    });
}

#[test]
fn several_edits_in_one_batch_leave_what_a_fresh_match_makes() {
    let (mut doc, ul, items) = list(EVERY_KIND, 8);
    let added: Vec<u64> = (0..3).map(|_| doc.make("li")).collect();
    doc.tree.insert_before(ul, added[0], items[3]);
    doc.tree.append_child(ul, items[0]);
    doc.tree.destroy_element(items[6]);
    doc.tree.insert_before(ul, added[1], items[0]);
    doc.tree.append_child(ul, added[2]);
    doc.tree.insert_before(ul, items[7], added[0]);
    doc.tree.destroy_element(items[1]);
    doc.flush();
    same_as_fresh(&doc, EVERY_KIND, "a batch");
}

/// Pseudo-random edits, each checked.
#[test]
fn random_edits_leave_what_a_fresh_match_makes() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound as u64) as usize
    };
    let (mut doc, ul, items) = list(EVERY_KIND, 6);
    let mut live = items;
    for round in 0..60 {
        for _ in 0..1 + next(3) {
            match next(5) {
                0 if live.len() < 30 => {
                    let id = doc.make(["li", "li", "p"][next(3)]);
                    let at = next(live.len() + 1);
                    match live.get(at) {
                        Some(before) => doc.tree.insert_before(ul, id, *before),
                        None => doc.tree.append_child(ul, id),
                    }
                    live.insert(at, id);
                }
                1 if !live.is_empty() => {
                    let id = live.remove(next(live.len()));
                    doc.tree.destroy_element(id);
                }
                2 if live.len() > 1 => {
                    let id = live.remove(next(live.len()));
                    let at = next(live.len() + 1);
                    match live.get(at) {
                        Some(before) => doc.tree.insert_before(ul, id, *before),
                        None => doc.tree.append_child(ul, id),
                    }
                    live.insert(at, id);
                }
                3 if !live.is_empty() => {
                    let item = live[next(live.len())];
                    if doc.tree.elements[&item].children.is_empty() {
                        let text = doc.element("#text", item);
                        doc.tree.set_text(text, ["", "t", " "][next(3)].into());
                    } else {
                        let child = doc.tree.elements[&item].children[0];
                        doc.tree.destroy_element(child);
                    }
                }
                _ if !live.is_empty() => {
                    let item = live[next(live.len())];
                    doc.classed("span", item, "label");
                }
                _ => {}
            }
        }
        doc.flush();
        same_as_fresh(&doc, EVERY_KIND, &format!("round {round}"));
    }
}

// Cost: what an edit of a long list marks.

fn rematched_by_append(css: &str) -> u64 {
    let (mut doc, ul, _) = list(css, 1000);
    doc.rematched(|doc| drop(doc.classed("li", ul, "x")))
}

#[test]
fn appending_to_a_long_list_matches_only_what_the_selectors_can_change() {
    assert_eq!(rematched_by_append("li:last-child { color: red }"), 2, "the new one and the one it follows");
    assert_eq!(rematched_by_append("li:first-child { color: red }"), 2, "an edge reads both neighbours");
    assert_eq!(rematched_by_append("li:only-child { color: red }"), 2);
    assert_eq!(rematched_by_append("li:nth-child(odd) { color: red }"), 1, "nothing follows it");
    assert_eq!(rematched_by_append("li:first-of-type { color: red }"), 1);
    assert_eq!(rematched_by_append(".x { color: red }"), 1, "a sheet without them marks nothing else");
    assert_eq!(rematched_by_append("li:empty { color: red }"), 2, "the new li, and the list it is in, which reads no `:empty`");
}

#[test]
fn a_sheet_without_structural_pseudo_classes_marks_no_siblings() {
    let (mut doc, ul, items) = list(".x { color: red } li + li { top: 1px }", 100);
    assert!(doc.tree.sheets.index.invalidation.positional.is_empty());
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(items[50]).clear()), 1, "the next sibling, for the combinator only");
    assert_eq!(doc.rematched(|doc| drop(doc.classed("li", ul, "x"))), 1);
}

#[test]
fn removing_a_row_marks_the_neighbours_of_an_edge_and_the_siblings_a_count_reads() {
    let (mut doc, _, items) = list("li:last-child { color: red }", 1000);
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(items[500]).clear()), 2, "its neighbours");
    let (mut doc, _, items) = list("li:nth-child(odd) { color: red }", 1000);
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(items[900]).clear()), 99, "the ones after it");
    let (mut doc, _, items) = list("li:nth-last-child(odd) { color: red }", 1000);
    assert_eq!(doc.rematched(|doc| doc.tree.destroy_element(items[100]).clear()), 100, "the ones before it");
}

#[test]
fn building_a_list_a_row_at_a_time_costs_work_in_proportion_to_its_length() {
    for (css, first, last) in [
        ("li:nth-child(odd) { color: red }", true, false),
        ("li:nth-last-child(odd) { color: red }", false, true),
        ("li:last-of-type { color: red }", false, true),
        ("li:last-child { color: red }", false, true),
        ("li:first-of-type { color: red }", true, false),
    ] {
        let mut doc = Doc::new();
        doc.style_element(ROOT, css);
        doc.flush();
        let n = 2000;
        let ul = doc.element("ul", ROOT);
        let items: Vec<u64> = (0..n).map(|_| doc.classed("li", ul, "x")).collect();
        reset_sibling_work();
        doc.flush();
        assert!(sibling_work() < 40 * n, "{css}: {}", sibling_work());
        assert!(counts().elements_rematched >= n as u64, "{css}");
        assert_eq!(red(&doc, items[0]), first, "{css}");
        assert_eq!(red(&doc, items[n - 1]), last, "{css}");
    }
}

#[test]
fn a_style_element_arriving_with_a_list_matches_it_whole() {
    let mut doc = Doc::new();
    let ul = doc.element("ul", ROOT);
    let items = doc.run(5, "li", ul, "x");
    doc.flush();
    doc.style_element(ROOT, "li:nth-child(2n) { color: red } li:last-child { background-color: blue }");
    doc.flush();
    assert_eq!(items.iter().map(|id| red(&doc, *id)).collect::<Vec<_>>(), [false, true, false, true, false]);
    assert_eq!(doc.background(items[4]), Some("blue"));
}

#[test]
fn a_rule_added_later_reads_the_positions_the_tree_has() {
    let mut doc = Doc::new();
    let (_, css_text) = doc.style_element(ROOT, ".x { top: 1px }");
    let ul = doc.element("ul", ROOT);
    let items = doc.run(4, "li", ul, "x");
    doc.flush();
    doc.tree.set_text(css_text, ".x { top: 1px } li:nth-child(2) { color: red } li:last-child { background-color: blue }".into());
    doc.flush();
    assert!(red(&doc, items[1]) && !red(&doc, items[0]));
    assert_eq!(doc.background(items[3]), Some("blue"));
    let more = doc.classed("li", ul, "x");
    doc.flush();
    assert_eq!(doc.background(items[3]), None);
    assert_eq!(doc.background(more), Some("blue"));
}
