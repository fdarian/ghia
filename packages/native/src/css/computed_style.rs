//! `getComputedStyle`: the values Chrome's resolved style reports for the properties web libraries
//! read, worked out for one element when it is asked.
//!
//! Nothing here is stored per element. The element's style is resolved the way a build of the
//! frame resolves it (state styles, CSS transitions, `motion`, motion values and CSS animations at
//! the instant of the read, `renderer::style_at_read`), on top of the inherited values that the
//! build walks down from the root (`Inherited::descend`). Lengths that depend on layout are the
//! used px of the laid-out box, as Chrome's resolved values are, and an element with no box
//! reports its computed values.
//!
//! The result is a flat list `[name, value, name, value, ...]` with the names in kebab case.

use gpui::{Pixels, Size};

use crate::automation::ElementBounds;
use crate::css::length::{LengthContext, LinearLength};
use crate::css::syntax::{split_commas, split_whitespace};
use crate::motion::text::{length as length_text, pixels, six_digits};
use crate::renderer::{BuildCtx, Inherited};
use crate::retained_tree::RetainedElement;
use crate::style::{DimensionValue, StyleDesc};

/// The laid-out boxes a read needs, taken right after the window was laid out.
pub(crate) struct Boxes {
    pub own: Option<ElementBounds>,
    pub parent: Option<ElementBounds>,
}

impl Boxes {
    pub(crate) fn read(window: gpui::WindowId, id: u64, parent: Option<u64>) -> Self {
        Self {
            own: crate::automation::get_bounds(window, id),
            parent: parent.and_then(|parent| crate::automation::get_bounds(window, parent)),
        }
    }
}

/// What the parent of the element being read decides for it.
#[derive(Default)]
struct ParentFacts {
    /// The parent lays its children out as flex or grid items, which blockifies their `display` and
    /// makes their `z-index` apply without a `position`.
    lays_out_items: bool,
}

/// Whether `id` is under the window's root, and so is in the document.
pub(crate) fn is_connected(tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
    let mut current = Some(id);
    while let Some(id) = current {
        let Some(element) = tree.elements.get(&id) else { return false };
        if element.parent.is_none() {
            return tree.root_id == Some(id);
        }
        current = element.parent;
    }
    false
}

/// The values of every property of the set for element `id`, or `None` when it is not in the
/// document. `pseudo` asks for a `::before` or `::after` the element does not have, which Chrome
/// reports with the values it inherits and the initial value of every other property.
pub(crate) fn read(
    ctx: &mut BuildCtx,
    window: &mut gpui::Window,
    id: u64,
    boxes: &Boxes,
    pseudo: bool,
) -> Option<Vec<String>> {
    let tree = ctx.tree;
    if !is_connected(tree, id) {
        return None;
    }
    let element = tree.elements.get(&id)?;
    let chain = crate::layout::content_visibility::ancestors_of(tree, id);
    let parent = enter_ancestors(ctx, &chain);
    let style = if pseudo { StyleDesc::default() } else { crate::renderer::style_at_read(ctx, window, element) };
    let own = ctx.inherited.clone().descend(Some(&style), element.has_inert_prop());
    let vars = crate::css::transform::resolve_vars(&style, &own.custom);
    let style = vars.as_ref().unwrap_or(&style);
    let rtl = own.direction.direction.is_rtl();
    let mirrored = rtl.then(|| style.mirrored_inline_pairs()).flatten();
    let style = mirrored.as_ref().unwrap_or(style);
    let view = View {
        element,
        style,
        own: &own,
        boxes,
        pseudo,
        parent: &parent,
        rtl,
        no_box: pseudo || crate::layout::box_generation::is_display_none(element) || boxes.own.is_none(),
        viewport_width: ctx.inherited.lengths.viewport_width,
    };
    Some(view.values())
}

