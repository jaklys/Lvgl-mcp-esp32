#ifndef WIDGET_TREE_H
#define WIDGET_TREE_H

#include "lvgl.h"

/**
 * Dump the widget tree rooted at `root` as JSON to a file.
 * @param filename output JSON path
 * @param root     root object (typically lv_screen_active())
 * @return 0 on success, -1 on failure
 */
int widget_tree_dump_json(const char *filename, lv_obj_t *root);

#endif /* WIDGET_TREE_H */
