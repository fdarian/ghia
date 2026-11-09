//! A custom element that is the root of a virtual-list row is built unlifted (`CustomRenderContext::lift_absorbed`),
//! whatever its style and the focus variants laid over it make of its lift. The elements that are built by
//! `custom_surface` (`<markdown>`, `<code>`, `<diff>`, `<webview>`, `<svg>`, the `<img>` fallback and blank) are
//! not recorded as retained, so no frame asserts their lift: this does.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use gpui::{InteractiveElement as _, Styled as _};

use super::{custom_surface, CustomRenderContext};
use crate::color::{ColorContext, Scheme};
use crate::css::length::LengthContext;
use crate::focus::FocusStyles;
use crate::retained_tree::RetainedTree;
use crate::style::StyleDesc;

const ID: u64 = 3;

/// The lift of the root `custom_surface` builds of an element with `style`, while `ID` is focused inside.
fn lift_of_surface(style: &str, lift_absorbed: bool) -> Option<i32> {
    let style: StyleDesc = serde_json::from_str(style).unwrap();
    let colors = ColorContext::root(Scheme::Light);
    let lengths = LengthContext::for_tests();
    let events = HashSet::new();
    let callback = None;
    let activation = crate::events::activation::Activation {
        tree: Arc::new(Mutex::new(RetainedTree::new())),
        callback: None,
        routing: Default::default(),
    };
    let props = HashMap::new();
    let ctx = CustomRenderContext {
        id: ID,
        doc_path: Default::default(),
        events: &events,
        event_callback: &callback,
        focus_handle: None,
        click_path: Vec::new(),
        activation: &activation,
        focus_styles: FocusStyles { within: Arc::from([ID]), ..Default::default() },
        style: Some(&style),
        colors,
        lengths,
        font_features: None,
        font_variations: None,
        children: Vec::new(),
        svg_markup: None,
        shapes_run: false,
        cull_outset: None,
        selection: Default::default(),
        selectable: true,
        inert: false,
        selection_wash: gpui::transparent_black(),
        highlight_set: None,
        props: &props,
        pointer_events_none: false,
        app_region: None,
        stacking_root: true,
        lift_absorbed,
        resolved: crate::resolved_style::Resolved::UNSTYLED,
    };
    custom_surface(gpui::div().id("surface"), &ctx).style().lift_z()
}

const LIFTING_STYLES: [&str; 5] = [
    r#"{"position": "relative"}"#,
    r#"{"position": "relative", "zIndex": 1}"#,
    r#"{"opacity": 0.6}"#,
    r#"{"transform": "translateX(2px)"}"#,
    // A focus variant lifts a static element, and the element is focused within.
    r#"{"focusWithin": {"position": "relative", "zIndex": 4}}"#,
];

#[test]
fn the_surface_of_a_row_root_is_unlifted_whatever_lifts_its_style() {
    for style in LIFTING_STYLES {
        assert_eq!(lift_of_surface(style, true), None, "{style}");
    }
}

#[test]
fn the_surface_of_an_element_that_is_no_row_root_lifts() {
    for style in LIFTING_STYLES {
        assert!(lift_of_surface(style, false).is_some(), "{style}");
    }
}
