//! Sheets applied to a retained tree: matching, the cascade against inline styles, and what each
//! kind of mutation does to the style of an element.

use std::sync::Arc;

use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;

struct Doc {
    tree: RetainedTree,
    next: u64,
}

const ROOT: u64 = 1;

impl Doc {
    fn new() -> Doc {
        let mut tree = RetainedTree::new();
        tree.create_element(ROOT, "div".into());
        tree.set_root(ROOT);
        Doc { tree, next: 2 }
    }

    fn element(&mut self, tag: &str, parent: u64) -> u64 {
        let id = self.make(tag);
        self.tree.append_child(parent, id);
        id
    }

    /// Created and not yet in the tree.
    fn make(&mut self, tag: &str) -> u64 {
        let id = self.next;
        self.next += 1;
        self.tree.create_element(id, tag.into());
        id
    }

    fn classed(&mut self, tag: &str, parent: u64, class: &str) -> u64 {
        let id = self.make(tag);
        self.tree.set_attribute(id, "class", Some(class.into()));
        self.tree.append_child(parent, id);
        id
    }

    /// A `<style>` element under `parent` holding `css`, and the id of its text node.
    fn style_element(&mut self, parent: u64, css: &str) -> (u64, u64) {
        let style = self.make("style");
        let text = self.make("#text");
        self.tree.set_text(text, css.into());
        self.tree.append_child(style, text);
        self.tree.append_child(parent, style);
        (style, text)
    }

    fn inline(&mut self, id: u64, json: &str) {
        let style = self.tree.styles.intern(json.as_bytes()).unwrap();
        self.tree.set_style(id, style);
    }

    fn flush(&mut self) {
        self.tree.flush_styles();
    }

    /// A frame builds the document, as `GpuixView::render` does after a batch.
    fn frame(&mut self) {
        self.tree.note_frame_built();
    }

    fn style(&self, id: u64) -> Option<&StyleDesc> {
        self.tree.elements[&id].style.as_deref()
    }

    fn color(&self, id: u64) -> Option<&str> {
        self.style(id).and_then(|style| style.color.as_deref())
    }

    fn background(&self, id: u64) -> Option<&str> {
        self.style(id).and_then(|style| style.background_color.as_deref())
    }

    fn style_arc(&self, id: u64) -> Option<Arc<StyleDesc>> {
        self.tree.elements[&id].style.clone()
    }
}

fn counts() -> crate::perf_counters::Counts {
    crate::perf_counters::snapshot()
}

#[test]
fn a_document_without_sheets_keeps_no_state() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"red"}"#);
    doc.flush();
    assert!(!doc.tree.sheets.enabled);
    assert!(doc.tree.elements[&div].css().is_none_or(|css| css.is_empty()));
    assert_eq!(counts().elements_rematched, 0);
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn tag_class_id_and_attribute_selectors_apply() {
    let mut doc = Doc::new();
    let plain = doc.element("span", ROOT);
    let classed = doc.classed("div", ROOT, "a b");
    let identified = doc.element("div", ROOT);
    doc.tree.set_attribute(identified, "id", Some("x".into()));
    let attributed = doc.element("div", ROOT);
    doc.tree.set_attribute(attributed, "data-k", Some("v w".into()));
    doc.style_element(
        ROOT,
        "span { color: red } .b { background-color: blue } #x { opacity: 0.5 } [data-k~=w] { padding-top: 4px }",
    );
    doc.flush();

    assert_eq!(doc.color(plain), Some("red"));
    assert_eq!(doc.color(classed), None);
    assert_eq!(doc.background(classed), Some("blue"));
    assert_eq!(doc.style(identified).and_then(|style| style.opacity), Some(0.5));
    assert!(doc.style(attributed).is_some_and(|style| style.padding_top.is_some()));
    assert!(doc.style(classed).is_some_and(|style| style.padding_top.is_none()));
}

#[test]
fn an_id_that_arrives_as_an_attribute_matches() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.tree.set_attribute(div, "id", Some("x".into()));
    doc.style_element(ROOT, "#x { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    doc.tree.set_attribute(div, "id", Some("y".into()));
    doc.flush();
    assert_eq!(doc.color(div), None);
}

#[test]
fn a_custom_prop_is_not_an_attribute_to_a_selector() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.tree.set_custom_prop(div, "id".into(), serde_json::json!("x"));
    doc.tree.set_custom_prop(div, "tabIndex".into(), serde_json::json!(0));
    doc.style_element(ROOT, "#x { color: red } [tabindex] { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert_eq!(doc.background(div), None);
}

#[test]
fn data_and_aria_booleans_match_as_true_and_false() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.tree.set_attribute(div, "data-open", Some("true".into()));
    doc.tree.set_attribute(div, "aria-expanded", Some("false".into()));
    doc.style_element(ROOT, "[data-open=\"true\"] { color: red } [aria-expanded=\"false\"] { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(doc.background(div), Some("blue"));

    doc.tree.set_attribute(div, "aria-expanded", Some("true".into()));
    doc.flush();
    assert_eq!(doc.background(div), None);
}

#[test]
fn an_html_attribute_name_matches_without_regard_to_case_and_an_svg_one_with_it() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    let label = doc.element("label", ROOT);
    let svg = doc.element("svg", ROOT);
    let path = doc.element("path", svg);
    doc.tree.set_attribute(div, "tabindex", Some("0".into()));
    doc.tree.set_attribute(label, "for", Some("x".into()));
    doc.tree.set_attribute(svg, "viewBox", Some("0 0 1 1".into()));
    doc.tree.set_attribute(path, "pathLength", Some("1".into()));
    doc.style_element(
        ROOT,
        "[tabIndex=\"0\"] { color: red } [for=x] { background-color: blue } \
         svg[viewBox] { opacity: 0.5 } path[pathlength] { padding-top: 1px }",
    );
    doc.flush();
    assert_eq!(doc.color(div), Some("red"), "[tabIndex] reads tabindex on an HTML element");
    assert_eq!(doc.background(label), Some("blue"));
    assert_eq!(doc.style(svg).and_then(|style| style.opacity), Some(0.5), "[viewBox] reads viewBox");
    assert!(doc.style(path).is_none_or(|style| style.padding_top.is_none()), "[pathlength] is not pathLength");

    doc.tree.set_attribute(div, "tabindex", Some("-1".into()));
    doc.flush();
    assert_eq!(doc.color(div), None);
    doc.tree.set_attribute(div, "tabindex", Some("0".into()));
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn combinators_follow_the_tree() {
    let mut doc = Doc::new();
    let parent = doc.classed("div", ROOT, "p");
    let child = doc.classed("div", parent, "c");
    let grandchild = doc.classed("div", child, "c");
    let first = doc.classed("span", ROOT, "a");
    let next = doc.classed("span", ROOT, "b");
    let later = doc.classed("span", ROOT, "b");
    doc.style_element(
        ROOT,
        ".p > .c { color: red } .p .c { background-color: blue } .a + .b { opacity: 0.1 } .a ~ .b { padding-top: 1px }",
    );
    doc.flush();

    assert_eq!(doc.color(child), Some("red"));
    assert_eq!(doc.color(grandchild), None, "a child is not a grandchild");
    assert_eq!(doc.background(grandchild), Some("blue"));
    assert_eq!(doc.style(next).and_then(|style| style.opacity), Some(0.1));
    assert_eq!(doc.style(later).and_then(|style| style.opacity), None);
    assert!(doc.style(later).is_some_and(|style| style.padding_top.is_some()));
    assert!(doc.style(first).is_none());
}

#[test]
fn not_and_is_match() {
    let mut doc = Doc::new();
    let a = doc.classed("div", ROOT, "a");
    let b = doc.classed("div", ROOT, "b");
    let c = doc.classed("div", ROOT, "c x");
    doc.style_element(ROOT, "div:not(.a, .x) { color: red } :is(.a, .c) { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(a), None);
    assert_eq!(doc.color(b), Some("red"));
    assert_eq!(doc.color(c), None);
    assert_eq!(doc.background(a), Some("blue"));
    assert_eq!(doc.background(b), None);
    assert_eq!(doc.background(c), Some("blue"));
}

#[test]
fn specificity_decides_then_source_order() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, "div.a { color: red } .a { color: blue } .a { background-color: red } .a { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"), "(0,1,1) beats (0,1,0) whatever the order");
    assert_eq!(doc.background(div), Some("blue"), "the later of two equals");
}

#[test]
fn a_later_sheet_wins_over_an_earlier_one() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red; background-color: red }");
    doc.style_element(ROOT, ".a { color: blue }");
    doc.set_adopted("p { color: green } .a { background-color: green }");
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.background(div), Some("green"), "adopted sheets come after style elements");
}

impl Doc {
    fn set_adopted(&mut self, css: &str) {
        self.tree.set_style_sheet(900, Some(css));
        self.tree.set_adopted_style_sheets(vec![900]);
    }
}

#[test]
fn style_elements_apply_in_tree_order_not_creation_order() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (late, _) = doc.style_element(ROOT, ".a { color: blue }");
    let (early, _) = doc.style_element(ROOT, ".a { color: red }");
    doc.tree.insert_before(ROOT, early, late);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"), "the one later in the tree wins");
}

#[test]
fn a_style_element_appended_to_a_parent_created_later_is_not_in_the_document() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let first = doc.make("style");
    let second = doc.make("style");
    let parent = 900;
    doc.tree.append_child(parent, first);
    doc.tree.append_child(parent, second);
    doc.tree.create_element(parent, "div".into());
    doc.tree.append_child(ROOT, parent);
    doc.flush();
    assert_eq!(doc.color(div), None);

    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn layers_rank_below_unlayered_styles_and_important_reverses() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(
        ROOT,
        "@layer base { .a { color: red; opacity: 0.1 !important } } @layer theme { .a { opacity: 0.2 !important } } \
         div { color: blue; opacity: 0.3 !important }",
    );
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"), "unlayered beats a layer despite less specificity");
    assert_eq!(
        doc.style(div).and_then(|style| style.opacity),
        Some(0.1),
        "important: the first layer wins and unlayered loses"
    );
}

#[test]
fn important_beats_inline_and_inline_beats_normal() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"green","backgroundColor":"green","opacity":0.9}"#);
    doc.style_element(ROOT, ".a { color: red; background-color: blue !important; opacity: 0.2 }");
    doc.flush();
    assert_eq!(doc.color(div), Some("green"), "inline beats a normal declaration");
    assert_eq!(doc.background(div), Some("blue"), "important beats inline");
    assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.9));
}

#[test]
fn unset_important_removes_the_inline_value() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"green","backgroundColor":"green"}"#);
    doc.style_element(ROOT, ".a { color: UNSET !important }");
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert_eq!(doc.background(div), Some("green"));
}

#[test]
fn an_inline_value_that_is_no_value_does_not_erase_a_sheet_declaration() {
    let mut doc = Doc::new();
    let empty = doc.classed("div", ROOT, "x");
    let null = doc.classed("div", ROOT, "x");
    let bogus = doc.classed("div", ROOT, "x");
    doc.inline(empty, r#"{"display":"","opacity":0.5}"#);
    doc.inline(null, r#"{"color":null,"opacity":0.5}"#);
    doc.inline(bogus, r#"{"color":"bogus","opacity":0.5}"#);
    doc.style_element(ROOT, ".x { display: flex; color: red }");
    doc.flush();
    assert_eq!(doc.style(empty).and_then(|style| style.display.as_deref()), Some("flex"));
    assert_eq!(doc.color(null), Some("red"));
    assert_eq!(doc.color(bogus), Some("red"));
    for id in [empty, null, bogus] {
        assert_eq!(doc.style(id).and_then(|style| style.opacity), Some(0.5));
    }
}

#[test]
fn a_valid_inline_value_still_wins_and_state_styles_and_custom_properties_pass_through() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "x");
    doc.inline(div, r##"{"color":"blue","--k":"1","hover":{"backgroundColor":"green"}}"##);
    doc.style_element(ROOT, ".x { color: red }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.color.as_deref(), Some("blue"));
    assert!(style.custom_properties.is_some());
    assert_eq!(style.hover.as_ref().and_then(|hover| hover.background_color.as_deref()), Some("green"));
}

#[test]
fn a_css_wide_keyword_takes_back_what_a_shorthand_covered() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"paddingTop":4,"opacity":0.5}"#);
    doc.style_element(ROOT, ".a { padding: initial !important }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert!(style.padding_top.is_none(), "unsetting the shorthand clears the longhands it covers");
    assert_eq!(style.opacity, Some(0.5));
}

#[test]
fn a_css_wide_keyword_on_a_longhand_takes_back_what_an_earlier_shorthand_gave_it() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"position":"absolute","inset":0}"#);
    doc.style_element(ROOT, ".a { right: unset !important }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.right, Some(crate::style::DimensionValue::Auto), "the shorthand no longer gives right 0");
    assert!(style.inset.is_some(), "the shorthand still gives the other sides");
}

#[test]
fn initial_on_a_padding_longhand_resets_it_below_the_shorthand() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"padding":"8px"}"#);
    doc.style_element(ROOT, ".a { padding-left: initial !important }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.padding_left, Some(crate::css::length::LinearLength::px(0.0)));
    assert!(style.padding.is_some(), "the shorthand still gives the other sides");
}

#[test]
fn a_keyword_on_a_longhand_no_shorthand_covers_only_removes_it() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"paddingLeft":4}"#);
    doc.style_element(ROOT, ".a { padding-left: unset !important }");
    doc.flush();
    assert!(doc.style(div).is_none_or(|style| style.padding_left.is_none()));
}

#[test]
fn a_keyword_on_a_shorthand_resets_the_longhands_an_outer_shorthand_gave() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"padding":"8px"}"#);
    doc.style_element(ROOT, ".a { padding-block: unset !important }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.padding_top, Some(crate::css::length::LinearLength::px(0.0)));
    assert_eq!(style.padding_bottom, Some(crate::css::length::LinearLength::px(0.0)));
    assert!(style.padding.is_some());
}

fn popover(doc: &mut Doc, class: &str) -> u64 {
    let id = doc.classed("div", ROOT, class);
    doc.tree.set_custom_prop(id, "popover".into(), serde_json::json!("manual"));
    doc.tree.set_custom_prop(id, "popoverOpen".into(), serde_json::json!(1));
    id
}

const ZERO: crate::css::length::LinearLength = crate::css::length::LinearLength::px(0.0);

