//! A sheet change matches again only the elements it reaches (`css::sheet::reload`), and the
//! document it leaves is the one a fresh load of the same sheets makes.

use std::sync::Arc;

use super::{counts, Doc, ROOT};
use crate::style::StyleDesc;

fn scoped_reloads() -> usize {
    crate::css::sheet::reload::SCOPED_RELOADS.with(|count| count.get())
}

/// Sixty `.item` elements, the first few of which also carry other classes, under a sheet adopted
/// as one constructed sheet, flushed.
struct Page {
    doc: Doc,
    items: Vec<u64>,
}

impl Page {
    fn new(css: &str) -> Page {
        let mut doc = Doc::new();
        let items = (0..60)
            .map(|index| {
                let class = match index {
                    0..=2 => "item mark",
                    3..=4 => "item other",
                    _ => "item",
                };
                doc.classed("div", ROOT, class)
            })
            .collect();
        doc.set_adopted(css);
        doc.flush();
        Page { doc, items }
    }

    /// Changes the sheet and flushes: how many elements were matched again, how many cascades were
    /// merged, and whether the scoped path ran.
    fn change(&mut self, css: &str) -> (u64, u64, bool) {
        crate::perf_counters::reset();
        let before = scoped_reloads();
        self.doc.set_adopted(css);
        self.doc.flush();
        (counts().elements_rematched, counts().cascades_computed, scoped_reloads() > before)
    }

    fn style(&self, index: usize) -> Option<Arc<StyleDesc>> {
        self.doc.style_arc(self.items[index])
    }
}

const BASE: &str = ".item { color: red }\n.mark { background-color: blue }\n.other { opacity: 0.5 }";

#[test]
fn a_rule_that_matches_nothing_matches_no_element_again() {
    let mut page = Page::new(BASE);
    let before: Vec<_> = (0..60).map(|index| page.style(index)).collect();
    let (rematched, cascades, scoped) = page.change(&format!("{BASE}\n.nomatch-x {{ color: green }}"));
    assert_eq!((rematched, cascades, scoped), (0, 0, true));
    assert!((0..60).all(|index| page.style(index).as_ref().map(Arc::as_ptr) == before[index].as_ref().map(Arc::as_ptr)));

    let (rematched, cascades, scoped) = page.change(BASE);
    assert_eq!((rematched, cascades, scoped), (0, 0, true), "and deleting it matches none");
}

#[test]
fn a_rule_for_a_class_matches_the_elements_with_that_class_again() {
    let mut page = Page::new(".item { color: red }\n.other { opacity: 0.5 }");
    // A class no sheet named before.
    let (rematched, cascades, scoped) = page.change(".item { color: red }\n.other { opacity: 0.5 }\n.mark { background-color: blue }");
    assert_eq!((rematched, scoped), (3, true));
    assert_eq!(cascades, 1, "the three share their match");
    assert_eq!(page.doc.background(page.items[1]), Some("blue"));
    assert_eq!(page.doc.background(page.items[10]), None);

    // A class a sheet already named.
    let (rematched, _, scoped) = page.change(".item { color: red }\n.other { opacity: 0.5 }\n.mark { background-color: blue }\n.other { top: 1px }");
    assert_eq!((rematched, scoped), (2, true));
    assert!(page.doc.style(page.items[3]).is_some_and(|style| style.top.is_some()));
    assert!(page.doc.style(page.items[7]).is_some_and(|style| style.top.is_none()));
}

#[test]
fn a_rule_for_an_id_an_attribute_or_a_tag_matches_the_elements_that_have_it_again() {
    let mut page = Page::new(BASE);
    page.doc.tree.set_attribute(page.items[20], "id", Some("twenty".into()));
    page.doc.tree.set_attribute(page.items[21], "data-k", Some("v".into()));
    page.doc.flush();
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n#twenty {{ top: 2px }}"));
    assert_eq!((rematched, scoped), (1, true));
    assert!(page.doc.style(page.items[20]).is_some_and(|style| style.top.is_some()));
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n#twenty {{ top: 2px }}\n[data-k] {{ left: 3px }}"));
    assert_eq!((rematched, scoped), (1, true));
    assert!(page.doc.style(page.items[21]).is_some_and(|style| style.left.is_some()));
    // The root is a `div` too, and the sixty items: more than half of the elements.
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n#twenty {{ top: 2px }}\n[data-k] {{ left: 3px }}\ndiv {{ right: 1px }}"));
    assert_eq!(scoped, false);
    assert!(rematched >= 61);
    assert!(page.doc.style(page.items[40]).is_some_and(|style| style.right.is_some()));
}

