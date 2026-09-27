#include "widget_tree.h"

/* Access lv_obj_class_t internals (name, base_class) */
#include "src/core/lv_obj_class_private.h"

#include <string.h>

/*
 * Output format: format_version 2 of the simulator contract. Keys whose value
 * is trivial are omitted to keep the tree small; consumers must treat a
 * missing key as its default:
 *   hidden=false, visible=true, states=[], flags=[], children=[],
 *   styles: bg_color (only when bg_opa>0), border_width=0 (border_color only
 *   when border_width>0), radius=0, pad_*=0, opa=255.
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
static void write_string_n(FILE *f, const char *str, size_t len)
{
    const unsigned char *p = (const unsigned char *)str;
    const unsigned char *end = p + len;

    fputc('"', f);
    while (p < end) {
        unsigned char c = *p;
        if (c == '"') {
            fputs("\\\"", f);
        } else if (c == '\\') {
            fputs("\\\\", f);
        } else if (c == '\n') {
            fputs("\\n", f);
        } else if (c == '\r') {
            fputs("\\r", f);
        } else if (c == '\t') {
            fputs("\\t", f);
        } else if (c < 0x20 || c == 0x7F) {
            fprintf(f, "\\u%04x", c);
        } else if (c < 0x80) {
            fputc(c, f);
        } else {
            size_t n = utf8_seq_len(p, (size_t)(end - p));
            if (n == 0) {
                fputs("\\ufffd", f);
                n = 1;
            } else {
                fwrite(p, 1, n, f);
            }
            p += n;
            continue;
        }
        p++;
    }
    fputc('"', f);
}

void widget_tree_write_string(FILE *f, const char *str)
{
    if (!str) str = "";
    write_string_n(f, str, strlen(str));
}

/** Write `,"key":` */
static void write_key(FILE *f, const char *key)
{
    fprintf(f, ",\"%s\":", key);
}

static void write_color(FILE *f, const char *key, lv_color_t c)
{
    fprintf(f, ",\"%s\":\"#%02x%02x%02x\"", key, c.red, c.green, c.blue);
}

static void write_int(FILE *f, const char *key, int32_t v)
{
    fprintf(f, ",\"%s\":%d", key, (int)v);
}

/**
 * Write a JSON array of the '\n'-separated entries in `options`, at most
 * `max_count` of them.
 */
static void write_option_list(FILE *f, const char *options, uint32_t max_count)
{
    uint32_t count = 0;
    const char *p = options ? options : "";

    fputc('[', f);
    while (*p && count < max_count) {
        const char *end = strchr(p, '\n');
        size_t len = end ? (size_t)(end - p) : strlen(p);
        if (count > 0) fputc(',', f);
        write_string_n(f, p, len);
        count++;
        if (!end) break;
        p = end + 1;
    }
    fputc(']', f);
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

static const char *font_name(const lv_font_t *font)
{
    for (size_t i = 0; builtin_fonts[i].font; i++) {
        if (builtin_fonts[i].font == font) return builtin_fonts[i].name;
    }
    return "custom";
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
static const char *type_name(const lv_obj_t *obj)
{
    for (const lv_obj_class_t *cls = lv_obj_get_class(obj); cls; cls = cls->base_class) {
        if (cls->name) return cls->name;
    }
    return "lv_obj";
}

/**********************
 *  Node sections
 **********************/

static void write_states(FILE *f, lv_obj_t *obj)
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
        fputs(first ? ",\"states\":[" : ",", f);
        fprintf(f, "\"%s\"", states[i].name);
        first = false;
    }
    if (!first) fputc(']', f);
}

static void write_flags(FILE *f, lv_obj_t *obj)
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
        fputs(first ? ",\"flags\":[" : ",", f);
        fprintf(f, "\"%s\"", flags[i].name);
        first = false;
    }
    if (!first) fputc(']', f);
}