#[test]
fn an_author_unset_beats_the_user_agent_style_of_a_popover() {
    let mut doc = Doc::new();
    let div = popover(&mut doc, "a");
    let untouched = popover(&mut doc, "b");
    doc.style_element(
        ROOT,
        ".a { left: 40px !important; right: unset !important; margin: unset } @layer l { .a { max-width: none } }",
    );
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.left, Some(crate::style::DimensionValue::Pixels(40.0)));
    assert_eq!(style.right.clone(), None, "the user agent's right: 0 is taken back");
    assert!(style.margin.is_none(), "the user agent's margin: auto is taken back");
    assert_eq!((style.margin_top.clone(), style.margin_right.clone(), style.margin_bottom.clone(), style.margin_left.clone()), (None, None, None, None));
    assert_eq!(style.max_width, None, "`none` is the initial value, and the user agent's 100% is taken back");
    assert_eq!(style.position.as_deref(), Some("fixed"), "what no keyword names stays");
    assert!(style.background_color.is_some());
    let other = doc.style(untouched).expect("the element has a style");
    assert!(other.margin.is_some() && other.max_width.is_some(), "a popover no rule matches keeps the user agent style");
}

#[test]
fn an_author_keyword_beats_the_user_agent_style_of_a_tag() {
    let mut doc = Doc::new();
    let unset = doc.classed("p", ROOT, "unset");
    let initial = doc.classed("p", ROOT, "initial");
    let reverted = doc.classed("p", ROOT, "revert");
    let plain = doc.classed("p", ROOT, "plain");
    doc.style_element(
        ROOT,
        ".unset { margin: unset } .initial { margin-block: initial } .revert { margin: revert }",
    );
    doc.flush();
    let margins = |doc: &Doc, id: u64| {
        let style = doc.style(id).expect("the element has a style");
        (style.margin_top.clone(), style.margin_bottom.clone())
    };
    assert!(margins(&doc, plain).0.is_some(), "a paragraph has a margin");
    assert_eq!(margins(&doc, unset), (None, None));
    assert_eq!(margins(&doc, initial), (None, None));
    assert_eq!(margins(&doc, reverted), margins(&doc, plain), "revert rolls back to the user agent style");
}

#[test]
fn inherit_and_initial_on_an_inherited_property_beat_the_user_agent_style() {
    let mut doc = Doc::new();
    let inherit = doc.classed("h1", ROOT, "inherit");
    let initial = doc.classed("h1", ROOT, "initial");
    let reverted = doc.classed("h1", ROOT, "revert");
    let size = doc.classed("h1", ROOT, "size");
    doc.style_element(
        ROOT,
        ".inherit { font-weight: inherit } .initial { font-weight: initial } .revert { font-weight: revert } \
         .size { font-size: unset }",
    );
    doc.flush();
    assert_eq!(doc.style(inherit).and_then(|style| style.font_weight.clone()), None);
    assert_eq!(doc.style(initial).and_then(|style| style.font_weight.clone()), None);
    assert!(doc.style(reverted).and_then(|style| style.font_weight.clone()).is_some(), "revert keeps the h1 weight");
    let style = doc.style(size).expect("the element has a style");
    assert_eq!(style.font_size, None);
    assert!(style.font_weight.is_some(), "only the named property is taken back");
}

#[test]
fn inherit_on_a_property_that_does_not_inherit_is_dropped() {
    let mut doc = Doc::new();
    let div = doc.classed("p", ROOT, "a");
    let plain = doc.classed("p", ROOT, "b");
    doc.style_element(ROOT, ".a { margin: inherit }");
    doc.flush();
    assert_eq!(doc.style(div).map(|style| style.margin_top.clone()), doc.style(plain).map(|style| style.margin_top.clone()));
}

#[test]
fn an_author_keyword_beats_the_universal_style() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let plain = doc.classed("div", ROOT, "b");
    let layer = doc.tree.styles.intern(br##"{"color":"#336699","paddingTop":4,"opacity":0.5}"##).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.style_element(ROOT, ".a { color: unset; padding-top: initial }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!((style.color.as_deref(), style.padding_top.clone(), style.opacity), (None, None, Some(0.5)));
    assert_eq!(doc.color(plain), Some("#336699"));
}

#[test]
fn a_keyword_on_a_longhand_leaves_the_sides_a_user_agent_shorthand_gave() {
    let mut doc = Doc::new();
    let button = doc.classed("button", ROOT, "a");
    doc.style_element(ROOT, ".a { padding-block: unset }");
    doc.flush();
    let style = doc.style(button).expect("the element has a style");
    assert_eq!((style.padding_top.clone(), style.padding_bottom.clone()), (Some(ZERO), Some(ZERO)));
    assert!(style.padding.is_some(), "the shorthand still gives the left and the right");
}

#[test]
fn an_inline_keyword_beats_the_user_agent_style_too() {
    let mut doc = Doc::new();
    let div = popover(&mut doc, "a");
    let paragraph = doc.element("p", ROOT);
    doc.inline(div, r#"{"margin":"unset","color":"inherit","right":"initial"}"#);
    doc.inline(paragraph, r#"{"marginTop":"unset","marginBottom":"revert"}"#);
    let style = doc.style(div).expect("the element has a style");
    assert!(style.margin.is_none() && style.color.is_none());
    assert_eq!((style.margin_left.clone(), style.right.clone()), (None, None));
    let style = doc.style(paragraph).expect("the element has a style");
    assert_eq!(style.margin_top.clone(), None);
    assert!(style.margin_bottom.is_some(), "revert keeps the user agent's margin");
}

#[test]
fn an_inline_keyword_beats_what_a_sheet_declared() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"unset","inset":0,"right":"unset"}"#);
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    let style = doc.style(div).expect("the element has a style");
    assert_eq!(style.color, None);
    assert_eq!(style.right.clone(), Some(crate::style::DimensionValue::Auto), "the shorthand no longer gives right 0");
}

#[test]
fn a_reset_takes_back_a_var_value_of_a_layer_under_it() {
    let mut doc = Doc::new();
    let reset = doc.classed("div", ROOT, "a");
    let shorthand = doc.classed("div", ROOT, "b");
    let longhand = doc.classed("div", ROOT, "c");
    let plain = doc.classed("div", ROOT, "d");
    let layer = doc.tree.styles.intern(br#"{"borderColor":"var(--border)","opacity":0.5}"#).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.style_element(ROOT, ".a { border-color: unset } .b { border: initial } .c { border-top-color: initial }");
    doc.flush();
    let held = |doc: &Doc, id: u64| doc.style(id).is_some_and(|style| style.var_declarations.is_some());
    assert!(!held(&doc, reset), "the `var()` of the universal style is taken back");
    assert!(!held(&doc, shorthand), "so is one a shorthand of the keyword covers");
    assert!(held(&doc, longhand), "a longhand keyword leaves the shorthand's `var()` to the other sides");
    assert!(held(&doc, plain));
    assert_eq!(doc.style(reset).and_then(|style| style.opacity), Some(0.5));
}

#[test]
fn a_longhand_reset_lays_its_initial_value_over_a_held_shorthand_of_a_layer_under_it() {
    use crate::css::custom_properties::CustomProperties;
    let mut doc = Doc::new();
    let color = doc.classed("div", ROOT, "a");
    let side = doc.classed("div", ROOT, "b");
    let plain = doc.classed("div", ROOT, "c");
    let layer = doc.tree.styles.intern(br#"{"borderColor":"var(--c)"}"#).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.style_element(ROOT, ".a { border-top-color: initial } .b { border-right-color: unset }");
    doc.flush();
    let custom = CustomProperties::declared([("--c".to_owned(), "red".to_owned())]).expect("custom properties");
    let built = |doc: &Doc, id: u64| {
        let style = doc.style(id).expect("the element has a style");
        crate::css::var_substitution::resolve(&style, &custom).expect("a held declaration")
    };
    let top = built(&doc, color);
    assert_eq!(top.border_top_color.as_deref(), Some("currentColor"), "the reset side is at its initial value");
    assert_eq!(top.border_color.as_deref(), Some("red"), "the other sides keep the shorthand");
    let right = built(&doc, side);
    assert_eq!(right.border_right_color.as_deref(), Some("currentColor"));
    assert_eq!(right.border_color.as_deref(), Some("red"));
    assert_eq!(built(&doc, plain).border_top_color, None);
    assert_eq!(built(&doc, plain).border_color.as_deref(), Some("red"));
}

#[test]
fn a_side_shorthand_reset_takes_its_longhands_back_from_a_held_border() {
    use crate::css::custom_properties::CustomProperties;
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let layer = doc.tree.styles.intern(br#"{"border":"1px solid var(--c)"}"#).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.style_element(ROOT, ".a { border-top: unset }");
    doc.flush();
    let custom = CustomProperties::declared([("--c".to_owned(), "red".to_owned())]).expect("custom properties");
    let style = doc.style(div).expect("the element has a style");
    let built = crate::css::var_substitution::resolve(&style, &custom).expect("a held declaration");
    assert_eq!(built.border_top_color.as_deref(), Some("currentColor"));
    assert_eq!(built.border_top_style.as_deref(), Some("none"));
    assert_eq!(built.border.as_deref().map(|border| border.split_whitespace().collect::<Vec<_>>()), Some(vec!["1px", "solid", "red"]), "the other sides keep the border");
}

#[test]
fn an_initial_value_written_as_a_keyword_the_parser_has_no_form_for_beats_the_user_agent_style() {
    let mut doc = Doc::new();
    let bare = popover(&mut doc, "a");
    let ruled = popover(&mut doc, "b");
    let plain = popover(&mut doc, "c");
    doc.inline(bare, r#"{"maxWidth":"none"}"#);
    doc.inline(ruled, r#"{"maxWidth":"none","color":"red"}"#);
    doc.style_element(ROOT, ".b { margin: 1px }");
    doc.flush();
    assert_eq!(doc.style(bare).and_then(|style| style.max_width.clone()), None, "no rule matches it");
    assert_eq!(doc.style(ruled).and_then(|style| style.max_width.clone()), None, "a rule matches it");
    assert!(doc.style(plain).is_some_and(|style| style.max_width.is_some()), "the user agent's 100% stays");
}

#[test]
fn a_keyword_on_webkit_font_smoothing_is_read_as_the_key_is_written() {
    let mut doc = Doc::new();
    let inline = doc.classed("div", ROOT, "a");
    let ruled = doc.classed("div", ROOT, "b");
    let plain = doc.classed("div", ROOT, "c");
    let layer = doc.tree.styles.intern(br#"{"WebkitFontSmoothing":"antialiased"}"#).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.inline(inline, r#"{"WebkitFontSmoothing":"unset"}"#);
    doc.style_element(ROOT, ".b { -webkit-font-smoothing: initial }");
    doc.flush();
    assert_eq!(doc.style(inline).and_then(|style| style.webkit_font_smoothing.clone()), None);
    assert_eq!(doc.style(ruled).and_then(|style| style.webkit_font_smoothing.clone()), None);
    assert!(doc.style(plain).is_some_and(|style| style.webkit_font_smoothing.is_some()));
}

#[test]
fn display_reset_over_an_inline_tag_is_inline() {
    let mut doc = Doc::new();
    let tags: Vec<(u64, &str)> = ["a", "strong", "em", "button"]
        .into_iter()
        .map(|tag| (doc.classed(tag, ROOT, "x"), tag))
        .collect();
    let inline = doc.element("em", ROOT);
    doc.inline(inline, r#"{"display":"initial"}"#);
    doc.style_element(ROOT, ".x { display: unset }");
    doc.flush();
    for (id, tag) in tags {
        let want = if tag == "button" { "inline-block" } else { "inline" };
        assert_eq!(doc.style(id).and_then(|style| style.display.as_deref()), Some(want), "<{tag}>");
    }
    assert_eq!(doc.style(inline).and_then(|style| style.display.as_deref()), Some("inline"));
}

#[test]
fn a_closed_popover_a_sheet_shows_is_the_user_agent_box() {
    let mut doc = Doc::new();
    let closed = doc.classed("div", ROOT, "x");
    doc.tree.set_custom_prop(closed, "popover".into(), serde_json::json!("manual"));
    doc.style_element(ROOT, ".x { display: block }");
    doc.flush();
    let style = doc.style(closed).expect("style");
    assert_eq!(style.display.as_deref(), Some("block"));
    assert_eq!(style.position.as_deref(), Some("fixed"));
    assert!(style.margin.is_some() && style.border_width.is_some() && style.padding.is_some());
}

#[test]
fn display_reset_over_no_display_is_inline() {
    let mut doc = Doc::new();
    let ruled = doc.classed("div", ROOT, "x");
    let inline = doc.element("div", ROOT);
    let plain = doc.element("div", ROOT);
    let closed = doc.classed("div", ROOT, "y");
    doc.tree.set_custom_prop(closed, "popover".into(), serde_json::json!("manual"));
    let open = popover(&mut doc, "z");
    doc.inline(inline, r#"{"display":"unset"}"#);
    doc.style_element(ROOT, ".x { display: initial } .y { display: unset } .z { display: unset }");
    doc.flush();
    let display = |id: u64| doc.style(id).and_then(|style| style.display.clone());
    assert_eq!(display(ruled).as_deref(), Some("inline"));
    assert_eq!(display(inline).as_deref(), Some("inline"));
    assert_eq!(display(plain), None, "a div that no one resets is a block");
    assert_eq!(display(closed).as_deref(), Some("inline"), "the closed popover's `display: none` is taken back; the user agent box under it stays");
    assert_eq!(display(open).as_deref(), Some("inline"));
}

#[test]
fn revert_on_a_custom_property_is_not_a_value() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"--x":"red"}"#);
    doc.style_element(ROOT, ".a { --x: revert; --y: revert-layer }");
    doc.flush();
    let custom = doc.style(div).and_then(|style| style.custom_properties.clone()).expect("custom properties");
    let computed = crate::css::custom_properties::CustomProperties::default().descend(&custom);
    assert_eq!(computed.get("--y"), None);
    assert_eq!(crate::css::custom_properties::substitute("var(--y, fb)", &computed).as_deref().map(str::trim), Some("fb"));
}

#[test]
fn a_style_without_a_keyword_has_no_reset() {
    let mut doc = Doc::new();
    let div = popover(&mut doc, "a");
    doc.inline(div, r#"{"color":"red"}"#);
    doc.style_element(ROOT, ".a { margin-top: 1px; color: green !important }");
    doc.flush();
    assert!(doc.style(div).is_some_and(|style| style.reset.is_none()));
    assert!(crate::css::sheet::resolve_wide_keywords(br#"{"color":"red","content":"a unitless value"}"#).is_none());
}

#[test]
fn nested_rules_apply() {
    let mut doc = Doc::new();
    let parent = doc.classed("div", ROOT, "p");
    let child = doc.classed("div", parent, "c");
    let outside = doc.classed("div", ROOT, "c");
    doc.style_element(ROOT, ".p { color: red; .c { background-color: blue } }");
    doc.flush();
    assert_eq!(doc.color(parent), Some("red"));
    assert_eq!(doc.background(child), Some("blue"));
    assert_eq!(doc.background(outside), None);
}

#[test]
fn a_class_change_matches_the_element_again() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let other = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".on { color: red } .a { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(div), None);

    doc.tree.set_attribute(div, "class", Some("a on".into()));
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(doc.color(other), None);

    doc.tree.set_attribute(div, "class", Some("a".into()));
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert_eq!(doc.background(div), Some("blue"));
}

#[test]
fn an_attribute_change_matches_the_subtree_again() {
    let mut doc = Doc::new();
    let parent = doc.element("div", ROOT);
    let child = doc.element("div", parent);
    doc.style_element(ROOT, "[data-theme=dark] div { color: white } [data-open] { background-color: red }");
    doc.flush();
    assert_eq!(doc.color(child), None);

    doc.tree.set_attribute(parent, "data-theme", Some("dark".into()));
    doc.flush();
    assert_eq!(doc.color(child), Some("white"));
    assert_eq!(doc.background(parent), None);

    doc.tree.set_attribute(parent, "data-open", Some(String::new()));
    doc.flush();
    assert_eq!(doc.background(parent), Some("red"));

    doc.tree.set_attribute(parent, "data-theme", None);
    doc.flush();
    assert_eq!(doc.color(child), None);
}

#[test]
fn a_change_no_selector_reads_matches_nothing_again() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    crate::perf_counters::reset();

    doc.tree.set_attribute(div, "data-unrelated", Some("1".into()));
    doc.tree.set_attribute(div, "title", Some("t".into()));
    doc.flush();
    assert_eq!(counts().elements_rematched, 0);

    doc.tree.set_attribute(div, "class", Some("a b".into()));
    doc.flush();
    assert_eq!(counts().elements_rematched, 0, "`.b` is not read either");

    doc.tree.set_attribute(div, "class", Some("b".into()));
    doc.flush();
    assert_eq!(counts().elements_rematched, 1);
}

#[test]
fn the_style_attribute_reads_the_own_declarations() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.inline(div, r#"{"--dnd-scale":"1.5","backgroundColor":"red"}"#);
    doc.style_element(ROOT, "[style*='--dnd-scale'] { color: blue } [style*='background-color: red'] { opacity: 0.5 }");
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.5));

    doc.inline(div, r#"{"backgroundColor":"red"}"#);
    doc.flush();
    assert_eq!(doc.color(div), None, "a new own style is read again");
}

#[test]
fn elements_created_before_the_sheet_are_matched_and_after_it_too() {
    let mut doc = Doc::new();
    let early = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red }");
    let late = doc.classed("div", ROOT, "a");
    doc.flush();
    assert_eq!(doc.color(early), Some("red"));
    assert_eq!(doc.color(late), Some("red"));
}

#[test]
fn an_element_built_away_from_the_document_is_matched_when_it_is_put_in() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".p > .c { color: red }");
    let parent = doc.make("div");
    doc.tree.set_attribute(parent, "class", Some("p".into()));
    let child = doc.make("div");
    doc.tree.set_attribute(child, "class", Some("c".into()));
    doc.tree.append_child(parent, child);
    doc.flush();
    assert_eq!(doc.color(child), None, "not in the document");

    doc.tree.append_child(ROOT, parent);
    doc.flush();
    assert_eq!(doc.color(child), Some("red"));

    doc.tree.detach_child(parent);
    doc.flush();
    assert_eq!(doc.color(child), None, "out of the document again");
}

#[test]
fn removing_a_sibling_matches_the_ones_after_it_again() {
    let mut doc = Doc::new();
    let first = doc.classed("span", ROOT, "a");
    let middle = doc.classed("span", ROOT, "a");
    let last = doc.classed("span", ROOT, "b");
    doc.style_element(ROOT, ".a + .b { color: red }");
    doc.flush();
    assert_eq!(doc.color(last), Some("red"), "the middle one is its previous sibling");

    doc.tree.destroy_element(middle);
    doc.flush();
    assert_eq!(doc.color(last), Some("red"), "the first one is now");
    doc.tree.destroy_element(first);
    doc.flush();
    assert_eq!(doc.color(last), None);
}

#[test]
fn inserting_a_sibling_matches_the_ones_after_it_again() {
    let mut doc = Doc::new();
    let last = doc.classed("span", ROOT, "b");
    doc.style_element(ROOT, ".a + .b { color: red }");
    doc.flush();
    assert_eq!(doc.color(last), None);

    let first = doc.make("span");
    doc.tree.set_attribute(first, "class", Some("a".into()));
    doc.tree.insert_before(ROOT, first, last);
    doc.flush();
    assert_eq!(doc.color(last), Some("red"));
}

#[test]
fn a_text_node_is_skipped_by_sibling_combinators() {
    let mut doc = Doc::new();
    doc.classed("span", ROOT, "a");
    let text = doc.element("#text", ROOT);
    doc.tree.set_text(text, "hello".into());
    let last = doc.classed("span", ROOT, "b");
    doc.style_element(ROOT, ".a + .b { color: red }");
    doc.flush();
    assert_eq!(doc.color(last), Some("red"));

    doc.tree.destroy_element(text);
    doc.flush();
    assert_eq!(doc.color(last), Some("red"));
}

#[test]
fn removing_a_sheet_restores_the_inline_style() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"green"}"#);
    let own = doc.style_arc(div);
    doc.tree.set_style_sheet(5, Some(".a { color: red !important; opacity: 0.5 }"));
    doc.tree.set_adopted_style_sheets(vec![5]);
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    doc.tree.set_adopted_style_sheets(vec![]);
    doc.flush();
    assert_eq!(doc.color(div), Some("green"));
    assert!(Arc::ptr_eq(&doc.style_arc(div).unwrap(), &own.unwrap()), "exactly the own style again");
}

#[test]
fn deleting_the_last_sheet_frees_the_state() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.tree.set_style_sheet(5, Some(".a { color: red }"));
    doc.tree.set_adopted_style_sheets(vec![5]);
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert!(doc.tree.sheets.enabled);

    doc.tree.set_style_sheet(5, None);
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert!(!doc.tree.sheets.enabled);
    assert!(doc.tree.elements[&div].css().is_none_or(|css| css.is_empty()));
    assert_eq!(doc.tree.styles.cascaded.len(), 0);

    doc.tree.set_style_sheet(5, Some(".a { color: blue }"));
    doc.tree.set_adopted_style_sheets(vec![5]);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"), "the adopted list outlived the sheet");
}