/// Takes `ctx.inherited` down the ancestors of the element, as the build of the frame does, and
/// says what the last of them decides for it. An ancestor's own transitions and animations are
/// not run: only what they leave for the inherited values (a `font-size` in motion) would differ.
fn enter_ancestors(ctx: &mut BuildCtx, chain: &[u64]) -> ParentFacts {
    let mut parent = ParentFacts::default();
    for id in chain {
        let element = ctx.tree.elements.get(id).expect("an ancestor of an element in the tree is in the tree");
        let declared = element.style.as_deref();
        let inert = element.has_inert_prop();
        let pointer_states = declared.map(|style| ctx.pointer_states(*id, style, inert)).unwrap_or_default();
        let stated = declared
            .filter(|_| pointer_states.any())
            .map(|style| crate::events::state_styles::resolve_pointer_states(style, pointer_states));
        let base = stated.as_ref().or(declared);
        let focused = base.map(|style| ctx.focus_styles.folded(*id, style, ctx.focus_handles.contains_key(id)));
        let style = focused.as_deref();
        parent.lays_out_items = crate::layout::display::lays_out_items(style.and_then(|style| style.display.as_deref()));
        ctx.inherited = ctx.inherited.clone().descend(style, inert);
    }
    parent
}

struct View<'a> {
    element: &'a RetainedElement,
    style: &'a StyleDesc,
    own: &'a Inherited,
    boxes: &'a Boxes,
    pseudo: bool,
    parent: &'a ParentFacts,
    rtl: bool,
    no_box: bool,
    viewport_width: f64,
}

struct Out(Vec<String>);

impl Out {
    fn push(&mut self, name: &str, value: String) {
        self.0.push(name.to_string());
        self.0.push(value);
    }
}

#[derive(Clone, Copy)]
enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

impl Side {
    const ALL: [Side; 4] = [Side::Top, Side::Right, Side::Bottom, Side::Left];

    fn name(self) -> &'static str {
        match self {
            Side::Top => "top",
            Side::Right => "right",
            Side::Bottom => "bottom",
            Side::Left => "left",
        }
    }
}

/// The physical sides the logical ones are.
struct Ends {
    inline_start: Side,
    inline_end: Side,
}

impl Ends {
    /// Pushes `<prefix>-<side><suffix>` for the four sides and the four logical ones.
    fn push(&self, out: &mut Out, prefix: &str, suffix: &str, text: &dyn Fn(Side) -> String) {
        for side in Side::ALL {
            out.push(&format!("{prefix}-{}{suffix}", side.name()), text(side));
        }
        out.push(&format!("{prefix}-inline-start{suffix}"), text(self.inline_start));
        out.push(&format!("{prefix}-inline-end{suffix}"), text(self.inline_end));
        out.push(&format!("{prefix}-block-start{suffix}"), text(Side::Top));
        out.push(&format!("{prefix}-block-end{suffix}"), text(Side::Bottom));
    }
}

