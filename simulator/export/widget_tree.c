#include "widget_tree.h"
#include "lvgl.h"

/* Access lv_obj_class_t internal fields (name) */
#include "core/lv_obj_class_private.h"

#include <stdio.h>
#include <string.h>

/* Forward-declare widget class externs for type detection */
extern const lv_obj_class_t lv_label_class;
extern const lv_obj_class_t lv_button_class;
extern const lv_obj_class_t lv_slider_class;
extern const lv_obj_class_t lv_bar_class;
extern const lv_obj_class_t lv_checkbox_class;
extern const lv_obj_class_t lv_switch_class;
extern const lv_obj_class_t lv_dropdown_class;
extern const lv_obj_class_t lv_roller_class;
extern const lv_obj_class_t lv_textarea_class;
extern const lv_obj_class_t lv_arc_class;

/**
 * Write a JSON-escaped version of `str` to `f`.
 */
static void write_json_string(FILE *f, const char *str)
{
    fputc('"', f);
    for (const char *p = str; *p; p++) {
        switch (*p) {
            case '"':  fputs("\\\"", f); break;
            case '\\': fputs("\\\\", f); break;
            case '\n': fputs("\\n", f);  break;
            case '\r': fputs("\\r", f);  break;
            case '\t': fputs("\\t", f);  break;
            default:
                if ((unsigned char)*p < 0x20) {
                    fprintf(f, "\\u%04x", (unsigned char)*p);
                } else {
                    fputc(*p, f);
                }
                break;
        }
    }
    fputc('"', f);
}

/**
 * Write indentation spaces.
 */
static void indent(FILE *f, int depth)
{
    for (int i = 0; i < depth * 2; i++) fputc(' ', f);
}

/**
 * Recursively dump an lv_obj_t and its children as JSON.
 */
static void dump_obj(FILE *f, lv_obj_t *obj, int depth)
{
    const lv_obj_class_t *cls = lv_obj_get_class(obj);
    const char *type_name = cls->name ? cls->name : "lv_obj";

    int32_t x = lv_obj_get_x(obj);
    int32_t y = lv_obj_get_y(obj);
    int32_t w = lv_obj_get_width(obj);
    int32_t h = lv_obj_get_height(obj);

    /* Pre-declare all variables (MSVC C89) */
    lv_color_t bg_color, text_color, border_color;
    lv_opa_t bg_opa, opa;
    const lv_font_t *font;
    int32_t border_w, radius, pad_t, pad_b, pad_l, pad_r, pad_gap;
    uint32_t child_count;

    indent(f, depth);
    fprintf(f, "{\n");

    indent(f, depth + 1);
    fprintf(f, "\"type\": ");
    write_json_string(f, type_name);
    fprintf(f, ",\n");

    indent(f, depth + 1);
    fprintf(f, "\"x\": %d, \"y\": %d, \"w\": %d, \"h\": %d",
            (int)x, (int)y, (int)w, (int)h);

    /* Widget-specific properties */
    if (cls == &lv_label_class) {
        char *text = lv_label_get_text(obj);
        if (text) {
            fprintf(f, ",\n");
            indent(f, depth + 1);
            fprintf(f, "\"text\": ");
            write_json_string(f, text);
        }
    }
    else if (cls == &lv_slider_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"value\": %d, \"min\": %d, \"max\": %d",
                (int)lv_slider_get_value(obj),
                (int)lv_slider_get_min_value(obj),
                (int)lv_slider_get_max_value(obj));
    }
    else if (cls == &lv_bar_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"value\": %d, \"min\": %d, \"max\": %d",
                (int)lv_bar_get_value(obj),
                (int)lv_bar_get_min_value(obj),
                (int)lv_bar_get_max_value(obj));
    }
    else if (cls == &lv_checkbox_class || cls == &lv_switch_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"checked\": %s",
                lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false");
    }
    else if (cls == &lv_dropdown_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"selected\": %u", (unsigned)lv_dropdown_get_selected(obj));
    }
    else if (cls == &lv_roller_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"selected\": %u", (unsigned)lv_roller_get_selected(obj));
    }
    else if (cls == &lv_arc_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"value\": %d, \"min\": %d, \"max\": %d",
                (int)lv_arc_get_value(obj),
                (int)lv_arc_get_min_value(obj),
                (int)lv_arc_get_max_value(obj));
    }

    /* Style properties */
    fprintf(f, ",\n");
    indent(f, depth + 1);
    fprintf(f, "\"styles\": {\n");

    /* Background */
    bg_color = lv_obj_get_style_bg_color(obj, LV_PART_MAIN);
    bg_opa = lv_obj_get_style_bg_opa(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"bg_color\": \"#%02x%02x%02x\", \"bg_opa\": %d,\n",
            bg_color.red, bg_color.green, bg_color.blue, (int)bg_opa);

    /* Text (applicable to all — LVGL inherits text styles) */
    text_color = lv_obj_get_style_text_color(obj, LV_PART_MAIN);
    font = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"text_color\": \"#%02x%02x%02x\", \"text_font_size\": %d,\n",
            text_color.red, text_color.green, text_color.blue,
            font ? (int)font->line_height : 0);

    /* Border */
    border_w = lv_obj_get_style_border_width(obj, LV_PART_MAIN);
    border_color = lv_obj_get_style_border_color(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"border_width\": %d, \"border_color\": \"#%02x%02x%02x\",\n",
            (int)border_w, border_color.red, border_color.green, border_color.blue);

    /* Radius */
    radius = lv_obj_get_style_radius(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"radius\": %d,\n", (int)radius);

    /* Padding */
    pad_t = lv_obj_get_style_pad_top(obj, LV_PART_MAIN);
    pad_b = lv_obj_get_style_pad_bottom(obj, LV_PART_MAIN);
    pad_l = lv_obj_get_style_pad_left(obj, LV_PART_MAIN);
    pad_r = lv_obj_get_style_pad_right(obj, LV_PART_MAIN);
    pad_gap = lv_obj_get_style_pad_row(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"pad_top\": %d, \"pad_bottom\": %d, \"pad_left\": %d, \"pad_right\": %d, \"pad_gap\": %d,\n",
            (int)pad_t, (int)pad_b, (int)pad_l, (int)pad_r, (int)pad_gap);

    /* Opacity */
    opa = lv_obj_get_style_opa(obj, LV_PART_MAIN);
    indent(f, depth + 2);
    fprintf(f, "\"opa\": %d\n", (int)opa);

    indent(f, depth + 1);
    fprintf(f, "}");

    /* Recurse into children */
    child_count = lv_obj_get_child_count(obj);
    if (child_count > 0) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"children\": [\n");

        for (uint32_t i = 0; i < child_count; i++) {
            lv_obj_t *child = lv_obj_get_child(obj, (int32_t)i);
            dump_obj(f, child, depth + 2);
            if (i < child_count - 1) fprintf(f, ",");
            fprintf(f, "\n");
        }

        indent(f, depth + 1);
        fprintf(f, "]");
    }

    fprintf(f, "\n");
    indent(f, depth);
    fprintf(f, "}");
}

int widget_tree_dump_json(const char *filename, lv_obj_t *root)
{
    FILE *f = fopen(filename, "w");
    if (!f) return -1;

    dump_obj(f, root, 0);
    fprintf(f, "\n");

    fclose(f);
    return 0;
}