#[test]
fn deleting_a_rule_matches_again_only_the_elements_that_matched_it() {
    let mut page = Page::new(BASE);
    let other = page.style(3);
    // `.other`, which follows, is renumbered, and the elements that matched it are left alone.
    let (rematched, cascades, scoped) = page.change(".item { color: red }\n.other { opacity: 0.5 }");
    assert_eq!((rematched, cascades, scoped), (3, 0, true), "they now match what the other items match");
    assert_eq!(page.doc.background(page.items[0]), None);
    assert_eq!(page.style(3).as_ref().map(Arc::as_ptr), other.as_ref().map(Arc::as_ptr));
    assert_eq!(page.style(0).as_ref().map(Arc::as_ptr), page.style(10).as_ref().map(Arc::as_ptr));
    // A rule nothing matched leaves everything alone.
    let (rematched, cascades, scoped) = page.change(".item { color: red }\n.other { opacity: 0.5 }\n.zzz { top: 1px }");
    assert_eq!((rematched, cascades, scoped), (0, 0, true));
    let (rematched, cascades, scoped) = page.change(".item { color: red }\n.other { opacity: 0.5 }");
    assert_eq!((rematched, cascades, scoped), (0, 0, true));
    // A rule every item matched is more than half of the elements.
    let (rematched, _, scoped) = page.change(".other { opacity: 0.5 }");
    assert!(!scoped && rematched >= 60);
    assert_eq!(page.doc.color(page.items[3]), None);
}

#[test]
fn an_edit_in_the_middle_and_at_the_end_matches_again_only_what_it_reaches() {
    let rules = [
        ".item { color: red }",
        ".mark { background-color: blue }",
        ".other { opacity: 0.5 }",
        ".item.mark { top: 1px }",
        ".other.item { margin-top: 2px }",
    ];
    let mut page = Page::new(&rules.join("\n"));
    let unchanged = page.style(30);
    for (position, reached, element) in [(1, 3, 0), (2, 2, 3), (3, 3, 0), (4, 2, 3)] {
        let mut edited = rules.map(String::from);
        edited[position] = edited[position].replace('}', "; left: 9px }");
        let (rematched, _, scoped) = page.change(&edited.join("\n"));
        assert_eq!((rematched, scoped), (reached, true), "rule {position} edited");
        assert!(page.doc.style(page.items[element]).is_some_and(|style| style.left.is_some()), "rule {position}");
        let (rematched, _, scoped) = page.change(&rules.join("\n"));
        assert_eq!((rematched, scoped), (reached, true), "rule {position} put back");
        assert!(page.doc.style(page.items[element]).is_some_and(|style| style.left.is_none()), "rule {position}");
    }
    assert_eq!(page.style(30).as_ref().map(Arc::as_ptr), unchanged.as_ref().map(Arc::as_ptr));

    // The first rule is every item's: more than half of the elements, so every one is matched again.
    let (rematched, _, scoped) = page.change(&format!(".item {{ color: green }}\n{}", rules[1..].join("\n")));
    assert!(!scoped && rematched >= 60);
    assert_eq!(page.doc.color(page.items[30]), Some("green"));
    assert_eq!(page.doc.background(page.items[0]), Some("blue"));
}

#[test]
fn a_rule_inserted_before_the_others_renumbers_them_and_matches_only_what_it_reaches() {
    let mut page = Page::new(BASE);
    let unchanged = page.style(30);
    let (rematched, cascades, scoped) = page.change(&format!(".other {{ left: 4px }}\n{BASE}"));
    assert_eq!((rematched, scoped), (2, true));
    assert_eq!(cascades, 1);
    assert_eq!(page.style(30).as_ref().map(Arc::as_ptr), unchanged.as_ref().map(Arc::as_ptr));
    assert_eq!(page.doc.background(page.items[0]), Some("blue"));
    assert_eq!(page.doc.color(page.items[0]), Some("red"));
    assert!(page.doc.style(page.items[4]).is_some_and(|style| style.left.is_some() && style.opacity == Some(0.5)));
    // A class change after the renumbering matches against the new numbers.
    page.doc.class(page.items[30], "item other");
    page.doc.flush();
    assert!(page.doc.style(page.items[30]).is_some_and(|style| style.left.is_some() && style.opacity == Some(0.5)));
}