impl View<'_> {
    fn lengths(&self) -> &LengthContext {
        &self.own.lengths
    }

    fn values(&self) -> Vec<String> {
        let mut out = Out(Vec::new());
        self.layout_keywords(&mut out);
        self.transforms(&mut out);
        self.boxes_and_sizes(&mut out);
        self.motion(&mut out);
        self.paint(&mut out);
        self.custom_properties(&mut out);
        out.0
    }

    fn display(&self) -> String {
        if !self.pseudo && crate::layout::box_generation::is_display_none(self.element) {
            return "none".to_string();
        }
        let declared = self.style.display.as_deref();
        let display = match declared {
            Some(display) => display,
            None if self.pseudo || self.element.element_type == "span" => "inline",
            None => "block",
        };
        let blockified = matches!(self.position(), "absolute" | "fixed") || self.parent.lays_out_items;
        match (blockified, display) {
            (true, "inline" | "inline-block") => "block",
            (true, "inline-flex") => "flex",
            (true, "inline-grid") => "grid",
            (true, "inline-table") => "table",
            _ => display,
        }
        .to_string()
    }

    fn position(&self) -> &str {
        self.style.position.as_deref().unwrap_or("static")
    }

    fn is_inline(&self) -> bool {
        self.display() == "inline"
    }

    fn layout_keywords(&self, out: &mut Out) {
        out.push("display", self.display());
        out.push("position", self.position().to_string());
        out.push("visibility", if self.own.visibility_hidden { "hidden" } else { "visible" }.to_string());
        let axes = crate::scroll::Axes::of(self.style);
        let (x, y) = (overflow_name(axes.x), overflow_name(axes.y));
        out.push("overflow", if x == y { x.to_string() } else { format!("{x} {y}") });
        out.push("overflow-x", x.to_string());
        out.push("overflow-y", y.to_string());
        out.push("direction", if self.rtl { "rtl" } else { "ltr" }.to_string());
        out.push("writing-mode", "horizontal-tb".to_string());
        out.push("box-sizing", "border-box".to_string());
        out.push("will-change", "auto".to_string());
        out.push("contain", "none".to_string());
        out.push("scrollbar-gutter", "auto".to_string());
        out.push("content", if self.pseudo { "none" } else { "normal" }.to_string());
        out.push("z-index", self.z_index());
        out.push("filter", filter_text(self.style.filter.as_deref()));
        out.push("backdrop-filter", filter_text(self.style.backdrop_filter.as_deref()));
    }

    fn z_index(&self) -> String {
        let applies = self.position() != "static" || self.parent.lays_out_items;
        match self.style.z_index {
            Some(z) if applies => crate::layout::stacking::round_z(z).to_string(),
            _ => "auto".to_string(),
        }
    }

    fn size(&self) -> Size<Pixels> {
        let (width, height) = match &self.boxes.own {
            Some(bounds) if !self.no_box => (bounds.width, bounds.height),
            _ => (0.0, 0.0),
        };
        Size { width: gpui::px(width as f32), height: gpui::px(height as f32) }
    }

    fn transforms(&self, out: &mut Out) {
        use crate::css::transform::{self, Property, Value};
        let lengths = self.lengths();
        // Chrome writes the matrix of a box it laid out; one with no box reads `none`.
        let transform_text = match transform::list_of(self.style, lengths) {
            Some(Value::List(functions)) if !self.no_box => matrix_text(&gpui::list_matrix(&functions, self.size())),
            _ => "none".to_string(),
        };
        out.push("transform", transform_text);
        let origin = transform::Parts::of(self.style, lengths).origin;
        let origin_text = match (origin, self.no_box) {
            (Some(origin), false) => origin_px(origin.x, origin.y, origin.z, self.size()),
            (None, false) => origin_px(
                gpui::TransformLength::fraction(0.5),
                gpui::TransformLength::fraction(0.5),
                0.0,
                self.size(),
            ),
            (Some(origin), true) => transform::format_origin(&origin),
            (None, true) => "50% 50%".to_string(),
        };
        out.push("transform-origin", origin_text);
        for (name, property, declared) in [
            ("translate", Property::Translate, &self.style.translate),
            ("rotate", Property::Rotate, &self.style.rotate),
            ("scale", Property::Scale, &self.style.scale),
        ] {
            let text = declared
                .as_deref()
                .and_then(|value| transform::computed_text(property, value, lengths))
                .unwrap_or_else(|| "none".to_string());
            out.push(name, text);
        }
        let perspective = match transform::perspective_of(self.style, lengths) {
            Some(Some(distance)) => pixels(f64::from(distance)),
            Some(None) | None => "none".to_string(),
        };
        out.push("perspective", perspective);
    }

    fn boxes_and_sizes(&self, out: &mut Out) {
        let lengths = self.lengths();
        let boxed = self.boxes.own.as_ref().filter(|_| !self.no_box);
        let used = boxed.filter(|_| !self.is_inline());
        out.push("width", match used {
            Some(bounds) => pixels(bounds.width),
            None => dimension_text(self.style.width.as_ref(), lengths, "auto"),
        });
        out.push("height", match used {
            Some(bounds) => pixels(bounds.height),
            None => dimension_text(self.style.height.as_ref(), lengths, "auto"),
        });
        // `auto` is a flex item's automatic minimum size; any other box has none and computes to 0.
        let is_item = self.parent.lays_out_items && !matches!(self.position(), "absolute" | "fixed");
        let auto_minimum = if is_item { "auto" } else { "0px" };
        out.push("min-width", dimension_text(self.style.min_width.as_ref(), lengths, auto_minimum));
        out.push("min-height", dimension_text(self.style.min_height.as_ref(), lengths, auto_minimum));
        out.push("max-width", dimension_text(self.style.max_width.as_ref(), lengths, "none"));
        out.push("max-height", dimension_text(self.style.max_height.as_ref(), lengths, "none"));

        let padding = self.style.padding_below_longhands();
        let declared_padding = |side: Side| match side {
            Side::Top => self.style.padding_top.as_ref().or(padding.top.as_ref()),
            Side::Right => self.style.padding_right.as_ref().or(padding.right.as_ref()),
            Side::Bottom => self.style.padding_bottom.as_ref().or(padding.bottom.as_ref()),
            Side::Left => self.style.padding_left.as_ref().or(padding.left.as_ref()),
        };
        let padding_text = |side: Side| match boxed {
            Some(bounds) => pixels(match side {
                Side::Top => bounds.padding_top,
                Side::Right => bounds.padding_right,
                Side::Bottom => bounds.padding_bottom,
                Side::Left => bounds.padding_left,
            }),
            None => declared_padding(side).map_or_else(|| "0px".to_string(), |length| linear_text(length, lengths)),
        };

        let margin = self.style.margin_below_longhands();
        let declared_margin = |side: Side| match side {
            Side::Top => self.style.margin_top.as_ref().or(margin.top.as_ref()),
            Side::Right => self.style.margin_right.as_ref().or(margin.right.as_ref()),
            Side::Bottom => self.style.margin_bottom.as_ref().or(margin.bottom.as_ref()),
            Side::Left => self.style.margin_left.as_ref().or(margin.left.as_ref()),
        };
        let percent_basis = self.containing_width();
        let margin_text = |side: Side| match declared_margin(side) {
            None => "0px".to_string(),
            Some(value) if self.no_box => dimension_text(Some(value), lengths, "0px"),
            Some(DimensionValue::Auto) => pixels(self.auto_margin(side)),
            Some(DimensionValue::Intrinsic(_) | DimensionValue::AnchorSize(_)) => "0px".to_string(),
            Some(DimensionValue::Pixels(px)) => pixels(*px),
            Some(DimensionValue::Percentage(fraction)) => pixels(fraction * percent_basis),
            Some(DimensionValue::Calc(length)) => pixels(lengths.resolve(length, percent_basis)),
        };

        let borders = crate::css::border::sides(self.style, &self.own.colors, lengths);
        let border_text = |side: Side| pixels(f64::from(f32::from(borders[side as usize].width)));

        // The writing mode is horizontal-tb, so the inline start is the left in ltr and the right in
        // rtl, and `mirrored_inline_pairs` has already put the logical pairs on those sides.
        let (inline_start, inline_end) = if self.rtl { (Side::Right, Side::Left) } else { (Side::Left, Side::Right) };
        let ends = Ends { inline_start, inline_end };
        ends.push(out, "padding", "", &padding_text);
        ends.push(out, "margin", "", &margin_text);
        ends.push(out, "border", "-width", &border_text);
        ends.push(out, "scroll-margin", "", &|_| "0px".to_string());
        ends.push(out, "scroll-padding", "", &|_| "auto".to_string());
    }

    /// What an `auto` margin came to: how far the box sits from the content edge of its parent, for the
    /// left and right margins of a box in the flow of a block. Anything else (the vertical margins, a
    /// flex or grid item, a positioned box) lays it out against more than the parent and reads 0.
    fn auto_margin(&self, side: Side) -> f64 {
        let Some(own) = &self.boxes.own else { return 0.0 };
        let Some(parent) = &self.boxes.parent else { return 0.0 };
        if self.parent.lays_out_items || matches!(self.position(), "absolute" | "fixed") {
            return 0.0;
        }
        let content_left = parent.x + parent.client_left + parent.padding_left;
        let content_right = parent.x + parent.width - parent.border_right - parent.padding_right;
        match side {
            Side::Left => (own.x - content_left).max(0.0),
            Side::Right => (content_right - (own.x + own.width)).max(0.0),
            Side::Top | Side::Bottom => 0.0,
        }
    }

    /// The width percentages of the box resolve against: the parent's content box.
    fn containing_width(&self) -> f64 {
        match &self.boxes.parent {
            Some(parent) => {
                (parent.width - parent.client_left - parent.border_right - parent.padding_left - parent.padding_right)
                    .max(0.0)
            }
            None => self.viewport_width,
        }
    }

    fn motion(&self, out: &mut Out) {
        let transitions = Transitions::of(self.style);
        out.push("transition", transitions.shorthand());
        out.push("transition-property", transitions.properties.join(", "));
        out.push("transition-duration", transitions.durations.join(", "));
        out.push("transition-delay", transitions.delays.join(", "));
        out.push("transition-timing-function", transitions.timings.join(", "));
        let animations = Animations::of(self.style);
        out.push("animation-name", animations.names.join(", "));
        out.push("animation-duration", animations.durations.join(", "));
    }

    fn paint(&self, out: &mut Out) {
        out.push("font-size", pixels(self.lengths().font_size));
        out.push("color", color_text(self.own.colors.current()));
        out.push("opacity", six_digits(self.style.opacity.unwrap_or(1.0).clamp(0.0, 1.0)));
        let background = match (&self.style.background_color, &self.style.background) {
            (Some(color), _) => Some(color.as_str()),
            (None, Some(crate::style::BackgroundValue::Color(color))) => Some(color.as_str()),
            _ => None,
        };
        let background = background.and_then(|value| self.own.colors.resolve(value));
        out.push("background-color", background.map_or_else(|| "rgba(0, 0, 0, 0)".to_string(), color_text));
    }

    fn custom_properties(&self, out: &mut Out) {
        for (name, value) in self.own.custom.entries() {
            out.push(name, value.to_string());
        }
    }
}

