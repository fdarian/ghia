//! The marker of a `display: list-item` box (CSS Lists 3): which one it is, and which elements a
//! change of the tree or of a style makes show another.
//!
//! The marker of an item is a function of its `list-style-type`, which it inherits, and for the
//! counting types of its ordinal, the value of the list-item counter that the items before it in
//! the same parent count up (`ol start`, `ol reversed`, `li value`). So an ordinal marker depends
//! on its siblings: an item that comes, goes or moves, a `value`, `start` or `reversed` that
//! changes, or a sibling that stops being a list item renumbers the items after it (every item of
//! a reversed list that has no `start`, which counts down from the number of items). The tree
//! notes those changes as they happen and [`RetainedTree::flush_list_markers`] marks the items
//! once, at the end of the batch, as `flush_styles` does for the sheets.
//!
//! The UA rules of Chrome that need an element's place are here too: a list inside a list has no
//! block margin, and a `ul` is a `circle` inside one list and a `square` inside two or more
//! (`html::tags::NESTED_LISTS`). They are the user agent layer of the element, so an author value
//! is over them, and the element is styled again when it comes into or goes out of a list.
//!
//! `menu` and `dir` are not tags here, `counter-reset`, `counter-increment`, `@counter-style` and
//! `::marker` are not supported, and an item counts in the list of its parent element, not of the
//! nearest `ul` or `ol` above it ([deviations](../../../../docs/fork/deviations.md)).

use rustc_hash::{FxHashMap, FxHashSet};

use crate::css::list_style::{self, ListStylePosition, ListStyleType};
use crate::retained_tree::{RetainedElement, RetainedTree};

/// The marker of one item, as text and where it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Marker {
    pub text: String,
    pub position: ListStylePosition,
}

fn is_list_item(element: &RetainedElement) -> bool {
    element.display().as_deref() == Some("list-item")
}

/// The integer a `value` or `start` prop holds: a number, or the text of an attribute by the HTML
/// rules for parsing integers (leading white space, a sign, digits, anything after ignored).
fn integer_of(value: Option<&serde_json::Value>) -> Option<i64> {
    let parsed = match value? {
        serde_json::Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|float| float as i64))?,
        serde_json::Value::String(text) => {
            let text = text.trim_start_matches([' ', '\t', '\n', '\x0c', '\r']);
            let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
            let digits = unsigned.len() - unsigned.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if digits == 0 {
                return None;
            }
            text[..text.len() - unsigned.len() + digits].parse::<i64>().ok()?
        }
        _ => return None,
    };
    i32::try_from(parsed).ok().map(i64::from)
}

/// A boolean attribute as a prop: written as `true`, or as any text (`setAttribute("reversed", "")`).
fn is_present(value: Option<&serde_json::Value>) -> bool {
    matches!(value, Some(serde_json::Value::Bool(true) | serde_json::Value::String(_)))
}

fn is_reversed(list: &RetainedElement) -> bool {
    list.element_type == "ol" && is_present(list.custom_props().get("reversed"))
}

fn declared_start(list: &RetainedElement) -> Option<i64> {
    if list.element_type == "ol" { integer_of(list.custom_props().get("start")) } else { None }
}

/// The ordinal of each list item among the children of `parent_id`.
fn ordinals_of_children(tree: &RetainedTree, parent_id: u64) -> FxHashMap<u64, i64> {
    let parent = &tree.elements[&parent_id];
    let items: Vec<&RetainedElement> =
        parent.children.iter().filter_map(|id| tree.elements.get(id)).filter(|child| is_list_item(child)).collect();
    let reversed = is_reversed(parent);
    let start = declared_start(parent).unwrap_or(if reversed { items.len() as i64 } else { 1 });
    let step = if reversed { -1 } else { 1 };
    let mut next = start;
    let mut ordinals = FxHashMap::with_capacity_and_hasher(items.len(), Default::default());
    for item in items {
        let value = if item.element_type == "li" { integer_of(item.custom_props().get("value")) } else { None };
        let ordinal = value.unwrap_or(next);
        ordinals.insert(item.id, ordinal);
        next = ordinal.saturating_add(step);
    }
    ordinals
}