#[test]
fn a_style_elements_text_is_the_sheet_and_a_change_to_it_applies() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (style, text) = doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    doc.tree.set_text(text, ".a { color: blue }".into());
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));

    // The sheet is every text child of the element.
    let more = doc.make("#text");
    doc.tree.set_text(more, " .a { background-color: red }".into());
    doc.tree.append_child(style, more);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.background(div), Some("red"));

    doc.tree.destroy_element(more);
    doc.flush();
    assert_eq!(doc.background(div), None);
}

#[test]
fn a_style_element_is_not_rendered() {
    let mut doc = Doc::new();
    let (style, text) = doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.tree.elements[&style].display().as_deref(), Some("none"));
    assert!(crate::layout::box_generation::is_display_none(&doc.tree.elements[&style]));
    assert!(doc.tree.elements[&text].parent == Some(style));
}

#[test]
fn a_detached_style_element_stops_applying_and_applies_when_put_back() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (style, _) = doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    doc.tree.detach_child(style);
    doc.flush();
    assert_eq!(doc.color(div), None);

    doc.tree.append_child(ROOT, style);
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    doc.tree.destroy_element(style);
    doc.flush();
    assert_eq!(doc.color(div), None);
    assert!(!doc.tree.sheets.enabled);
}

#[test]
fn a_reload_matches_a_detached_element_even_when_a_child_id_has_no_element() {
    let mut doc = Doc::new();
    let detached = doc.make("div");
    // The walk from the root lists the missing id, so it is as long as the element table.
    doc.tree.elements.get_mut(&ROOT).unwrap().children.push(9999);
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    let set = doc.tree.restyle_set(&[], true);
    assert!(set.contains(&(detached, false)), "{set:?}");
    assert!(set.contains(&(ROOT, true)));
}

#[test]
fn a_style_element_under_a_detached_parent_does_not_apply() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let holder = doc.make("div");
    let (_, _) = doc.style_element(holder, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), None);

    doc.tree.append_child(ROOT, holder);
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn elements_that_match_the_same_rules_share_one_cascade() {
    let mut doc = Doc::new();
    doc.inline(ROOT, "{}");
    let rows: Vec<u64> = (0..40).map(|_| doc.classed("div", ROOT, "row")).collect();
    for row in &rows {
        doc.inline(*row, r#"{"opacity":0.5}"#);
    }
    doc.style_element(ROOT, ".row { color: red }");
    crate::perf_counters::reset();
    doc.flush();
    assert_eq!(counts().cascades_computed, 1, "forty rows, one merge");
    for row in &rows {
        assert!(Arc::ptr_eq(&doc.style_arc(*row).unwrap(), &doc.style_arc(rows[0]).unwrap()));
        assert_eq!(doc.color(*row), Some("red"));
    }

    // A row with another own style is another pair, and a new row with the first pair is a hit.
    let other = doc.classed("div", ROOT, "row");
    doc.inline(other, r#"{"opacity":0.7}"#);
    let same = doc.classed("div", ROOT, "row");
    doc.inline(same, r#"{"opacity":0.5}"#);
    doc.flush();
    assert_eq!(counts().cascades_computed, 2);
}

#[test]
fn a_sheet_change_clears_the_cascade_cache() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let (_, text) = doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.tree.styles.cascaded.len(), 1);
    crate::perf_counters::reset();

    doc.tree.set_text(text, ".a { color: blue }".into());
    doc.flush();
    assert_eq!(counts().cascades_computed, 1);
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.tree.styles.cascaded.len(), 1);
}

#[test]
fn a_drag_over_a_rule_naming_the_dragged_keys_leaves_the_cascade_cache_and_style_table_bounded() {
    let mut doc = Doc::new();
    let item = doc.classed("div", ROOT, "item");
    doc.style_element(ROOT, ".item { left: 0px; top: 0px }");
    doc.flush();
    for frame in 1..200 {
        doc.inline(item, &format!(r#"{{"left":{frame},"top":{frame}}}"#));
        doc.flush();
        doc.tree.styles.sweep();
    }
    assert!(doc.tree.styles.cascaded.len() <= 2, "cascade entries: {}", doc.tree.styles.cascaded.len());
    assert!(doc.tree.styles.len() <= 3, "interned styles: {}", doc.tree.styles.len());
    assert!(doc.style(item).is_some_and(|style| style.left.is_some()));
}

#[test]
fn own_styles_that_all_merge_to_one_style_are_not_pinned_by_it() {
    let mut doc = Doc::new();
    let item = doc.classed("div", ROOT, "x");
    doc.style_element(ROOT, ".x { left: 0px !important }");
    doc.flush();
    for frame in 1..200 {
        doc.inline(item, &format!(r#"{{"left":{frame}}}"#));
        doc.flush();
        doc.tree.styles.sweep();
    }
    // The element's current own style, and the rules alone, which stay while the rules are held.
    assert!(doc.tree.styles.cascaded.len() <= 2, "cascade entries: {}", doc.tree.styles.cascaded.len());
    assert!(doc.tree.styles.len() <= 3, "interned styles: {}", doc.tree.styles.len());
    assert!(doc.style(item).is_some_and(|style| style.left.is_some()));
}

#[test]
fn a_cascade_entry_with_no_own_style_survives_sweeps_when_the_elements_holding_it_hold_a_layered_style() {
    let mut doc = Doc::new();
    // An `li` has a user agent style, so each element holds the layer over the merge and not the merge.
    let items: Vec<u64> = (0..30).map(|_| doc.classed("li", ROOT, "item")).collect();
    // The inline style is what the sheet merges to, so that entry's merged style is its own style.
    let equal = doc.classed("li", ROOT, "item");
    doc.inline(equal, r#"{"color":"red"}"#);
    doc.style_element(ROOT, ".item { color: red }");
    doc.flush();
    for _ in 0..3 {
        doc.tree.styles.sweep();
    }
    let entries = doc.tree.styles.cascaded.len();
    assert!(entries >= 2, "an entry for the tag alone and one for the own style: {entries}");

    crate::perf_counters::reset();
    let later = doc.classed("li", ROOT, "item");
    doc.flush();
    assert_eq!(counts().cascades_computed, 0, "a new item is a hit on the entry that was kept");
    assert_eq!(doc.tree.styles.cascaded.len(), entries);
    assert!(items.iter().chain([&equal, &later]).all(|id| doc.color(*id) == Some("red")));
}

#[test]
fn z_index_auto_takes_back_an_earlier_rules_value_and_so_does_an_inline_one() {
    let mut doc = Doc::new();
    let both = doc.classed("div", ROOT, "a b");
    let inline = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { z-index: 5 } .a.b { z-index: auto }");
    doc.inline(inline, r#"{"zIndex":"auto"}"#);
    doc.flush();
    assert_eq!(doc.style(both).and_then(|style| style.z_index), None);
    assert_eq!(doc.style(inline).and_then(|style| style.z_index), None);
}

#[test]
fn an_initial_keyword_the_style_parser_reads_still_applies_as_written() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a b");
    doc.style_element(ROOT, ".a { top: 5px } .a.b { top: auto }");
    doc.flush();
    assert!(doc.style(div).is_some_and(|style| style.top.is_some()));
}

#[test]
fn an_opacity_percentage_from_a_sheet_overrides_an_earlier_rule() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a b");
    doc.style_element(ROOT, ".a { opacity: 1 } .a.b { opacity: 50% }");
    doc.flush();
    assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.5));
}

#[test]
fn an_inline_important_beats_an_important_rule_and_an_inline_normal_value_does_not() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red !important; opacity: 0.2 !important; display: flex }");
    doc.inline(div, r#"{"color":"blue !important","opacity":0.9,"display":"none"}"#);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.2));
    assert_eq!(doc.style(div).and_then(|style| style.display.as_deref()), Some("none"));
}

#[test]
fn an_inline_important_with_no_rule_matching_is_the_plain_value() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.style_element(ROOT, ".never { color: red }");
    doc.inline(div, r#"{"display":"none !important","color":"blue"}"#);
    doc.flush();
    assert_eq!(doc.style(div).and_then(|style| style.display.as_deref()), Some("none"));
    assert_eq!(doc.color(div), Some("blue"));
}

#[test]
fn an_inline_important_is_the_plain_value_when_there_is_no_sheet() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.inline(div, r#"{"display":"none !important"}"#);
    assert_eq!(doc.style(div).and_then(|style| style.display.as_deref()), Some("none"));
}

#[test]
fn entries_that_share_one_cascaded_style_are_released_once_no_element_uses_it() {
    let mut doc = Doc::new();
    let first = doc.classed("div", ROOT, "a");
    let second = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red !important }");
    doc.inline(first, r#"{"color":"blue"}"#);
    doc.inline(second, r#"{"color":"green"}"#);
    doc.flush();
    assert_eq!(doc.tree.styles.cascaded.len(), 2);
    assert!(Arc::ptr_eq(&doc.style_arc(first).unwrap(), &doc.style_arc(second).unwrap()));

    doc.tree.set_attribute(first, "class", None);
    doc.tree.set_attribute(second, "class", None);
    doc.flush();
    doc.tree.styles.sweep();
    assert_eq!(doc.tree.styles.cascaded.len(), 0);
    assert_eq!(doc.color(first), Some("blue"));
}

#[test]
fn names_no_sheet_mentions_are_not_interned_and_elements_keep_nothing_of_them() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a { color: red } #b { color: blue }");
    doc.flush();
    let names = doc.tree.sheets.atoms.len();
    let mut last = 0;
    for n in 0..10_000 {
        last = doc.classed("div", ROOT, &format!("c{n} d{n}"));
        doc.tree.set_attribute(last, "id", Some(format!("i{n}")));
    }
    doc.flush();
    assert_eq!(doc.tree.sheets.atoms.len(), names);
    assert!(doc.tree.elements[&last].css().is_none_or(|css| css.is_empty()));
    assert!(doc.tree.elements[&last].attribute_store().is_some());
}

#[test]
fn a_sheet_that_names_a_class_elements_already_have_matches_them() {
    let mut doc = Doc::new();
    let late = doc.classed("div", ROOT, "late other");
    let named = doc.classed("div", ROOT, "a");
    let identified = doc.element("div", ROOT);
    doc.tree.set_attribute(identified, "id", Some("i".into()));
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(late), None);
    assert_eq!(doc.color(named), Some("red"));

    doc.style_element(ROOT, ".late { color: blue } #i { color: green }");
    doc.flush();
    assert_eq!(doc.color(late), Some("blue"));
    assert_eq!(doc.color(identified), Some("green"));
    assert_eq!(doc.color(named), Some("red"));

    doc.tree.set_attribute(late, "class", Some("other".into()));
    doc.flush();
    assert_eq!(doc.color(late), None);
}

