//! The sizes a virtual list declares for its rows (zed `ListState::set_exact_item_size`).
//!
//! The list measures a row it does not show by building it and laying it out in a scratch frame
//! that is thrown away, and builds it again when it comes into view. A row whose root style fixes
//! its border box leaves nothing to measure, so the list is told the box and builds the row once,
//! where it shows. What the list asks is the box a layout of the row would find, to the digit: a
//! row is declared only when the style alone says it, and the list checks the declaration of every
//! row it lays out (`ListMeasureCounters::exact_size_mismatches`, a debug assertion).
//!
//! The box is the border box of a `div` laid out in a block of the list's width: a height in px
//! (never below its padding and border, which Ghia counts inside the height), and a width that is
//! either in px or fills the list less the horizontal margins. Vertical margins are not part of the
//! box a root is measured at. Anything a style or the build could move at another time, whatever
//! its state, is not declared: the row is measured by layout, as before.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use crate::color::{ColorContext, Scheme};
use crate::retained_tree::RetainedElement;
use crate::style::{DimensionValue, StyleDesc};

/// Off with `GPUIX_LIST_SIZES_OFF`, or `set_enabled(false)` of the test renderer, which measure and
/// compare lists that declare nothing. Read at every ask, so a list made before it is off too.
/// Chrome's `LayoutUnit`, the same constant as gpui's `util::LAYOUT_UNIT`, which is not public.
const LAYOUT_UNIT: f32 = 1.0 / 64.0;

static ENABLED: LazyLock<AtomicBool> =
    LazyLock::new(|| AtomicBool::new(std::env::var_os("GPUIX_LIST_SIZES_OFF").is_none()));

pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// What a row root declares, in the px of its style. The border widths wait for the scale of the
/// window, which snaps them to whole device pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RowBox {
    height: f32,
    width: RowWidth,
    padding: [f32; 4],
    border: [f32; 4],
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum RowWidth {
    Px(f32),
    /// `auto` on a block: what is left of the list's width after the horizontal margins.
    Fill { margins: [f32; 2] },
}

impl RowBox {
    /// `None` for a row that is not declared. `focusable` says the row sits in the `div` that holds
    /// its focus handle, which is a box of its own around the root.
    pub(crate) fn of(element: &RetainedElement, focusable: bool) -> Option<Self> {
        if focusable || element.element_type != "div" {
            return None;
        }
        let props = element.custom_props();
        if ["motion", "motionValues", "layout"].into_iter().any(|key| props.contains_key(key)) {
            return None;
        }
        let style = element.style.as_deref()?;
        if !declares_the_box_alone(style) {
            return None;
        }
        let height = px(style.height.as_ref()?)?;
        let width = match style.width.as_ref() {
            // A flex or grid container with no width is as wide as its content when it is a root.
            None | Some(DimensionValue::Auto) if matches!(style.display.as_deref(), None | Some("block" | "flow-root")) => {
                let margins = style.margin_below_longhands();
                let side = |longhand: &Option<DimensionValue>, shorthand: &Option<DimensionValue>| {
                    longhand.as_ref().or(shorthand.as_ref()).map_or(Some(0.0), px)
                };
                RowWidth::Fill { margins: [side(&style.margin_left, &margins.left)?, side(&style.margin_right, &margins.right)?] }
            }
            Some(width) => RowWidth::Px(px(width)?),
            None => return None,
        };
        let padding = style.padding_below_longhands();
        let padding_side = |longhand: &Option<crate::css::length::LinearLength>, shorthand: &Option<crate::css::length::LinearLength>| {
            longhand.as_ref().or(shorthand.as_ref()).map_or(Some(0.0), |length| length.as_px().map(|px| px as f32))
        };
        let padding = [
            padding_side(&style.padding_top, &padding.top)?,
            padding_side(&style.padding_right, &padding.right)?,
            padding_side(&style.padding_bottom, &padding.bottom)?,
            padding_side(&style.padding_left, &padding.left)?,
        ];
        let border = crate::css::border::used_px_widths(style, &ColorContext::root(Scheme::Light))?;
        Some(Self { height, width, padding, border })
    }

