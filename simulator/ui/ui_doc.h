/**
 * @file ui_doc.h
 * JSON UI documents (contract section 10): a runtime interpreter that builds
 * LVGL objects from a JSON description whose vocabulary mirrors the widget
 * tree output (same type names, style keys and enum strings).
 */
#ifndef SIM_UI_DOC_H
#define SIM_UI_DOC_H

#include "lvgl.h"

/**
 * Parse, validate and build the document at `path` on `disp`.
 * Every problem is printed to stderr as "ui: <json-path>: <message>"
 * (all of them, sorted by path).
 * @return 0, or SIM_EXIT_UI on any error
 */
int ui_doc_load(const char *path, lv_display_t *disp);

#endif /* SIM_UI_DOC_H */
