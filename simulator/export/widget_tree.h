#ifndef WIDGET_TREE_H
#define WIDGET_TREE_H

#include "lvgl.h"
#include "jw.h"

#include <stdbool.h>
#include <stdint.h>

/** Longest "<type>#<index>" path, including the NUL */
#define WIDGET_TREE_PATH_MAX 96

typedef struct {
    const char *type;
    uint32_t next;
} widget_tree_path_count_t;

/**
 * Path numbering state for one document. Paths are "<type>#<index>" where
 * index counts the objects of that type in pre-order over the active screen,
 * then layer_top, then layer_sys. Write (or skip) the roots in that order
 * with one state so that the numbers match widget_tree_walk().
 */
typedef struct {
    widget_tree_path_count_t *items;
    size_t count;
    size_t cap;
} widget_tree_paths_t;

void widget_tree_paths_init(widget_tree_paths_t *paths);
void widget_tree_paths_free(widget_tree_paths_t *paths);

/**
 * Write `obj` and its whole subtree as one compact JSON node object
 * (format_version 3, see the simulator contract). No trailing newline.
 * @param f     output sink
 * @param obj   root of the subtree (e.g. lv_screen_active(), lv_layer_top())
 * @param paths numbering state (adds "path" to every node), or NULL
 */
void widget_tree_write_node(jw_t *f, lv_obj_t *obj, widget_tree_paths_t *paths);

/** Advance the numbering over `obj` and its subtree without writing it */
void widget_tree_skip(widget_tree_paths_t *paths, lv_obj_t *obj);

/**
 * Write `str` as a quoted JSON string. Control characters are escaped and
 * invalid UTF-8 sequences are replaced by U+FFFD, so the output is always
 * valid JSON; valid UTF-8 is passed through unchanged.
 */
void widget_tree_write_string(jw_t *f, const char *str);

/** Class name of `obj` (nearest named class), e.g. "lv_button" */
const char *widget_tree_type_name(const lv_obj_t *obj);

/** Name of a built-in font ("montserrat_14"), or "custom" */
const char *widget_tree_font_name(const lv_font_t *font);

/** Built-in font by name, or NULL */
const lv_font_t *widget_tree_font_by_name(const char *name);

/** Call `cb` for every built-in font name */
void widget_tree_font_names(void (*cb)(const char *name, void *user), void *user);

/**
 * Visitor for widget_tree_walk(): return false to stop the walk.
 * Must not create or delete objects.
 */
typedef bool (*widget_tree_visit_cb_t)(lv_obj_t *obj, const char *path, int depth, void *user);

/** Collect the walk roots: active screen, layer_top, layer_sys */
uint32_t widget_tree_roots(lv_display_t *disp, lv_obj_t *roots[3]);

/** Pre-order walk over the roots, with the same paths as the JSON tree */
void widget_tree_walk(lv_display_t *disp, widget_tree_visit_cb_t cb, void *user);

/** Path of `obj`; false if it is not under one of the roots */
bool widget_tree_path_of(lv_display_t *disp, const lv_obj_t *obj, char *buf, size_t size);

/** Object with the given "<type>#<index>" path, or NULL */
lv_obj_t *widget_tree_find_path(lv_display_t *disp, const char *path);

/** The object's name if set, else its path (stored in buf) */
const char *widget_tree_label_of(lv_display_t *disp, const lv_obj_t *obj, char *buf, size_t size);

#endif /* WIDGET_TREE_H */