#[test]
fn a_change_the_scoped_path_cannot_tell_matches_every_element_again() {
    let mut page = Page::new(BASE);
    // A layer.
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n@layer late {{ .other {{ color: black }} }}"));
    assert_eq!(scoped, false);
    assert!(rematched >= 60);
    assert_eq!(page.doc.color(page.items[3]), Some("red"), "the layer is below unlayered rules");
    let (_, _, scoped) = page.change(BASE);
    assert_eq!(scoped, false);
    assert_eq!(page.doc.color(page.items[3]), Some("red"));
    // A subject no feature of an element finds.
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n:not(.mark) {{ top: 5px }}"));
    assert_eq!(scoped, false);
    assert!(rematched >= 60);
    assert!(page.doc.style(page.items[10]).is_some_and(|style| style.top.is_some()));
    assert!(page.doc.style(page.items[0]).is_some_and(|style| style.top.is_none()));
    let (_, _, scoped) = page.change(BASE);
    assert_eq!(scoped, false);
    assert!(page.doc.style(page.items[10]).is_some_and(|style| style.top.is_none()));
    // An `:is()` subject takes the features of its arguments, unless one has none.
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n:is(.mark, .other) {{ top: 5px }}"));
    assert_eq!((rematched, scoped), (5, true));
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n.mark {{ &:hover {{ top: 5px }} }}"));
    assert_eq!((rematched, scoped), (5, true), "the five the rule deleted was for, three of which the nested rule reaches too");
    let (_, _, scoped) = page.change(&format!("{BASE}\n:is(.mark, :not(.other)) {{ top: 5px }}"));
    assert_eq!(scoped, false);
    let (rematched, _, scoped) = page.change(BASE);
    assert!(rematched >= 60 && !scoped, "a rule that more than half of the elements matched");
    // A source the splitter cannot cut.
    let (rematched, _, scoped) = page.change(&format!("{BASE}\n.broken {{ top: 1px"));
    assert_eq!(scoped, false);
    assert!(rematched >= 60);
    let (_, _, scoped) = page.change(&format!("{BASE}\n.nomatch {{ top: 1px }}"));
    assert_eq!(scoped, false, "the load before was parsed whole");
    let (_, _, scoped) = page.change(&format!("{BASE}\n.nomatch {{ top: 2px }}"));
    assert_eq!(scoped, true, "and this one is cut");
}

/// A load that names a class and adds no rule to the index still gives the elements the atom of the
/// name, so a rule for the class that comes later reaches them.
#[test]
fn a_name_a_load_interned_without_a_rule_is_found_on_the_elements_by_the_next_rule() {
    for first in [".card::before { top: 1px }", ".card { }", ".card { colr: red }", ".card { top: }"] {
        let mut page = Page::new(BASE);
        for index in 5..8 {
            page.doc.class(page.items[index], "item card");
        }
        page.doc.flush();
        page.change(&format!("{BASE}\n{first}"));
        let (rematched, _, scoped) = page.change(&format!("{BASE}\n{first}\n.card {{ padding-top: 3px }}"));
        assert_eq!((rematched, scoped), (3, true), "{first}");
        for index in 5..8 {
            assert!(page.doc.style(page.items[index]).is_some_and(|style| style.padding_top.is_some()), "{first}: item {index}");
        }
        assert!(page.doc.style(page.items[10]).is_some_and(|style| style.padding_top.is_none()), "{first}");
    }
}

// Equivalence: after every step the document is what a fresh load of the same sheets makes.