    /// The border box at a window of `scale`, with the list laying its rows out `available_width` wide.
    /// Layout cuts each length to 1/64 of a device pixel (zed `truncate_to_layout_unit`) and sums them
    /// in device pixels, so that is what is summed here.
    fn size(&self, available_width: Option<gpui::Pixels>, scale: f32) -> Option<gpui::Size<gpui::Pixels>> {
        let device = |length: f32| ((length * scale) / LAYOUT_UNIT).trunc() * LAYOUT_UNIT;
        let border = self.border.map(|width| crate::layout::collapse::snap(width, scale) * scale);
        let padding = self.padding.map(device);
        let vertical = padding[0] + padding[2] + border[0] + border[2];
        let horizontal = padding[1] + padding[3] + border[1] + border[3];
        let width = match self.width {
            RowWidth::Px(width) => device(width),
            RowWidth::Fill { margins } => f32::from(available_width?) * scale - margins.map(device).iter().sum::<f32>(),
        };
        let height = device(self.height);
        Some(gpui::size(gpui::px(width.max(horizontal) / scale), gpui::px(height.max(vertical) / scale)))
    }
}

/// A length that is a definite number of px and nothing else.
fn px(value: &DimensionValue) -> Option<f32> {
    match value {
        DimensionValue::Pixels(px) if px.is_finite() && *px >= 0.0 => Some(*px as f32),
        _ => None,
    }
}

/// Nothing in `style`, in any state, can give the border box another size than its own height,
/// width, padding and border: a `div` that is a block, flex or grid container in the flow, with no
/// bound, ratio, query block, state style or motion that touches the box.
fn declares_the_box_alone(style: &StyleDesc) -> bool {
    let unbounded = |value: &Option<DimensionValue>| matches!(value, None | Some(DimensionValue::Auto));
    matches!(style.display.as_deref(), None | Some("block" | "flex" | "grid" | "flow-root"))
        && matches!(style.position.as_deref(), None | Some("relative" | "static"))
        && unbounded(&style.min_width)
        && unbounded(&style.max_width)
        && unbounded(&style.min_height)
        && unbounded(&style.max_height)
        && style.aspect_ratio.is_none()
        && style.container_rules.is_none()
        && paints_in_every_state(style)
        && crate::motion::leaves_box_size(style)
}

/// A state style that sets anything but what paints would change the box while it applies.
fn paints_in_every_state(style: &StyleDesc) -> bool {
    let nothing = StyleDesc::default();
    [
        &style.hover,
        &style.active,
        &style.focus_visible,
        &style.focus_within,
        &style.group_hover,
        &style.group_active,
        &style.group_focus_within,
        &style.has_hover,
        &style.has_active,
        &style.has_focus,
        &style.has_focus_visible,
        &style.disabled,
        &style.enabled,
        &style.has_disabled,
        &style.has_enabled,
    ]
    .into_iter()
    .all(|state| state.as_deref().is_none_or(|state| nothing.differs_only_in_paint(state)))
}

/// What the callback of one list reads: the rows of its window and the scale of the window.
#[derive(Default)]
pub(crate) struct DeclaredSizes {
    window_start: Cell<usize>,
    rows: RefCell<Vec<Option<RowBox>>>,
    scale: Cell<Option<f32>>,
}

impl DeclaredSizes {
    pub(crate) fn declare(&self, window_start: usize, rows: Vec<Option<RowBox>>) {
        self.window_start.set(window_start);
        *self.rows.borrow_mut() = rows;
    }

    /// Read at every build of the list: the borders snap to the device pixels of the window the
    /// rows are laid out in.
    pub(crate) fn set_scale(&self, scale: f32) {
        self.scale.set(Some(scale));
    }

    /// Tells `state` to ask these, which stay current as they are declared again.
    pub(crate) fn install(self: &Rc<Self>, state: &gpui::ListState) {
        let sizes = Rc::clone(self);
        state.set_exact_item_size(move |index, width| sizes.size(index, width));
    }

    fn size(&self, index: usize, available_width: Option<gpui::Pixels>) -> Option<gpui::Size<gpui::Pixels>> {
        if !ENABLED.load(Ordering::Relaxed) {
            return None;
        }
        let offset = index.checked_sub(self.window_start.get())?;
        let rows = self.rows.borrow();
        rows.get(offset)?.as_ref()?.size(available_width, self.scale.get()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retained_tree::RetainedTree;
    use std::sync::Arc;

    fn row(element_type: &str, style: &str) -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, element_type.to_string());
        tree.set_style(1, Arc::new(serde_json::from_str(style).expect("a style")));
        tree
    }

    fn declared(style: &str, width: Option<f32>, scale: f32) -> Option<(f32, f32)> {
        let tree = row("div", style);
        let size = RowBox::of(&tree.elements[&1], false)?.size(width.map(gpui::px), scale)?;
        Some((f32::from(size.width), f32::from(size.height)))
    }