fn overflow_name(overflow: crate::scroll::Overflow) -> &'static str {
    use crate::scroll::Overflow;
    match overflow {
        Overflow::Visible => "visible",
        Overflow::Clip => "clip",
        Overflow::Hidden => "hidden",
        Overflow::Scroll => "scroll",
        Overflow::Auto => "auto",
    }
}

fn filter_text(declared: Option<&str>) -> String {
    match declared.map(str::trim) {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => "none".to_string(),
    }
}

fn linear_text(length: &LinearLength, lengths: &LengthContext) -> String {
    let (px, fraction) = lengths.split(length);
    length_text(px, fraction)
}

/// A size as a computed value: what a box with no layout reports, and `max-*` and `min-*` always.
fn dimension_text(value: Option<&DimensionValue>, lengths: &LengthContext, unset: &str) -> String {
    use crate::style::IntrinsicKeyword;
    match value {
        None | Some(DimensionValue::Auto | DimensionValue::AnchorSize(_)) => unset.to_string(),
        Some(DimensionValue::Pixels(px)) => pixels(*px),
        Some(DimensionValue::Percentage(fraction)) => length_text(0.0, *fraction),
        Some(DimensionValue::Calc(length)) => linear_text(length, lengths),
        Some(DimensionValue::Intrinsic(IntrinsicKeyword::MinContent)) => "min-content".to_string(),
        Some(DimensionValue::Intrinsic(IntrinsicKeyword::MaxContent)) => "max-content".to_string(),
        Some(DimensionValue::Intrinsic(IntrinsicKeyword::FitContent)) => "fit-content".to_string(),
        Some(DimensionValue::Intrinsic(IntrinsicKeyword::FitContentLimit(limit))) => {
            format!("fit-content({})", linear_text(limit, lengths))
        }
        Some(DimensionValue::Intrinsic(IntrinsicKeyword::Content)) => "content".to_string(),
    }
}