/// The ordinals of the list items of the parents asked about, each parent counted once, so the
/// markers of a list of N items cost N and not N times N. Made for one build.
#[derive(Default)]
pub(crate) struct Ordinals {
    by_parent: FxHashMap<u64, FxHashMap<u64, i64>>,
}

impl Ordinals {
    fn of(&mut self, tree: &RetainedTree, id: u64) -> Option<i64> {
        let Some(parent) = tree.elements.get(&id)?.parent else {
            return Some(1);
        };
        self.by_parent.entry(parent).or_insert_with(|| ordinals_of_children(tree, parent)).get(&id).copied()
    }
}

/// The marker of the element `id`: `None` unless its `display` is `list-item` and its
/// `list-style-type` is not `none`.
pub(crate) fn marker_of(tree: &RetainedTree, ordinals: &mut Ordinals, id: u64) -> Option<Marker> {
    if !is_list_item(tree.elements.get(&id)?) {
        return None;
    }
    let list_type = tree.list_style_type_of(id);
    let ordinal = if list_type.is_ordinal() { ordinals.of(tree, id)? } else { 0 };
    Some(Marker { text: list_type.marker_text(ordinal)?, position: tree.list_style_position_of(id) })
}

/// What the tree has noted since the last flush.
#[derive(Default)]
pub(crate) struct ListMarkers {
    /// How many `ul` and `ol` there are: with none, nothing about a place in a list needs reading.
    lists: usize,
    /// Elements that were put somewhere or taken out of it, whose lists inside are styled by the
    /// lists they now are in.
    moved: Vec<u64>,
    reordered: Vec<Reorder>,
}

/// The items of `parent` after `after` (all of them for `None`) are numbered again.
struct Reorder {
    parent: u64,
    after: Option<u64>,
    /// An item came, went or stopped being one, which changes how many there are: that is also the
    /// start of a reversed list with no `start`.
    membership: bool,
}

impl ListMarkers {
    pub(crate) fn element_created(&mut self, element_type: &str) {
        self.lists += usize::from(crate::html::is_list(element_type));
    }

    pub(crate) fn element_destroyed(&mut self, element_type: &str) {
        self.lists -= usize::from(crate::html::is_list(element_type));
    }

    fn is_empty(&self) -> bool {
        self.moved.is_empty() && self.reordered.is_empty()
    }
}

impl RetainedTree {
    /// How many `ul` and `ol` are above `id`, counted to two: all that the user agent style reads.
    pub(crate) fn lists_above(&self, id: u64) -> usize {
        let mut count = 0;
        let mut current = self.elements.get(&id).and_then(|element| element.parent);
        while let Some(parent_id) = current {
            let Some(parent) = self.elements.get(&parent_id) else { break };
            if crate::html::is_list(&parent.element_type) {
                count += 1;
                if count == 2 {
                    break;
                }
            }
            current = parent.parent;
        }
        count
    }

    /// The `list-style-type` of `id`: the nearest one an element declares, itself first.
    pub(crate) fn list_style_type_of(&self, id: u64) -> ListStyleType {
        self.nearest(id, list_style::declared_type).unwrap_or(ListStyleType::Disc)
    }

    /// The `list-style-position` of `id`, found as the type is.
    pub(crate) fn list_style_position_of(&self, id: u64) -> ListStylePosition {
        self.nearest(id, list_style::declared_position).unwrap_or(ListStylePosition::Outside)
    }

    fn nearest<T>(&self, id: u64, declared: fn(&crate::style::StyleDesc) -> Option<T>) -> Option<T> {
        let mut current = Some(id);
        while let Some(element_id) = current {
            let element = self.elements.get(&element_id)?;
            if let Some(value) = element.style.as_deref().and_then(declared) {
                return Some(value);
            }
            current = element.parent;
        }
        None
    }

    fn note_reorder(&mut self, parent: u64, after: Option<u64>, membership: bool) {
        self.list_markers.reordered.push(Reorder { parent, after, membership });
    }

    /// Before `child` leaves its parent.
    pub(crate) fn list_unlinking(&mut self, child: u64) {
        let Some(element) = self.elements.get(&child) else { return };
        let Some(parent_id) = element.parent else { return };
        if self.list_markers.lists > 0 {
            self.list_markers.moved.push(child);
        }
        if is_list_item(element) {
            let before = self.elements.get(&parent_id).and_then(|parent| {
                let at = parent.children.iter().position(|id| *id == child)?;
                at.checked_sub(1).map(|previous| parent.children[previous])
            });
            self.note_reorder(parent_id, before, true);
        }
    }

