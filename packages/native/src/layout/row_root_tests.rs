//! The root of a virtual-list row is built unlifted, whatever element it is (`stacking::absorb_lift`).
//!
//! gpui asserts, in a debug build, that the root of a retained subtree is lifted as the node that was
//! recorded for it says (`Retained`'s `request_subtree_layout`), and the record of a row root says it does not
//! lift. So each test draws a list whose rows are one kind of element with a style that would lift it, and a
//! row root that lifts anyway fails the draw.

use std::sync::{Arc, Mutex};

use gpui::AppContext as _;

use crate::events::state::PointerRequests;
use crate::renderer::GpuixView;
use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;
use crate::text::SharedSelection;

const LIST: u64 = 2;
const ROW: u64 = 3;

/// Each of these lifts an element that is not the root of a row.
const LIFTING_STYLES: [&str; 5] = [
    r#"{"height": 40, "position": "relative"}"#,
    r#"{"height": 40, "position": "relative", "zIndex": 1}"#,
    r#"{"height": 40, "opacity": 0.6}"#,
    r#"{"height": 40, "transform": "translateX(2px)"}"#,
    r#"{"height": 40, "position": "sticky", "top": 0}"#,
];

/// A 1x1 PNG, which an `<img>` decodes and draws as a leaf.
const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

struct Page {
    tree: Arc<Mutex<RetainedTree>>,
    window: gpui::WindowHandle<GpuixView>,
}

impl Page {
    /// A list in a root, with one row: an element of `element_type` with `props` and `style`.
    fn new(cx: &mut gpui::TestAppContext, element_type: &str, style: &str, props: &[(&str, serde_json::Value)]) -> Self {
        let tree = Arc::new(Mutex::new(RetainedTree::new()));
        {
            let mut tree = tree.lock().unwrap();
            let mut create = |id: u64, element_type: &str, style: &str, parent: Option<u64>| {
                let style: StyleDesc = serde_json::from_str(style).unwrap();
                tree.create_element(id, element_type.to_owned());
                tree.set_style_desc(id, style);
                if let Some(parent) = parent {
                    tree.append_child(parent, id);
                }
            };
            create(1, "div", r#"{"width": 400, "height": 400}"#, None);
            create(LIST, "virtual-list", r#"{"height": 300}"#, Some(1));
            create(ROW, element_type, style, Some(LIST));
            for (key, value) in props {
                tree.set_custom_prop(ROW, (*key).to_owned(), value.clone());
            }
            tree.set_root(1);
        }
        let view_tree = tree.clone();
        let window = cx.add_window(|window, _| {
            crate::events::enable_dom_hit_testing(window);
            crate::layout::container::allow_redraw_passes(window);
            let mut view = GpuixView::new(
                view_tree,
                None,
                "test".to_owned(),
                SharedSelection::default(),
                PointerRequests::default(),
            );
            // A row root is handed to gpui as a retained subtree only when the frame plans what it keeps.
            view.retain.set_planning(true);
            view.clock.pause();
            view
        });
        let page = Self { tree, window };
        page.draw(cx);
        page
    }

    fn draw(&self, cx: &mut gpui::TestAppContext) {
        cx.update_window(self.window.into(), |_, window, app| {
            window.refresh();
            window.draw(app).clear(app);
        })
        .unwrap();
        let mismatches = self.window.update(cx, |view, _, _| view.retain.mismatches().to_vec()).unwrap();
        assert!(mismatches.is_empty(), "{mismatches:?}");
    }

    fn assert_row_was_painted(&self) {
        assert!(
            crate::automation::get_bounds(self.window.window_id(), ROW).is_some(),
            "the row root was not painted"
        );
    }
}

/// Draws a list of one row of `element_type` for every style that lifts.
fn assert_unlifted_in_every_style(cx: &mut gpui::TestAppContext, element_type: &str, props: &[(&str, serde_json::Value)]) {
    for style in LIFTING_STYLES {
        Page::new(cx, element_type, style, props).assert_row_was_painted();
    }
}

#[gpui::test]
fn a_div_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "div", &[]);
}

#[gpui::test]
fn an_img_row_root_that_has_a_picture_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "img", &[("src", serde_json::json!(PNG))]);
}

#[gpui::test]
fn an_img_row_root_that_is_blank_or_failed_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "img", &[("src", serde_json::json!("blob:pending"))]);
    assert_unlifted_in_every_style(cx, "img", &[]);
}

#[gpui::test]
fn an_input_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "input", &[("value", serde_json::json!("a"))]);
    assert_unlifted_in_every_style(cx, "textarea", &[("value", serde_json::json!("a"))]);
}

#[gpui::test]
fn a_markdown_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "markdown", &[("source", serde_json::json!("# a"))]);
}

#[gpui::test]
fn a_code_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "code", &[("code", serde_json::json!("a\nb"))]);
}

#[gpui::test]
fn a_diff_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "diff", &[]);
}

#[gpui::test]
fn an_svg_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "svg", &[]);
}

#[gpui::test]
fn a_nested_virtual_list_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "virtual-list", &[]);
}

#[gpui::test]
fn an_anchored_row_root_is_unlifted(cx: &mut gpui::TestAppContext) {
    assert_unlifted_in_every_style(cx, "anchored", &[]);
}

/// A focus variant is laid over the element as it is built and decides the lift again from the style it
/// folds, so the row root says `unlifted()` after it.
#[gpui::test]
fn a_div_row_root_with_a_focus_variant_that_lifts_stays_unlifted(cx: &mut gpui::TestAppContext) {
    for variant in ["focusVisible", "focusWithin"] {
        let style = format!(r#"{{"height": 40, "{variant}": {{"position": "relative", "zIndex": 4}}}}"#);
        let page = Page::new(cx, "div", &style, &[]);
        page.tree.lock().unwrap().set_custom_prop(ROW, "tabIndex".to_owned(), serde_json::json!(0));
        page.draw(cx);
        page.window.update(cx, |_, window, _| window.activate_window()).unwrap();
        cx.run_until_parked();
        page.window.update(cx, |view, window, cx| view.request_focus(ROW, window, cx)).unwrap();
        page.draw(cx);
        page.draw(cx);
        page.assert_row_was_painted();
    }
}

#[gpui::test]
fn an_input_row_root_with_a_focus_variant_that_lifts_stays_unlifted(cx: &mut gpui::TestAppContext) {
    let style = r#"{"height": 40, "focusVisible": {"position": "relative", "zIndex": 4}}"#;
    let page = Page::new(cx, "input", style, &[("value", serde_json::json!("a"))]);
    page.window.update(cx, |_, window, _| window.activate_window()).unwrap();
    cx.run_until_parked();
    page.window.update(cx, |view, window, cx| view.request_focus(ROW, window, cx)).unwrap();
    page.draw(cx);
    page.draw(cx);
    page.assert_row_was_painted();
}