fn origin_px(x: gpui::TransformLength, y: gpui::TransformLength, z: f32, size: Size<Pixels>) -> String {
    let (x, y) = (f64::from(x.resolve(f32::from(size.width))), f64::from(y.resolve(f32::from(size.height))));
    if z == 0.0 {
        format!("{} {}", pixels(x), pixels(y))
    } else {
        format!("{} {} {}", pixels(x), pixels(y), pixels(f64::from(z)))
    }
}

/// `matrix()` for a matrix of the plane, `matrix3d()` for any other, numbers at six digits.
fn matrix_text(matrix: &gpui::Matrix3d) -> String {
    let number = |value: f32| six_digits(f64::from(value));
    if matrix.is_2d() {
        let rows = matrix.rows;
        let values = [rows[0][0], rows[1][0], rows[0][1], rows[1][1], rows[0][3], rows[1][3]];
        format!("matrix({})", values.map(number).join(", "))
    } else {
        let mut values = Vec::with_capacity(16);
        for column in 0..4 {
            for row in 0..4 {
                values.push(number(matrix.rows[row][column]));
            }
        }
        format!("matrix3d({})", values.join(", "))
    }
}

/// `rgb()` or `rgba()` with the alpha Chrome writes: two digits when they give the same 8-bit
/// alpha, otherwise three.
fn color_text(color: gpui::Rgba) -> String {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    let (red, green, blue) = (channel(color.r), channel(color.g), channel(color.b));
    let alpha = channel(color.a);
    if alpha == 255 {
        return format!("rgb({red}, {green}, {blue})");
    }
    let exact = f64::from(alpha) / 255.0;
    let digits = [100.0, 1000.0]
        .into_iter()
        .map(|scale| (exact * scale).round() / scale)
        .find(|rounded| (rounded * 255.0).round() as u8 == alpha)
        .unwrap_or(exact);
    format!("rgba({red}, {green}, {blue}, {})", six_digits(digits))
}