#[test]
fn winding_down_frees_the_names_and_the_style_texts() {
    let mut doc = Doc::new();
    let item = doc.classed("div", ROOT, "a");
    doc.inline(item, r#"{"left":1}"#);
    let (style, _) = doc.style_element(ROOT, r#".a { color: red } [style*="left"] { top: 1px }"#);
    doc.flush();
    assert!(doc.tree.sheets.atoms.len() > 1);
    assert_eq!(doc.tree.sheets.style_text_count(), 1);

    doc.tree.destroy_element(style);
    doc.flush();
    assert!(!doc.tree.sheets.enabled);
    assert_eq!(doc.tree.sheets.atoms.len(), 1);
    assert_eq!(doc.tree.sheets.style_text_count(), 0);
    assert!(doc.tree.elements[&item].css().is_none_or(|css| css.is_empty()));

    doc.style_element(ROOT, ".a { color: blue }");
    doc.flush();
    assert_eq!(doc.color(item), Some("blue"));
}

#[test]
fn sibling_combinators_over_thousands_of_siblings_cost_work_in_proportion_to_them() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a + .b { color: red } .a ~ .c { background-color: blue }");
    doc.flush();
    let n = 2000;
    let list = doc.element("div", ROOT);
    let items: Vec<u64> = (0..n).map(|i| doc.classed("div", list, ["a", "b", "c"][i % 3])).collect();
    reset_sibling_work();
    doc.flush();
    assert!(sibling_work() < 40 * n, "mount: {}", sibling_work());
    assert_eq!(doc.color(items[1]), Some("red"));
    assert_eq!(doc.color(items[2]), None);
    assert_eq!(doc.background(items[2]), Some("blue"));
    assert_eq!(doc.background(items[0]), None);
    assert_eq!(doc.background(items[n - 1]), doc.background(items[n - 1 - 3]));

    reset_sibling_work();
    doc.tree.set_attribute(items[999], "class", Some("z".into()));
    doc.flush();
    assert!(sibling_work() < 40 * n, "toggle: {}", sibling_work());
    assert_eq!(doc.color(items[1000]), None);
    assert_eq!(doc.background(items[1001]), Some("blue"));

    reset_sibling_work();
    doc.tree.set_attribute(items[0], "class", Some("z".into()));
    doc.flush();
    assert!(sibling_work() < 40 * n, "first toggle: {}", sibling_work());
    assert_eq!(doc.color(items[1]), None);
}

#[test]
fn a_subsequent_sibling_combinator_that_cannot_match_costs_work_in_proportion_to_the_siblings() {
    let n = 2000;
    // The position of the one `.x` among n `.item`s, or none.
    for x_at in [None, Some(n - 1), Some(1000)] {
        let mut doc = Doc::new();
        doc.style_element(ROOT, ".x ~ .item { color: red }");
        doc.flush();
        let list = doc.element("div", ROOT);
        let items: Vec<u64> =
            (0..n).map(|i| doc.classed("div", list, if x_at == Some(i) { "x" } else { "item" })).collect();
        reset_sibling_work();
        doc.flush();
        assert!(sibling_work() < 40 * n, "{x_at:?}: {}", sibling_work());
        for (i, item) in items.iter().enumerate() {
            let expected = x_at.is_some_and(|x| x < i).then_some("red");
            assert_eq!(doc.color(*item), expected, "{x_at:?} item {i}");
        }
    }
}

#[test]
fn a_type_selector_ignores_case_on_an_html_element_and_not_on_an_svg_one() {
    let mut doc = Doc::new();
    let svg = doc.element("linearGradient", ROOT);
    let html = doc.element("lineargradient", ROOT);
    let shouting = doc.element("DIV", ROOT);
    doc.style_element(ROOT, "lineargradient { color: red } linearGradient { background-color: blue } Div { opacity: 0.5 }");
    doc.flush();
    assert_eq!(doc.color(svg), None);
    assert_eq!(doc.background(svg), Some("blue"));
    assert_eq!(doc.color(html), Some("red"));
    assert_eq!(doc.background(html), Some("blue"));
    assert_eq!(doc.style(shouting).and_then(|style| style.opacity), Some(0.5));
}

#[test]
fn a_skipped_rule_is_logged_once_across_reloads_and_again_after_the_sheets_are_gone() {
    let mut doc = Doc::new();
    let (first, _) = doc.style_element(ROOT, "@media print { a { color: red } } a:checked { color: red } .a { color: blue }");
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, 2);

    let (second, text) = doc.style_element(ROOT, ".b { color: red }");
    doc.flush();
    doc.tree.set_text(text, ".b { color: red } @media print { a { color: red } } @font-face { x: y }".into());
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, 3, "only @font-face is new");

    doc.tree.destroy_element(first);
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, 3);

    doc.tree.destroy_element(second);
    doc.flush();
    assert!(!doc.tree.sheets.enabled);
    doc.style_element(ROOT, "@font-face { x: y }");
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, 4);
}

#[test]
fn sibling_marks_under_one_parent_expand_the_following_siblings_once() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, ".a ~ .b { color: red }");
    doc.flush();
    let n = 2000;
    let items: Vec<u64> = (0..n).map(|_| doc.classed("div", ROOT, "b")).collect();
    doc.flush();
    reset_sibling_work();
    for item in items.iter().step_by(2) {
        doc.tree.set_attribute(*item, "class", Some("a".into()));
    }
    doc.flush();
    assert!(sibling_work() < 40 * n, "marks: {}", sibling_work());
    assert_eq!(doc.color(items[0]), None);
    assert_eq!(doc.color(items[1]), Some("red"));
    assert_eq!(doc.color(items[2]), None);
    assert_eq!(doc.color(items[3]), Some("red"));
}

#[test]
fn a_style_element_deep_in_a_large_subtree_is_found_when_the_subtree_is_removed() {
    let mut doc = Doc::new();
    let item = doc.classed("div", ROOT, "a");
    let container = doc.element("div", ROOT);
    for _ in 0..100 {
        doc.element("div", container);
    }
    let nested = doc.element("div", container);
    doc.style_element(nested, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(item), Some("red"));

    doc.tree.detach_child(container);
    doc.flush();
    assert_eq!(doc.color(item), None);
}

#[test]
fn an_element_that_stops_matching_and_has_no_classes_lets_go_of_its_extras() {
    let mut doc = Doc::new();
    let item = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert!(doc.tree.elements[&item].css().is_some_and(|css| css.matched.is_some()));

    doc.tree.set_attribute(item, "class", None);
    doc.flush();
    assert_eq!(doc.color(item), None);
    assert!(doc.tree.elements[&item].css().is_none());
}

fn sibling_work() -> usize {
    super::view::SIBLING_WORK.with(|work| work.get())
}

fn reset_sibling_work() {
    super::view::SIBLING_WORK.with(|work| work.set(0));
}

#[test]
fn the_universal_layer_goes_under_the_cascade() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    let layer = doc.tree.styles.intern(br#"{"color":"gray","backgroundColor":"gray"}"#).unwrap();
    doc.tree.set_universal_style(Some(layer.into_arc()));
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
    assert_eq!(doc.background(div), Some("gray"));
}

#[test]
fn a_text_node_is_never_matched() {
    let mut doc = Doc::new();
    let text = doc.make("#text");
    doc.tree.set_text(text, "hello".into());
    doc.tree.set_attribute(text, "class", Some("a".into()));
    doc.tree.append_child(ROOT, text);
    doc.style_element(ROOT, ".a { color: red } * { color: red } #text { color: red }");
    doc.flush();
    assert_eq!(doc.color(text), None);
}

#[test]
fn root_matches_the_container_element() {
    let mut doc = Doc::new();
    let child = doc.element("div", ROOT);
    doc.style_element(ROOT, ":root { color: red } :root > div { background-color: blue }");
    doc.flush();
    assert_eq!(doc.color(ROOT), Some("red"));
    assert_eq!(doc.color(child), None);
    assert_eq!(doc.background(child), Some("blue"));
}

#[test]
fn an_invalid_value_in_a_sheet_does_not_take_the_element_down() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red; transition-duration: bogus }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));
}

#[test]
fn a_restyle_marks_the_tree_like_set_style() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red }");
    doc.flush();
    doc.tree.take_dirty();
    let revision = doc.tree.elements[&div].subtree_revision;

    doc.tree.set_attribute(div, "class", Some("b".into()));
    doc.flush();
    assert_ne!(doc.tree.elements[&div].subtree_revision, revision, "the style changed, so the element is dirty");
    assert_ne!(doc.tree.take_dirty(), crate::retained_tree::Dirty::Clean);
}

// Invalidation: what a change marks.

impl Doc {
    /// How many elements matched again for what `change` did and the flush that followed.
    fn rematched(&mut self, change: impl FnOnce(&mut Doc)) -> u64 {
        crate::perf_counters::reset();
        change(self);
        self.flush();
        counts().elements_rematched
    }

    fn class(&mut self, id: u64, class: &str) {
        self.tree.set_attribute(id, "class", Some(class.into()));
    }

    /// `count` elements of `tag` under `parent`, classed `class`.
    fn run(&mut self, count: usize, tag: &str, parent: u64, class: &str) -> Vec<u64> {
        (0..count).map(|_| self.classed(tag, parent, class)).collect()
    }

    /// The sheet comes first, so the elements built after it have no `<style>` among their siblings.
    fn settled(css: &str, build: impl FnOnce(&mut Doc)) -> Doc {
        let mut doc = Doc::new();
        doc.style_element(ROOT, css);
        build(&mut doc);
        doc.flush();
        doc
    }
}

#[test]
fn a_class_only_the_subject_reads_matches_one_element_again() {
    let mut list = Vec::new();
    let mut doc = Doc::settled(".a { color: red }", |doc| list = doc.run(20, "div", ROOT, "x"));
    assert_eq!(doc.rematched(|doc| doc.class(list[7], "x a")), 1);
    assert_eq!(doc.color(list[7]), Some("red"));
    assert_eq!(doc.rematched(|doc| doc.class(list[7], "x")), 1);
    assert_eq!(doc.color(list[7]), None);
}

#[test]
fn a_class_read_through_a_descendant_combinator_matches_the_descendants_again() {
    let (mut parent, mut child, mut grandchild, mut other_child, mut elsewhere) = (0, 0, 0, 0, 0);
    let mut doc = Doc::settled(".a .b { color: red }", |doc| {
        parent = doc.classed("div", ROOT, "x");
        child = doc.classed("div", parent, "b");
        grandchild = doc.classed("div", child, "b");
        other_child = doc.classed("div", parent, "x");
        let unrelated = doc.classed("div", ROOT, "x");
        elsewhere = doc.classed("div", unrelated, "b");
    });
    assert_eq!(doc.rematched(|doc| doc.class(parent, "x a")), 3, "the three below it, not itself");
    assert_eq!(doc.color(child), Some("red"));
    assert_eq!(doc.color(grandchild), Some("red"));
    assert_eq!(doc.color(other_child), None);
    assert_eq!(doc.color(elsewhere), None);
}

#[test]
fn a_class_read_through_a_child_combinator_matches_only_the_children_again() {
    let (mut parent, mut child, mut grandchild) = (0, 0, 0);
    let mut doc = Doc::settled(".a > .b { color: red }", |doc| {
        parent = doc.classed("div", ROOT, "x");
        child = doc.classed("div", parent, "b");
        doc.classed("div", parent, "b");
        grandchild = doc.classed("div", child, "b");
    });
    assert_eq!(doc.rematched(|doc| doc.class(parent, "a")), 2);
    assert_eq!(doc.color(child), Some("red"));
    assert_eq!(doc.color(grandchild), None);
}

#[test]
fn a_class_read_through_sibling_combinators_matches_the_siblings_again() {
    let mut siblings = Vec::new();
    let mut doc = Doc::settled(".a + .b { color: red } .c ~ .d { background-color: blue }", |doc| {
        siblings = doc.run(5, "span", ROOT, "b d");
    });
    assert_eq!(doc.rematched(|doc| doc.class(siblings[1], "b d a")), 1, "only the next one");
    assert_eq!(doc.color(siblings[2]), Some("red"));
    assert_eq!(doc.color(siblings[3]), None);

    assert_eq!(doc.rematched(|doc| doc.class(siblings[1], "b d c")), 3, "all that follow");
    assert_eq!(doc.background(siblings[2]), Some("blue"));
    assert_eq!(doc.background(siblings[4]), Some("blue"));
    assert_eq!(doc.background(siblings[0]), None);
    assert_eq!(doc.color(siblings[2]), None, "no longer after an .a");
}

#[test]
fn a_sibling_combinator_followed_by_a_descendant_one_matches_below_the_siblings_again() {
    let (mut first, mut second, mut inside, mut later) = (0, 0, 0, 0);
    let mut doc = Doc::settled(".a + .b .c { color: red }", |doc| {
        first = doc.classed("div", ROOT, "x");
        second = doc.classed("div", ROOT, "b");
        inside = doc.classed("div", second, "c");
        later = doc.classed("div", ROOT, "b");
        doc.classed("div", later, "c");
    });
    assert_eq!(doc.rematched(|doc| doc.class(first, "a")), 1, "what is below the next sibling");
    assert_eq!(doc.color(inside), Some("red"));
    assert_eq!(doc.rematched(|doc| doc.class(second, "x")), 1, "what is below an element read as `.b`");
    assert_eq!(doc.color(inside), None);
}

