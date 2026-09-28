/**
 * @file annotate.h
 * Annotated screenshot: the current frame with a 1 px outline around every
 * visible object (colour by depth) and a small label with the object's name
 * or "<type>#<index>" path.
 *
 * The overlay is drawn with LVGL's own renderer (lv_draw_rect/lv_draw_label)
 * into a malloc'ed copy of the frame held by a temporary canvas on an
 * unloaded screen, which is deleted afterwards. Nothing is added to the
 * active screen or its layers, so layout, the widget tree and the real
 * frame buffer are never affected.
 */
#ifndef SIM_ANNOTATE_H
#define SIM_ANNOTATE_H

#include "lvgl.h"

/** Write the annotated PNG of the current frame; 0 on success, -1 on failure */
int annotate_save_png(const char *filename, lv_display_t *disp, int32_t scale);

#endif /* SIM_ANNOTATE_H */