    /// After `child` was put in its parent.
    pub(crate) fn list_linked(&mut self, child: u64) {
        let Some(element) = self.elements.get(&child) else { return };
        let Some(parent_id) = element.parent else { return };
        if self.list_markers.lists > 0 {
            self.list_markers.moved.push(child);
        }
        if is_list_item(element) {
            let before = self.elements.get(&parent_id).and_then(|parent| {
                let at = parent.children.iter().rposition(|id| *id == child)?;
                at.checked_sub(1).map(|previous| parent.children[previous])
            });
            self.note_reorder(parent_id, before, true);
        }
    }

    /// The `value` of `id` changed: the items after it count from it.
    pub(crate) fn list_value_changed(&mut self, id: u64) {
        let Some(element) = self.elements.get(&id) else { return };
        if element.element_type != "li" {
            return;
        }
        if let Some(parent) = element.parent {
            self.note_reorder(parent, Some(id), false);
        }
    }

    /// `start` or `reversed` of the list `id` changed: every item counts again.
    pub(crate) fn list_counting_changed(&mut self, id: u64) {
        if self.elements.get(&id).is_some_and(|element| element.element_type == "ol") {
            self.note_reorder(id, None, false);
        }
    }

    /// `id` became or stopped being a list item: the items after it count with or without it.
    pub(crate) fn list_item_changed(&mut self, id: u64) {
        if let Some(parent) = self.elements.get(&id).and_then(|element| element.parent) {
            self.note_reorder(parent, Some(id), true);
        }
    }

    /// The `list-style-type` or `list-style-position` that `id` declares changed: the items below it
    /// that inherit it show another marker.
    pub(crate) fn list_style_changed(&mut self, id: u64) {
        let mut pending: Vec<u64> = self.elements.get(&id).map(|element| element.children.clone()).unwrap_or_default();
        while let Some(current) = pending.pop() {
            let Some(element) = self.elements.get(&current) else { continue };
            pending.extend(element.children.iter().copied());
            if is_list_item(element) && !self.is_fresh(current) {
                self.mark_render_changed(current);
            }
        }
    }

    /// Styles the lists that came into or out of lists, and marks the items that were renumbered.
    /// Runs at the end of a batch.
    pub(crate) fn flush_list_markers(&mut self) {
        if self.list_markers.is_empty() {
            return;
        }
        let moved = std::mem::take(&mut self.list_markers.moved);
        let reordered = std::mem::take(&mut self.list_markers.reordered);
        self.restyle_moved_lists(moved);
        self.mark_reordered_items(reordered);
    }

    fn restyle_moved_lists(&mut self, moved: Vec<u64>) {
        let moved: FxHashSet<u64> = moved.into_iter().filter(|id| self.elements.contains_key(id)).collect();
        let tops: Vec<u64> = moved
            .iter()
            .copied()
            .filter(|id| {
                let mut ancestor = self.elements.get(id).and_then(|element| element.parent);
                while let Some(ancestor_id) = ancestor {
                    if moved.contains(&ancestor_id) {
                        return false;
                    }
                    ancestor = self.elements.get(&ancestor_id).and_then(|element| element.parent);
                }
                true
            })
            .collect();
        for top in tops {
            let mut pending = vec![top];
            while let Some(id) = pending.pop() {
                let Some(element) = self.elements.get(&id) else { continue };
                pending.extend(element.children.iter().copied());
                if crate::html::is_list(&element.element_type) {
                    self.restyle_list(id);
                }
            }
        }
    }