#[test]
fn a_class_no_selector_names_matches_nothing_again() {
    let mut list = Vec::new();
    let mut doc = Doc::settled(".a .b + .c { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    assert_eq!(doc.rematched(|doc| doc.class(list[3], "x other")), 0);
    assert_eq!(doc.rematched(|doc| doc.class(list[3], "")), 0);
}

#[test]
fn an_attribute_that_is_set_or_removed_marks_what_a_selector_reads_it_for() {
    let mut list = Vec::new();
    let mut doc = Doc::settled("[data-x] { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(list[2], "data-x", Some(String::new())))), 1);
    assert_eq!(doc.color(list[2]), Some("red"));
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(list[2], "data-x", None))), 1);
    assert_eq!(doc.color(list[2]), None);
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(list[2], "data-y", Some(String::new())))), 0);
}

#[test]
fn an_aria_attribute_marks_like_any_attribute() {
    let mut list = Vec::new();
    let mut doc = Doc::settled("[aria-busy=true] { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(list[4], "aria-busy", Some("true".into())))), 1);
    assert_eq!(doc.color(list[4]), Some("red"));
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(list[4], "aria-label", Some("x".into())))), 0);
}

#[test]
fn an_id_change_marks_the_old_and_the_new_id() {
    let mut list = Vec::new();
    let mut doc = Doc::settled("#one { color: red } #two { background-color: blue }", |doc| {
        list = doc.run(10, "div", ROOT, "x");
    });
    fn set(id: u64, value: Option<&'static str>) -> impl FnOnce(&mut Doc) {
        move |doc| drop(doc.tree.set_attribute(id, "id", value.map(String::from)))
    }
    assert_eq!(doc.rematched(set(list[1], Some("one"))), 1);
    assert_eq!(doc.color(list[1]), Some("red"));
    assert_eq!(doc.rematched(set(list[1], Some("two"))), 1);
    assert_eq!(doc.color(list[1]), None);
    assert_eq!(doc.background(list[1]), Some("blue"));
    assert_eq!(doc.rematched(set(list[1], Some("three"))), 1, "the old one was named");
    assert_eq!(doc.background(list[1]), None);
    assert_eq!(doc.rematched(set(list[1], Some("four"))), 0, "neither is");
    assert_eq!(doc.rematched(set(list[1], None)), 0);
}

#[test]
fn a_negated_class_marks_the_subject() {
    let mut list = Vec::new();
    let mut doc = Doc::settled(":not(.a) { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    assert_eq!(doc.color(list[0]), Some("red"));
    assert_eq!(doc.rematched(|doc| doc.class(list[5], "a")), 1);
    assert_eq!(doc.color(list[5]), None);
    assert_eq!(doc.color(list[6]), Some("red"));
}

#[test]
fn a_selector_inside_is_reaches_through_its_own_combinators() {
    let (mut parent, mut child, mut grandchild, mut other) = (0, 0, 0, 0);
    let mut doc = Doc::settled(":is(.a .b) { color: red }", |doc| {
        parent = doc.classed("div", ROOT, "x");
        child = doc.classed("div", parent, "b");
        grandchild = doc.classed("div", child, "x");
        other = doc.classed("div", ROOT, "b");
    });
    assert_eq!(doc.rematched(|doc| doc.class(parent, "a")), 2, "what is below it");
    assert_eq!(doc.color(child), Some("red"));
    assert_eq!(doc.color(other), None);
    assert_eq!(doc.rematched(|doc| doc.class(child, "b y")), 0, "`.b` stays, `.y` is read by nothing");
}

#[test]
fn an_insert_matches_the_new_subtree_and_siblings_only_when_a_selector_looks_at_them() {
    let mut list = Vec::new();
    let mut doc = Doc::settled(".a { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    let inserted = doc.make("div");
    let child = doc.make("div");
    doc.tree.append_child(inserted, child);
    assert_eq!(doc.rematched(|doc| doc.tree.insert_before(ROOT, inserted, list[2])), 2, "it and what it holds");
    assert_eq!(doc.rematched(|doc| doc.tree.detach_child(inserted)), 2, "out of the document, it and what it holds");

    let mut doc = Doc::settled(".a + .b { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    let inserted = doc.make("div");
    assert_eq!(doc.rematched(|doc| doc.tree.insert_before(ROOT, inserted, list[2])), 2, "it and the one it now precedes");
    assert_eq!(doc.rematched(|doc| drop(doc.tree.destroy_element(inserted))), 1, "the one after it");
}

#[test]
fn a_general_sibling_combinator_matches_the_following_siblings_on_insert_and_removal() {
    let mut list = Vec::new();
    let mut doc = Doc::settled(".a ~ .b { color: red }", |doc| list = doc.run(10, "div", ROOT, "x"));
    let inserted = doc.make("div");
    assert_eq!(doc.rematched(|doc| doc.tree.insert_before(ROOT, inserted, list[6])), 5, "it and the four after");
    assert_eq!(doc.rematched(|doc| drop(doc.tree.destroy_element(list[6]))), 3, "what follows it");
}

#[test]
fn the_dnd_kit_attribute_marks_the_element_and_what_is_below_it() {
    let mut items = Vec::new();
    let mut doc = Doc::settled(include_str!("fixtures/dnd-kit.css"), |doc| {
        let list = doc.classed("div", ROOT, "list");
        items = doc.run(100, "div", list, "item");
        for item in &items {
            let child = doc.element("div", *item);
            doc.element("div", child);
        }
    });
    let dragged = items[40];
    assert_eq!(
        doc.rematched(|doc| drop(doc.tree.set_attribute(dragged, "data-dnd-dragging", Some(String::new())))),
        3,
        "the item, its child and its grandchild: `[data-dnd-dragging] *`"
    );
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(dragged, "data-dnd-dragging", None))), 3);
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(items[41], "data-dnd-overlay", Some(String::new())))), 1);
    assert_eq!(doc.rematched(|doc| drop(doc.tree.set_attribute(items[41], "data-unrelated", Some(String::new())))), 0);
}

#[test]
fn an_invalid_important_declaration_does_not_take_part_in_the_cascade() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"right":"5px","top":"1px"}"#);
    doc.style_element(ROOT, ".a { right: bogus !important; top: 2px !important; color: red }");
    doc.flush();
    assert!(doc.style(div).unwrap().right.is_some(), "the inline `right` stays");
    assert_eq!(doc.color(div), Some("red"));
    let top = doc.style(div).unwrap().top.clone();
    let wins = doc.tree.styles.intern(br#"{"top":"2px"}"#).unwrap().top.clone();
    assert_eq!(top, wins, "a valid important declaration still wins");
}

#[test]
fn a_declaration_with_an_unknown_property_is_ignored() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { frobnicate: 1px !important; color: red }");
    doc.flush();
    assert_eq!(doc.color(div), Some("red"));

    let only = doc.classed("div", ROOT, "b");
    doc.style_element(ROOT, ".b { frobnicate: 1px }");
    doc.flush();
    assert!(doc.tree.elements[&only].css().is_some_and(|css| css.matched.is_none()), "nothing is left of the rule");
}

#[test]
fn custom_properties_var_and_css_wide_keywords_stay_in_the_cascade() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "a");
    doc.inline(div, r#"{"color":"green"}"#);
    doc.style_element(ROOT, ".a { --x: whatever; width: var(--w, 4px); color: unset !important }");
    doc.flush();
    assert_eq!(doc.color(div), None, "`unset` took the inline color back");
    assert!(doc.style(div).is_some_and(|style| style.var_declarations.is_some()), "the `var()` is held for build time");
}

// ── The order of the layers under the inline style ──────────────────

impl Doc {
    fn universal(&mut self, json: &str) {
        let style = crate::retained_tree::parse_style(json.as_bytes()).unwrap();
        self.tree.set_universal_style(Some(Arc::new(style)));
    }

    fn margin_top(&self, id: u64) -> Option<String> {
        self.style(id).and_then(|style| style.margin_top.as_ref()).map(|margin| format!("{margin:?}"))
    }
}

#[test]
fn a_rule_beats_the_user_agent_style_of_a_tag() {
    let mut doc = Doc::new();
    let p = doc.classed("p", ROOT, "x");
    let other = doc.element("p", ROOT);
    let button = doc.element("button", ROOT);
    assert_eq!(doc.style(button).and_then(|style| style.display.as_deref()), Some("inline-block"));
    let user_agent = doc.margin_top(p);
    doc.style_element(ROOT, "p.x { margin-top: 0px } button { display: flex }");
    doc.flush();
    assert_ne!(doc.margin_top(p), user_agent, "the rule replaced the margin of the tag");
    assert_eq!(doc.margin_top(other), user_agent, "a `p` the rule does not match keeps it");
    assert_eq!(doc.style(p).and_then(|style| style.display.as_deref()), Some("block"), "and what the rule leaves out is the tag's");
    assert_eq!(doc.style(button).and_then(|style| style.display.as_deref()), Some("flex"));
}

