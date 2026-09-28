#include "widget_tree.h"

/* Access lv_obj_class_t internals (name, base_class) */
#include "src/core/lv_obj_class_private.h"

#include <stdlib.h>
#include <string.h>

/*
 * Output format: format_version 3 of the simulator contract. Keys whose value
 * is trivial are omitted to keep the tree small; consumers must treat a
 * missing key as its default:
 *   hidden=false, visible=true, states=[], flags=[], children=[],
 *   styles: bg_color (only when bg_opa>0), bg_grad_dir="none" (bg_grad_color
 *   only when a gradient is set), border_width=0 (border_color/opa/side only
 *   when border_width>0), radius=0, pad_*=0, margin_*=0, opa=255,
 *   outline_width=0, shadow_width=0, text_opa=255, text_align="auto",
 *   text_letter_space=0, text_line_space=0, transform_*=identity,
 *   translate_*=0, clip_corner=false.
 * Every node carries "path": "<type>#<index>", the index of the object among
 * all objects of the same type in pre-order over the active screen, then
 * layer_top, then layer_sys (see widget_tree_walk()).
 */

/**********************
 *  JSON helpers
 **********************/

/**
 * Length of the valid UTF-8 sequence starting at `p` (with `avail` bytes
 * available), or 0 if it is invalid or truncated. Overlong forms, surrogates
 * and code points above U+10FFFF are rejected.
 */
static size_t utf8_seq_len(const unsigned char *p, size_t avail)
{
    unsigned char c = p[0];
    unsigned char lo = 0x80, hi = 0xBF;
    size_t len;

    if (c < 0x80) return 1;
    if (c >= 0xC2 && c <= 0xDF) len = 2;
    else if (c >= 0xE0 && c <= 0xEF) len = 3;
    else if (c >= 0xF0 && c <= 0xF4) len = 4;
    else return 0;
    if (len > avail) return 0;

    /* Tighter bounds for the second byte */
    if (c == 0xE0) lo = 0xA0;
    else if (c == 0xED) hi = 0x9F;
    else if (c == 0xF0) lo = 0x90;
    else if (c == 0xF4) hi = 0x8F;

    if (p[1] < lo || p[1] > hi) return 0;
    for (size_t i = 2; i < len; i++) {
        if (p[i] < 0x80 || p[i] > 0xBF) return 0;
    }
    return len;
}

/** Write the first `len` bytes of `str` as a quoted JSON string */
static void write_string_n(jw_t *f, const char *str, size_t len)
{
    const unsigned char *p = (const unsigned char *)str;
    const unsigned char *end = p + len;

    jw_putc('"', f);
    while (p < end) {
        unsigned char c = *p;
        if (c == '"') {
            jw_puts("\\\"", f);
        } else if (c == '\\') {
            jw_puts("\\\\", f);
        } else if (c == '\n') {
            jw_puts("\\n", f);
        } else if (c == '\r') {
            jw_puts("\\r", f);
        } else if (c == '\t') {
            jw_puts("\\t", f);
        } else if (c < 0x20 || c == 0x7F) {
            jw_printf(f, "\\u%04x", c);
        } else if (c < 0x80) {
            jw_putc(c, f);
        } else {
            size_t n = utf8_seq_len(p, (size_t)(end - p));
            if (n == 0) {
                jw_puts("\\ufffd", f);
                n = 1;
            } else {
                jw_write(p, 1, n, f);
            }
            p += n;
            continue;
        }
        p++;
    }
    jw_putc('"', f);
}

void widget_tree_write_string(jw_t *f, const char *str)
{
    if (!str) str = "";
    write_string_n(f, str, strlen(str));
}

/** Write `,"key":` */
static void write_key(jw_t *f, const char *key)
{
    jw_printf(f, ",\"%s\":", key);
}

static void write_color(jw_t *f, const char *key, lv_color_t c)
{
    jw_printf(f, ",\"%s\":\"#%02x%02x%02x\"", key, c.red, c.green, c.blue);
}

static void write_int(jw_t *f, const char *key, int32_t v)
{
    jw_printf(f, ",\"%s\":%d", key, (int)v);
}

/**
 * Write a JSON array of the '\n'-separated entries in `options`, at most
 * `max_count` of them.
 */
static void write_option_list(jw_t *f, const char *options, uint32_t max_count)
{
    uint32_t count = 0;
    const char *p = options ? options : "";

    jw_putc('[', f);
    while (*p && count < max_count) {
        const char *end = strchr(p, '\n');
        size_t len = end ? (size_t)(end - p) : strlen(p);
        if (count > 0) jw_putc(',', f);
        write_string_n(f, p, len);
        count++;
        if (!end) break;
        p = end + 1;
    }
    jw_putc(']', f);
}

/**********************
 *  Name tables
 **********************/

typedef struct {
    const lv_font_t *font;
    const char *name;
} font_entry_t;