fn time_seconds(token: &str) -> Option<f64> {
    let (number, scale) = match token.strip_suffix("ms") {
        Some(number) => (number, 0.001),
        None => (token.strip_suffix('s')?, 1.0),
    };
    number.parse::<f64>().ok().map(|value| value * scale)
}

fn time_text(seconds: f64) -> String {
    format!("{}s", six_digits(seconds))
}

fn is_timing_function(token: &str) -> bool {
    matches!(token, "ease" | "ease-in" | "ease-out" | "ease-in-out" | "linear" | "step-start" | "step-end")
        || ["cubic-bezier(", "steps(", "linear("].into_iter().any(|start| token.starts_with(start))
}

/// A timing function as Chrome writes it: the arguments of a function separated by a comma and a
/// space.
fn timing_text(token: &str) -> String {
    match token.split_once('(') {
        Some((name, arguments)) => {
            let arguments = arguments.trim_end_matches(')');
            let arguments: Vec<String> =
                arguments.split(',').map(|argument| argument.trim().to_string()).collect();
            format!("{name}({})", arguments.join(", "))
        }
        None => token.to_string(),
    }
}

/// The `transition-*` lists as Chrome computes them: each longhand as its own comma list, the
/// shorthand's parts where a longhand does not name them, and the initial value for a list that
/// nothing names.
struct Transitions {
    properties: Vec<String>,
    durations: Vec<String>,
    delays: Vec<String>,
    timings: Vec<String>,
}