/** Widget-specific content: text, value ranges, options, image source */
static void write_widget_props(FILE *f, lv_obj_t *obj)
{
    if (lv_obj_has_class(obj, &lv_label_class)) {
        write_key(f, "text");
        widget_tree_write_string(f, lv_label_get_text(obj));
        write_key(f, "long_mode");
        fprintf(f, "\"%s\"", long_mode_name(lv_label_get_long_mode(obj)));
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
        fprintf(f, ",\"checked\":%s", lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
    } else if (lv_obj_has_class(obj, &lv_switch_class)) {
        fprintf(f, ",\"checked\":%s", lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
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
                case LV_IMAGE_SRC_VARIABLE: fputs("\"<c-array>\"", f); break;
                case LV_IMAGE_SRC_SYMBOL:   fputs("\"<symbol>\"", f); break;
                default:                    fputs("\"<unknown>\"", f); break;
            }
        }
    }
}

static void write_layout(FILE *f, lv_obj_t *obj)
{
    uint16_t layout = (uint16_t)lv_obj_get_style_layout(obj, LV_PART_MAIN);

    if (layout == LV_LAYOUT_NONE) return;
    write_key(f, "layout");
    if (layout == LV_LAYOUT_FLEX) {
        fprintf(f, "{\"type\":\"flex\",\"flow\":\"%s\",\"main\":\"%s\",\"cross\":\"%s\",\"track\":\"%s\"}",
                flex_flow_name(lv_obj_get_style_flex_flow(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_main_place(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_cross_place(obj, LV_PART_MAIN)),
                flex_align_name(lv_obj_get_style_flex_track_place(obj, LV_PART_MAIN)));
    } else if (layout == LV_LAYOUT_GRID) {
        fputs("{\"type\":\"grid\"}", f);
    } else {
        fputs("{\"type\":\"custom\"}", f); /* registered with lv_layout_register() */
    }
}

/** Scroll position and overflow; only written when there is something to report */
static void write_scroll(FILE *f, lv_obj_t *obj)
{
    int32_t sx = lv_obj_get_scroll_x(obj);
    int32_t sy = lv_obj_get_scroll_y(obj);
    bool overflow_x = lv_obj_get_scroll_left(obj) > 0 || lv_obj_get_scroll_right(obj) > 0;
    bool overflow_y = lv_obj_get_scroll_top(obj) > 0 || lv_obj_get_scroll_bottom(obj) > 0;

    if (sx == 0 && sy == 0 && !overflow_x && !overflow_y) return;
    fprintf(f, ",\"scroll\":{\"x\":%d,\"y\":%d,\"overflow_x\":%s,\"overflow_y\":%s}",
            (int)sx, (int)sy, overflow_x ? "true" : "false", overflow_y ? "true" : "false");
}

/** LV_PART_MAIN styles for the current state, trivial values omitted */
static void write_main_styles(FILE *f, lv_obj_t *obj)
{
    lv_opa_t bg_opa = lv_obj_get_style_bg_opa(obj, LV_PART_MAIN);
    int32_t border_w = lv_obj_get_style_border_width(obj, LV_PART_MAIN);
    int32_t radius = lv_obj_get_style_radius(obj, LV_PART_MAIN);
    const lv_font_t *font = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
    lv_opa_t opa = lv_obj_get_style_opa_recursive(obj, LV_PART_MAIN);
    static const struct { lv_style_prop_t prop; const char *name; } pads[] = {
        {LV_STYLE_PAD_TOP,    "pad_top"},
        {LV_STYLE_PAD_BOTTOM, "pad_bottom"},
        {LV_STYLE_PAD_LEFT,   "pad_left"},
        {LV_STYLE_PAD_RIGHT,  "pad_right"},
        {LV_STYLE_PAD_ROW,    "pad_row"},
        {LV_STYLE_PAD_COLUMN, "pad_column"},
    };

    fprintf(f, ",\"styles\":{\"bg_opa\":%d", (int)bg_opa);
    if (bg_opa > LV_OPA_TRANSP) write_color(f, "bg_color", lv_obj_get_style_bg_color(obj, LV_PART_MAIN));
    if (border_w > 0) {
        write_int(f, "border_width", border_w);
        write_color(f, "border_color", lv_obj_get_style_border_color(obj, LV_PART_MAIN));
    }
    if (radius != 0) write_int(f, "radius", radius);
    for (size_t i = 0; i < sizeof(pads) / sizeof(pads[0]); i++) {
        int32_t v = lv_obj_get_style_prop(obj, LV_PART_MAIN, pads[i].prop).num;
        if (v != 0) write_int(f, pads[i].name, v);
    }
    write_color(f, "text_color", lv_obj_get_style_text_color(obj, LV_PART_MAIN));
    if (font) {
        write_key(f, "font");
        fprintf(f, "\"%s\"", font_name(font));
        write_int(f, "line_height", lv_font_get_line_height(font));
    }
    if (opa < LV_OPA_COVER) write_int(f, "opa", opa);
    fputc('}', f);
}

/** Background style block of `part`, written only when it is drawn at all */
static void write_part_bg(FILE *f, lv_obj_t *obj, const char *key, lv_part_t part)
{
    lv_opa_t bg_opa = lv_obj_get_style_bg_opa(obj, part);

    if (bg_opa == LV_OPA_TRANSP) return;
    write_key(f, key);
    fprintf(f, "{\"bg_opa\":%d", (int)bg_opa);
    write_color(f, "bg_color", lv_obj_get_style_bg_color(obj, part));
    fputc('}', f);
}

/** Indicator/knob blocks for slider, bar, arc and switch */
static void write_part_styles(FILE *f, lv_obj_t *obj)
{
    bool is_arc = lv_obj_has_class(obj, &lv_arc_class);
    bool is_bar = lv_obj_has_class(obj, &lv_bar_class); /* includes lv_slider */
    bool has_knob = is_arc || lv_obj_has_class(obj, &lv_slider_class) ||
                    lv_obj_has_class(obj, &lv_switch_class);

    if (is_arc) {
        /* The arc indicator is drawn with arc_* styles, not bg_* */
        int32_t arc_w = lv_obj_get_style_arc_width(obj, LV_PART_INDICATOR);
        lv_opa_t arc_opa = lv_obj_get_style_arc_opa(obj, LV_PART_INDICATOR);
        if (arc_w > 0 && arc_opa > LV_OPA_TRANSP) {
            fprintf(f, ",\"indicator\":{\"arc_opa\":%d,\"arc_width\":%d", (int)arc_opa, (int)arc_w);
            write_color(f, "arc_color", lv_obj_get_style_arc_color(obj, LV_PART_INDICATOR));
            fputc('}', f);
        }
    } else if (is_bar || has_knob) {
        write_part_bg(f, obj, "indicator", LV_PART_INDICATOR);
    }
    if (has_knob) write_part_bg(f, obj, "knob", LV_PART_KNOB);
}

void widget_tree_write_node(FILE *f, lv_obj_t *obj)
{
    lv_area_t coords;
    uint32_t child_count;

    fputs("{\"type\":", f);
    widget_tree_write_string(f, type_name(obj));

#if LV_USE_OBJ_NAME
    const char *name = lv_obj_get_name(obj);
    if (name) {
        write_key(f, "name");
        widget_tree_write_string(f, name);
    }
#endif

    fprintf(f, ",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d",
            (int)lv_obj_get_x(obj), (int)lv_obj_get_y(obj),
            (int)lv_obj_get_width(obj), (int)lv_obj_get_height(obj));

    lv_obj_get_coords(obj, &coords);
    fprintf(f, ",\"abs\":{\"x1\":%d,\"y1\":%d,\"x2\":%d,\"y2\":%d}",
            (int)coords.x1, (int)coords.y1, (int)coords.x2, (int)coords.y2);

    if (lv_obj_is_hidden(obj)) fputs(",\"hidden\":true", f);
    if (!lv_obj_is_visible(obj)) fputs(",\"visible\":false", f);
    write_states(f, obj);
    write_flags(f, obj);
    write_widget_props(f, obj);
    write_layout(f, obj);
    write_scroll(f, obj);
    write_main_styles(f, obj);
    write_part_styles(f, obj);

    child_count = lv_obj_get_child_count(obj);
    if (child_count > 0) {
        fputs(",\"children\":[", f);
        for (uint32_t i = 0; i < child_count; i++) {
            if (i > 0) fputc(',', f);
            widget_tree_write_node(f, lv_obj_get_child(obj, (int32_t)i));
        }
        fputc(']', f);
    }

    fputc('}', f);
}
