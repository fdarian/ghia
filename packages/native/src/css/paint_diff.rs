//! Whether two styles differ in nothing but what a box paints.

use crate::css::length::LengthContext;
use crate::style::StyleDesc;

/// What `StyleDesc::differs_only_in_paint` decides. The lists name every field of the struct (the
/// destructure has no `..`), so a field that is added fails to compile here until it is put in one
/// of them, and `layout` is where it goes unless it is one of the keys that paint.
///
/// `custom_properties_may_differ` lets the custom properties differ: the caller says the tree has no
/// `@container` rule.
pub(crate) fn paint_only_difference(this: &StyleDesc, other: &StyleDesc, custom_properties_may_differ: bool) -> bool {
    macro_rules! classify {
        (
            paint: [$($paint:ident),+ $(,)?],
            transform: [$($transform:ident),+ $(,)?],
            states: [$($state:ident),+ $(,)?],
            layout: [$($layout:ident),+ $(,)?] $(,)?
        ) => {{
            // No `..`: this is what makes the lists name every field.
            let StyleDesc {
                $($paint: _,)+
                $($transform: _,)+
                $($state: _,)+
                $($layout: _,)+
                custom_properties: _,
            } = this;
            $(
                if this.$layout != other.$layout {
                    return false;
                }
            )+
            if !custom_properties_may_differ && this.custom_properties != other.custom_properties {
                return false;
            }
            // A state both declare is compared by the same rule, as a style of its own. One that
            // only one of them declares is layout.
            $(
                match (&this.$state, &other.$state) {
                    (Some(before), Some(after)) => {
                        if !before.differs_only_in_paint_as_state(after) {
                            return false;
                        }
                    }
                    (None, None) => {}
                    _ => return false,
                }
            )+
            // Having a transform makes the element a containing block, which layout reads: only the
            // values of one that stays on or off are paint. Whether a text with a `var()` is a
            // transform is not known until the custom properties substitute it.
            if $(this.$transform != other.$transform)||+ {
                let has_transform = |style: &StyleDesc| crate::css::transform::forms_context(style, &LengthContext::initial(0.0, 0.0));
                let reads_vars = crate::css::transform::reads_vars(this) || crate::css::transform::reads_vars(other);
                if reads_vars || has_transform(this) != has_transform(other) {
                    return false;
                }
            }
            true
        }};
    }
    classify!(
        // What a style reset below it is already in the style it was laid over: no box reads it.
        paint: [
            reset, revert, opacity, box_shadow, color, background_color, border_color, border_top_color,
            border_right_color, border_bottom_color, border_left_color, outline_color,
            text_decoration_color, scrollbar_color, selection_color, backface_visibility,
        ],
        transform: [
            perspective, perspective_origin, transform_style, z, translate_z, transform_perspective,
            rotate_x, rotate_y, transform, translate, rotate, scale, transform_origin, x, y, translate_x,
            translate_y, motion_scale, scale_x, scale_y, scale_z, motion_rotate, rotate_z, skew, skew_x,
            skew_y, origin_x, origin_y, origin_z, motion_transform,
        ],
        states: [
            hover, active, focus, focus_visible, focus_within, group_hover, group_active, group_focus_within,
            has_hover, has_active, has_focus, has_focus_visible, disabled, enabled, has_disabled, has_enabled,
        ],
        layout: [
            display, visibility, flex_direction, flex_wrap, flex_grow, flex_shrink, flex_basis, flex,
            flex_flow, align_items, align_self, align_content, justify_content, gap, row_gap, column_gap,
            order, justify_items, justify_self, place_items, place_content, place_self,
            grid_template_columns, grid_template_rows, grid_column_min, grid_row_min, grid_auto_columns,
            grid_auto_rows, grid_auto_flow, grid_template_areas, grid_area, grid_column, grid_row,
            grid_column_start, grid_column_end, grid_row_start, grid_row_end, width, height, min_width,
            min_height, max_width, max_height, padding, padding_block, padding_inline, padding_top,
            padding_right, padding_bottom, padding_left, margin, margin_block, margin_inline, margin_top,
            margin_right, margin_bottom, margin_left, position, z_index, inset, inset_block, inset_inline,
            top, right, bottom, left, background, background_image, background_size, background_position,
            background_repeat, background_origin, background_clip, color_scheme, border_width,
            border_top_width, border_right_width, border_bottom_width, border_left_width, border,
            border_block, border_inline, border_top, border_right, border_bottom, border_left,
            border_radius, border_top_left_radius, border_top_right_radius, border_bottom_left_radius,
            border_bottom_right_radius, filter, backdrop_filter, mask_image, mask_size, mask_position,
            mask_repeat, mask_origin, mask_clip, mask_mode, mask_composite, mask, mask_border_source,
            mask_border_slice, mask_border_width, mask_border_outset, mask_border_repeat,
            mask_border_mode, mask_border, clip_path, border_style, border_top_style, border_right_style,
            border_bottom_style, border_left_style, aspect_ratio, outline_width, outline_style, outline,
            outline_offset, font_size, font_family, font_weight, font_style, text_align, direction,
            line_height, white_space, tab_size, text_box, text_box_trim, text_box_edge, word_break,
            overflow_wrap, text_wrap, text_wrap_mode, text_wrap_style, text_overflow, vertical_align,
            table_layout, border_spacing, border_collapse, caption_side, empty_cells, line_clamp,
            text_decoration, text_decoration_line, text_decoration_style, text_decoration_thickness,
            text_underline_offset, font_variant_numeric, font_feature_settings, font_variation_settings,
            webkit_font_smoothing, overflow, overflow_x, overflow_y, scrollbar_width, overscroll_behavior,
            overscroll_behavior_x, overscroll_behavior_y, scroll_behavior, overflow_anchor, cursor,
            pointer_events, app_region, user_select, transition, transition_property, transition_duration,
            transition_timing_function, transition_delay, transition_behavior, interpolate_size,
            measure_natural_width, flex_or_grid_item, keeps_background, atomic_inline, animating_opacity,
            animating_transform, transform_in_motion, animation, animation_name, animation_duration,
            animation_timing_function, animation_delay, animation_iteration_count, animation_direction,
            animation_fill_mode, animation_play_state, group, keyboard_focus_dim, container_type,
            container_name, container, content_visibility, contain_intrinsic_size,
            contain_intrinsic_width, contain_intrinsic_height, contain_intrinsic_inline_size,
            contain_intrinsic_block_size, container_rules, container_unit_axes, clone_probe,
            contents_levels, var_declarations,
        ],
    )
}