#[test]
fn the_layers_stack_from_the_tag_to_an_important_inline_value() {
    let mut doc = Doc::new();
    let mark = doc.classed("mark", ROOT, "a");
    assert_eq!(doc.color(mark), Some("#000000"), "the user agent style of the tag");

    doc.universal(r##"{"color":"#111111","opacity":0.5}"##);
    assert_eq!(doc.color(mark), Some("#111111"), "`*` beats the user agent style");
    assert_eq!(doc.background(mark), Some("#ffff00"), "and leaves what it does not set");

    doc.style_element(ROOT, ".a { color: red; opacity: 0.2 }");
    doc.flush();
    assert_eq!(doc.color(mark), Some("red"), "a rule beats `*`");
    assert_eq!(doc.style(mark).and_then(|style| style.opacity), Some(0.2));

    doc.inline(mark, r#"{"color":"green"}"#);
    doc.flush();
    assert_eq!(doc.color(mark), Some("green"), "an inline value beats a rule");

    let (_, _) = doc.style_element(ROOT, ".a { color: blue !important }");
    doc.flush();
    assert_eq!(doc.color(mark), Some("blue"), "an important rule beats an inline value");

    doc.inline(mark, r#"{"color":"purple !important"}"#);
    doc.flush();
    assert_eq!(doc.color(mark), Some("purple"), "an important inline value beats an important rule");
    assert_eq!(doc.background(mark), Some("#ffff00"), "the tag still shows through where nothing else speaks");
}

#[test]
fn a_rule_sets_the_display_of_html_and_body_and_the_style_attribute_selector_leaves_them_alone() {
    let mut doc = Doc::new();
    let html = doc.make("html");
    let head = doc.make("head");
    let body = doc.make("body");
    doc.tree.append_child(html, head);
    doc.tree.append_child(html, body);
    doc.tree.set_root(html);
    assert_eq!(doc.style(body).and_then(|style| style.display.as_deref()), Some("block"));
    assert_eq!(doc.style(head).and_then(|style| style.display.as_deref()), Some("none"));
    assert!(doc.style(body).is_some_and(|style| style.width.is_some() && style.height.is_some()));
    assert!(doc.tree.elements[&body].own_style().is_none(), "nothing sends the defaults as an inline style");

    let marked = doc.element("div", body);
    doc.inline(marked, r#"{"color":"red"}"#);
    doc.style_element(head, "body { display: flex } [style] { opacity: 0.3 }");
    doc.flush();
    assert_eq!(doc.style(body).and_then(|style| style.display.as_deref()), Some("flex"));
    assert_eq!(doc.style(head).and_then(|style| style.display.as_deref()), Some("none"), "head is not matched");
    assert!(doc.style(body).is_some_and(|style| style.width.is_some()), "the rest of the defaults stay");
    assert_eq!(doc.style(body).and_then(|style| style.opacity), None);
    assert_eq!(doc.style(html).and_then(|style| style.opacity), None);
    assert_eq!(doc.style(marked).and_then(|style| style.opacity), Some(0.3));
}

#[test]
fn a_type_selector_matches_the_html_tags_by_name() {
    let mut doc = Doc::new();
    let ids: Vec<(&str, u64)> = ["p", "button", "a", "h1", "ul", "li", "table", "td"].iter().map(|tag| (*tag, doc.element(tag, ROOT))).collect();
    let rules: String = ids.iter().map(|(tag, _)| format!("{tag} {{ opacity: 0.25 }} ")).collect();
    doc.style_element(ROOT, &rules);
    doc.flush();
    for (tag, id) in &ids {
        assert_eq!(doc.style(*id).and_then(|style| style.opacity), Some(0.25), "<{tag}>");
    }
    let div = doc.element("div", ROOT);
    doc.flush();
    assert_eq!(doc.style(div).and_then(|style| style.opacity), None);
}

#[test]
fn an_element_does_not_transition_into_the_style_a_sheet_gives_it_on_mount() {
    let mut doc = Doc::new();
    doc.style_element(
        ROOT,
        ".btn { background-color: blue; transition: background-color .3s } .off { background-color: red }",
    );
    let div = doc.make("div");
    doc.inline(div, r#"{"opacity":0.5}"#);
    doc.tree.set_attribute(div, "class", Some("btn".into()));
    doc.tree.append_child(ROOT, div);
    doc.flush();
    assert_eq!(doc.background(div), Some("blue"));
    assert!(doc.tree.elements[&div].style_before_transition().is_none());

    // In a later batch the element has a first style, and a class change transitions.
    let other = doc.classed("div", ROOT, "off");
    doc.flush();
    doc.frame();
    doc.tree.set_attribute(other, "class", Some("btn".into()));
    doc.flush();
    assert_eq!(doc.background(other), Some("blue"));
    assert_eq!(
        doc.tree.elements[&other].style_before_transition().and_then(|before| before.background_color.as_deref()),
        Some("red")
    );
}

const TRANSITIONING: &str = ".btn { background-color: blue; transition: background-color .3s } .off { background-color: red }";

fn transitions_from(doc: &Doc, id: u64) -> Option<String> {
    doc.tree.elements[&id]
        .style_before_transition()
        .map(|before| before.background_color.clone().unwrap_or_default())
}

#[test]
fn an_element_created_detached_and_inserted_in_a_later_batch_does_not_transition_into_the_first_style() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, TRANSITIONING);
    let div = doc.make("div");
    doc.tree.set_attribute(div, "class", Some("off".into()));
    doc.flush();
    doc.frame();

    // It was not in the document, so that frame drew nothing of it, and the class it is given when
    // it is inserted is the first style it has.
    doc.tree.set_attribute(div, "class", Some("btn".into()));
    doc.tree.append_child(ROOT, div);
    doc.flush();
    assert_eq!(doc.background(div), Some("blue"));
    assert_eq!(transitions_from(&doc, div), None);

    doc.frame();
    doc.tree.set_attribute(div, "class", Some("off".into()));
    doc.flush();
    doc.tree.set_attribute(div, "class", Some("btn".into()));
    doc.flush();
    assert_eq!(transitions_from(&doc, div).as_deref(), Some("red"));
}

#[test]
fn an_element_given_a_class_in_a_second_batch_before_any_frame_does_not_transition() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, TRANSITIONING);
    let div = doc.classed("div", ROOT, "off");
    doc.flush();
    doc.tree.set_attribute(div, "class", Some("btn".into()));
    doc.flush();
    assert_eq!(doc.background(div), Some("blue"));
    assert_eq!(transitions_from(&doc, div), None);

    doc.frame();
    doc.tree.set_attribute(div, "class", Some("off".into()));
    doc.flush();
    doc.tree.set_attribute(div, "class", Some("btn".into()));
    doc.flush();
    assert_eq!(transitions_from(&doc, div).as_deref(), Some("red"));
}

#[test]
fn an_element_removed_and_inserted_again_in_a_later_batch_does_not_transition() {
    let mut doc = Doc::new();
    doc.style_element(ROOT, TRANSITIONING);
    let parent = doc.element("section", ROOT);
    let child = doc.classed("div", parent, "off");
    doc.flush();
    doc.frame();

    doc.tree.detach_child(parent);
    doc.flush();
    doc.frame();
    doc.tree.set_attribute(child, "class", Some("btn".into()));
    doc.tree.append_child(ROOT, parent);
    doc.flush();
    assert_eq!(doc.background(child), Some("blue"));
    assert_eq!(transitions_from(&doc, child), None, "a descendant of what was removed is as new as it");

    doc.frame();
    doc.tree.set_attribute(child, "class", Some("off".into()));
    doc.flush();
    doc.tree.set_attribute(child, "class", Some("btn".into()));
    doc.flush();
    assert_eq!(transitions_from(&doc, child).as_deref(), Some("red"));
}

#[test]
fn a_keyword_initial_value_takes_back_an_earlier_rules_value_in_a_sheet_and_inline() {
    let mut doc = Doc::new();
    let wide = doc.classed("div", ROOT, "a wide");
    let tall = doc.classed("div", ROOT, "a");
    let gapped = doc.classed("div", ROOT, "g normal");
    let rowed = doc.classed("div", ROOT, "g r");
    doc.style_element(
        ROOT,
        ".a { max-width: 300px; max-height: 40px } .a.wide { max-width: none } \
         .g { gap: 5px; column-gap: 7px } .normal { gap: normal } .r { row-gap: normal }",
    );
    doc.inline(tall, r#"{"maxWidth":"none","maxHeight":"none"}"#);
    doc.flush();
    assert_eq!(doc.style(wide).and_then(|style| style.max_width.clone()), None);
    assert!(doc.style(wide).is_some_and(|style| style.max_height.is_some()));
    assert_eq!(doc.style(tall).and_then(|style| style.max_width.clone()), None, "inline over a sheet value");
    assert_eq!(doc.style(tall).and_then(|style| style.max_height.clone()), None);
    let gap_of = |id| doc.style(id).map(|style| (style.gap.is_some(), style.row_gap.clone(), style.column_gap.is_some()));
    assert!(gap_of(gapped).is_none_or(|gap| gap == (false, None, false)), "gap: normal takes back the shorthand and the longhand");
    let rowed = gap_of(rowed).expect("the shorthand still gives a gap");
    assert!(rowed.0 && rowed.2, "row-gap: normal leaves the rest of the gap");
    assert!(rowed.1.is_some(), "and is the initial row gap over the shorthand");
}

#[test]
fn an_inline_value_that_gains_or_loses_important_restyles() {
    let mut doc = Doc::new();
    let div = doc.classed("div", ROOT, "x");
    doc.style_element(ROOT, ".x { color: blue !important }");
    doc.inline(div, r#"{"color":"red"}"#);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));

    doc.inline(div, r#"{"color":"red !important"}"#);
    doc.flush();
    assert_eq!(doc.color(div), Some("red"), "an important inline value beats an important rule");

    doc.inline(div, r#"{"color":"red"}"#);
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
}

#[test]
fn skipped_rules_are_logged_up_to_a_cap_and_then_summed_up_once() {
    let mut doc = Doc::new();
    let limit = 1024;
    let rules = |from: usize, to: usize| (from..to).map(|n| format!(".css-{n}:checked {{ color: red }} ")).collect::<String>();
    let (_, text) = doc.style_element(ROOT, &rules(0, limit));
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, limit);

    doc.tree.set_text(text, rules(0, limit + 5));
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, limit + 1, "one summary, for the five past the cap");

    doc.tree.set_text(text, rules(0, limit + 50));
    doc.flush();
    assert_eq!(doc.tree.sheets.skip_warnings, limit + 1, "the summary is not repeated");
}

#[test]
fn the_style_attribute_has_the_units_and_omissions_of_the_dom() {
    let mut doc = Doc::new();
    let div = doc.element("div", ROOT);
    doc.inline(div, r#"{"width":10,"left":null,"zIndex":3,"top":0,"--n":2}"#);
    doc.style_element(
        ROOT,
        "[style*='width: 10px'] { color: blue } [style*='left'] { opacity: 0.5 } [style*='z-index: 3;'] { background-color: red } \
         [style*='top: 0;'] { display: flex } [style*='--n: 2'] { cursor: pointer }",
    );
    doc.flush();
    assert_eq!(doc.color(div), Some("blue"));
    assert_eq!(doc.style(div).and_then(|style| style.opacity), None, "a null value is no declaration");
    assert_eq!(doc.background(div), Some("red"));
    assert_eq!(doc.style(div).and_then(|style| style.display.as_deref()), Some("flex"));
    assert_eq!(doc.style(div).and_then(|style| style.cursor.as_deref()), Some("pointer"));
}

fn full_matches() -> usize {
    super::share::FULL_MATCHES.with(|count| count.get())
}

fn reset_full_matches() {
    super::share::FULL_MATCHES.with(|count| count.set(0));
    super::share::INSERTS.with(|count| count.set(0));
    super::share::KEY_BUILDS.with(|count| count.set(0));
}

fn key_builds() -> usize {
    super::share::KEY_BUILDS.with(|count| count.get())
}

fn memo_inserts() -> usize {
    super::share::INSERTS.with(|count| count.get())
}

#[test]
fn elements_that_look_alike_are_matched_once() {
    let mut doc = Doc::new();
    let rows: Vec<u64> = (0..40).map(|_| doc.classed("div", ROOT, "row")).collect();
    doc.style_element(ROOT, ".row { color: red }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 1, "forty rows, one match");
    let first = doc.tree.elements[&rows[0]].css().unwrap().matched.clone().unwrap();
    for row in &rows {
        assert_eq!(doc.color(*row), Some("red"));
        assert!(Arc::ptr_eq(doc.tree.elements[row].css().unwrap().matched.as_ref().unwrap(), &first));
    }

    let more: Vec<u64> = (0..5).map(|_| doc.classed("div", ROOT, "row")).collect();
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 1, "the memo lives for one flush: the first row of the next is matched");
    assert!(more.iter().all(|row| doc.color(*row) == Some("red")));
}

#[test]
fn a_flush_of_elements_that_all_differ_stops_using_the_memo_after_the_trial() {
    let mut doc = Doc::new();
    let rows: Vec<(u64, String)> = (0..200)
        .map(|at| {
            let id = doc.classed("div", ROOT, "row");
            let value = format!("v{at}");
            doc.tree.set_attribute(id, "data-k", Some(value.as_str().into()));
            (id, value)
        })
        .collect();
    doc.style_element(ROOT, ".row { opacity: 0.5 } [data-k^=v1] { color: red }");
    reset_full_matches();
    doc.flush();
    assert!(memo_inserts() <= 64, "the memo took {} keys, one per lookup of the trial at most", memo_inserts());
    for (id, value) in &rows {
        assert_eq!(doc.color(*id), value.starts_with("v1").then_some("red"), "{value}");
        assert_eq!(doc.style(*id).and_then(|style| style.opacity), Some(0.5));
    }
}

#[test]
fn a_flush_that_opens_with_chrome_that_differs_still_shares_the_list_after_it() {
    let mut doc = Doc::new();
    for at in 0..100 {
        let id = doc.classed("div", ROOT, "row");
        doc.tree.set_attribute(id, "data-k", Some(format!("chrome{at}").into()));
    }
    let list: Vec<u64> = (0..1000)
        .map(|_| {
            let id = doc.classed("div", ROOT, "row");
            doc.tree.set_attribute(id, "data-k", Some("same".into()));
            id
        })
        .collect();
    doc.style_element(ROOT, ".row { opacity: 0.5 } [data-k=same] { color: red }");
    reset_full_matches();
    doc.flush();
    // The trial of the chrome, the pause after it, and the first row of the window that follows.
    assert!(full_matches() < 64 + 256 + 16, "{} full matches for 1100 elements", full_matches());
    assert!(list.iter().all(|id| doc.color(*id) == Some("red") && doc.style(*id).and_then(|style| style.opacity) == Some(0.5)));
}

#[test]
fn a_flush_of_unique_values_keeps_the_memo_bounded_across_windows() {
    let mut doc = Doc::new();
    let rows: Vec<u64> = (0..1500)
        .map(|at| {
            let id = doc.classed("div", ROOT, "row");
            doc.tree.set_attribute(id, "data-k", Some(format!("v{at}").into()));
            id
        })
        .collect();
    doc.style_element(ROOT, ".row { opacity: 0.5 } [data-k^=v1] { color: red }");
    reset_full_matches();
    doc.flush();
    // One window of 64 per 320 elements.
    assert!(memo_inserts() <= 64 * (1502 / 320 + 1), "the memo took {} keys", memo_inserts());
    assert!(rows.iter().enumerate().all(|(at, id)| doc.color(*id) == format!("v{at}").starts_with("v1").then_some("red")));
}

#[test]
fn a_flush_of_unshareable_keys_stops_building_keys_while_the_memo_is_paused() {
    let mut doc = Doc::new();
    let list = doc.classed("div", ROOT, "list");
    let rows: Vec<u64> = (0..1000).map(|_| doc.classed("div", list, "row")).collect();
    doc.style_element(ROOT, ".row { color: red } .list .row { background-color: blue }");
    reset_full_matches();
    doc.flush();
    assert!(key_builds() < 1002 / 2, "{} keys built for 1000 rows", key_builds());
    assert!(rows.iter().all(|id| (doc.color(*id), doc.background(*id)) == (Some("red"), Some("blue"))));
}

#[test]
fn a_flush_whose_elements_share_keys_keeps_the_memo_past_the_trial() {
    let mut doc = Doc::new();
    let rows: Vec<u64> = (0..300)
        .map(|at| {
            let id = doc.classed("div", ROOT, "row");
            doc.tree.set_attribute(id, "data-k", Some(format!("v{}", at % 3).into()));
            id
        })
        .collect();
    doc.style_element(ROOT, ".row { opacity: 0.5 } [data-k=v1] { color: red }");
    reset_full_matches();
    doc.flush();
    // The root and the `<style>` element are candidates for the attribute rule too.
    assert_eq!(full_matches(), 3 + 2, "three values, matched once each");
    for (at, id) in rows.iter().enumerate() {
        assert_eq!(doc.color(*id), (at % 3 == 1).then_some("red"));
    }
}

#[test]
fn the_order_of_the_classes_and_classes_no_sheet_names_do_not_tell_elements_apart() {
    let mut doc = Doc::new();
    let first = doc.classed("div", ROOT, "a b");
    let swapped = doc.classed("div", ROOT, "b a");
    let extra = doc.classed("div", ROOT, "x a  b  a");
    let fewer = doc.classed("div", ROOT, "a");
    doc.style_element(ROOT, ".a { color: red } .a.b { background-color: blue }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 2, "{{a, b}} and {{a}}");
    for id in [first, swapped, extra] {
        assert_eq!((doc.color(id), doc.background(id)), (Some("red"), Some("blue")));
    }
    assert_eq!((doc.color(fewer), doc.background(fewer)), (Some("red"), None));
}

#[test]
fn a_different_attribute_value_is_a_different_match() {
    let mut doc = Doc::new();
    let with = |doc: &mut Doc, value: Option<&str>| {
        let id = doc.classed("div", ROOT, "row");
        if let Some(value) = value {
            doc.tree.set_attribute(id, "data-k", Some(value.into()));
        }
        id
    };
    let a = with(&mut doc, Some("a"));
    let b = with(&mut doc, Some("b"));
    let again = with(&mut doc, Some("a"));
    let none = with(&mut doc, None);
    let prefixed = with(&mut doc, Some("ba"));
    doc.style_element(ROOT, ".row { opacity: 0.5 } [data-k=a] { color: red } [data-k^=b] { background-color: blue }");
    reset_full_matches();
    doc.flush();
    // The root and the `<style>` element are candidates for the attribute rules too.
    assert_eq!(full_matches(), 4 + 2, "a, b, none and ba; the second a is shared");
    assert_eq!((doc.color(a), doc.background(a)), (Some("red"), None));
    assert_eq!((doc.color(again), doc.background(again)), (Some("red"), None));
    assert_eq!((doc.color(b), doc.background(b)), (None, Some("blue")));
    assert_eq!((doc.color(prefixed), doc.background(prefixed)), (None, Some("blue")));
    assert_eq!((doc.color(none), doc.background(none)), (None, None));
}

#[test]
fn an_html_and_an_svg_element_with_the_same_name_and_attribute_are_matched_apart() {
    let mut doc = Doc::new();
    let html = doc.element("div", ROOT);
    let lower = doc.element("svg", ROOT);
    let written = doc.element("svg", ROOT);
    doc.tree.set_attribute(html, "viewBox", Some("1".into()));
    doc.tree.set_attribute(lower, "viewbox", Some("1".into()));
    doc.tree.set_attribute(written, "viewBox", Some("1".into()));
    doc.style_element(ROOT, "[viewBox] { color: red }");
    doc.flush();
    assert_eq!(doc.color(html), Some("red"), "an HTML element's names are lower-cased");
    assert_eq!(doc.color(lower), None, "an SVG element's names are as written");
    assert_eq!(doc.color(written), Some("red"));

    let mut doc = Doc::new();
    let svg = doc.element("linearGradient", ROOT);
    let html = doc.element("lineargradient", ROOT);
    doc.style_element(ROOT, "lineargradient { color: red } linearGradient { background-color: blue }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 2 + 2, "the two, and the root and the `<style>` element");
    assert_eq!((doc.color(svg), doc.background(svg)), (None, Some("blue")));
    assert_eq!((doc.color(html), doc.background(html)), (Some("red"), Some("blue")));
}

#[test]
fn an_element_a_combinator_rule_could_match_is_matched_in_full() {
    let mut doc = Doc::new();
    let list = doc.classed("div", ROOT, "list");
    let inside: Vec<u64> = (0..3).map(|_| doc.classed("div", list, "row")).collect();
    let outside: Vec<u64> = (0..3).map(|_| doc.classed("div", ROOT, "row")).collect();
    doc.style_element(ROOT, ".row { color: red } .list .row { background-color: blue }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 6 + 1, "every row has the combinator rule as a candidate, and the list is tried");
    assert!(inside.iter().all(|id| (doc.color(*id), doc.background(*id)) == (Some("red"), Some("blue"))));
    assert!(outside.iter().all(|id| (doc.color(*id), doc.background(*id)) == (Some("red"), None)));

    // The elements without that candidate are still shared.
    let plain: Vec<u64> = (0..4).map(|_| doc.classed("div", ROOT, "cell")).collect();
    doc.style_element(ROOT, ".cell { opacity: 0.5 }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 6 + 1 + 1, "the rows and the list again, one cell");
    assert!(plain.iter().all(|id| doc.style(*id).and_then(|style| style.opacity) == Some(0.5)));
}

#[test]
fn a_rule_reading_an_attribute_inside_a_combinator_rule_still_tells_elements_apart() {
    let mut doc = Doc::new();
    let list = doc.classed("div", ROOT, "list");
    let with = doc.element("div", list);
    let without = doc.element("div", list);
    doc.tree.set_attribute(with, "data-k", Some("1".into()));
    doc.style_element(ROOT, "* { opacity: 0.5 } .list [data-k] { color: red }");
    doc.flush();
    assert_eq!(doc.color(with), Some("red"));
    assert_eq!(doc.color(without), None);
}

#[test]
fn arguments_that_read_the_tree_make_a_selector_not_self_contained() {
    let mut doc = Doc::new();
    let list = doc.classed("div", ROOT, "list");
    let inside = doc.classed("div", list, "row");
    let outside = doc.classed("div", ROOT, "row");
    doc.style_element(ROOT, ":is(.list .row) { color: red } .row:not(.x) { background-color: blue } .row:where(.y, [z]) { opacity: 0.5 }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 5, "the universal list holds the :is rule: every element is matched in full");
    assert_eq!((doc.color(inside), doc.background(inside)), (Some("red"), Some("blue")));
    assert_eq!((doc.color(outside), doc.background(outside)), (None, Some("blue")));

    let mut doc = Doc::new();
    let rows: Vec<u64> = (0..10).map(|_| doc.classed("div", ROOT, "row")).collect();
    doc.style_element(ROOT, ".row:not(.x):is(.row, .y) { background-color: blue } .row:where(.y, [z]) { opacity: 0.5 }");
    reset_full_matches();
    doc.flush();
    assert_eq!(full_matches(), 1, "self-contained arguments are shared");
    assert!(rows.iter().all(|id| doc.background(*id) == Some("blue")));
}

#[test]
fn a_style_selector_and_root_are_matched_in_full() {
    let mut doc = Doc::new();
    let first = doc.classed("div", ROOT, "row");
    let second = doc.classed("div", ROOT, "row");
    let third = doc.classed("div", ROOT, "row");
    doc.inline(first, r#"{"--s":"1"}"#);
    doc.inline(second, r#"{"--t":"1"}"#);
    doc.inline(third, r#"{"--s":"2"}"#);
    let bare = doc.classed("div", ROOT, "row");
    let bare_too = doc.classed("div", ROOT, "row");
    doc.style_element(ROOT, ".row { opacity: 0.5 } [style*='--s'] { color: blue }");
    reset_full_matches();
    doc.flush();
    assert_eq!(doc.color(first), Some("blue"));
    assert_eq!(doc.color(second), None, "the same key as the first, another own style");
    assert_eq!(doc.color(third), Some("blue"));
    assert_eq!(full_matches(), 3 + 1 + 2, "three rows with an own style, the bare ones once, the root and the `<style>` element");
    assert_eq!((doc.color(bare), doc.color(bare_too)), (None, None));

    let mut doc = Doc::new();
    let sibling = doc.element("div", ROOT);
    doc.style_element(ROOT, ":root { color: red } div { opacity: 0.5 }");
    doc.flush();
    assert_eq!(doc.color(ROOT), Some("red"));
    assert_eq!(doc.color(sibling), None, "looks like the root and is not it");
}

#[test]
fn a_reload_matches_again_with_the_new_rules_and_nothing_of_the_old() {
    let mut doc = Doc::new();
    let rows: Vec<u64> = (0..5).map(|_| doc.classed("div", ROOT, "row")).collect();
    let (_, text) = doc.style_element(ROOT, ".row { color: red }");
    doc.flush();
    assert!(rows.iter().all(|id| doc.color(*id) == Some("red")));
    doc.tree.set_text(text, ".row { color: blue }".into());
    doc.flush();
    assert!(rows.iter().all(|id| doc.color(*id) == Some("blue")));
}


mod states {
    use super::*;
    use crate::css::sheet::State;
    use serde_json::json;

    fn block<'a>(doc: &'a Doc, id: u64, state: &str) -> Option<&'a StyleDesc> {
        let style = doc.style(id)?;
        match state {
            "hover" => style.hover.as_deref(),
            "active" => style.active.as_deref(),
            "focus" => style.focus.as_deref(),
            "focusVisible" => style.focus_visible.as_deref(),
            "focusWithin" => style.focus_within.as_deref(),
            _ => panic!("{state}"),
        }
    }

    fn with(css: &str, inline: Option<&str>) -> (Doc, u64) {
        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        if let Some(inline) = inline {
            doc.inline(div, inline);
        }
        doc.style_element(ROOT, css);
        doc.flush();
        (doc, div)
    }

    #[test]
    fn a_state_rule_becomes_the_state_block_of_the_element_and_leaves_its_base_alone() {
        let (doc, div) = with(".a { color: red } .a:hover { color: blue; opacity: 0.5 }", None);
        assert_eq!(doc.color(div), Some("red"));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.color.as_deref(), Some("blue"));
        assert_eq!(hover.opacity, Some(0.5));
        assert!(doc.style(div).is_some_and(|style| style.opacity.is_none()));
    }

    #[test]
    fn each_state_has_its_block() {
        let (doc, div) = with(
            ".a:hover { top: 1px } .a:active { top: 2px } .a:focus { top: 3px } .a:focus-visible { top: 4px } .a:focus-within { top: 5px }",
            None,
        );
        for (state, top) in [("hover", "1px"), ("active", "2px"), ("focus", "3px"), ("focusVisible", "4px"), ("focusWithin", "5px")] {
            let found = block(&doc, div, state).unwrap_or_else(|| panic!("{state}"));
            assert!(found.top.is_some(), "{state} has {top}");
        }
        assert_eq!(State::Focus.block_key(), "focus");
    }

    #[test]
    fn an_inline_value_beats_a_sheet_state_value_of_a_property_it_sets() {
        let (doc, div) = with(".a { color: red } .a:hover { color: green; opacity: 0.5 }", Some(r#"{"color":"blue"}"#));
        assert_eq!(doc.color(div), Some("blue"));
        assert!(block(&doc, div, "hover").is_none_or(|hover| hover.color.is_none()), "the inline base wins over the lower conditional value");
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.opacity), Some(0.5), "a property the inline style leaves alone stays conditional");
    }

    #[test]
    fn a_more_specific_unconditional_rule_beats_a_state_rule() {
        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        doc.tree.set_attribute(div, "id", Some("x".into()));
        doc.style_element(ROOT, "#x { color: blue } .a:hover { color: red; opacity: 0.5 }");
        doc.flush();
        assert_eq!(doc.color(div), Some("blue"));
        assert!(block(&doc, div, "hover").is_none_or(|hover| hover.color.is_none()));
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.opacity), Some(0.5));
    }

    #[test]
    fn a_more_specific_state_rule_beats_a_less_specific_base_rule() {
        let (doc, div) = with(".a:hover { color: red } div { color: blue }", None);
        assert_eq!(doc.color(div), Some("blue"));
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.color.as_deref()), Some("red"));
        let (doc, div) = with("div { color: blue } :where(.a):hover { color: red }", None);
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.color.as_deref()), Some("red"), "equal specificity, later wins");
    }

    #[test]
    fn an_unconditional_value_after_a_state_value_of_the_same_specificity_shadows_it() {
        let (doc, div) = with(".a:where(:hover) { color: red } .b, .a { color: blue }", None);
        assert_eq!(doc.color(div), Some("blue"));
        assert!(block(&doc, div, "hover").is_none_or(|hover| hover.color.is_none()));
    }

    #[test]
    fn a_shorthand_base_shadows_a_lower_longhand_under_a_state() {
        let (doc, div) = with(".a:hover { background-color: red } div.a.a { background: blue }", None);
        assert!(block(&doc, div, "hover").is_none_or(|hover| hover.background_color.is_none()));
        assert!(doc.style(div).is_some_and(|style| style.background.is_some() || style.background_color.is_some()));
    }

    #[test]
    fn a_surviving_state_shorthand_does_not_overwrite_a_longhand_the_inline_style_sets_above_it() {
        let (doc, div) = with(".a:hover { background: blue }", Some(r#"{"backgroundColor":"red"}"#));
        assert_eq!(doc.background(div), Some("red"));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert!(hover.background.is_some(), "the shorthand still gives the rest of the background");
        assert_eq!(hover.background_color.as_deref(), Some("red"), "the longhand's own value is declared after it");

        let (doc, div) = with(".a:hover { background: blue } div.a.a { background-color: red }", None);
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.background_color.as_deref()), Some("red"));
        let (doc, div) = with(".a { background-color: red } .a:hover { background: blue }", None);
        assert!(block(&doc, div, "hover").is_some_and(|hover| hover.background_color.is_none()), "a lower longhand is the shorthand's to reset");
    }

    #[test]
    fn a_surviving_state_shorthand_does_not_overwrite_what_an_overlapping_inline_declaration_sets_above_it() {
        // The inline `border-top` is above the rule's `border-color` and only overlaps it: the
        // rule still gives the other sides their colour, and the top keeps what the inline style says.
        let (doc, div) = with(".a:hover { border-color: blue }", Some(r#"{"borderTop":"1px solid red"}"#));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.border_right_color.as_deref(), Some("blue"), "the other sides");
        assert_eq!(hover.border_top.as_deref(), Some("1px solid red"), "declared after the colour, which is the top's too");

        // The other way round: the inline `border-color` beats the top colour of the rule's `border-top`.
        let (doc, div) = with(".a:hover { border-top: 2px solid blue }", Some(r#"{"borderColor":"red"}"#));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.border_top.as_deref(), Some("2px solid blue"), "the width and the style");
        assert_eq!(hover.border_color.as_deref(), Some("red"), "declared after the side, so the top colour is red");
    }

    #[test]
    fn an_important_inline_value_beats_the_inline_state_block_with_or_without_a_sheet() {
        let inline = r#"{"color":"red !important","hover":{"color":"blue","opacity":0.5}}"#;
        let (doc, div) = with(".a { top: 1px }", Some(inline));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.color, None, "with a sheet matching");
        assert_eq!(hover.opacity, Some(0.5));

        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        doc.inline(div, inline);
        doc.flush();
        assert_eq!(doc.color(div), Some("red"));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.color, None, "with no sheet at all");
        assert_eq!(hover.opacity, Some(0.5));
    }

    #[test]
    fn an_inline_state_block_splits_when_the_element_matches_a_sheet_whatever_the_rules_are_under() {
        // No rule is under a state, and the important sheet value still shadows the inline hover value.
        let (doc, div) = with(".a { color: green !important }", Some(r#"{"hover":{"color":"blue","opacity":0.5}}"#));
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.color, None, "`!important` beats a normal declaration in an inline state block");
        assert_eq!(hover.opacity, Some(0.5));

        // Under another state, as before.
        let (doc, div) = with(".a:focus { opacity: 0.1 } .a { color: green !important }", Some(r#"{"hover":{"color":"blue"}}"#));
        assert!(block(&doc, div, "hover").is_none_or(|hover| hover.color.is_none()));
    }

    #[test]
    fn a_null_state_block_is_no_block_and_another_value_is_left_to_the_parse() {
        let (doc, div) = with(".a:hover { color: red }", Some(r#"{"hover":null}"#));
        assert_eq!(block(&doc, div, "hover").and_then(|hover| hover.color.as_deref()), Some("red"));
        let (doc, div) = with(".a:focus { color: red }", Some(r#"{"hover":null,"opacity":0.5}"#));
        assert!(block(&doc, div, "hover").is_none());
        assert_eq!(doc.style(div).and_then(|style| style.opacity), Some(0.5));
    }

    #[test]
    fn a_fold_order_disagreement_is_logged_once_and_not_for_equal_values() {
        let mut doc = Doc::new();
        let elements: Vec<u64> = (0..4).map(|_| doc.classed("div", ROOT, "a")).collect();
        for (index, id) in elements.iter().enumerate() {
            doc.inline(*id, &format!(r#"{{"opacity":0.{}}}"#, index + 1));
        }
        // `:hover` has the higher precedence and `:active` folds later.
        doc.style_element(ROOT, ".a:active { color: blue } .a:hover { color: red }");
        doc.flush();
        assert_eq!(doc.tree.sheets.fold_warnings(), 1, "four elements, one message");

        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        doc.style_element(ROOT, ".a:active { color: red } .a:hover { color: red }");
        doc.flush();
        assert!(doc.style(div).is_some());
        assert_eq!(doc.tree.sheets.fold_warnings(), 0, "equal values fold the same in either order");
    }

    #[test]
    fn a_reload_does_not_log_a_fold_disagreement_again() {
        let mut doc = Doc::new();
        doc.classed("div", ROOT, "a");
        let (_, text) = doc.style_element(ROOT, ".a:active { color: blue } .a:hover { color: red }");
        doc.flush();
        assert_eq!(doc.tree.sheets.fold_warnings(), 1);

        doc.tree.set_text(text, ".a:active { color: blue } .a:hover { color: red } .b { top: 1px }".to_owned());
        doc.flush();
        assert_eq!(doc.tree.sheets.fold_warnings(), 1, "the same pair after a reload");
    }

    #[test]
    fn fold_disagreements_are_logged_up_to_a_cap_and_then_summed_up_once() {
        let mut doc = Doc::new();
        let limit = 1024;
        doc.classed("div", ROOT, "a");
        let rules = |count: usize| {
            (0..count)
                .map(|n| format!(".a:active {{ --p{n}: 1 }} .a:hover {{ --p{n}: 2 }} "))
                .collect::<String>()
        };
        let (_, text) = doc.style_element(ROOT, &rules(limit));
        doc.flush();
        assert_eq!(doc.tree.sheets.fold_warnings(), limit);

        doc.tree.set_text(text, rules(limit + 5));
        doc.flush();
        assert_eq!(doc.tree.sheets.fold_warnings(), limit + 1, "one summary, for the five past the cap");
    }

    #[test]
    fn a_rule_with_a_state_and_a_plain_selector_applies_both_ways() {
        let (doc, div) = with(".a, .b:hover { color: red }", None);
        assert_eq!(doc.color(div), Some("red"));
        assert!(block(&doc, div, "hover").is_none(), ".b is not a class of the element");
        let mut doc = Doc::new();
        let both = doc.classed("div", ROOT, "a b");
        doc.style_element(ROOT, ".a, .b:hover { color: red; top: 1px } .b:hover { top: 2px }");
        doc.flush();
        assert_eq!(doc.color(both), Some("red"));
        assert!(block(&doc, both, "hover").is_some_and(|hover| hover.top.is_some()));
    }

    #[test]
    fn important_inside_a_state_beats_an_inline_state_block() {
        let (doc, div) = with(
            ".a:hover { color: red !important; opacity: 0.5 }",
            Some(r#"{"hover":{"color":"blue","opacity":0.9}}"#),
        );
        let hover = block(&doc, div, "hover").expect("a hover block");
        assert_eq!(hover.color.as_deref(), Some("red"));
        assert_eq!(hover.opacity, Some(0.9), "the inline state block beats a normal sheet value");
    }

    #[test]
    fn an_inline_state_block_is_kept_when_no_rule_is_under_that_state() {
        let (doc, div) = with(".a:active { color: red }", Some(r##"{"hover":{"backgroundColor":"#eee"}}"##));
        assert!(block(&doc, div, "hover").is_some_and(|hover| hover.background_color.is_some()));
        assert!(block(&doc, div, "active").is_some());
    }

    #[test]
    fn a_rule_under_a_state_changes_with_the_classes_like_any_other() {
        let mut doc = Doc::new();
        let div = doc.element("div", ROOT);
        doc.style_element(ROOT, ".a:hover { color: red }");
        doc.flush();
        assert!(block(&doc, div, "hover").is_none());
        doc.tree.set_attribute(div, "class", Some("a".into()));
        doc.flush();
        assert!(block(&doc, div, "hover").is_some());
        doc.tree.set_attribute(div, "class", None);
        doc.flush();
        assert!(block(&doc, div, "hover").is_none());
    }

    #[test]
    fn elements_that_look_alike_share_the_style_that_has_the_state_block() {
        let mut doc = Doc::new();
        let first = doc.classed("div", ROOT, "a");
        let second = doc.classed("div", ROOT, "a");
        doc.style_element(ROOT, ".a:hover { color: red }");
        doc.flush();
        assert!(Arc::ptr_eq(&doc.style_arc(first).unwrap(), &doc.style_arc(second).unwrap()));
    }

    #[test]
    fn a_state_rule_changes_only_the_state_block_so_it_is_a_paint_change() {
        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        doc.style_element(ROOT, ".a { width: 10px } .a:hover { color: red }");
        doc.flush();
        let before = doc.style_arc(div).unwrap();
        let (other, other_div) = with(".a { width: 10px } .a:hover { color: blue }", None);
        let after = other.style_arc(other_div).unwrap();
        assert!(before.differs_only_in_paint(&after));
    }

    #[test]
    fn a_state_block_from_a_sheet_is_the_one_an_inline_style_writes_and_is_classified_as_it_is() {
        let (red, red_div) = with(".a:hover { background-color: red }", None);
        let (blue, blue_div) = with(".a:hover { background-color: blue }", None);
        let (inline_red, inline_red_div) = with("", Some(r#"{"hover":{"backgroundColor":"red"}}"#));
        let (inline_blue, inline_blue_div) = with("", Some(r#"{"hover":{"backgroundColor":"blue"}}"#));
        let sheet = (red.style(red_div).unwrap(), blue.style(blue_div).unwrap());
        let inline = (inline_red.style(inline_red_div).unwrap(), inline_blue.style(inline_blue_div).unwrap());
        assert_eq!(sheet.0.hover, inline.0.hover);
        assert!(sheet.0.hover_sets_background_color());
        let paints = crate::events::hover_paint::restyle_paints_of;
        assert_eq!(paints(sheet.0, sheet.1), paints(inline.0, inline.1));
        assert_eq!(sheet.0.differs_only_in_paint(sheet.1), inline.0.differs_only_in_paint(inline.1));
    }

    /// The user agent style of a popover sets a colour, so the tests read a property it does not set.
    fn opacity(doc: &Doc, id: u64) -> Option<f64> {
        doc.style(id).and_then(|style| style.opacity)
    }

    #[test]
    fn popover_open_matches_while_the_popover_is_open_and_stops_when_it_closes() {
        use crate::html::popover::OPEN_PROP;
        let mut doc = Doc::new();
        let popover = doc.element("div", ROOT);
        doc.tree.set_attribute(popover, "popover", Some("".into()));
        doc.tree.set_custom_prop(popover, "popover".into(), json!("manual"));
        doc.style_element(ROOT, "[popover]:popover-open { opacity: 0.5 } [popover] { top: 1px }");
        doc.flush();
        assert_eq!(opacity(&doc, popover), None);
        assert!(doc.style(popover).is_some_and(|style| style.top.is_some()));

        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), json!(1));
        doc.flush();
        assert_eq!(opacity(&doc, popover), Some(0.5));

        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), serde_json::Value::Null);
        doc.flush();
        assert_eq!(opacity(&doc, popover), None);
    }

    #[test]
    fn popover_open_in_an_ancestor_position_reaches_the_descendants() {
        use crate::html::popover::OPEN_PROP;
        let mut doc = Doc::new();
        let popover = doc.element("div", ROOT);
        doc.tree.set_custom_prop(popover, "popover".into(), json!("manual"));
        let child = doc.classed("span", popover, "c");
        doc.style_element(ROOT, ":popover-open .c { color: red }");
        doc.flush();
        assert_eq!(doc.color(child), None);
        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), json!(1));
        doc.flush();
        assert_eq!(doc.color(child), Some("red"));
    }

    #[test]
    fn a_selector_that_reads_popover_state_is_not_shared() {
        use crate::html::popover::OPEN_PROP;
        let mut doc = Doc::new();
        let first = doc.classed("div", ROOT, "p");
        let second = doc.classed("div", ROOT, "p");
        for id in [first, second] {
            doc.tree.set_custom_prop(id, "popover".into(), json!("manual"));
        }
        doc.style_element(ROOT, ".p:popover-open { opacity: 0.5 }");
        doc.tree.set_custom_prop(first, OPEN_PROP.into(), json!(1));
        doc.flush();
        assert_eq!(opacity(&doc, first), Some(0.5));
        assert_eq!(opacity(&doc, second), None, "same classes, not the same state");
    }

    #[test]
    fn a_sheet_that_reads_no_popover_state_marks_nothing_when_one_opens() {
        use crate::html::popover::OPEN_PROP;
        let mut doc = Doc::new();
        let popover = doc.element("div", ROOT);
        doc.tree.set_custom_prop(popover, "popover".into(), json!("manual"));
        doc.style_element(ROOT, ".a { color: red }");
        doc.flush();
        let before = counts().elements_rematched;
        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), json!(1));
        doc.flush();
        assert_eq!(counts().elements_rematched, before);
    }

    #[test]
    fn popover_open_reaches_the_siblings_a_combinator_names() {
        use crate::html::popover::OPEN_PROP;
        let mut doc = Doc::new();
        let popover = doc.element("div", ROOT);
        doc.tree.set_custom_prop(popover, "popover".into(), json!("manual"));
        let next = doc.classed("span", ROOT, "x");
        let later = doc.classed("span", ROOT, "x");
        let before = doc.classed("span", ROOT, "x");
        doc.tree.insert_before(ROOT, before, popover);
        doc.style_element(ROOT, ":popover-open + .x { color: red } :popover-open ~ .x { opacity: 0.5 }");
        doc.flush();
        for id in [before, next, later] {
            assert_eq!((doc.color(id), doc.style(id).and_then(|style| style.opacity)), (None, None));
        }

        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), json!(1));
        doc.flush();
        assert_eq!(doc.color(next), Some("red"), "the next sibling");
        assert_eq!(doc.color(later), None, "`+` is the next sibling only");
        assert_eq!(doc.style(later).and_then(|style| style.opacity), Some(0.5), "`~` is every later sibling");
        assert_eq!(doc.style(before).and_then(|style| style.opacity), None, "not an earlier one");

        doc.tree.set_custom_prop(popover, OPEN_PROP.into(), serde_json::Value::Null);
        doc.flush();
        assert_eq!(doc.color(next), None);
        assert_eq!(doc.style(later).and_then(|style| style.opacity), None);
    }

    /// The style the element has while the pointer is over it.
    fn hovered(doc: &Doc, id: u64) -> StyleDesc {
        let style = doc.style(id).expect("the element has a style");
        crate::events::state_styles::resolve_pointer_states(
            style,
            crate::events::state_styles::PointerStates { hovered: true, ..Default::default() },
        )
    }

    #[test]
    fn a_state_initial_takes_back_the_base_value_while_the_state_applies() {
        let (doc, div) = with(".a { color: red; opacity: 0.5 } .a:hover { color: initial }", None);
        assert_eq!(doc.color(div), Some("red"));
        let hovered = hovered(&doc, div);
        assert_eq!(hovered.color, None, "initial resets the colour to what the parent gives");
        assert_eq!(hovered.opacity, Some(0.5), "what no keyword names stays");
        assert!(block(&doc, div, "hover").is_some_and(|hover| hover.color.is_none()), "the keyword is no value");
    }

    #[test]
    fn a_state_unset_on_a_property_that_does_not_inherit_is_its_initial_value() {
        let (doc, div) = with(".a { margin: 4px; width: 10px } .a:hover { margin: unset }", None);
        let base = doc.style(div).expect("the element has a style");
        assert!(base.margin.is_some());
        let hovered = hovered(&doc, div);
        assert!(hovered.margin.is_none() && hovered.margin_top.is_none(), "no margin while hovered");
        assert!(hovered.width.is_some());
    }

    #[test]
    fn a_state_unset_on_a_longhand_leaves_the_sides_the_base_shorthand_gives() {
        let (doc, div) = with(".a { padding: 4px } .a:hover { padding-top: unset }", None);
        let hovered = hovered(&doc, div);
        assert_eq!(hovered.padding_top, Some(ZERO), "the top is at its initial value");
        assert!(hovered.padding.is_some(), "the shorthand still gives the other sides");
    }

    #[test]
    fn a_state_display_unset_is_inline_over_a_block_and_over_a_flex_base() {
        let (doc, div) = with(".a { display: flex } .a:hover { display: unset }", None);
        assert_eq!(hovered(&doc, div).display.as_deref(), Some("inline"));
        let mut doc = Doc::new();
        let plain = doc.classed("div", ROOT, "plain");
        doc.style_element(ROOT, ".plain:hover { display: initial }");
        doc.flush();
        assert_eq!(hovered(&doc, plain).display.as_deref(), Some("inline"), "a div is a block and initial is inline");
        assert!(doc.style(plain).is_some_and(|style| style.display.is_none()));
    }

    #[test]
    fn a_state_revert_rolls_back_to_the_user_agent_value_while_the_state_applies() {
        let mut doc = Doc::new();
        let paragraph = doc.classed("p", ROOT, "a");
        let plain = doc.classed("p", ROOT, "plain");
        doc.style_element(ROOT, ".a { margin-top: 10px; margin-bottom: 3px } .a:hover { margin: revert }");
        doc.flush();
        let ua_margin = doc.style(plain).and_then(|style| style.margin_top.clone());
        assert!(ua_margin.is_some(), "a paragraph has a margin");
        assert_ne!(doc.style(paragraph).and_then(|style| style.margin_top.clone()), ua_margin);
        let hovered = hovered(&doc, paragraph);
        assert_eq!(hovered.margin_top, ua_margin);
        assert_eq!(hovered.margin_bottom, doc.style(plain).and_then(|style| style.margin_bottom.clone()));
    }

    #[test]
    fn a_state_revert_over_a_tag_with_no_user_agent_value_is_unset() {
        let (doc, div) = with(".a { margin: 4px } .a:hover { margin: revert }", None);
        assert!(hovered(&doc, div).margin.is_none());
    }

    #[test]
    fn a_state_inherit_takes_the_parents_value_for_an_inherited_property_and_is_dropped_for_the_rest() {
        let (doc, div) = with(".a { color: red; margin: 4px } .a:hover { color: inherit; margin: inherit }", None);
        let hovered = hovered(&doc, div);
        assert_eq!(hovered.color, None, "no value of its own: the parent's colour is inherited");
        assert!(hovered.margin.is_some(), "inherit on a property that does not inherit changes nothing");
    }

    #[test]
    fn an_inline_state_block_keyword_resets_the_base_too() {
        let (doc, div) = with(".a { color: red }", Some(r#"{"color":"blue","width":5,"hover":{"color":"initial","width":"unset"}}"#));
        assert_eq!(doc.color(div), Some("blue"));
        let hovered = hovered(&doc, div);
        assert_eq!((hovered.color.clone(), hovered.width.clone()), (None, None));
        let mut doc = Doc::new();
        let div = doc.element("div", ROOT);
        doc.inline(div, r#"{"opacity":0.5,"focusVisible":{"opacity":"initial"}}"#);
        let focused = crate::events::state_styles::resolve_pointer_states(
            doc.style(div).expect("a style"),
            crate::events::state_styles::PointerStates { focus_visible: true, ..Default::default() },
        );
        assert_eq!(focused.opacity, None);
    }

    #[test]
    fn a_state_rule_that_is_shadowed_by_a_more_specific_base_rule_resets_nothing() {
        let (doc, div) = with("div.a.a { color: red } .a:hover { color: initial }", None);
        assert_eq!(hovered(&doc, div).color.as_deref(), Some("red"));
    }

    #[test]
    fn a_state_keyword_resets_the_universal_value_and_a_universal_state_keyword_resets_the_base() {
        let mut doc = Doc::new();
        let div = doc.classed("div", ROOT, "a");
        let layer = doc.tree.styles.intern(br##"{"color":"#336699","hover":{"opacity":"initial"}}"##).unwrap();
        doc.tree.set_universal_style(Some(layer.into_arc()));
        doc.style_element(ROOT, ".a { opacity: 0.5 } .a:hover { color: unset }");
        doc.flush();
        let hovered = hovered(&doc, div);
        assert_eq!(hovered.color, None, "the state keyword beats the universal colour");
        assert_eq!(hovered.opacity, None, "the universal state keyword beats the element's base value, as it would in CSS");
        assert_eq!(doc.color(div), Some("#336699"));
    }

    #[test]
    fn two_states_that_reset_different_properties_do_not_share_a_fold() {
        let (doc, div) = with(".a { color: red; opacity: 0.5 } .a:hover { color: initial } .a:active { opacity: initial }", None);
        let hovered = hovered(&doc, div);
        assert_eq!((hovered.color.clone(), hovered.opacity), (None, Some(0.5)));
        let style = doc.style(div).expect("the element has a style");
        let pressed = crate::events::state_styles::resolve_pointer_states(
            style,
            crate::events::state_styles::PointerStates { active: true, ..Default::default() },
        );
        assert_eq!((pressed.color.as_deref(), pressed.opacity), (Some("red"), None));
    }
}