/* Built-in fonts enabled in lv_conf.h, matched by pointer */
static const font_entry_t builtin_fonts[] = {
#if LV_FONT_MONTSERRAT_8
    {&lv_font_montserrat_8, "montserrat_8"},
#endif
#if LV_FONT_MONTSERRAT_10
    {&lv_font_montserrat_10, "montserrat_10"},
#endif
#if LV_FONT_MONTSERRAT_12
    {&lv_font_montserrat_12, "montserrat_12"},
#endif
#if LV_FONT_MONTSERRAT_14
    {&lv_font_montserrat_14, "montserrat_14"},
#endif
#if LV_FONT_MONTSERRAT_16
    {&lv_font_montserrat_16, "montserrat_16"},
#endif
#if LV_FONT_MONTSERRAT_18
    {&lv_font_montserrat_18, "montserrat_18"},
#endif
#if LV_FONT_MONTSERRAT_20
    {&lv_font_montserrat_20, "montserrat_20"},
#endif
#if LV_FONT_MONTSERRAT_22
    {&lv_font_montserrat_22, "montserrat_22"},
#endif
#if LV_FONT_MONTSERRAT_24
    {&lv_font_montserrat_24, "montserrat_24"},
#endif
#if LV_FONT_MONTSERRAT_26
    {&lv_font_montserrat_26, "montserrat_26"},
#endif
#if LV_FONT_MONTSERRAT_28
    {&lv_font_montserrat_28, "montserrat_28"},
#endif
#if LV_FONT_MONTSERRAT_30
    {&lv_font_montserrat_30, "montserrat_30"},
#endif
#if LV_FONT_MONTSERRAT_32
    {&lv_font_montserrat_32, "montserrat_32"},
#endif
#if LV_FONT_MONTSERRAT_34
    {&lv_font_montserrat_34, "montserrat_34"},
#endif
#if LV_FONT_MONTSERRAT_36
    {&lv_font_montserrat_36, "montserrat_36"},
#endif
#if LV_FONT_MONTSERRAT_38
    {&lv_font_montserrat_38, "montserrat_38"},
#endif
#if LV_FONT_MONTSERRAT_40
    {&lv_font_montserrat_40, "montserrat_40"},
#endif
#if LV_FONT_MONTSERRAT_42
    {&lv_font_montserrat_42, "montserrat_42"},
#endif
#if LV_FONT_MONTSERRAT_44
    {&lv_font_montserrat_44, "montserrat_44"},
#endif
#if LV_FONT_MONTSERRAT_46
    {&lv_font_montserrat_46, "montserrat_46"},
#endif
#if LV_FONT_MONTSERRAT_48
    {&lv_font_montserrat_48, "montserrat_48"},
#endif
#if LV_FONT_MONTSERRAT_28_COMPRESSED
    {&lv_font_montserrat_28_compressed, "montserrat_28_compressed"},
#endif
#if LV_FONT_DEJAVU_16_PERSIAN_HEBREW
    {&lv_font_dejavu_16_persian_hebrew, "dejavu_16_persian_hebrew"},
#endif
#if LV_FONT_SOURCE_HAN_SANS_SC_14_CJK
    {&lv_font_source_han_sans_sc_14_cjk, "source_han_sans_sc_14_cjk"},
#endif
#if LV_FONT_SOURCE_HAN_SANS_SC_16_CJK
    {&lv_font_source_han_sans_sc_16_cjk, "source_han_sans_sc_16_cjk"},
#endif
#if LV_FONT_UNSCII_8
    {&lv_font_unscii_8, "unscii_8"},
#endif
#if LV_FONT_UNSCII_16
    {&lv_font_unscii_16, "unscii_16"},
#endif
    {NULL, NULL} /* keeps the array non-empty when no font is enabled */
};

const char *widget_tree_font_name(const lv_font_t *font)
{
    for (size_t i = 0; builtin_fonts[i].font; i++) {
        if (builtin_fonts[i].font == font) return builtin_fonts[i].name;
    }
    return "custom";
}

const lv_font_t *widget_tree_font_by_name(const char *name)
{
    for (size_t i = 0; builtin_fonts[i].font; i++) {
        if (strcmp(builtin_fonts[i].name, name) == 0) return builtin_fonts[i].font;
    }
    return NULL;
}

void widget_tree_font_names(void (*cb)(const char *name, void *user), void *user)
{
    for (size_t i = 0; builtin_fonts[i].font; i++) cb(builtin_fonts[i].name, user);
}

static const char *long_mode_name(lv_label_long_mode_t mode)
{
    switch (mode) {
        case LV_LABEL_LONG_MODE_WRAP:            return "wrap";
        case LV_LABEL_LONG_MODE_DOTS:            return "dots";
        case LV_LABEL_LONG_MODE_SCROLL:          return "scroll";
        case LV_LABEL_LONG_MODE_SCROLL_CIRCULAR: return "scroll_circular";
        case LV_LABEL_LONG_MODE_CLIP:            return "clip";
        default:                                 return "unknown";
    }
}

static const char *flex_flow_name(lv_flex_flow_t flow)
{
    switch (flow) {
        case LV_FLEX_FLOW_ROW:                 return "row";
        case LV_FLEX_FLOW_COLUMN:              return "column";
        case LV_FLEX_FLOW_ROW_WRAP:            return "row_wrap";
        case LV_FLEX_FLOW_ROW_REVERSE:         return "row_reverse";
        case LV_FLEX_FLOW_ROW_WRAP_REVERSE:    return "row_wrap_reverse";
        case LV_FLEX_FLOW_COLUMN_WRAP:         return "column_wrap";
        case LV_FLEX_FLOW_COLUMN_REVERSE:      return "column_reverse";
        case LV_FLEX_FLOW_COLUMN_WRAP_REVERSE: return "column_wrap_reverse";
        default:                               return "unknown";
    }
}