const STYLE_ZERO: &str = "
.row { color: red }
.row + .row { background-color: #111111 }
.row ~ .last { opacity: 0.9 }
.list > .row .cell { padding-top: 3px }
.row:hover { color: blue }
#seven { color: green !important }
@layer base { .cell { margin-top: 1px } }
.cell[data-k] { margin-left: 2px }
.plain { top: 1px; &:hover { top: 2px } .x & { top: 3px } }
p { left: 4px }
.row.first { padding-left: 5px !important }
";

/// The page the sheets apply to, under a `<div>` for the `<style>` elements. Returns the ids of its elements.
fn build_page(doc: &mut Doc) -> Vec<u64> {
    let mut all = Vec::new();
    let list = doc.classed("div", ROOT, "list");
    all.push(list);
    for index in 0..12 {
        let class = match index % 4 {
            0 => "row first",
            3 => "row last",
            _ => "row",
        };
        let row = doc.classed("div", list, class);
        all.push(row);
        let cell = doc.classed("span", row, "cell");
        all.push(cell);
        if index % 3 == 0 {
            doc.tree.set_attribute(cell, "data-k", Some("v".into()));
        }
        if index % 5 == 0 {
            doc.inline(row, r#"{"opacity":0.5}"#);
        }
        if index == 7 {
            doc.tree.set_attribute(row, "id", Some("seven".into()));
        }
    }
    for index in 0..8 {
        let plain = doc.classed("p", ROOT, if index % 2 == 0 { "plain" } else { "plain x" });
        all.push(plain);
    }
    for _ in 0..30 {
        let pad = doc.classed("section", ROOT, "pad");
        all.push(pad);
    }
    all
}

#[derive(Clone)]
struct Sheets {
    styles: Vec<String>,
    adopted: String,
}

/// The document the sheets would make from nothing.
fn fresh(sheets: &Sheets) -> (Doc, Vec<u64>) {
    let mut doc = Doc::new();
    let head = doc.element("div", ROOT);
    for css in &sheets.styles {
        doc.style_element(head, css);
    }
    if !sheets.adopted.is_empty() {
        doc.set_adopted(&sheets.adopted);
    }
    let page = build_page(&mut doc);
    doc.flush();
    (doc, page)
}

struct Live {
    doc: Doc,
    head: u64,
    styles: Vec<(u64, u64)>,
    page: Vec<u64>,
}

impl Live {
    fn new(sheets: &Sheets) -> Live {
        let mut doc = Doc::new();
        let head = doc.element("div", ROOT);
        let styles = sheets.styles.iter().map(|css| doc.style_element(head, css)).collect();
        if !sheets.adopted.is_empty() {
            doc.set_adopted(&sheets.adopted);
        }
        let page = build_page(&mut doc);
        doc.flush();
        Live { doc, head, styles, page }
    }

    /// Makes the document hold `sheets`: edits the text of the `<style>` elements it has, adds and
    /// removes the others. Whether the scoped path ran.
    fn set(&mut self, sheets: &Sheets) -> bool {
        let before = scoped_reloads();
        for (position, css) in sheets.styles.iter().enumerate() {
            match self.styles.get(position) {
                Some((_, text)) => self.doc.tree.set_text(*text, css.clone()),
                None => {
                    let added = self.doc.style_element(self.head, css);
                    self.styles.push(added);
                }
            }
        }
        while self.styles.len() > sheets.styles.len() {
            let (style, _) = self.styles.pop().unwrap();
            self.doc.tree.destroy_element(style);
        }
        self.doc.set_adopted(&sheets.adopted);
        self.doc.flush();
        scoped_reloads() > before
    }

    fn same_as_fresh(&self, sheets: &Sheets, step: &str) {
        let (other, other_page) = fresh(sheets);
        assert_eq!(self.page.len(), other_page.len());
        for (position, (mine, theirs)) in self.page.iter().zip(&other_page).enumerate() {
            let (mine, theirs) = (&self.doc.tree.elements[mine], &other.tree.elements[theirs]);
            assert_eq!(mine.style.as_deref(), theirs.style.as_deref(), "{step}: element {position} ({:?})", mine.attribute("class"));
            let list = |element: &crate::retained_tree::RetainedElement| {
                element.css().and_then(|css| css.matched.as_ref()).map(|matched| (matched.normal.clone(), matched.important.clone()))
            };
            assert_eq!(list(mine), list(theirs), "{step}: element {position}");
        }
    }
}

/// The steps of a document's sheets: a rule inserted at the end, in the middle and at the start, a rule deleted, a
/// declaration edited, a `<style>` element added, edited and removed, and the changes that fall back to a full reload.
fn steps() -> Vec<(&'static str, Sheets, bool)> {
    let mut sheets = Sheets { styles: vec![STYLE_ZERO.to_string()], adopted: String::new() };
    let mut steps = Vec::new();
    let mut step = |name: &'static str, scoped: bool, change: &mut dyn FnMut(&mut Sheets)| {
        change(&mut sheets);
        steps.push((name, sheets.clone(), scoped));
    };
    step("an adopted sheet", true, &mut |sheets| sheets.adopted = ".x1 { color: pink }\n.cell { border-radius: 2px }".into());
    step("a rule in the middle", true, &mut |sheets| {
        sheets.styles[0] = sheets.styles[0].replace("#seven {", ".row.last { top: 6px }\n#seven {");
    });
    step("a rule at the start", true, &mut |sheets| sheets.styles[0] = format!(".cell {{ width: 7px }}\n{}", sheets.styles[0]));
    step("a rule deleted", true, &mut |sheets| {
        sheets.styles[0] = sheets.styles[0].replace(".row ~ .last { opacity: 0.9 }\n", "");
    });
    step("a declaration edited", true, &mut |sheets| {
        sheets.styles[0] = sheets.styles[0].replace("margin-left: 2px", "margin-left: 8px");
    });
    step("a style element added", true, &mut |sheets| sheets.styles.push(".plain { left: 9px }\n.cell { top: 7px }".into()));
    step("a hover rule", true, &mut |sheets| sheets.styles[1].push_str("\n.cell:hover { top: 8px }\n.row.first:hover { color: black }"));
    step("a layer added", false, &mut |sheets| sheets.styles[1].push_str("\n@layer late { .row { color: black } }"));
    step("a rule with no feature", false, &mut |sheets| sheets.styles[1].push_str("\n:not(.row) { right: 1px }"));
    step("both deleted", false, &mut |sheets| {
        sheets.styles[1] = ".plain { left: 9px }\n.cell { top: 7px }".into();
    });
    step("an id, an attribute and a tag", true, &mut |sheets| {
        sheets.styles[1].push_str("\n#seven { bottom: 1px }\n[data-k] { left: 1px }\nspan { right: 2px }");
    });
    step("the first style element removed, and its layer with it", false, &mut |sheets| {
        sheets.styles.remove(0);
    });
    step("an adopted sheet edited", true, &mut |sheets| sheets.adopted = ".x1 { color: orange }\n.cell { border-radius: 2px }".into());
    step("an important rule", true, &mut |sheets| sheets.adopted.push_str("\n.row { opacity: 0.1 !important }"));
    step("nothing changed", true, &mut |sheets| sheets.adopted.push_str("\n/* a comment */"));
    step("every sheet removed", true, &mut |sheets| {
        sheets.styles.clear();
        sheets.adopted.clear();
    });
    steps
}

#[test]
fn every_step_of_a_sequence_of_sheet_changes_leaves_what_a_fresh_load_makes() {
    let mut sheets = Sheets { styles: vec![STYLE_ZERO.to_string()], adopted: String::new() };
    let mut live = Live::new(&sheets);
    live.same_as_fresh(&sheets, "the start");
    for (name, next, scoped) in steps() {
        sheets = next;
        let ran_scoped = live.set(&sheets);
        live.same_as_fresh(&sheets, name);
        if scoped {
            assert!(ran_scoped, "{name} takes the scoped path");
        } else {
            assert!(!ran_scoped, "{name} takes the full path");
        }
    }
}

const POOL: [&str; 18] = [
    ".row { color: red }",
    ".row + .row { background-color: #222222 }",
    ".row ~ .last { opacity: 0.8 }",
    ".list > .row .cell { padding-top: 2px }",
    ".row:hover { color: blue }",
    "#seven { color: green !important }",
    ".cell[data-k] { margin-left: 3px }",
    ".plain { top: 1px; &:hover { top: 2px } .x & { top: 3px } }",
    "p { left: 4px }",
    ".row.first { padding-left: 5px !important }",
    "span { right: 6px }",
    "@layer base { .cell { margin-top: 1px } }",
    "@layer base, late;",
    "@layer late { .row { color: black } .plain { left: 1px } }",
    ":not(.row) { bottom: 1px }",
    ".pad:hover, .plain:hover { opacity: 0.4 }",
    "@media (min-width: 10px) { .row { top: 9px } }",
    ".cell { top: 5px; opacity: 0.7 !important }",
];

/// A sequence of random edits to two sheets, each followed by the check against a fresh load.
#[test]
fn random_sheet_edits_leave_what_a_fresh_load_makes() {
    let mut random = 0x2545_f491_4f6c_dd1du64;
    let mut next = |bound: usize| {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        (random % bound as u64) as usize
    };
    let mut rules: [Vec<&str>; 2] = [vec![POOL[0], POOL[3]], vec![POOL[6]]];
    let render = |rules: &[Vec<&str>; 2]| Sheets { styles: vec![rules[0].join("\n")], adopted: rules[1].join("\n") };
    let mut live = Live::new(&render(&rules));
    let mut scoped = 0;
    for step in 0..400 {
        let sheet = next(2);
        match (next(3), rules[sheet].len()) {
            (1, length) if length > 0 => {
                rules[sheet].remove(next(length));
            }
            (2, length) if length > 0 => {
                let at = next(length);
                rules[sheet][at] = POOL[next(POOL.len())];
            }
            (_, length) => {
                let at = next(length + 1);
                rules[sheet].insert(at, POOL[next(POOL.len())]);
            }
        }
        let sheets = render(&rules);
        if live.set(&sheets) {
            scoped += 1;
        }
        live.same_as_fresh(&sheets, &format!("step {step}: {:?}", rules));
    }
    assert!(scoped > 100, "{scoped} of 400 reloads were scoped");
}
