use super::*;
use crate::css::lenient::Declaration;
use crate::retained_tree::StyleTable;
use crate::style::StyleDesc;

const DND_KIT: &str = include_str!("fixtures/dnd-kit.css");

struct Doc {
    atoms: Atoms,
    layers: Layers,
}

impl Doc {
    fn new() -> Doc {
        Doc { atoms: Atoms::default(), layers: Layers::default() }
    }

    fn parse(&mut self, text: &str) -> StyleSheet {
        parse_sheet(text, &mut self.atoms, &mut self.layers)
    }

    /// The first selector of `selector { color: red }`.
    fn selector(&mut self, selector: &str) -> ComplexSelector {
        let sheet = self.parse(&format!("{selector} {{ color: red }}"));
        assert_eq!(sheet.rules.len(), 1, "{selector} is valid");
        sheet.rules[0].selectors[0].0.clone()
    }
}

fn pairs(declarations: &[Declaration]) -> Vec<(&str, &str)> {
    declarations.iter().map(|d| (d.key.as_str(), d.value.as_str())).collect()
}

fn specificity(selector: &str) -> (u32, u32, u32) {
    let sheet = Doc::new().parse(&format!("{selector} {{ color: red }}"));
    assert_eq!(sheet.rules.len(), 1, "{selector} is valid");
    let found = sheet.rules[0].selectors[0].1;
    (found.ids, found.classes, found.types)
}

fn is_valid(selector: &str) -> bool {
    !Doc::new().parse(&format!("{selector} {{ color: red }}")).rules.is_empty()
}

struct Node {
    tag: Atom,
    id: Option<Atom>,
    classes: Vec<Atom>,
    attrs: Vec<(Atom, String)>,
    parent: Option<usize>,
    prev: Option<usize>,
}

#[derive(Default)]
struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    fn add(
        &mut self,
        atoms: &mut Atoms,
        tag: &str,
        parent: Option<usize>,
        prev: Option<usize>,
        id: Option<&str>,
        classes: &[&str],
        attrs: &[(&str, &str)],
    ) -> usize {
        self.nodes.push(Node {
            tag: atoms.intern(tag),
            id: id.map(|id| atoms.intern(id)),
            classes: classes.iter().map(|class| atoms.intern(class)).collect(),
            attrs: attrs.iter().map(|(name, value)| (atoms.intern(name), (*value).to_owned())).collect(),
            parent,
            prev,
        });
        self.nodes.len() - 1
    }

    fn view(&self, index: usize) -> View<'_> {
        View { tree: self, index }
    }
}

#[derive(Clone, Copy)]
struct View<'a> {
    tree: &'a Tree,
    index: usize,
}

impl ElementView for View<'_> {
    fn tag(&self) -> Option<Atom> {
        Some(self.tree.nodes[self.index].tag)
    }
    fn is_svg(&self) -> bool {
        false
    }
    fn id(&self) -> Option<Atom> {
        self.tree.nodes[self.index].id
    }
    fn has_class(&self, class: Atom) -> bool {
        self.tree.nodes[self.index].classes.contains(&class)
    }
    fn attr(&self, name: super::selector::AttrName) -> Option<super::matching::AttrValue<'_>> {
        let node = &self.tree.nodes[self.index];
        node.attrs.iter().find(|(key, _)| *key == name.lower).map(|(_, value)| super::matching::AttrValue::Text(value.as_str().into()))
    }
    fn parent(&self) -> Option<Self> {
        self.tree.nodes[self.index].parent.map(|index| View { tree: self.tree, index })
    }
    fn prev_sibling(&self) -> Option<Self> {
        self.tree.nodes[self.index].prev.map(|index| View { tree: self.tree, index })
    }
    fn is_root(&self) -> bool {
        self.tree.nodes[self.index].parent.is_none()
    }
}

const HTML: usize = 0;
const BODY: usize = 1;
const MAIN: usize = 2;
const FIRST: usize = 3;
const SECOND: usize = 4;
const PARA: usize = 5;

/// html > body > div#main.box.wide[data-x="a b"] > (span.first, span.second[lang=en-US], p)
fn fixture(atoms: &mut Atoms) -> Tree {
    let mut tree = Tree::default();
    tree.add(atoms, "html", None, None, None, &[], &[]);
    tree.add(atoms, "body", Some(HTML), None, None, &[], &[]);
    tree.add(atoms, "div", Some(BODY), None, Some("main"), &["box", "wide"], &[("data-x", "a b")]);
    tree.add(atoms, "span", Some(MAIN), None, None, &["first"], &[]);
    tree.add(atoms, "span", Some(MAIN), Some(FIRST), None, &["second"], &[("lang", "en-US")]);
    tree.add(atoms, "p", Some(MAIN), Some(SECOND), None, &[], &[]);
    tree
}

/// The nodes of the fixture `selector` matches.
fn selected(selector: &str) -> Vec<usize> {
    let mut doc = Doc::new();
    let tree = fixture(&mut doc.atoms);
    let selector = doc.selector(selector);
    (0..tree.nodes.len()).filter(|index| matches(&selector, &tree.view(*index))).collect()
}

// Declarations

#[test]
fn property_names_become_camel_case() {
    let sheet = Doc::new().parse(
        "a { background-color: red; --Foo-bar: 1; -webkit-user-select: none; -moz-appearance: none; \
         -ms-transform: none; COLOR: blue }",
    );
    let keys: Vec<&str> = sheet.rules[0].normal.iter().map(|d| d.key.as_str()).collect();
    assert_eq!(
        keys,
        ["backgroundColor", "--Foo-bar", "WebkitUserSelect", "MozAppearance", "msTransform", "color"]
    );
}