    fn mark_reordered_items(&mut self, reordered: Vec<Reorder>) {
        let mut from: FxHashMap<u64, usize> = FxHashMap::default();
        for note in reordered {
            let Some(parent) = self.elements.get(&note.parent) else { continue };
            let counts_down_from_the_end = note.membership && is_reversed(parent) && declared_start(parent).is_none();
            let start = match note.after {
                Some(after) if !counts_down_from_the_end => {
                    parent.children.iter().rposition(|id| *id == after).map_or(0, |at| at + 1)
                }
                _ => 0,
            };
            let first = from.entry(note.parent).or_insert(start);
            *first = (*first).min(start);
        }
        for (parent_id, start) in from {
            let Some(parent) = self.elements.get(&parent_id) else { continue };
            let renumbered: Vec<u64> = parent.children[start.min(parent.children.len())..]
                .iter()
                .copied()
                .filter(|id| {
                    !self.is_fresh(*id)
                        && self.elements.get(id).is_some_and(is_list_item)
                        && self.list_style_type_of(*id).is_ordinal()
                })
                .collect();
            for id in renumbered {
                self.mark_render_changed(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: u64 = 1;

    struct Doc {
        tree: RetainedTree,
        next: u64,
    }

    impl Doc {
        fn new() -> Doc {
            let mut tree = RetainedTree::new();
            tree.create_element(ROOT, "div".into());
            tree.set_root(ROOT);
            Doc { tree, next: 2 }
        }

        fn make(&mut self, tag: &str) -> u64 {
            let id = self.next;
            self.next += 1;
            self.tree.create_element(id, tag.into());
            id
        }

        fn element(&mut self, tag: &str, parent: u64) -> u64 {
            let id = self.make(tag);
            self.tree.append_child(parent, id);
            id
        }

        fn list(&mut self, tag: &str, items: usize) -> (u64, Vec<u64>) {
            let list = self.element(tag, ROOT);
            let items = (0..items).map(|_| self.element("li", list)).collect();
            (list, items)
        }

        fn style(&mut self, id: u64, json: &str) {
            let style = self.tree.styles.intern(json.as_bytes()).unwrap();
            self.tree.set_style(id, style);
        }

        fn prop(&mut self, id: u64, key: &str, value: serde_json::Value) {
            self.tree.set_custom_prop(id, key.into(), value);
        }

        /// The batch ends and a frame is drawn: what is marked after it is a change.
        fn frame(&mut self) {
            self.tree.flush_styles();
            self.tree.note_frame_built();
        }

        fn texts(&self, ids: &[u64]) -> Vec<Option<String>> {
            let mut ordinals = Ordinals::default();
            ids.iter().map(|id| marker_of(&self.tree, &mut ordinals, *id).map(|marker| marker.text)).collect()
        }

        fn revisions(&self, ids: &[u64]) -> Vec<u64> {
            ids.iter().map(|id| self.tree.elements[id].subtree_revision).collect()
        }

        /// Which of `ids` the batch since `before` marked.
        fn marked(&mut self, ids: &[u64], before: &[u64]) -> Vec<bool> {
            self.tree.flush_styles();
            self.revisions(ids).iter().zip(before).map(|(now, then)| now != then).collect()
        }

        fn lists_above_style(&self, id: u64) -> &crate::style::StyleDesc {
            self.tree.elements[&id].style.as_deref().expect("a list has a style")
        }

        fn has_block_margin(&self, id: u64) -> bool {
            self.lists_above_style(id).margin_top.as_ref().is_some_and(|margin| *margin != crate::style::DimensionValue::Pixels(0.0))
        }
    }

    fn texts(markers: &[&str]) -> Vec<Option<String>> {
        markers.iter().map(|text| Some((*text).to_string())).collect()
    }

    #[test]
    fn a_ul_has_discs_and_an_ol_numbers() {
        let mut doc = Doc::new();
        let (_, bullets) = doc.list("ul", 2);
        let (_, numbers) = doc.list("ol", 3);
        assert_eq!(doc.texts(&bullets), texts(&["\u{2022} ", "\u{2022} "]));
        assert_eq!(doc.texts(&numbers), texts(&["1. ", "2. ", "3. "]));
    }

    #[test]
    fn only_a_list_item_has_a_marker() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ul", 1);
        let div = doc.element("div", list);
        let other = doc.element("li", list);
        doc.style(other, r#"{"display":"block"}"#);
        let styled = doc.element("div", list);
        doc.style(styled, r#"{"display":"list-item"}"#);
        assert_eq!(doc.texts(&[items[0], div, other, styled]), vec![Some("\u{2022} ".into()), None, None, Some("\u{2022} ".into())]);
    }

    #[test]
    fn the_type_is_inherited_from_the_nearest_element_that_declares_one() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ul", 3);
        doc.style(list, r#"{"listStyleType":"square"}"#);
        doc.style(items[1], r#"{"listStyle":"upper-roman inside"}"#);
        doc.style(items[2], r#"{"listStyleType":"none"}"#);
        assert_eq!(doc.texts(&items), vec![Some("\u{25AA} ".into()), Some("II. ".into()), None]);
        assert_eq!(doc.tree.list_style_position_of(items[1]), ListStylePosition::Inside);
        assert_eq!(doc.tree.list_style_position_of(items[0]), ListStylePosition::Outside);
        let inside_list = doc.element("div", items[0]);
        let nested_item = doc.element("div", inside_list);
        doc.style(nested_item, r#"{"display":"list-item"}"#);
        assert_eq!(doc.texts(&[nested_item]), texts(&["\u{25AA} "]), "through a box that declares none");
    }

    #[test]
    fn a_wide_keyword_takes_the_parents_type_or_the_initial_one() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 2);
        doc.style(list, r#"{"listStyleType":"lower-alpha"}"#);
        doc.style(items[0], r#"{"listStyleType":"inherit"}"#);
        doc.style(items[1], r#"{"listStyle":"inside square","listStyleType":"initial"}"#);
        assert_eq!(doc.texts(&items), texts(&["a. ", "\u{2022} "]));
        assert_eq!(doc.tree.list_style_position_of(items[1]), ListStylePosition::Inside);
    }

    #[test]
    fn an_ol_counts_from_start_and_a_value_sets_the_count_the_items_after_it_continue() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 4);
        doc.prop(list, "start", serde_json::json!(5));
        assert_eq!(doc.texts(&items), texts(&["5. ", "6. ", "7. ", "8. "]));
        doc.prop(items[1], "value", serde_json::json!("20"));
        assert_eq!(doc.texts(&items), texts(&["5. ", "20. ", "21. ", "22. "]));
        doc.prop(list, "start", serde_json::json!("-1"));
        doc.prop(items[1], "value", serde_json::Value::Null);
        assert_eq!(doc.texts(&items), texts(&["-1. ", "0. ", "1. ", "2. "]));
        doc.prop(list, "start", serde_json::json!("x"));
        assert_eq!(doc.texts(&items), texts(&["1. ", "2. ", "3. ", "4. "]), "no integer is no start");
    }

    #[test]
    fn a_reversed_list_counts_down_from_its_item_count_or_its_start() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 3);
        doc.prop(list, "reversed", serde_json::json!(true));
        assert_eq!(doc.texts(&items), texts(&["3. ", "2. ", "1. "]));
        doc.prop(items[1], "value", serde_json::json!(10));
        assert_eq!(doc.texts(&items), texts(&["3. ", "10. ", "9. "]));
        doc.prop(items[1], "value", serde_json::Value::Null);
        doc.prop(list, "start", serde_json::json!(2));
        assert_eq!(doc.texts(&items), texts(&["2. ", "1. ", "0. "]));
        doc.prop(list, "reversed", serde_json::json!(""));
        assert_eq!(doc.texts(&items), texts(&["2. ", "1. ", "0. "]), "a present attribute is on whatever its text");
        doc.prop(list, "reversed", serde_json::json!(false));
        assert_eq!(doc.texts(&items), texts(&["2. ", "3. ", "4. "]));
    }

    #[test]
    fn start_and_reversed_are_the_ol_s_alone_and_value_the_li_s() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ul", 2);
        doc.style(list, r#"{"listStyleType":"decimal"}"#);
        doc.prop(list, "start", serde_json::json!(9));
        doc.prop(list, "reversed", serde_json::json!(true));
        assert_eq!(doc.texts(&items), texts(&["1. ", "2. "]));
        let rows = doc.element("ol", ROOT);
        let row = doc.element("div", rows);
        doc.style(row, r#"{"display":"list-item"}"#);
        doc.prop(row, "value", serde_json::json!(7));
        assert_eq!(doc.texts(&[row]), texts(&["1. "]));
    }

    #[test]
    fn items_that_are_not_list_items_are_not_counted() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 4);
        doc.style(items[1], r#"{"display":"none"}"#);
        doc.element("div", list);
        assert_eq!(doc.texts(&items), vec![Some("1. ".into()), None, Some("2. ".into()), Some("3. ".into())]);
    }

    #[test]
    fn the_counting_types_run_a_to_z_and_roman_to_3999() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 3);
        doc.prop(list, "start", serde_json::json!(26));
        doc.style(list, r#"{"listStyleType":"lower-latin"}"#);
        assert_eq!(doc.texts(&items), texts(&["z. ", "aa. ", "ab. "]));
        doc.prop(list, "start", serde_json::json!(3998));
        doc.style(list, r#"{"listStyleType":"upper-roman"}"#);
        assert_eq!(doc.texts(&items), texts(&["MMMCMXCVIII. ", "MMMCMXCIX. ", "4000. "]));
    }

    #[test]
    fn the_ordinals_of_a_list_are_counted_once() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 200);
        let mut ordinals = Ordinals::default();
        for item in &items {
            assert!(marker_of(&doc.tree, &mut ordinals, *item).is_some());
        }
        assert_eq!(ordinals.by_parent.len(), 1);
        assert_eq!(ordinals.by_parent[&list].len(), 200);
        assert_eq!(ordinals.by_parent[&list][&items[199]], 200);
    }

    #[test]
    fn a_list_inside_lists_has_no_block_margin_and_the_symbols_chrome_gives_it() {
        let mut doc = Doc::new();
        let (outer, items) = doc.list("ul", 1);
        let wrapper = doc.element("div", items[0]);
        let middle = doc.element("ul", wrapper);
        let middle_item = doc.element("li", middle);
        let inner = doc.element("ul", middle_item);
        let numbered = doc.element("ol", middle_item);
        doc.frame();
        let one = |doc: &Doc, id| (doc.lists_above_style(id).list_style_type, doc.lists_above_style(id).margin_top.clone());
        assert_eq!(doc.lists_above_style(outer).list_style_type, Some(ListStyleType::Disc));
        assert!(doc.has_block_margin(outer));
        assert_eq!(one(&doc, middle).0, Some(ListStyleType::Circle), "at any depth, not only a child");
        assert_eq!(one(&doc, middle).1, Some(crate::style::DimensionValue::Pixels(0.0)));
        assert_eq!(one(&doc, inner).0, Some(ListStyleType::Square));
        assert_eq!(one(&doc, numbered).0, Some(ListStyleType::Decimal), "an ol is decimal inside any list");
        assert_eq!(one(&doc, numbered).1, Some(crate::style::DimensionValue::Pixels(0.0)));
        assert_eq!(doc.texts(&[middle_item]), texts(&["\u{25E6} "]));
        let square_item = doc.element("li", inner);
        assert_eq!(doc.texts(&[square_item]), texts(&["\u{25AA} "]));
    }

    #[test]
    fn a_nested_list_follows_the_lists_around_it_when_it_moves() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ul", 1);
        let alone = doc.element("ul", ROOT);
        doc.frame();
        assert_eq!(doc.lists_above_style(alone).list_style_type, Some(ListStyleType::Disc));
        let holder = doc.element("div", ROOT);
        doc.tree.append_child(holder, alone);
        doc.frame();
        assert_eq!(doc.lists_above_style(alone).list_style_type, Some(ListStyleType::Disc), "a div is not a list");
        doc.tree.append_child(items[0], holder);
        doc.frame();
        assert_eq!(doc.lists_above_style(alone).list_style_type, Some(ListStyleType::Circle), "it comes in with its parent");
        doc.tree.append_child(ROOT, alone);
        doc.frame();
        assert_eq!(doc.lists_above_style(alone).list_style_type, Some(ListStyleType::Disc));
        assert!(doc.has_block_margin(alone));
        doc.tree.detach_child(items[0]);
        doc.tree.append_child(alone, items[0]);
        doc.frame();
        assert_eq!(doc.lists_above_style(alone).list_style_type, Some(ListStyleType::Disc));
    }

    #[test]
    fn what_the_author_declares_is_over_the_nested_user_agent_style() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ul", 1);
        let inner = doc.element("ul", items[0]);
        let item = doc.element("li", inner);
        doc.style(inner, r#"{"listStyleType":"disc","marginTop":8}"#);
        doc.frame();
        assert_eq!(doc.lists_above_style(inner).list_style_type, Some(ListStyleType::Disc));
        assert_eq!(doc.lists_above_style(inner).margin_top, Some(crate::style::DimensionValue::Pixels(8.0)));
        assert_eq!(doc.texts(&[item]), texts(&["\u{2022} "]));
        doc.style(inner, r#"{}"#);
        doc.frame();
        assert_eq!(doc.texts(&[item]), texts(&["\u{25E6} "]), "and the user agent's is back");
    }

    #[test]
    fn a_list_made_apart_is_styled_when_it_is_put_in() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ul", 1);
        let inner = doc.make("ul");
        let item = doc.make("li");
        doc.tree.append_child(inner, item);
        doc.tree.append_child(items[0], inner);
        doc.frame();
        assert_eq!(doc.texts(&[item]), texts(&["\u{25E6} "]));
    }

    #[test]
    fn an_item_that_comes_renumbers_the_ones_after_it_and_not_the_ones_before() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 4);
        doc.frame();
        let before = doc.revisions(&items);
        let added = doc.make("li");
        doc.tree.insert_before(list, added, items[2]);
        assert_eq!(doc.marked(&items, &before), vec![false, false, true, true]);
        assert_eq!(doc.texts(&[items[0], items[1], added, items[2], items[3]]), texts(&["1. ", "2. ", "3. ", "4. ", "5. "]));
    }