static const char *flex_align_name(lv_flex_align_t align)
{
    switch (align) {
        case LV_FLEX_ALIGN_START:         return "start";
        case LV_FLEX_ALIGN_END:           return "end";
        case LV_FLEX_ALIGN_CENTER:        return "center";
        case LV_FLEX_ALIGN_SPACE_EVENLY:  return "space_evenly";
        case LV_FLEX_ALIGN_SPACE_AROUND:  return "space_around";
        case LV_FLEX_ALIGN_SPACE_BETWEEN: return "space_between";
        default:                          return "unknown";
    }
}

/**
 * Class name of `obj`. Custom classes without a name report the nearest
 * named base class.
 */
const char *widget_tree_type_name(const lv_obj_t *obj)
{
    for (const lv_obj_class_t *cls = lv_obj_get_class(obj); cls; cls = cls->base_class) {
        if (cls->name) return cls->name;
    }
    return "lv_obj";
}

/**********************
 *  Node sections
 **********************/

static void write_states(jw_t *f, lv_obj_t *obj)
{
    static const struct { lv_state_t state; const char *name; } states[] = {
        {LV_STATE_CHECKED,  "checked"},
        {LV_STATE_DISABLED, "disabled"},
        {LV_STATE_FOCUSED,  "focused"},
        {LV_STATE_PRESSED,  "pressed"},
        {LV_STATE_EDITED,   "edited"},
    };
    bool first = true;

    for (size_t i = 0; i < sizeof(states) / sizeof(states[0]); i++) {
        if (!lv_obj_has_state(obj, states[i].state)) continue;
        jw_puts(first ? ",\"states\":[" : ",", f);
        jw_printf(f, "\"%s\"", states[i].name);
        first = false;
    }
    if (!first) jw_putc(']', f);
}

static void write_flags(jw_t *f, lv_obj_t *obj)
{
    /* lv_obj_has_flag() is deprecated since v9.6 in favor of lv_obj_is_<flag>() */
    static const struct { bool (*is_set)(const lv_obj_t *); const char *name; } flags[] = {
        {lv_obj_is_clickable,     "clickable"},
        {lv_obj_is_scrollable,    "scrollable"},
        {lv_obj_is_checkable,     "checkable"},
        {lv_obj_is_floating,      "floating"},
        {lv_obj_is_ignore_layout, "ignore_layout"},
    };
    bool first = true;

    for (size_t i = 0; i < sizeof(flags) / sizeof(flags[0]); i++) {
        if (!flags[i].is_set(obj)) continue;
        jw_puts(first ? ",\"flags\":[" : ",", f);
        jw_printf(f, "\"%s\"", flags[i].name);
        first = false;
    }
    if (!first) jw_putc(']', f);
}

