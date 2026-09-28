#include "annotate.h"
#include "mem.h"
#include "screenshot.h"
#include "widget_tree.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LABEL_MIN_SIZE 24   /* no label when the object is smaller in both dimensions */

static const uint32_t depth_colors[] = {0xe11d48, 0x2563eb, 0x16a34a, 0xd97706, 0x7c3aed};

typedef struct {
    lv_obj_t *obj;
    int depth;
    char label[WIDGET_TREE_PATH_MAX];
} mark_t;

typedef struct {
    mark_t *marks;
    size_t count;
    size_t cap;
} mark_list_t;

/** True when obj or an ancestor has the HIDDEN flag */
static bool hidden_chain(const lv_obj_t *obj)
{
    for (const lv_obj_t *o = obj; o; o = lv_obj_get_parent(o)) {
        if (lv_obj_is_hidden(o)) return true;
    }
    return false;
}

static bool collect_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    mark_list_t *list = (mark_list_t *)user;

    /* The roots (screen, layers) are not outlined; hidden subtrees are skipped */
    if (depth == 0 || hidden_chain(obj)) return true;
    if (lv_obj_get_width(obj) <= 0 || lv_obj_get_height(obj) <= 0) return true;

    if (list->count == list->cap) {
        size_t ncap = list->cap ? list->cap * 2 : 64;
        mark_t *n = (mark_t *)realloc(list->marks, ncap * sizeof(*n));
        if (!n) return false;
        list->marks = n;
        list->cap = ncap;
    }
    mark_t *m = &list->marks[list->count++];
    m->obj = obj;
    m->depth = depth;
#if LV_USE_OBJ_NAME
    const char *name = lv_obj_get_name(obj);
    if (name && name[0]) {
        snprintf(m->label, sizeof(m->label), "%s", name);
        return true;
    }
#endif
    snprintf(m->label, sizeof(m->label), "%s", path);
    return true;
}

static void draw_outline(lv_layer_t *layer, const mark_t *m)
{
    lv_draw_rect_dsc_t dsc;
    lv_area_t a;

    lv_draw_rect_dsc_init(&dsc);
    dsc.bg_opa = LV_OPA_TRANSP;
    dsc.border_width = 1;
    dsc.border_opa = LV_OPA_COVER;
    dsc.border_color = lv_color_hex(depth_colors[(size_t)(m->depth - 1) % (sizeof(depth_colors) / sizeof(depth_colors[0]))]);
    dsc.radius = 0;
    lv_obj_get_coords(m->obj, &a);
    lv_draw_rect(layer, &dsc, &a);
}

static void draw_label(lv_layer_t *layer, const mark_t *m, int32_t disp_w, int32_t disp_h)
{
    const lv_font_t *font = &lv_font_unscii_8;
    lv_area_t a;
    lv_point_t size;

    if (lv_obj_get_width(m->obj) < LABEL_MIN_SIZE && lv_obj_get_height(m->obj) < LABEL_MIN_SIZE) return;
    lv_obj_get_coords(m->obj, &a);
    lv_text_get_size(&size, m->label, font, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);

    /*
     * Top-left corner inside the object; for flat objects (labels, sliders)
     * just above it when there is room, so the tag does not cover the text.
     * Always kept on the screen.
     */
    int32_t x = a.x1 + 1;
    int32_t y = a.y1 + 1;
    if (lv_area_get_height(&a) < 2 * (size.y + 2) + 4 && a.y1 - size.y - 2 >= 0) y = a.y1 - size.y - 2;
    if (x + size.x + 2 > disp_w) x = disp_w - size.x - 2;
    if (y + size.y + 2 > disp_h) y = disp_h - size.y - 2;
    if (x < 0) x = 0;
    if (y < 0) y = 0;

    lv_area_t bg = {x, y, x + size.x + 1, y + size.y + 1};
    lv_draw_rect_dsc_t rect;
    lv_draw_rect_dsc_init(&rect);
    rect.bg_color = lv_color_black();
    rect.bg_opa = LV_OPA_70;
    rect.radius = 0;
    lv_draw_rect(layer, &rect, &bg);

    lv_draw_label_dsc_t label;
    lv_draw_label_dsc_init(&label);
    label.font = font;
    label.color = lv_color_white();
    label.text = m->label;
    lv_area_t ta = {x + 1, y + 1, x + size.x, y + size.y};
    lv_draw_label(layer, &label, &ta);
}

int annotate_save_png(const char *filename, lv_display_t *disp, int32_t scale)
{
    lv_draw_buf_t *src = lv_display_get_buf_active(disp);
    int32_t w = lv_display_get_horizontal_resolution(disp);
    int32_t h = lv_display_get_vertical_resolution(disp);
    mark_list_t list = {NULL, 0, 0};
    int rc = -1;

    if (!src || !src->data) return -1;
    lv_color_format_t cf = (lv_color_format_t)src->header.cf;
    uint32_t px = lv_color_format_get_size(cf);
    uint32_t stride = lv_draw_buf_width_to_stride((uint32_t)w, cf);
    if (px == 0 || src->header.stride < (uint32_t)w * px) return -1;

    /* Copy of the frame, outside the LVGL heap */
    size_t size = (size_t)stride * (size_t)h;
    uint8_t *mem = (uint8_t *)malloc(size + LV_DRAW_BUF_ALIGN);
    if (!mem) return -1;
    uint8_t *data = (uint8_t *)lv_draw_buf_align(mem, cf);
    for (int32_t y = 0; y < h; y++) {
        memcpy(data + (size_t)y * stride, src->data + (size_t)y * src->header.stride, (size_t)w * px);
    }

    widget_tree_walk(disp, collect_cb, &list);

    mem_overhead_begin();
    lv_obj_t *tmp_screen = lv_obj_create(NULL);
    lv_obj_t *canvas = lv_canvas_create(tmp_screen);
    lv_canvas_set_buffer(canvas, data, w, h, cf);

    /* Outlines first, labels on top; one layer per object keeps the draw-task memory small */
    for (int pass = 0; pass < 2; pass++) {
        for (size_t i = 0; i < list.count; i++) {
            lv_layer_t layer;
            lv_canvas_init_layer(canvas, &layer);
            if (pass == 0) draw_outline(&layer, &list.marks[i]);
            else draw_label(&layer, &list.marks[i], w, h);
            lv_canvas_finish_layer(canvas, &layer);
        }
    }

    rc = screenshot_save_draw_buf(filename, lv_canvas_get_draw_buf(canvas), w, h, scale);
    lv_obj_delete(tmp_screen);
    mem_overhead_end();

    free(list.marks);
    free(mem);
    return rc;
}