impl Transitions {
    fn of(style: &StyleDesc) -> Self {
        let mut properties = Vec::new();
        let mut durations = Vec::new();
        let mut delays = Vec::new();
        let mut timings = Vec::new();
        for item in style.transition.as_deref().map(split_commas).unwrap_or_default() {
            let mut times = Vec::new();
            let mut property = None;
            let mut timing = None;
            for token in split_whitespace(item) {
                if let Some(seconds) = time_seconds(token) {
                    times.push(seconds);
                } else if is_timing_function(token) {
                    timing = Some(timing_text(token));
                } else if token != "allow-discrete" && token != "normal" {
                    property = Some(token.to_string());
                }
            }
            properties.push(property.unwrap_or_else(|| "all".to_string()));
            durations.push(time_text(times.first().copied().unwrap_or(0.0)));
            delays.push(time_text(times.get(1).copied().unwrap_or(0.0)));
            timings.push(timing.unwrap_or_else(|| "ease".to_string()));
        }
        let list = |text: &Option<String>, parse: fn(&str) -> Option<String>| -> Option<Vec<String>> {
            text.as_deref().map(|text| split_commas(text).into_iter().filter_map(|item| parse(item.trim())).collect())
        };
        let or_initial = |declared: Option<Vec<String>>, shorthand: Vec<String>, initial: &str| {
            let list = declared.unwrap_or(shorthand);
            if list.is_empty() { vec![initial.to_string()] } else { list }
        };
        Self {
            properties: or_initial(list(&style.transition_property, |item| Some(item.to_string())), properties, "all"),
            durations: or_initial(
                list(&style.transition_duration, |item| time_seconds(item).map(time_text)),
                durations,
                "0s",
            ),
            delays: or_initial(list(&style.transition_delay, |item| time_seconds(item).map(time_text)), delays, "0s"),
            timings: or_initial(
                list(&style.transition_timing_function, |item| Some(timing_text(item))),
                timings,
                "ease",
            ),
        }
    }