    #[test]
    fn appending_to_a_list_marks_no_other_item() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 3);
        doc.frame();
        let before = doc.revisions(&items);
        doc.element("li", list);
        assert_eq!(doc.marked(&items, &before), vec![false, false, false]);
    }

    #[test]
    fn an_item_that_goes_renumbers_the_ones_after_it() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ol", 4);
        doc.frame();
        let before = doc.revisions(&items);
        doc.tree.destroy_element(items[1]);
        let kept = [items[0], items[2], items[3]];
        assert_eq!(doc.marked(&kept, &[before[0], before[2], before[3]]), vec![false, true, true]);
        assert_eq!(doc.texts(&kept), texts(&["1. ", "2. ", "3. "]));

        let before = doc.revisions(&kept[1..]);
        doc.tree.detach_child(items[0]);
        assert_eq!(doc.marked(&kept[1..], &before), vec![true, true], "the first one leaving renumbers all that remain");
    }

    #[test]
    fn an_item_that_moves_is_marked_where_it_was_and_where_it_is() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 5);
        doc.frame();
        let before = doc.revisions(&items);
        doc.tree.insert_before(list, items[3], items[1]);
        assert_eq!(doc.marked(&items, &before), vec![false, true, true, true, true]);
        assert_eq!(doc.texts(&[items[0], items[3], items[1], items[2], items[4]]), texts(&["1. ", "2. ", "3. ", "4. ", "5. "]));

        let before = doc.revisions(&items);
        doc.tree.append_child(list, items[0]);
        assert_eq!(doc.marked(&items, &before), vec![true, true, true, true, true]);
    }

    #[test]
    fn an_item_that_moves_to_another_list_marks_both() {
        let mut doc = Doc::new();
        let (_, left) = doc.list("ol", 3);
        let (right_list, right) = doc.list("ol", 2);
        doc.frame();
        let ids: Vec<u64> = left.iter().chain(&right).copied().collect();
        let before = doc.revisions(&ids);
        doc.tree.insert_before(right_list, left[0], right[1]);
        assert_eq!(doc.marked(&ids, &before), vec![true, true, true, false, true]);
    }

    #[test]
    fn a_changed_value_marks_the_item_and_the_ones_after_it() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ol", 4);
        doc.frame();
        let before = doc.revisions(&items);
        doc.prop(items[1], "value", serde_json::json!(8));
        assert_eq!(doc.marked(&items, &before), vec![false, true, true, true]);
        let before = doc.revisions(&items);
        doc.prop(items[1], "value", serde_json::json!(8));
        assert_eq!(doc.marked(&items, &before), vec![false, false, false, false], "the same value is no change");
    }

    #[test]
    fn a_changed_start_or_reversed_marks_every_item() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 3);
        doc.frame();
        let before = doc.revisions(&items);
        doc.prop(list, "start", serde_json::json!(4));
        assert_eq!(doc.marked(&items, &before), vec![true, true, true]);
        let before = doc.revisions(&items);
        doc.prop(list, "reversed", serde_json::json!(true));
        assert_eq!(doc.marked(&items, &before), vec![true, true, true]);
    }

    #[test]
    fn a_reversed_list_without_a_start_renumbers_every_item_when_one_comes_or_goes() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ol", 3);
        doc.prop(list, "reversed", serde_json::json!(true));
        doc.frame();
        let before = doc.revisions(&items);
        doc.element("li", list);
        assert_eq!(doc.marked(&items, &before), vec![true, true, true], "an appended item makes every other one count down from more");
        let before = doc.revisions(&items);
        doc.tree.destroy_element(items[2]);
        assert_eq!(doc.marked(&items[..2], &before[..2]), vec![true, true]);

        doc.prop(list, "start", serde_json::json!(9));
        doc.frame();
        let before = doc.revisions(&items[..2]);
        doc.element("li", list);
        assert_eq!(doc.marked(&items[..2], &before), vec![false, false], "with a start, an appended item changes nothing before it");
    }

    #[test]
    fn a_change_of_type_on_the_list_marks_its_items_and_a_bullet_list_is_not_renumbered() {
        let mut doc = Doc::new();
        let (list, items) = doc.list("ul", 3);
        doc.frame();
        let before = doc.revisions(&items);
        let added = doc.make("li");
        doc.tree.insert_before(list, added, items[0]);
        assert_eq!(doc.marked(&items, &before), vec![false, false, false], "bullets do not depend on the siblings");

        let before = doc.revisions(&items);
        doc.style(list, r#"{"listStyleType":"decimal"}"#);
        assert_eq!(doc.marked(&items, &before), vec![true, true, true]);
        doc.frame();

        let before = doc.revisions(&items);
        doc.style(list, r#"{"listStyleType":"decimal","opacity":0.5}"#);
        assert_eq!(doc.marked(&items, &before), vec![false, false, false], "a style that leaves the markers alone");

        let before = doc.revisions(&items);
        doc.style(list, r#"{"listStyle":"inside decimal"}"#);
        assert_eq!(doc.marked(&items, &before), vec![true, true, true], "the position is part of the marker");
    }

    #[test]
    fn an_item_that_stops_being_a_list_item_renumbers_the_ones_after_it() {
        let mut doc = Doc::new();
        let (_, items) = doc.list("ol", 4);
        doc.frame();
        let before = doc.revisions(&items);
        doc.style(items[1], r#"{"display":"block"}"#);
        assert_eq!(doc.marked(&items, &before), vec![false, true, true, true]);
        assert_eq!(doc.texts(&items), vec![Some("1. ".into()), None, Some("2. ".into()), Some("3. ".into())]);
    }

    #[test]
    fn a_list_built_in_one_batch_marks_nothing_that_was_never_drawn() {
        let mut doc = Doc::new();
        doc.frame();
        let (list, items) = doc.list("ol", 50);
        let before = doc.revisions(&items);
        doc.prop(list, "reversed", serde_json::json!(true));
        let marked = doc.marked(&items, &before);
        assert!(marked.iter().all(|marked| !marked), "an element that was never drawn has no stale frame");
        assert_eq!(doc.texts(&items[..2]), texts(&["50. ", "49. "]));
    }

    #[test]
    fn integers_are_read_as_the_html_attribute_is() {
        let read = |value: serde_json::Value| integer_of(Some(&value));
        assert_eq!(read(serde_json::json!(3)), Some(3));
        assert_eq!(read(serde_json::json!(3.0)), Some(3));
        assert_eq!(read(serde_json::json!(" +4abc")), Some(4));
        assert_eq!(read(serde_json::json!("-12")), Some(-12));
        assert_eq!(read(serde_json::json!("")), None);
        assert_eq!(read(serde_json::json!("-")), None);
        assert_eq!(read(serde_json::json!("x1")), None);
        assert_eq!(read(serde_json::json!(true)), None);
        assert_eq!(read(serde_json::json!(4294967296i64)), None, "past 32 bits");
        assert_eq!(integer_of(None), None);
    }
}
