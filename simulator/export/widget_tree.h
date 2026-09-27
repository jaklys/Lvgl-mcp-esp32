#ifndef WIDGET_TREE_H
#define WIDGET_TREE_H

#include "lvgl.h"
#include <stdio.h>

/**
 * Write `obj` and its whole subtree as one compact JSON node object
 * (format_version 2, see the simulator contract) to an open stream.
 * No trailing newline is written.
 * @param f   output stream
 * @param obj root of the subtree (e.g. lv_screen_active(), lv_layer_top())
 */
void widget_tree_write_node(FILE *f, lv_obj_t *obj);

/**
 * Write `str` as a quoted JSON string. Control characters are escaped and
 * invalid UTF-8 sequences are replaced by U+FFFD, so the output is always
 * valid JSON; valid UTF-8 is passed through unchanged.
 * @param f   output stream
 * @param str NUL-terminated string (NULL is written as "")
 */
void widget_tree_write_string(FILE *f, const char *str);

#endif /* WIDGET_TREE_H */
