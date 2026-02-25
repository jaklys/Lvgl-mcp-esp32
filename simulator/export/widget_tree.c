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
        fprintf(f, "\"value\": %d", (int)lv_slider_get_value(obj));
    }
    else if (cls == &lv_bar_class) {
        fprintf(f, ",\n");
        indent(f, depth + 1);
        fprintf(f, "\"value\": %d", (int)lv_bar_get_value(obj));
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
        fprintf(f, "\"value\": %d", (int)lv_arc_get_value(obj));
    }

    /* Recurse into children */
    uint32_t child_count = lv_obj_get_child_count(obj);
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