#[test]
fn values_are_trimmed_with_comments_removed() {
    let sheet = Doc::new().parse("a { margin:  1px /* c */ 2px\n 3px  ; color : red/**/}");
    assert_eq!(pairs(&sheet.rules[0].normal), [("margin", r#""1px 2px 3px""#), ("color", r#""red""#)]);
}

#[test]
fn important_is_split_in_any_spacing_and_case() {
    let sheet = Doc::new().parse(
        "a { color: red !important; top: 1px! important; left: 2px ! IMPORTANT ; width: 3px; \
         content: '!important'; height: 1px !importantly }",
    );
    let rule = &sheet.rules[0];
    assert_eq!(
        pairs(&rule.important),
        [("color", r#""red""#), ("top", r#""1px""#), ("left", r#""2px""#)]
    );
    assert_eq!(
        pairs(&rule.normal),
        [("width", r#""3px""#), ("content", r#""'!important'""#), ("height", r#""1px !importantly""#)]
    );
}

#[test]
fn a_declaration_without_a_colon_or_a_value_is_skipped() {
    let sheet = Doc::new().parse("a { color red; width: ; height: !important; top: 1px; : x; 5: y }");
    assert_eq!(pairs(&sheet.rules[0].normal), [("top", r#""1px""#)]);
    assert!(sheet.rules[0].important.is_empty());
}

#[test]
fn a_plain_number_of_a_unitless_property_is_a_json_number() {
    let sheet = Doc::new().parse(
        "a { opacity: 0.5; z-index: 3; flex: 1; line-height: 1.5; margin: 0; width: 10; opacity: .25; \
         order: +2; zoom: 1e2; flex-grow: 1 }",
    );
    assert_eq!(
        pairs(&sheet.rules[0].normal),
        [
            ("zIndex", "3"),
            ("flex", "1"),
            ("lineHeight", "1.5"),
            ("margin", r#""0""#),
            ("width", r#""10""#),
            ("opacity", "0.25"),
            ("order", "2"),
            ("zoom", "100"),
            ("flexGrow", "1"),
        ]
    );
}

#[test]
fn a_repeated_key_keeps_the_last_declaration() {
    let sheet = Doc::new().parse("a { color: red; width: 1px; color: blue }");
    assert_eq!(pairs(&sheet.rules[0].normal), [("width", r#""1px""#), ("color", r#""blue""#)]);
}

#[test]
fn declarations_render_as_the_object_the_style_prop_carries() {
    let sheet = Doc::new().parse("a { color: red; opacity: 0.5; content: \"a\\\"b\" }");
    let text = render_declarations(&sheet.rules[0].normal);
    assert_eq!(text, r#"{"color":"red","opacity":0.5,"content":"\"a\\\"b\""}"#);
    serde_json::from_str::<serde_json::Value>(&text).expect("valid JSON");
}

#[test]
fn a_custom_property_value_may_hold_braces() {
    let sheet = Doc::new().parse("a { --x: { a: b }; color: red }");
    assert_eq!(pairs(&sheet.rules[0].normal), [("--x", r#""{ a: b }""#), ("color", r#""red""#)]);
}

// Parser edge cases

#[test]
fn braces_and_semicolons_inside_strings_do_not_end_anything() {
    let sheet = Doc::new().parse(r#"a { content: "}{;"; color: red } b::after { content: '/* no */' }"#);
    assert_eq!(sheet.rules.len(), 2);
    assert_eq!(pairs(&sheet.rules[0].normal), [("content", r#""\"}{;\"""#), ("color", r#""red""#)]);
    assert_eq!(pairs(&sheet.rules[1].normal), [("content", r#""'/* no */'""#)]);
}

#[test]
fn comments_may_sit_anywhere() {
    let sheet = Doc::new().parse("/* a { x: y } */ a /* c */ , /* c */ b { /* c */ color /* c */ : red /* c */ ; } /* end");
    assert_eq!(sheet.rules.len(), 1);
    assert_eq!(sheet.rules[0].selectors.len(), 2);
    assert_eq!(pairs(&sheet.rules[0].normal), [("color", r#""red""#)]);
}

#[test]
fn escapes_in_names_are_decoded() {
    let mut doc = Doc::new();
    let sheet = doc.parse(r".a\:b, .\31 0, .x\2c y { color: red }");
    assert_eq!(sheet.rules[0].selectors.len(), 3);
    for name in ["a:b", "10", "x,y"] {
        assert!(doc.atoms.get(name).is_some(), "{name}");
    }
}

#[test]
fn unknown_at_rules_are_skipped_whole_and_recorded() {
    let mut doc = Doc::new();
    let sheet = doc.parse(
        "@charset \"utf-8\"; @import url(a.css) layer(x); a { color: red } \
         @media (min-width: 1px) { b { color: blue } @media print { c { x: y } } } \
         @keyframes k { from { top: 0 } to { top: 1px } } @font-face { font-family: x; } \
         @Supports (display: grid) { d { display: grid } } e { top: 1px }",
    );
    assert_eq!(sheet.unsupported, ["charset", "import", "media", "keyframes", "font-face", "supports"]);
    let colors: Vec<_> = sheet.rules.iter().map(|rule| pairs(&rule.normal)[0].0).collect();
    assert_eq!(colors, ["color", "top"]);
}

#[test]
fn an_invalid_selector_drops_the_rule_and_is_recorded() {
    let sheet = Doc::new().parse("a, b:hover { color: red } c { top: 1px } d:nth-child(2n) { x: y } ,a { x: y }");
    assert_eq!(sheet.rules.len(), 1);
    assert_eq!(pairs(&sheet.rules[0].normal), [("top", r#""1px""#)]);
    assert_eq!(sheet.unsupported, ["a, b:hover", "d:nth-child(2n)", ",a"]);
}

#[test]
fn an_unclosed_block_ends_at_the_end_of_the_sheet() {
    let sheet = Doc::new().parse("a { color: red; b { top: 1px");
    assert_eq!(sheet.rules.len(), 2);
}

#[test]
fn a_stray_closer_does_not_end_a_block() {
    let mut doc = Doc::new();
    let sheet = doc.parse(".a { width: calc(1px + 2px)); } .b { color: red }");
    assert_eq!(pairs(&sheet.rules.last().expect("a rule").normal), [("color", r#""red""#)]);
    let sheet = doc.parse(".a { width: calc(1px + 2px)]; } .b { color: red }");
    assert_eq!(pairs(&sheet.rules.last().expect("a rule").normal), [("color", r#""red""#)]);
}

#[test]
fn a_rule_without_declarations_is_not_kept() {
    let sheet = Doc::new().parse("a { } b { /* nothing */ ; } c { color: red }");
    assert_eq!(sheet.rules.len(), 1);
    assert_eq!(sheet.rules[0].order, 0);
}

#[test]
fn rule_order_is_source_order() {
    let sheet = Doc::new().parse("a { x: 1 } @layer l { b { x: 2 } } c { x: 3 }");
    let orders: Vec<u32> = sheet.rules.iter().map(|rule| rule.order).collect();
    assert_eq!(orders, [0, 1, 2]);
}

// Layers

fn rank_of(doc: &Doc, layer: Option<LayerId>) -> u32 {
    doc.layers.order().rank(layer)
}

#[test]
fn layers_rank_in_first_declared_order_and_unlayered_wins() {
    let mut doc = Doc::new();
    let sheet = doc.parse(
        "@layer base, theme; @layer theme { a { x: 1 } } @layer base { b { x: 2 } } @layer { c { x: 3 } } d { x: 4 }",
    );
    let layers: Vec<Option<LayerId>> = sheet.rules.iter().map(|rule| rule.layer).collect();
    let ranks: Vec<u32> = layers.iter().map(|layer| rank_of(&doc, *layer)).collect();
    assert_eq!(ranks, [1, 0, 2, 3]);
    assert!(layers[3].is_none());
}

#[test]
fn nested_layers_rank_inside_their_parent() {
    let mut doc = Doc::new();
    let sheet = doc.parse(
        "@layer a.x { p { x: 1 } } @layer b { q { x: 2 } } @layer a { @layer y; r { x: 3 } } \
         @layer a.y { s { x: 4 } }",
    );
    let ranks: Vec<u32> = sheet.rules.iter().map(|rule| rank_of(&doc, rule.layer)).collect();
    // a.x < a.y < a (its own rules) < b < unlayered.
    assert_eq!(ranks, [0, 3, 2, 1]);
    assert_eq!(rank_of(&doc, None), 4);
}

#[test]
fn layers_are_shared_between_the_sheets_of_a_document() {
    let mut doc = Doc::new();
    let first = doc.parse("@layer a { p { x: 1 } }");
    let second = doc.parse("@layer b { q { x: 1 } } @layer a { r { x: 1 } }");
    assert_eq!(first.rules[0].layer, second.rules[1].layer);
    assert!(rank_of(&doc, second.rules[1].layer) < rank_of(&doc, second.rules[0].layer));
}

#[test]
fn a_malformed_layer_is_ignored() {
    let sheet = Doc::new().parse("@layer a, { p { x: 1 } } @layer a b { q { x: 1 } } @layer a, b { r { x: 1 } } s { x: 1 }");
    assert_eq!(sheet.rules.len(), 1);
    assert!(sheet.unsupported.is_empty());
}

// Nesting

#[test]
fn a_nested_rule_with_and_is_the_parent_as_is() {
    let mut doc = Doc::new();
    let sheet = doc.parse(".a, #b { color: red; &.c { top: 1px } }");
    assert_eq!(sheet.rules.len(), 2);
    let nested = &sheet.rules[1];
    assert_eq!(nested.selectors.len(), 1);
    // :is(.a, #b) is as specific as #b, plus .c.
    assert_eq!(nested.selectors[0].1, Specificity::new(1, 1, 0));
    let tree = fixture(&mut doc.atoms);
    let mut tree = tree;
    let both = tree.add(&mut doc.atoms, "div", Some(BODY), None, Some("b"), &["c"], &[]);
    let only_parent = tree.add(&mut doc.atoms, "div", Some(BODY), None, Some("b"), &[], &[]);
    assert!(matches(&nested.selectors[0].0, &tree.view(both)));
    assert!(!matches(&nested.selectors[0].0, &tree.view(only_parent)));
}

#[test]
fn a_relative_nested_selector_gets_an_implicit_and() {
    let mut doc = Doc::new();
    let sheet = doc.parse(".box { color: red; span { top: 1px } > .first { top: 2px } + p { top: 3px } ~ p { top: 4px } }");
    assert_eq!(sheet.rules.len(), 5);
    let tree = fixture(&mut doc.atoms);
    let matching = |rule: usize| -> Vec<usize> {
        (0..tree.nodes.len())
            .filter(|index| sheet.rules[rule].selectors.iter().any(|(s, _)| matches(s, &tree.view(*index))))
            .collect()
    };
    assert_eq!(matching(1), [FIRST, SECOND]);
    assert_eq!(matching(2), [FIRST]);
    assert!(matching(3).is_empty());
    assert!(matching(4).is_empty());
    assert_eq!(sheet.rules[1].selectors[0].1, Specificity::new(0, 1, 1));
}

#[test]
fn sibling_combinators_nest_too() {
    let mut doc = Doc::new();
    let sheet = doc.parse(".first { top: 0; + .second { top: 1px } ~ p { top: 2px } }");
    let tree = fixture(&mut doc.atoms);
    let matching = |rule: usize| -> Vec<usize> {
        (0..tree.nodes.len()).filter(|index| matches(&sheet.rules[rule].selectors[0].0, &tree.view(*index))).collect()
    };
    assert_eq!(matching(1), [SECOND]);
    assert_eq!(matching(2), [PARA]);
}

#[test]
fn and_may_sit_inside_the_selector() {
    let mut doc = Doc::new();
    let sheet = doc.parse("span { top: 0; .box & { top: 1px } :is(&, p) { top: 2px } }");
    assert_eq!(sheet.rules.len(), 3);
    let tree = fixture(&mut doc.atoms);
    let matching = |rule: usize| -> Vec<usize> {
        (0..tree.nodes.len()).filter(|index| matches(&sheet.rules[rule].selectors[0].0, &tree.view(*index))).collect()
    };
    assert_eq!(matching(1), [FIRST, SECOND]);
    // `&` named inside, so no implicit `&` in front: any span (the parent) or any p.
    assert_eq!(matching(2), [FIRST, SECOND, PARA]);
}

#[test]
fn declarations_after_a_nested_rule_come_after_it() {
    let sheet = Doc::new().parse("a { top: 1px; b { top: 2px } left: 3px }");
    let rules: Vec<_> = sheet.rules.iter().map(|rule| (rule.order, pairs(&rule.normal)[0].0)).collect();
    assert_eq!(rules, [(0, "top"), (1, "top"), (2, "left")]);
}

#[test]
fn nesting_goes_several_levels_and_keeps_the_layer() {
    let mut doc = Doc::new();
    let sheet = doc.parse("@layer l { .a { .b { .c { top: 1px } } } }");
    assert_eq!(sheet.rules.len(), 1);
    assert!(sheet.rules[0].layer.is_some());
    assert_eq!(sheet.rules[0].selectors[0].1, Specificity::new(0, 3, 0));
}

#[test]
fn nesting_with_lists_at_every_level_shares_the_parent_list() {
    let depth = 20;
    let mut text = String::from(".a, .b { color: red; ");
    for _ in 1..depth {
        text.push_str(".c, .d { color: red; ");
    }
    text.push_str(&"}".repeat(depth));
    let mut doc = Doc::new();
    let sheet = doc.parse(&text);
    assert_eq!(sheet.rules.len(), depth);

    let mut tree = Tree::default();
    let mut parent = tree.add(&mut doc.atoms, "div", None, None, None, &["a"], &[]);
    for _ in 1..depth {
        parent = tree.add(&mut doc.atoms, "div", Some(parent), None, None, &["c"], &[]);
    }
    let deepest = &sheet.rules[depth - 1];
    assert!(deepest.selectors.iter().any(|(selector, _)| matches(selector, &tree.view(parent))));
    let top = &sheet.rules[0];
    assert!(top.selectors.iter().all(|(selector, _)| !matches(selector, &tree.view(parent))));
    assert_eq!(deepest.selectors[0].1, Specificity::new(0, depth as u32, 0));
}

#[test]
fn hostile_nesting_is_cut_off_instead_of_overflowing_the_stack() {
    let depth = 1000;
    let mut doc = Doc::new();
    let nested = format!("{}color: red;{}", ".a { top: 1px; ".repeat(depth), "}".repeat(depth));
    let sheet = doc.parse(&nested);
    assert!(sheet.rules.len() < 40, "{}", sheet.rules.len());
    assert!(!sheet.rules.is_empty());
    assert_eq!(sheet.unsupported.len(), 1);

    let layers = format!("{}.a {{ color: red }}{}", "@layer l { ".repeat(depth), "}".repeat(depth));
    assert!(doc.parse(&layers).rules.is_empty());

    for function in ["is", "where", "not"] {
        let selector = format!("{}.a{}", format!(":{function}(").repeat(depth), ")".repeat(depth));
        let sheet = doc.parse(&format!("{selector} {{ color: red }}"));
        assert!(sheet.rules.len() <= 1, ":{function}");
    }
    assert!(is_valid(":is(:is(:is(.a)))"));
}

#[test]
fn an_invalid_nested_selector_drops_only_that_rule() {
    let sheet = Doc::new().parse("a { top: 1px; &:hover { top: 2px } b { top: 3px } }");
    let tops: Vec<_> = sheet.rules.iter().map(|rule| pairs(&rule.normal)[0].1.to_owned()).collect();
    assert_eq!(tops, [r#""1px""#, r#""3px""#]);
    assert_eq!(sheet.unsupported, ["&:hover"]);
}

#[test]
fn at_rules_in_a_style_rule_are_skipped_and_recorded() {
    let sheet = Doc::new().parse("a { top: 1px; @media print { top: 2px } left: 3px }");
    assert_eq!(sheet.rules.len(), 1);
    assert_eq!(pairs(&sheet.rules[0].normal), [("top", r#""1px""#), ("left", r#""3px""#)]);
    assert_eq!(sheet.unsupported, ["media"]);
}

#[test]
fn a_top_level_and_is_the_root() {
    assert_eq!(selected("&"), [HTML]);
    assert_eq!(specificity("&"), (0, 1, 0));
}

// Selectors

#[test]
fn type_selectors_ignore_case() {
    assert_eq!(selected("DIV"), [MAIN]);
    assert_eq!(selected("SpAn"), [FIRST, SECOND]);
    assert_eq!(selected("*"), [HTML, BODY, MAIN, FIRST, SECOND, PARA]);
}

#[test]
fn class_and_id_selectors_are_case_sensitive() {
    assert_eq!(selected(".box"), [MAIN]);
    assert_eq!(selected(".Box"), Vec::<usize>::new());
    assert_eq!(selected("#main"), [MAIN]);
    assert_eq!(selected("#Main"), Vec::<usize>::new());
    assert_eq!(selected("div.box.wide#main"), [MAIN]);
    assert_eq!(selected("div.box.nope"), Vec::<usize>::new());
    assert_eq!(selected("span.second"), [SECOND]);
}

#[test]
fn attribute_selectors_match_by_operator() {
    assert_eq!(selected("[data-x]"), [MAIN]);
    assert_eq!(selected("[DATA-X]"), [MAIN]);
    assert_eq!(selected("[data-x='a b']"), [MAIN]);
    assert_eq!(selected("[data-x=a]"), Vec::<usize>::new());
    assert_eq!(selected("[data-x~=b]"), [MAIN]);
    assert_eq!(selected("[data-x~='a b']"), Vec::<usize>::new());
    assert_eq!(selected("[data-x~='']"), Vec::<usize>::new());
    assert_eq!(selected("[lang|=en]"), [SECOND]);
    assert_eq!(selected("[lang|=en-US]"), [SECOND]);
    assert_eq!(selected("[lang|=e]"), Vec::<usize>::new());
    assert_eq!(selected("[lang^=en]"), [SECOND]);
    assert_eq!(selected("[lang$=US]"), [SECOND]);
    assert_eq!(selected("[lang*='-U']"), [SECOND]);
    assert_eq!(selected("[lang^='']"), Vec::<usize>::new());
    assert_eq!(selected("[lang$='']"), Vec::<usize>::new());
    assert_eq!(selected("[lang*='']"), Vec::<usize>::new());
}

#[test]
fn attribute_value_case_flags() {
    assert_eq!(selected("[lang=EN-us]"), Vec::<usize>::new());
    assert_eq!(selected("[lang=EN-us i]"), [SECOND]);
    assert_eq!(selected("[lang=EN-us I]"), [SECOND]);
    assert_eq!(selected("[lang='EN-us'i]"), [SECOND]);
    assert_eq!(selected("[lang=en-US s]"), [SECOND]);
    assert_eq!(selected("[lang|=EN i]"), [SECOND]);
    assert_eq!(selected("[lang|=EN]"), Vec::<usize>::new());
    assert_eq!(selected("[lang^=EN i]"), [SECOND]);
    assert_eq!(selected("[lang$=us i]"), [SECOND]);
    assert_eq!(selected("[lang*='-u' i]"), [SECOND]);
    assert_eq!(selected("[lang*='-u']"), Vec::<usize>::new());
    assert_eq!(selected("[data-x~=B i]"), [MAIN]);
    assert_eq!(selected("[lang$=en-us-longer i]"), Vec::<usize>::new());
    assert_eq!(selected("[ lang = 'en-US' ]"), [SECOND]);
    assert!(!is_valid("[lang=en x]"));
    assert!(!is_valid("[lang=1]"));
    assert!(!is_valid("[lang]]"));
    assert!(!is_valid("[]"));
    assert!(!is_valid("[ns|lang]"));
    assert!(!is_valid("[lang=]"));
}

#[test]
fn combinators() {
    assert_eq!(selected("body span"), [FIRST, SECOND]);
    assert_eq!(selected("html p"), [PARA]);
    assert_eq!(selected("body > span"), Vec::<usize>::new());
    assert_eq!(selected("div > span"), [FIRST, SECOND]);
    assert_eq!(selected("html > p"), Vec::<usize>::new());
    assert_eq!(selected(".first + span"), [SECOND]);
    assert_eq!(selected(".first + p"), Vec::<usize>::new());
    assert_eq!(selected(".first ~ p"), [PARA]);
    assert_eq!(selected(".first~*"), [SECOND, PARA]);
    assert_eq!(selected("span + p"), [PARA]);
    assert_eq!(selected("html body div > .second"), [SECOND]);
    assert_eq!(selected("html>body>div>span+span"), [SECOND]);
}

#[test]
fn a_descendant_combinator_backtracks() {
    // The nearest ancestor div is not the one that has a body parent in this tree.
    let mut doc = Doc::new();
    let mut tree = Tree::default();
    let outer = tree.add(&mut doc.atoms, "section", None, None, None, &[], &[]);
    let middle = tree.add(&mut doc.atoms, "div", Some(outer), None, None, &[], &[]);
    let inner = tree.add(&mut doc.atoms, "div", Some(middle), None, None, &[], &[]);
    let leaf = tree.add(&mut doc.atoms, "i", Some(inner), None, None, &[], &[]);
    let selector = doc.selector("section > div i");
    assert!(matches(&selector, &tree.view(leaf)));
    let selector = doc.selector("section > div > i");
    assert!(!matches(&selector, &tree.view(leaf)));
}

#[test]
fn is_where_and_not() {
    assert_eq!(selected(":is(.first, p)"), [FIRST, PARA]);
    assert_eq!(selected(":where(.first, p)"), [FIRST, PARA]);
    assert_eq!(selected("span:not(.first)"), [SECOND]);
    assert_eq!(selected(":not(span, div, p, body)"), [HTML]);
    assert_eq!(selected(":not(div p)"), [HTML, BODY, MAIN, FIRST, SECOND]);
    assert_eq!(selected(":is(div, body) > :is(span, div)"), [MAIN, FIRST, SECOND]);
    assert_eq!(selected(":is()"), Vec::<usize>::new());
}

#[test]
fn is_and_where_drop_invalid_arguments() {
    assert_eq!(selected(":is(.first, :hover, p)"), [FIRST, PARA]);
    assert_eq!(selected(":where(:hover, .first, 5)"), [FIRST]);
    assert_eq!(selected(":is(:hover)"), Vec::<usize>::new());
    assert_eq!(selected(":is(, .first,)"), [FIRST]);
    assert_eq!(selected(":is(::before, .first)"), [FIRST]);
    assert!(!is_valid(":not(:hover)"));
    assert!(!is_valid(":not()"));
    assert!(!is_valid(":not(.a,)"));
    assert!(!is_valid(":not(::before)"));
}

#[test]
fn root_and_host() {
    assert_eq!(selected(":root"), [HTML]);
    assert_eq!(selected(":ROOT"), [HTML]);
    assert_eq!(selected(":root body"), [BODY]);
    assert_eq!(selected(":host"), Vec::<usize>::new());
    assert_eq!(selected(":is(:root, :host)"), [HTML]);
    assert_eq!(selected(":is(:root,:host) span"), [FIRST, SECOND]);
    assert!(!is_valid(":host(.a)"));
}

#[test]
fn pseudo_elements_parse_and_never_match() {
    for selector in ["::backdrop", "div::before", "div:before", "p:after", "p:first-line", "p:FIRST-LETTER", "span::part(x)"] {
        let mut doc = Doc::new();
        let parsed = doc.selector(selector);
        assert!(parsed.has_pseudo_element(), "{selector}");
        let tree = fixture(&mut doc.atoms);
        assert!((0..tree.nodes.len()).all(|index| !matches(&parsed, &tree.view(index))), "{selector}");
    }
    assert_eq!(selected("*::before"), Vec::<usize>::new());
    assert_eq!(selected(":not(.nothing)::before"), Vec::<usize>::new());
}

#[test]
fn other_pseudo_classes_and_syntax_are_invalid() {
    for selector in [
        ":hover", "a:focus", ":first-child", ":nth-child(2)", ":has(a)", ":matches(a)", ":scope", "a|b", "*|*",
        "a >", "> a", "a > > b", "a,", ",a", "a, , b", ".", "#1", "a$", "a b!", "&&&:x", ":", "a:", "::",
    ] {
        assert!(!is_valid(selector), "{selector}");
    }
}

#[test]
fn specificity_follows_the_spec() {
    assert_eq!(specificity("*"), (0, 0, 0));
    assert_eq!(specificity("div"), (0, 0, 1));
    assert_eq!(specificity(".a"), (0, 1, 0));
    assert_eq!(specificity("#a"), (1, 0, 0));
    assert_eq!(specificity("[a]"), (0, 1, 0));
    assert_eq!(specificity("[a=b]"), (0, 1, 0));
    assert_eq!(specificity(":root"), (0, 1, 0));
    assert_eq!(specificity("div.a#b[c]"), (1, 2, 1));
    assert_eq!(specificity("div p > span ~ b"), (0, 0, 4));
    assert_eq!(specificity("div::before"), (0, 0, 2));
    assert_eq!(specificity(":where(#a, .b) .c"), (0, 1, 0));
    assert_eq!(specificity(":is(#a, .b, p)"), (1, 0, 0));
    assert_eq!(specificity(":is(.a .b, c)"), (0, 2, 0));
    assert_eq!(specificity(":not(#a)"), (1, 0, 0));
    assert_eq!(specificity(":not(.a, div p)"), (0, 1, 0));
    assert_eq!(specificity(":is()"), (0, 0, 0));
    assert_eq!(specificity(":is(:root, :host) [a]"), (0, 2, 0));
}

#[test]
fn each_selector_of_a_list_has_its_own_specificity() {
    let sheet = Doc::new().parse("#a, .b, c { color: red }");
    let found: Vec<_> = sheet.rules[0].selectors.iter().map(|(_, s)| (s.ids, s.classes, s.types)).collect();
    assert_eq!(found, [(1, 0, 0), (0, 1, 0), (0, 0, 1)]);
}

#[test]
fn a_selector_is_stored_subject_first() {
    let mut doc = Doc::new();
    let selector = doc.selector("html > body span.x");
    assert_eq!(selector.compounds.len(), 3);
    assert_eq!(selector.links, [Combinator::Descendant, Combinator::Child]);
    let span = doc.atoms.get("span").expect("interned");
    assert_eq!(selector.compounds[0].simples[0], Simple::Tag(TypeName { lower: span, written: span }));
}

#[test]
fn atoms_are_shared_and_lower_cased_where_css_is_case_insensitive() {
    let mut doc = Doc::new();
    doc.parse("DIV[Data-X].Foo#Bar { x: y }");
    assert!(doc.atoms.get("div").is_some());
    assert!(doc.atoms.get("data-x").is_some());
    assert!(doc.atoms.get("Foo").is_some());
    assert!(doc.atoms.get("Bar").is_some());
    // A type is kept as written too, which is what an SVG element compares.
    assert!(doc.atoms.get("DIV").is_some());
    assert!(doc.atoms.get("Data-X").is_some());
    assert!(doc.atoms.get("foo").is_none());
    let again = doc.atoms.intern("div");
    assert_eq!(doc.atoms.name(again), "div");
    assert_eq!(doc.atoms.get("div"), Some(again));
}

// The dnd-kit sheet

fn dnd_kit(doc: &mut Doc) -> StyleSheet {
    doc.parse(DND_KIT)
}

#[test]
fn dnd_kit_rules_and_specificity() {
    let mut doc = Doc::new();
    let sheet = dnd_kit(&mut doc);
    assert!(sheet.unsupported.is_empty(), "{:?}", sheet.unsupported);
    assert_eq!(sheet.rules.len(), 11);
    let specificities: Vec<Vec<(u32, u32, u32)>> = sheet
        .rules
        .iter()
        .map(|rule| rule.selectors.iter().map(|(_, s)| (s.ids, s.classes, s.types)).collect())
        .collect();
    assert_eq!(
        specificities,
        [
            vec![(0, 2, 0)],
            vec![(0, 2, 0)],
            vec![(0, 2, 0)],
            vec![(0, 1, 0)],
            vec![(0, 2, 0)],
            vec![(0, 2, 0)],
            vec![(0, 0, 0)],
            vec![(0, 0, 1)],
            vec![(0, 1, 1), (0, 2, 0)],
            vec![(0, 0, 0)],
            vec![(0, 0, 0)],
        ]
    );
    let orders: Vec<u32> = sheet.rules.iter().map(|rule| rule.order).collect();
    assert_eq!(orders, (0..11).collect::<Vec<_>>());
}

#[test]
fn dnd_kit_splits_important_from_normal() {
    let sheet = dnd_kit(&mut Doc::new());
    let keys = |declarations: &[Declaration]| -> Vec<String> { declarations.iter().map(|d| d.key.clone()).collect() };
    let dragging = &sheet.rules[0];
    assert_eq!(
        keys(&dragging.normal),
        ["touchAction", "zIndex", "willChange", "width", "maxWidth", "height", "maxHeight"].map(String::from)
    );
    assert_eq!(
        keys(&dragging.important),
        ["position", "pointerEvents", "top", "left", "right", "bottom", "transform", "transition"].map(String::from)
    );
    assert_eq!(dragging.normal[3].value, r#""var(--dnd-width, auto)""#);
    assert_eq!(dragging.normal[1].value, r#""calc(infinity)""#);
    let star = &sheet.rules[10];
    assert!(star.normal.is_empty());
    assert_eq!(keys(&star.important), ["userSelect", "WebkitUserSelect"].map(String::from));
    assert!(sheet.rules[1].important.is_empty());
}

#[test]
fn dnd_kit_layer_ranks_below_unlayered() {
    let mut doc = Doc::new();
    let sheet = dnd_kit(&mut doc);
    let order = doc.layers.order();
    assert!(sheet.rules[0].layer.is_none());
    let layered = [6, 7];
    for index in layered {
        assert!(sheet.rules[index].layer.is_some(), "rule {index}");
        assert!(order.rank(sheet.rules[index].layer) < order.rank(None));
    }
    assert_eq!(sheet.rules[6].layer, sheet.rules[7].layer);
    assert_eq!(sheet.rules.iter().filter(|rule| rule.layer.is_some()).count(), 2);
}

#[test]
fn dnd_kit_nested_rule_matches_only_buttons_and_inputs_in_the_popover() {
    let mut doc = Doc::new();
    let sheet = dnd_kit(&mut doc);
    let outer = &sheet.rules[6];
    assert_eq!(
        pairs(&outer.normal).iter().map(|(key, _)| *key).collect::<Vec<_>>(),
        ["overflow", "background", "border", "margin", "padding", "color"]
    );
    let nested = &sheet.rules[7];
    assert_eq!(pairs(&nested.normal), [("border", r#""revert""#), ("background", r#""revert""#)]);

    let mut tree = Tree::default();
    let popover = [("data-dnd-dragging", ""), ("popover", "")];
    let input = tree.add(&mut doc.atoms, "input", None, None, None, &[], &popover);
    let button = tree.add(&mut doc.atoms, "button", None, None, None, &[], &popover);
    let div = tree.add(&mut doc.atoms, "div", None, None, None, &[], &popover);
    let plain_input = tree.add(&mut doc.atoms, "input", None, None, None, &[], &[("data-dnd-dragging", "")]);
    let selector = &nested.selectors[0].0;
    assert!(matches(selector, &tree.view(input)));
    assert!(matches(selector, &tree.view(button)));
    assert!(!matches(selector, &tree.view(div)));
    assert!(!matches(selector, &tree.view(plain_input)));
    let outer_selector = &outer.selectors[0].0;
    assert!(matches(outer_selector, &tree.view(div)));
    assert!(!matches(outer_selector, &tree.view(plain_input)));
}

#[test]
fn dnd_kit_backdrop_never_matches_but_the_overlay_branch_does() {
    let mut doc = Doc::new();
    let sheet = dnd_kit(&mut doc);
    let rule = &sheet.rules[8];
    let backdrop = &rule.selectors[0].0;
    let overlay = &rule.selectors[1].0;
    assert!(backdrop.has_pseudo_element());

    let mut tree = Tree::default();
    let dragging = tree.add(&mut doc.atoms, "div", None, None, None, &[], &[("data-dnd-dragging", "")]);
    let resting_overlay = tree.add(&mut doc.atoms, "div", None, None, None, &[], &[("data-dnd-overlay", "")]);
    let dragged_overlay = tree.add(
        &mut doc.atoms,
        "div",
        None,
        None,
        None,
        &[],
        &[("data-dnd-overlay", ""), ("data-dnd-dragging", "")],
    );
    for index in [dragging, resting_overlay, dragged_overlay] {
        assert!(!matches(backdrop, &tree.view(index)));
    }
    assert!(!matches(overlay, &tree.view(dragging)));
    assert!(matches(overlay, &tree.view(resting_overlay)));
    assert!(!matches(overlay, &tree.view(dragged_overlay)));
}

#[test]
fn dnd_kit_style_attribute_selector_and_the_other_selectors() {
    let mut doc = Doc::new();
    let sheet = dnd_kit(&mut doc);
    let mut tree = Tree::default();
    let root = tree.add(&mut doc.atoms, "html", None, None, None, &[], &[]);
    let body = tree.add(&mut doc.atoms, "body", Some(root), None, None, &[], &[]);
    let scaled = tree.add(
        &mut doc.atoms,
        "div",
        Some(body),
        None,
        None,
        &[],
        &[("data-dnd-dragging", ""), ("style", "translate: 1px; --dnd-scale: 1.1;")],
    );
    let unscaled = tree.add(&mut doc.atoms, "div", Some(body), Some(scaled), None, &[], &[("data-dnd-dragging", "")]);
    let child = tree.add(&mut doc.atoms, "i", Some(scaled), None, None, &[], &[]);
    let placeholder = tree.add(&mut doc.atoms, "div", Some(body), None, None, &[], &[("data-dnd-placeholder", "hidden")]);

    let scale = &sheet.rules[5].selectors[0].0;
    assert!(matches(scale, &tree.view(scaled)));
    assert!(!matches(scale, &tree.view(unscaled)));

    let translate = &sheet.rules[4].selectors[0].0;
    assert!(matches(translate, &tree.view(scaled)));
    assert!(!matches(translate, &tree.view(placeholder)));

    let inside_dragging = &sheet.rules[3].selectors[0].0;
    assert!(matches(inside_dragging, &tree.view(child)));
    assert!(!matches(inside_dragging, &tree.view(scaled)));

    let under_root = &sheet.rules[0].selectors[0].0;
    assert!(matches(under_root, &tree.view(scaled)));
    assert!(!matches(under_root, &tree.view(root)));
    let hidden = &sheet.rules[2].selectors[0].0;
    assert!(matches(hidden, &tree.view(placeholder)));
    let any = &sheet.rules[9].selectors[0].0;
    assert!(matches(any, &tree.view(child)));
}

/// The style parser reads what the sheet emits. Lenient parsing drops what it cannot use, so this
/// passes however much is dropped; the test prints (`--nocapture`) what is.
#[test]
fn dnd_kit_declarations_go_through_the_style_table() {
    let sheet = dnd_kit(&mut Doc::new());
    let mut table = StyleTable::default();
    let mut dropped = Vec::new();
    for rule in &sheet.rules {
        for list in [&rule.normal, &rule.important] {
            let text = render_declarations(list);
            table.intern(text.as_bytes()).unwrap_or_else(|error| panic!("{text}: {error}"));
            for declaration in list {
                let alone = render_declarations(std::slice::from_ref(declaration));
                let style = table.intern(alone.as_bytes()).unwrap_or_else(|error| panic!("{alone}: {error}"));
                if *style == StyleDesc::default() {
                    dropped.push(format!("{}: {}", declaration.key, declaration.value));
                }
            }
        }
    }
    println!("dropped or ignored by the style parser:\n{}", dropped.join("\n"));
}

#[test]
fn a_block_with_no_prelude_is_skipped() {
    let mut doc = Doc::new();
    for text in ["{}", "{color:red}", "{} a { color: red }", "a { b { } {} color: red }"] {
        doc.parse(text);
    }
    let sheet = doc.parse("{color:red} a { color: red }");
    assert_eq!(sheet.rules.len(), 1);
    assert!(sheet.unsupported.is_empty());
}

#[test]
fn degenerate_sheets_do_not_panic() {
    let texts = [
        "", "}", "{", "{{", "}}", "{{}", ";", ";;", "@", "@layer", "@layer;", "@layer {", "@layer a {", "@layer a, ;",
        "@layer {}", "@layer a b {}", "@media", "@media {", "a{", "a {color", "a {color:", "a {color: red", "a { & }",
        "a { &{} }", "&{}", "& {color: red}", "&{", "> a {}", "a { > {} }", "a { { } }", "a { @x {", "a { @x", "a { --x: {",
        "a { --x: { } }", "\"abc", "a { content: \"abc", "/* unterminated", "a /* x", "a { color: red /* x", "a[", "a[b",
        "a:is(", "a:not({", ":is(){}", "a, {}", ",{}", "a,{}", "\\", "a\\", "url(", "a { b: url( }", "@layer a { { } }",
        "@layer a { @layer { } }", "a { } }", "a { ) }", ") { }", "] { }", "a { ( }", "a { [ }", "a { b { c { d {",
    ];
    let mut doc = Doc::new();
    for text in texts {
        doc.parse(text);
    }
}

#[test]
fn every_initial_value_is_a_declaration_the_validator_accepts() {
    let mut validator = super::validate::Validator::default();
    let rejected: Vec<String> = super::initial::all()
        .filter(|initial| validator.filter_own(vec![(*initial).clone()]).is_empty())
        .map(|initial| format!("{}: {}", initial.key, initial.value))
        .collect();
    assert!(rejected.is_empty(), "{rejected:?}");
}