    #[test]
    fn a_height_in_px_fills_the_width_of_the_list() {
        assert_eq!(declared(r#"{"height":40}"#, Some(300.0), 1.0), Some((300.0, 40.0)));
        assert_eq!(declared(r#"{"height":"40px","position":"relative"}"#, Some(300.0), 1.0), Some((300.0, 40.0)));
        assert_eq!(declared(r#"{"height":40,"display":"block"}"#, Some(300.0), 2.0), Some((300.0, 40.0)));
        assert_eq!(declared(r#"{"height":40,"display":"flex","width":120}"#, Some(300.0), 2.0), Some((120.0, 40.0)));
    }

    #[test]
    fn a_flex_or_grid_root_with_no_width_is_as_wide_as_its_content() {
        assert_eq!(declared(r#"{"height":40,"display":"flex"}"#, Some(300.0), 1.0), None);
        assert_eq!(declared(r#"{"height":40,"display":"grid"}"#, Some(300.0), 1.0), None);
    }

    #[test]
    fn each_length_is_cut_to_a_64th_of_a_device_pixel() {
        assert_eq!(declared(r#"{"height":20.37}"#, Some(300.0), 1.0), Some((300.0, 20.359375)));
        assert_eq!(declared(r#"{"height":20.37}"#, Some(300.0), 2.0), Some((300.0, 20.3671875)));
        assert_eq!(declared(r#"{"height":0,"paddingTop":0.37,"paddingBottom":0.37}"#, Some(300.0), 1.0), Some((300.0, 0.71875)));
    }

    #[test]
    fn a_list_that_sizes_to_its_widest_row_has_no_width_to_fill() {
        assert_eq!(declared(r#"{"height":40}"#, None, 1.0), None);
        assert_eq!(declared(r#"{"height":40,"width":120}"#, None, 1.0), Some((120.0, 40.0)));
    }

    #[test]
    fn horizontal_margins_come_off_the_width_and_vertical_ones_are_not_in_the_box() {
        assert_eq!(
            declared(r#"{"height":40,"margin":"7px 5px 9px 3px"}"#, Some(300.0), 1.0),
            Some((292.0, 40.0))
        );
        assert_eq!(declared(r#"{"height":40,"marginTop":12,"marginBottom":12}"#, Some(300.0), 1.0), Some((300.0, 40.0)));
        assert_eq!(declared(r#"{"height":40,"marginLeft":"auto"}"#, Some(300.0), 1.0), None);
        assert_eq!(declared(r#"{"height":40,"marginLeft":"10%"}"#, Some(300.0), 1.0), None);
        assert_eq!(declared(r#"{"height":40,"marginLeft":-4}"#, Some(300.0), 1.0), None);
    }

    #[test]
    fn padding_and_border_are_inside_the_height_and_a_floor_of_it() {
        assert_eq!(declared(r#"{"height":40,"padding":8,"borderBottom":"1px solid #eee"}"#, Some(300.0), 1.0), Some((300.0, 40.0)));
        assert_eq!(declared(r#"{"height":10,"paddingTop":8,"paddingBottom":8}"#, Some(300.0), 1.0), Some((300.0, 16.0)));
        assert_eq!(declared(r#"{"height":4,"border":"3px solid red"}"#, Some(300.0), 1.0), Some((300.0, 6.0)));
        assert_eq!(declared(r#"{"height":10,"width":10,"paddingLeft":6,"paddingRight":6}"#, Some(300.0), 1.0), Some((12.0, 10.0)));
    }

    #[test]
    fn a_border_is_snapped_to_the_device_pixels_of_the_window() {
        assert_eq!(declared(r#"{"height":0,"borderTop":"0.4px solid red"}"#, Some(300.0), 1.0), Some((300.0, 1.0)));
        assert_eq!(declared(r#"{"height":0,"borderTop":"0.4px solid red"}"#, Some(300.0), 2.0), Some((300.0, 0.5)));
        assert_eq!(declared(r#"{"height":0,"borderTop":"1.5px solid red"}"#, Some(300.0), 2.0), Some((300.0, 1.5)));
        assert_eq!(declared(r#"{"height":0,"borderTop":"1.5px solid red"}"#, Some(300.0), 1.0), Some((300.0, 1.0)));
        assert_eq!(declared(r#"{"height":0,"borderTop":"4px none red"}"#, Some(300.0), 1.0), Some((300.0, 0.0)));
    }

    #[test]
    fn a_style_that_leaves_the_box_to_layout_declares_nothing() {
        for style in [
            r#"{}"#,
            r#"{"height":"50%"}"#,
            r#"{"height":"auto"}"#,
            r#"{"height":"2em"}"#,
            r#"{"height":"10vh"}"#,
            r#"{"height":"calc(100% - 4px)"}"#,
            r#"{"height":"fit-content"}"#,
            r#"{"height":40,"minHeight":50}"#,
            r#"{"height":40,"minHeight":0}"#,
            r#"{"height":40,"maxHeight":50}"#,
            r#"{"height":40,"minWidth":10}"#,
            r#"{"height":40,"maxWidth":"100%"}"#,
            r#"{"height":40,"aspectRatio":2}"#,
            r#"{"height":40,"width":"50%"}"#,
            r#"{"height":40,"padding":"1em"}"#,
            r#"{"height":40,"padding":"5%"}"#,
            r#"{"height":40,"borderBottom":"1em solid red"}"#,
            r#"{"height":40,"position":"absolute"}"#,
            r#"{"height":40,"position":"fixed"}"#,
            r#"{"height":40,"display":"none"}"#,
            r#"{"height":40,"display":"contents"}"#,
            r#"{"height":40,"display":"table"}"#,
            r#"{"height":40,"display":"inline-block"}"#,
            r#"{"height":40,"hover":{"height":60}}"#,
            r#"{"height":40,"hover":{"padding":10}}"#,
            r#"{"height":40,"focusVisible":{"borderWidth":2,"borderStyle":"solid"}}"#,
            r#"{"height":40,"groupHover":{"display":"none"}}"#,
            r#"{"height":40,"transition":"height 0.2s"}"#,
            r#"{"height":40,"transition":"all 0.2s"}"#,
            r#"{"height":40,"transitionProperty":"padding-top","transitionDuration":"1s"}"#,
            r#"{"height":40,"hover":{"backgroundColor":"red","transition":"height 1s"}}"#,
            r#"{"height":40,"animation":"grow 1s"}"#,
            r#"{"height":40,"@container":{"(min-width: 10px)":{"height":10}}}"#,
        ] {
            assert_eq!(declared(style, Some(300.0), 1.0), None, "{style}");
        }
    }

    #[test]
    fn a_style_that_only_paints_in_its_states_and_transitions_declares() {
        for style in [
            r##"{"height":40,"hover":{"backgroundColor":"#eee"}}"##,
            r##"{"height":40,"hover":{"backgroundColor":"#eee","boxShadow":"0 0 2px red","opacity":0.5},"active":{"color":"red"}}"##,
            r##"{"height":40,"transition":"background-color 0.2s, color 0.2s","hover":{"backgroundColor":"#eee"}}"##,
            r##"{"height":40,"transition":"opacity 0.2s ease","userSelect":"none","cursor":"pointer"}"##,
        ] {
            assert_eq!(declared(style, Some(300.0), 1.0), Some((300.0, 40.0)), "{style}");
        }
    }

    #[test]
    fn only_a_div_in_no_motion_and_with_no_focus_wrapper_declares() {
        let tree = row("div", r#"{"height":40}"#);
        assert!(RowBox::of(&tree.elements[&1], false).is_some());
        assert!(RowBox::of(&tree.elements[&1], true).is_none());
        for kind in ["text", "img", "input", "virtual-list", "button"] {
            let tree = row(kind, r#"{"height":40}"#);
            assert!(RowBox::of(&tree.elements[&1], false).is_none(), "{kind}");
        }
        for key in ["motion", "motionValues", "layout"] {
            let mut tree = row("div", r#"{"height":40}"#);
            tree.set_custom_prop(1, key.to_string(), serde_json::json!({}));
            assert!(RowBox::of(&tree.elements[&1], false).is_none(), "{key}");
        }
        let no_style = {
            let mut tree = RetainedTree::new();
            tree.create_element(1, "div".to_string());
            tree
        };
        assert!(RowBox::of(&no_style.elements[&1], false).is_none());
    }

    #[test]
    fn the_list_asks_for_the_rows_of_its_window_and_only_those() {
        let sizes = DeclaredSizes::default();
        let tree = row("div", r#"{"height":40}"#);
        let one = RowBox::of(&tree.elements[&1], false);
        sizes.declare(10, vec![one, None, one]);
        let width = Some(gpui::px(100.0));
        assert_eq!(sizes.size(10, width), None, "before the window has a scale");
        sizes.set_scale(2.0);
        assert_eq!(sizes.size(9, width), None);
        assert_eq!(sizes.size(10, width), Some(gpui::size(gpui::px(100.0), gpui::px(40.0))));
        assert_eq!(sizes.size(11, width), None);
        assert_eq!(sizes.size(12, width), Some(gpui::size(gpui::px(100.0), gpui::px(40.0))));
        assert_eq!(sizes.size(13, width), None);
    }
}