    /// The shorthand as Chrome writes it: a part left out where it is the initial value, the duration
    /// kept when a delay follows it.
    fn shorthand(&self) -> String {
        let cycle = |list: &[String], index: usize| list[index % list.len()].clone();
        (0..self.properties.len())
            .map(|index| {
                let (duration, timing, delay) =
                    (cycle(&self.durations, index), cycle(&self.timings, index), cycle(&self.delays, index));
                let mut parts = vec![self.properties[index].clone()];
                if duration != "0s" || delay != "0s" {
                    parts.push(duration);
                }
                if timing != "ease" {
                    parts.push(timing);
                }
                if delay != "0s" {
                    parts.push(delay);
                }
                parts.join(" ")
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

struct Animations {
    names: Vec<String>,
    durations: Vec<String>,
}

impl Animations {
    fn of(style: &StyleDesc) -> Self {
        let mut names = Vec::new();
        let mut durations = Vec::new();
        for item in style.animation.as_deref().map(split_commas).unwrap_or_default() {
            let mut name = None;
            let mut duration = None;
            for token in split_whitespace(item) {
                if let Some(seconds) = time_seconds(token) {
                    duration.get_or_insert(seconds);
                } else if !is_animation_keyword(token) && token.parse::<f64>().is_err() {
                    name = Some(token.to_string());
                }
            }
            names.push(name.unwrap_or_else(|| "none".to_string()));
            durations.push(time_text(duration.unwrap_or(0.0)));
        }
        let longhand = |text: &Option<String>| -> Option<Vec<String>> {
            text.as_deref().map(|text| split_commas(text).into_iter().map(|item| item.trim().to_string()).collect())
        };
        let durations_declared = style.animation_duration.as_deref().map(|text| {
            split_commas(text)
                .into_iter()
                .filter_map(|item| time_seconds(item.trim()).map(time_text))
                .collect::<Vec<_>>()
        });
        let or_initial = |declared: Option<Vec<String>>, shorthand: Vec<String>, initial: &str| {
            let list = declared.unwrap_or(shorthand);
            if list.is_empty() { vec![initial.to_string()] } else { list }
        };
        Self {
            names: or_initial(longhand(&style.animation_name), names, "none"),
            durations: or_initial(durations_declared, durations, "0s"),
        }
    }
}

fn is_animation_keyword(token: &str) -> bool {
    is_timing_function(token)
        || matches!(
            token,
            "infinite"
                | "normal"
                | "reverse"
                | "alternate"
                | "alternate-reverse"
                | "forwards"
                | "backwards"
                | "both"
                | "running"
                | "paused"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(red: f32, green: f32, blue: f32, alpha: f32) -> gpui::Rgba {
        gpui::Rgba { r: red, g: green, b: blue, a: alpha }
    }

    #[test]
    fn opaque_colours_are_rgb_and_translucent_ones_rgba() {
        assert_eq!(color_text(rgba(1.0, 0.0, 0.0, 1.0)), "rgb(255, 0, 0)");
        assert_eq!(color_text(rgba(0.0, 0.0, 0.0, 0.0)), "rgba(0, 0, 0, 0)");
        assert_eq!(color_text(rgba(0.0, 0.0, 1.0, 0.5)), "rgba(0, 0, 255, 0.5)");
    }

    #[test]
    fn alpha_takes_the_digits_that_keep_its_eight_bit_value() {
        // 0.3 is 77/255: two digits give 0.3 again, which rounds to 77.
        assert_eq!(color_text(rgba(0.0, 0.0, 0.0, 0.3)), "rgba(0, 0, 0, 0.3)");
        // 0.333 is 85/255 = 0.3333: 0.33 rounds to 84, so three digits.
        assert_eq!(color_text(rgba(0.0, 0.0, 0.0, 85.0 / 255.0)), "rgba(0, 0, 0, 0.333)");
    }

    #[test]
    fn matrices_of_the_plane_are_matrix_and_the_rest_matrix3d() {
        let translate = gpui::Matrix3d::translate(10.0, 20.0, 0.0);
        assert_eq!(matrix_text(&translate), "matrix(1, 0, 0, 1, 10, 20)");
        let lifted = gpui::Matrix3d::translate(0.0, 0.0, 5.0);
        assert_eq!(matrix_text(&lifted), "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)");
    }

    fn style(json: &str) -> StyleDesc {
        serde_json::from_str(json).expect("a test style parses")
    }

    #[test]
    fn a_transition_shorthand_gives_every_list() {
        let transitions = Transitions::of(&style(r#"{"transition": "opacity 300ms ease-in 1s, transform 0.5s"}"#));
        assert_eq!(transitions.properties, ["opacity", "transform"]);
        assert_eq!(transitions.durations, ["0.3s", "0.5s"]);
        assert_eq!(transitions.delays, ["1s", "0s"]);
        assert_eq!(transitions.timings, ["ease-in", "ease"]);
        assert_eq!(transitions.shorthand(), "opacity 0.3s ease-in 1s, transform 0.5s");
    }

    #[test]
    fn no_transition_computes_to_the_initial_values() {
        let transitions = Transitions::of(&style("{}"));
        assert_eq!(transitions.shorthand(), "all");
    }

    #[test]
    fn a_transition_longhand_wins_over_the_shorthand() {
        let transitions = Transitions::of(&style(r#"{"transition": "opacity 1s", "transitionDuration": "2s"}"#));
        assert_eq!(transitions.durations, ["2s"]);
        assert_eq!(transitions.properties, ["opacity"]);
    }

    #[test]
    fn timing_functions_are_written_with_a_space_after_each_comma() {
        let transitions = Transitions::of(&style(r#"{"transitionTimingFunction": "cubic-bezier(0.4,0,0.2,1)"}"#));
        assert_eq!(transitions.timings, ["cubic-bezier(0.4, 0, 0.2, 1)"]);
    }

    #[test]
    fn an_animation_shorthand_names_its_animation_and_duration() {
        let animations = Animations::of(&style(r#"{"animation": "spin 2s linear infinite"}"#));
        assert_eq!(animations.names, ["spin"]);
        assert_eq!(animations.durations, ["2s"]);
        let none = Animations::of(&style("{}"));
        assert_eq!((none.names, none.durations), (vec!["none".to_string()], vec!["0s".to_string()]));
    }

    #[test]
    fn sizes_are_computed_values_without_a_box() {
        let lengths = LengthContext::for_tests();
        assert_eq!(dimension_text(None, &lengths, "auto"), "auto");
        assert_eq!(dimension_text(Some(&DimensionValue::Pixels(120.0)), &lengths, "auto"), "120px");
        assert_eq!(dimension_text(Some(&DimensionValue::Percentage(0.5)), &lengths, "auto"), "50%");
        assert_eq!(dimension_text(None, &lengths, "none"), "none");
    }
}