/** Widget-specific content: text, value ranges, options, image source */
static void write_widget_props(jw_t *f, lv_obj_t *obj)
{
    if (lv_obj_has_class(obj, &lv_label_class)) {
        write_key(f, "text");
        widget_tree_write_string(f, lv_label_get_text(obj));
        write_key(f, "long_mode");
        jw_printf(f, "\"%s\"", long_mode_name(lv_label_get_long_mode(obj)));
    } else if (lv_obj_has_class(obj, &lv_textarea_class)) {
        /* Also covers lv_spinbox (a textarea subclass): text is the formatted value */
        write_key(f, "text");
        widget_tree_write_string(f, lv_textarea_get_text(obj));
        const char *placeholder = lv_textarea_get_placeholder_text(obj);
        if (placeholder && placeholder[0]) {
            write_key(f, "placeholder");
            widget_tree_write_string(f, placeholder);
        }
        if (lv_obj_has_class(obj, &lv_spinbox_class)) {
            write_int(f, "value", lv_spinbox_get_value(obj));
            write_int(f, "min", lv_spinbox_get_min_value(obj));
            write_int(f, "max", lv_spinbox_get_max_value(obj));
        }
    } else if (lv_obj_has_class(obj, &lv_checkbox_class)) {
        write_key(f, "text");
        widget_tree_write_string(f, lv_checkbox_get_text(obj));
        jw_printf(f, ",\"checked\":%s", lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
    } else if (lv_obj_has_class(obj, &lv_switch_class)) {
        jw_printf(f, ",\"checked\":%s", lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
    } else if (lv_obj_has_class(obj, &lv_slider_class)) {
        /* Must precede lv_bar: a slider is a bar subclass */
        write_int(f, "value", lv_slider_get_value(obj));
        write_int(f, "min", lv_slider_get_min_value(obj));
        write_int(f, "max", lv_slider_get_max_value(obj));
    } else if (lv_obj_has_class(obj, &lv_bar_class)) {
        write_int(f, "value", lv_bar_get_value(obj));
        write_int(f, "min", lv_bar_get_min_value(obj));
        write_int(f, "max", lv_bar_get_max_value(obj));
    } else if (lv_obj_has_class(obj, &lv_arc_class)) {
        write_int(f, "value", lv_arc_get_value(obj));
        write_int(f, "min", lv_arc_get_min_value(obj));
        write_int(f, "max", lv_arc_get_max_value(obj));
    } else if (lv_obj_has_class(obj, &lv_dropdown_class)) {
        write_int(f, "selected", (int32_t)lv_dropdown_get_selected(obj));
        write_key(f, "options");
        write_option_list(f, lv_dropdown_get_options(obj), UINT32_MAX);
    } else if (lv_obj_has_class(obj, &lv_roller_class)) {
        write_int(f, "selected", (int32_t)lv_roller_get_selected(obj));
        write_key(f, "options");
        /* In infinite mode the option text is repeated; list each option once */
        write_option_list(f, lv_roller_get_options(obj), lv_roller_get_option_count(obj));
    } else if (lv_obj_has_class(obj, &lv_image_class)) {
        const void *src = lv_image_get_src(obj);
        if (src) {
            write_key(f, "src");
            switch (lv_image_src_get_type(src)) {
                case LV_IMAGE_SRC_FILE:     widget_tree_write_string(f, (const char *)src); break;
                case LV_IMAGE_SRC_VARIABLE: jw_puts("\"<c-array>\"", f); break;
                case LV_IMAGE_SRC_SYMBOL:   jw_puts("\"<symbol>\"", f); break;
                default:                    jw_puts("\"<unknown>\"", f); break;
            }
        }
    }
}

static void write_grid_template(jw_t *f, const int32_t *dsc)
{
    jw_putc('[', f);
    for (uint32_t i = 0; dsc && dsc[i] != LV_GRID_TEMPLATE_LAST && i < 64; i++) {
        if (i > 0) jw_putc(',', f);
        if (dsc[i] == LV_GRID_CONTENT) jw_puts("\"content\"", f);
        else if (dsc[i] > LV_GRID_CONTENT && dsc[i] < LV_GRID_TEMPLATE_LAST) jw_printf(f, "\"fr%d\"", (int)(dsc[i] - LV_GRID_FR(0)));
        else jw_printf(f, "%d", (int)dsc[i]);
    }
    jw_putc(']', f);
}

static const char *grid_align_name(lv_grid_align_t a)
{
    switch (a) {
        case LV_GRID_ALIGN_START:         return "start";
        case LV_GRID_ALIGN_CENTER:        return "center";
        case LV_GRID_ALIGN_END:           return "end";
        case LV_GRID_ALIGN_STRETCH:       return "stretch";
        case LV_GRID_ALIGN_SPACE_EVENLY:  return "space_evenly";
        case LV_GRID_ALIGN_SPACE_AROUND:  return "space_around";
        case LV_GRID_ALIGN_SPACE_BETWEEN: return "space_between";
        default:                          return "unknown";
    }
}

/** Per-child layout parameters: flex_grow (flex parent) or grid_cell (grid parent) */
static void write_layout_child(jw_t *f, lv_obj_t *obj)
{
    lv_obj_t *parent = lv_obj_get_parent(obj);
    if (!parent) return;
    uint16_t layout = (uint16_t)lv_obj_get_style_layout(parent, LV_PART_MAIN);
    if (layout == LV_LAYOUT_FLEX) {
        uint8_t grow = lv_obj_get_style_flex_grow(obj, LV_PART_MAIN);
        if (grow > 0) write_int(f, "flex_grow", grow);
    } else if (layout == LV_LAYOUT_GRID) {
        jw_printf(f, ",\"grid_cell\":{\"col\":%d,\"col_span\":%d,\"row\":%d,\"row_span\":%d,"
                  "\"x_align\":\"%s\",\"y_align\":\"%s\"}",
                  (int)lv_obj_get_style_grid_cell_column_pos(obj, LV_PART_MAIN),
                  (int)lv_obj_get_style_grid_cell_column_span(obj, LV_PART_MAIN),
                  (int)lv_obj_get_style_grid_cell_row_pos(obj, LV_PART_MAIN),
                  (int)lv_obj_get_style_grid_cell_row_span(obj, LV_PART_MAIN),
                  grid_align_name((lv_grid_align_t)lv_obj_get_style_grid_cell_x_align(obj, LV_PART_MAIN)),
                  grid_align_name((lv_grid_align_t)lv_obj_get_style_grid_cell_y_align(obj, LV_PART_MAIN)));
    }
}

static void write_layout(jw_t *f, lv_obj_t *obj)
{
    uint16_t layout = (uint16_t)lv_obj_get_style_layout(obj, LV_PART_MAIN);

    if (layout == LV_LAYOUT_NONE) return;
    write_key(f, "layout");
    if (layout == LV_LAYOUT_FLEX) {
        jw_printf(f, "{\"type\":\"flex\",\"flow\":\"%s\",\"main\":\"%s\",\"cross\":\"%s\",\"track\":\"%s\"}",
                flex_flow_name(lv_obj_get_style_flex_flow(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_main_place(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_cross_place(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_track_place(obj, LV_PART_MAIN)));
    } else if (layout == LV_LAYOUT_GRID) {
        jw_puts("{\"type\":\"grid\",\"cols\":", f);
        write_grid_template(f, lv_obj_get_style_grid_column_dsc_array(obj, LV_PART_MAIN));
        jw_puts(",\"rows\":", f);
        write_grid_template(f, lv_obj_get_style_grid_row_dsc_array(obj, LV_PART_MAIN));
        jw_putc('}', f);
    } else {
        jw_puts("{\"type\":\"custom\"}", f); /* registered with lv_layout_register() */
    }
}

/** Scroll position and overflow; only written when there is something to report */
static void write_scroll(jw_t *f, lv_obj_t *obj)
{
    int32_t sx = lv_obj_get_scroll_x(obj);
    int32_t sy = lv_obj_get_scroll_y(obj);
    bool overflow_x = lv_obj_get_scroll_left(obj) > 0 || lv_obj_get_scroll_right(obj) > 0;
    bool overflow_y = lv_obj_get_scroll_top(obj) > 0 || lv_obj_get_scroll_bottom(obj) > 0;

    if (sx == 0 && sy == 0 && !overflow_x && !overflow_y) return;
    jw_printf(f, ",\"scroll\":{\"x\":%d,\"y\":%d,\"overflow_x\":%s,\"overflow_y\":%s}",
            (int)sx, (int)sy, overflow_x ? "true" : "false", overflow_y ? "true" : "false");
}

static const char *grad_dir_name(lv_grad_dir_t dir)
{
    switch (dir) {
        case LV_GRAD_DIR_NONE: return "none";
        case LV_GRAD_DIR_VER:  return "ver";
        case LV_GRAD_DIR_HOR:  return "hor";
        default:               return "other";
    }
}

static const char *border_side_name(lv_border_side_t side)
{
    switch (side) {
        case LV_BORDER_SIDE_NONE:   return "none";
        case LV_BORDER_SIDE_TOP:    return "top";
        case LV_BORDER_SIDE_BOTTOM: return "bottom";
        case LV_BORDER_SIDE_LEFT:   return "left";
        case LV_BORDER_SIDE_RIGHT:  return "right";
        case LV_BORDER_SIDE_FULL:   return "full";
        default:                    return "mixed";
    }
}

static const char *text_align_name(lv_text_align_t align)
{
    switch (align) {
        case LV_TEXT_ALIGN_LEFT:   return "left";
        case LV_TEXT_ALIGN_CENTER: return "center";
        case LV_TEXT_ALIGN_RIGHT:  return "right";
        default:                   return "auto";
    }
}

/** Size style value: plain int, "N%" or "content" */
static void write_size_value(jw_t *f, const char *key, int32_t v)
{
    write_key(f, key);
    if (v == LV_SIZE_CONTENT) jw_puts("\"content\"", f);
    else if (LV_COORD_IS_PCT(v)) jw_printf(f, "\"%d%%\"", (int)LV_COORD_GET_PCT(v));
    else jw_printf(f, "%d", (int)v);
}

/**
 * Style properties of `part` in the current state, trivial values omitted.
 * `main` selects the LV_PART_MAIN set (always bg_opa/text_color/font, plus
 * the object-level keys: margins, text, transform, size limits).
 */
static void write_style_props(jw_t *f, lv_obj_t *obj, lv_part_t part, bool main)
{
    lv_opa_t bg_opa = lv_obj_get_style_bg_opa(obj, part);
    int32_t border_w = lv_obj_get_style_border_width(obj, part);
    int32_t outline_w = lv_obj_get_style_outline_width(obj, part);
    int32_t shadow_w = lv_obj_get_style_shadow_width(obj, part);
    int32_t radius = lv_obj_get_style_radius(obj, part);
    bool is_arc = lv_obj_has_class(obj, &lv_arc_class);
    static const struct { lv_style_prop_t prop; const char *name; } pads[] = {
        {LV_STYLE_PAD_TOP,    "pad_top"},
        {LV_STYLE_PAD_BOTTOM, "pad_bottom"},
        {LV_STYLE_PAD_LEFT,   "pad_left"},
        {LV_STYLE_PAD_RIGHT,  "pad_right"},
        {LV_STYLE_PAD_ROW,    "pad_row"},
        {LV_STYLE_PAD_COLUMN, "pad_column"},
    };
    static const struct { lv_style_prop_t prop; const char *name; } margins[] = {
        {LV_STYLE_MARGIN_TOP,    "margin_top"},
        {LV_STYLE_MARGIN_BOTTOM, "margin_bottom"},
        {LV_STYLE_MARGIN_LEFT,   "margin_left"},
        {LV_STYLE_MARGIN_RIGHT,  "margin_right"},
    };

    if (main || bg_opa > LV_OPA_TRANSP) write_int(f, "bg_opa", bg_opa);
    if (bg_opa > LV_OPA_TRANSP) {
        write_color(f, "bg_color", lv_obj_get_style_bg_color(obj, part));
        const lv_grad_dsc_t *grad = lv_obj_get_style_bg_grad(obj, part);
        lv_grad_dir_t dir = lv_obj_get_style_bg_grad_dir(obj, part);
        if (grad && grad->stops_count > 0) {
            write_key(f, "bg_grad_dir");
            jw_printf(f, "\"%s\"", grad_dir_name((lv_grad_dir_t)grad->dir));
            write_key(f, "bg_grad_stops");
            jw_putc('[', f);
            for (uint32_t i = 0; i < grad->stops_count && i < LV_GRADIENT_MAX_STOPS; i++) {
                lv_color_t c = grad->stops[i].color;
                jw_printf(f, "%s{\"color\":\"#%02x%02x%02x\",\"frac\":%d}", i ? "," : "",
                          c.red, c.green, c.blue, (int)grad->stops[i].frac);
            }
            jw_putc(']', f);
        } else if (dir != LV_GRAD_DIR_NONE) {
            write_key(f, "bg_grad_dir");
            jw_printf(f, "\"%s\"", grad_dir_name(dir));
            write_color(f, "bg_grad_color", lv_obj_get_style_bg_grad_color(obj, part));
        }
    }
    if (border_w > 0) {
        write_int(f, "border_width", border_w);
        write_color(f, "border_color", lv_obj_get_style_border_color(obj, part));
        lv_opa_t bo = lv_obj_get_style_border_opa(obj, part);
        if (bo < LV_OPA_COVER) write_int(f, "border_opa", bo);
        lv_border_side_t side = lv_obj_get_style_border_side(obj, part);
        if (side != LV_BORDER_SIDE_FULL) {
            write_key(f, "border_side");
            jw_printf(f, "\"%s\"", border_side_name(side));
        }
    }
    if (outline_w > 0) {
        write_int(f, "outline_width", outline_w);
        write_color(f, "outline_color", lv_obj_get_style_outline_color(obj, part));
        lv_opa_t oo = lv_obj_get_style_outline_opa(obj, part);
        if (oo < LV_OPA_COVER) write_int(f, "outline_opa", oo);
        int32_t op = lv_obj_get_style_outline_pad(obj, part);
        if (op != 0) write_int(f, "outline_pad", op);
    }
    if (shadow_w > 0) {
        write_int(f, "shadow_width", shadow_w);
        write_color(f, "shadow_color", lv_obj_get_style_shadow_color(obj, part));
        write_int(f, "shadow_opa", lv_obj_get_style_shadow_opa(obj, part));
        int32_t v = lv_obj_get_style_shadow_spread(obj, part);
        if (v != 0) write_int(f, "shadow_spread", v);
        v = lv_obj_get_style_shadow_offset_x(obj, part);
        if (v != 0) write_int(f, "shadow_ofs_x", v);
        v = lv_obj_get_style_shadow_offset_y(obj, part);
        if (v != 0) write_int(f, "shadow_ofs_y", v);
    }
    if (radius != 0) write_int(f, "radius", radius);
    for (size_t i = 0; i < sizeof(pads) / sizeof(pads[0]); i++) {
        int32_t v = lv_obj_get_style_prop(obj, part, pads[i].prop).num;
        if (v != 0) write_int(f, pads[i].name, v);
    }
    if (is_arc && (main || part == LV_PART_INDICATOR)) {
        int32_t arc_w = lv_obj_get_style_arc_width(obj, part);
        lv_opa_t arc_opa = lv_obj_get_style_arc_opa(obj, part);
        if (arc_w > 0 && arc_opa > LV_OPA_TRANSP) {
            write_int(f, "arc_opa", arc_opa);
            write_int(f, "arc_width", arc_w);
            write_color(f, "arc_color", lv_obj_get_style_arc_color(obj, part));
            if (lv_obj_get_style_arc_rounded(obj, part)) jw_puts(",\"arc_rounded\":true", f);
        }
    }
    if (main && lv_obj_has_class(obj, &lv_line_class)) {
        write_int(f, "line_width", lv_obj_get_style_line_width(obj, part));
        write_color(f, "line_color", lv_obj_get_style_line_color(obj, part));
        if (lv_obj_get_style_line_rounded(obj, part)) jw_puts(",\"line_rounded\":true", f);
    }

    if (main) {
        const lv_font_t *font = lv_obj_get_style_text_font(obj, part);
        lv_opa_t opa = lv_obj_get_style_opa_recursive(obj, part);

        for (size_t i = 0; i < sizeof(margins) / sizeof(margins[0]); i++) {
            int32_t v = lv_obj_get_style_prop(obj, part, margins[i].prop).num;
            if (v != 0) write_int(f, margins[i].name, v);
        }
        write_color(f, "text_color", lv_obj_get_style_text_color(obj, part));
        lv_opa_t to = lv_obj_get_style_text_opa(obj, part);
        if (to < LV_OPA_COVER) write_int(f, "text_opa", to);
        if (font) {
            write_key(f, "font");
            jw_printf(f, "\"%s\"", widget_tree_font_name(font));
            write_int(f, "line_height", lv_font_get_line_height(font));
        }
        lv_text_align_t ta = lv_obj_get_style_text_align(obj, part);
        if (ta != LV_TEXT_ALIGN_AUTO) {
            write_key(f, "text_align");
            jw_printf(f, "\"%s\"", text_align_name(ta));
        }
        int32_t v = lv_obj_get_style_text_letter_space(obj, part);
        if (v != 0) write_int(f, "text_letter_space", v);
        v = lv_obj_get_style_text_line_space(obj, part);
        if (v != 0) write_int(f, "text_line_space", v);
        if (opa < LV_OPA_COVER) write_int(f, "opa", opa);

        v = lv_obj_get_style_transform_rotation(obj, part);
        if (v != 0) write_int(f, "transform_rotation", v);
        int32_t sx = lv_obj_get_style_transform_scale_x(obj, part);
        int32_t sy = lv_obj_get_style_transform_scale_y(obj, part);
        if (sx != LV_SCALE_NONE || sy != LV_SCALE_NONE) {
            if (sx == sy) {
                write_int(f, "transform_scale", sx);
            } else {
                write_int(f, "transform_scale_x", sx);
                write_int(f, "transform_scale_y", sy);
            }
        }
        v = lv_obj_get_style_translate_x(obj, part);
        if (v != 0) write_int(f, "translate_x", v);
        v = lv_obj_get_style_translate_y(obj, part);
        if (v != 0) write_int(f, "translate_y", v);
        if (lv_obj_get_style_clip_corner(obj, part)) jw_puts(",\"clip_corner\":true", f);

        v = lv_obj_get_style_min_width(obj, part);
        if (v != 0) write_size_value(f, "min_width", v);
        v = lv_obj_get_style_max_width(obj, part);
        if (v != LV_COORD_MAX) write_size_value(f, "max_width", v);
        v = lv_obj_get_style_min_height(obj, part);
        if (v != 0) write_size_value(f, "min_height", v);
        v = lv_obj_get_style_max_height(obj, part);
        if (v != LV_COORD_MAX) write_size_value(f, "max_height", v);
    } else {
        lv_opa_t opa = lv_obj_get_style_opa(obj, part);
        if (opa < LV_OPA_COVER) write_int(f, "opa", opa);
    }
}

/** LV_PART_MAIN styles for the current state */
static void write_main_styles(jw_t *f, lv_obj_t *obj)
{
    jw_t tmp;
    jw_init_mem(&tmp);
    write_style_props(&tmp, obj, LV_PART_MAIN, true);
    char *s = jw_take(&tmp);
    /* s starts with ',' (bg_opa is always written for MAIN) */
    jw_printf(f, ",\"styles\":{%s}", s && s[0] ? s + 1 : "");
    free(s);
}

/** Style block of a non-main part; omitted when nothing non-trivial is set */
static void write_part_block(jw_t *f, lv_obj_t *obj, const char *key, lv_part_t part)
{
    jw_t tmp;
    jw_init_mem(&tmp);
    write_style_props(&tmp, obj, part, false);
    char *s = jw_take(&tmp);
    if (s && s[0] == ',') jw_printf(f, ",\"%s\":{%s}", key, s + 1);
    free(s);
}

/** Part blocks per widget type */
static void write_part_styles(jw_t *f, lv_obj_t *obj)
{
    bool is_arc = lv_obj_has_class(obj, &lv_arc_class);
    bool is_bar = lv_obj_has_class(obj, &lv_bar_class); /* includes lv_slider */
    bool is_switch = lv_obj_has_class(obj, &lv_switch_class);
    bool has_knob = is_arc || lv_obj_has_class(obj, &lv_slider_class) || is_switch;

    if (is_arc || is_bar || is_switch) write_part_block(f, obj, "indicator", LV_PART_INDICATOR);
    if (has_knob) write_part_block(f, obj, "knob", LV_PART_KNOB);
    if (lv_obj_has_class(obj, &lv_roller_class)) write_part_block(f, obj, "selected", LV_PART_SELECTED);
    if (lv_obj_has_class(obj, &lv_buttonmatrix_class) || lv_obj_has_class(obj, &lv_table_class)) {
        write_part_block(f, obj, "items", LV_PART_ITEMS);
    }
}

/**********************
 *  Paths
 **********************/

void widget_tree_paths_init(widget_tree_paths_t *paths)
{
    memset(paths, 0, sizeof(*paths));
}

void widget_tree_paths_free(widget_tree_paths_t *paths)
{
    free(paths->items);
    memset(paths, 0, sizeof(*paths));
}

/** Assign the next index for `type` and format "<type>#<index>" into buf */
static void paths_next(widget_tree_paths_t *paths, const char *type, char *buf, size_t size)
{
    size_t i;

    for (i = 0; i < paths->count; i++) {
        if (paths->items[i].type == type || strcmp(paths->items[i].type, type) == 0) break;
    }
    if (i == paths->count) {
        if (paths->count == paths->cap) {
            size_t ncap = paths->cap ? paths->cap * 2 : 16;
            widget_tree_path_count_t *ni =
                (widget_tree_path_count_t *)realloc(paths->items, ncap * sizeof(*ni));
            if (!ni) {
                snprintf(buf, size, "%s#?", type);
                return;
            }
            paths->items = ni;
            paths->cap = ncap;
        }
        paths->items[i].type = type;
        paths->items[i].next = 0;
        paths->count++;
    }
    snprintf(buf, size, "%s#%u", type, (unsigned)paths->items[i].next++);
}

typedef struct {
    widget_tree_visit_cb_t cb;
    void *user;
    widget_tree_paths_t paths;
    bool stop;
} walk_ctx_t;

static void walk_rec(walk_ctx_t *ctx, lv_obj_t *obj, int depth)
{
    char path[WIDGET_TREE_PATH_MAX];

    if (ctx->stop) return;
    paths_next(&ctx->paths, widget_tree_type_name(obj), path, sizeof(path));
    if (!ctx->cb(obj, path, depth, ctx->user)) {
        ctx->stop = true;
        return;
    }
    /* The callback may not delete objects, but re-read the count anyway */
    for (uint32_t i = 0; i < lv_obj_get_child_count(obj) && !ctx->stop; i++) {
        walk_rec(ctx, lv_obj_get_child(obj, (int32_t)i), depth + 1);
    }
}

uint32_t widget_tree_roots(lv_display_t *disp, lv_obj_t *roots[3])
{
    uint32_t n = 0;
    lv_obj_t *r;
    if ((r = lv_display_get_screen_active(disp)) != NULL) roots[n++] = r;
    if ((r = lv_display_get_layer_top(disp)) != NULL) roots[n++] = r;
    if ((r = lv_display_get_layer_sys(disp)) != NULL) roots[n++] = r;
    return n;
}

void widget_tree_walk(lv_display_t *disp, widget_tree_visit_cb_t cb, void *user)
{
    walk_ctx_t ctx;
    lv_obj_t *roots[3];
    uint32_t n = widget_tree_roots(disp, roots);

    ctx.cb = cb;
    ctx.user = user;
    ctx.stop = false;
    widget_tree_paths_init(&ctx.paths);
    for (uint32_t i = 0; i < n && !ctx.stop; i++) walk_rec(&ctx, roots[i], 0);
    widget_tree_paths_free(&ctx.paths);
}

typedef struct {
    const lv_obj_t *target;
    char *buf;
    size_t size;
    bool found;
} path_of_ctx_t;

static bool path_of_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    path_of_ctx_t *c = (path_of_ctx_t *)user;
    LV_UNUSED(depth);
    if (obj != c->target) return true;
    snprintf(c->buf, c->size, "%s", path);
    c->found = true;
    return false;
}

bool widget_tree_path_of(lv_display_t *disp, const lv_obj_t *obj, char *buf, size_t size)
{
    path_of_ctx_t c = {obj, buf, size, false};
    if (size) buf[0] = '\0';
    widget_tree_walk(disp, path_of_cb, &c);
    return c.found;
}

typedef struct {
    const char *path;
    lv_obj_t *found;
} find_path_ctx_t;

static bool find_path_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    find_path_ctx_t *c = (find_path_ctx_t *)user;
    LV_UNUSED(depth);
    if (strcmp(path, c->path) != 0) return true;
    c->found = obj;
    return false;
}

lv_obj_t *widget_tree_find_path(lv_display_t *disp, const char *path)
{
    find_path_ctx_t c = {path, NULL};
    widget_tree_walk(disp, find_path_cb, &c);
    return c.found;
}

const char *widget_tree_label_of(lv_display_t *disp, const lv_obj_t *obj, char *buf, size_t size)
{
#if LV_USE_OBJ_NAME
    const char *name = lv_obj_get_name(obj);
    if (name && name[0]) return name;
#endif
    if (!widget_tree_path_of(disp, obj, buf, size)) snprintf(buf, size, "%s", widget_tree_type_name(obj));
    return buf;
}

void widget_tree_skip(widget_tree_paths_t *paths, lv_obj_t *obj)
{
    char path[WIDGET_TREE_PATH_MAX];
    paths_next(paths, widget_tree_type_name(obj), path, sizeof(path));
    uint32_t n = lv_obj_get_child_count(obj);
    for (uint32_t i = 0; i < n; i++) widget_tree_skip(paths, lv_obj_get_child(obj, (int32_t)i));
}

/**********************
 *  Node
 **********************/

void widget_tree_write_node(jw_t *f, lv_obj_t *obj, widget_tree_paths_t *paths)
{
    lv_area_t coords;
    uint32_t child_count;

    jw_puts("{\"type\":", f);
    widget_tree_write_string(f, widget_tree_type_name(obj));

#if LV_USE_OBJ_NAME
    const char *name = lv_obj_get_name(obj);
    if (name) {
        write_key(f, "name");
        widget_tree_write_string(f, name);
    }
#endif
    if (paths) {
        char path[WIDGET_TREE_PATH_MAX];
        paths_next(paths, widget_tree_type_name(obj), path, sizeof(path));
        write_key(f, "path");
        widget_tree_write_string(f, path);
    }

    jw_printf(f, ",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d",
              (int)lv_obj_get_x(obj), (int)lv_obj_get_y(obj),
              (int)lv_obj_get_width(obj), (int)lv_obj_get_height(obj));

    lv_obj_get_coords(obj, &coords);
    jw_printf(f, ",\"abs\":{\"x1\":%d,\"y1\":%d,\"x2\":%d,\"y2\":%d}",
              (int)coords.x1, (int)coords.y1, (int)coords.x2, (int)coords.y2);

    if (lv_obj_is_hidden(obj)) jw_puts(",\"hidden\":true", f);
    if (!lv_obj_is_visible(obj)) jw_puts(",\"visible\":false", f);
    write_states(f, obj);
    write_flags(f, obj);
    write_widget_props(f, obj);
    write_layout(f, obj);
    write_layout_child(f, obj);
    write_scroll(f, obj);
    write_main_styles(f, obj);
    write_part_styles(f, obj);

    child_count = lv_obj_get_child_count(obj);
    if (child_count > 0) {
        jw_puts(",\"children\":[", f);
        for (uint32_t i = 0; i < child_count; i++) {
            if (i > 0) jw_putc(',', f);
            widget_tree_write_node(f, lv_obj_get_child(obj, (int32_t)i), paths);
        }
        jw_putc(']', f);
    }

    jw_putc('}', f);
}
