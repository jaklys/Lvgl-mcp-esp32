#ifndef SCREENSHOT_H
#define SCREENSHOT_H

#include "lvgl.h"

/**
 * Save the display's current frame as an RGB PNG file.
 *
 * Reads the active draw buffer (lv_display_get_buf_active) using its own
 * header (stride, color format), so it works for any buffer layout. The PNG
 * has the display's logical resolution, i.e. width and height are swapped
 * for 90/270 degree rotation.
 *
 * Supported buffer formats: XRGB8888, ARGB8888, RGB888, RGB565.
 *
 * @param filename output PNG path
 * @param disp     display to capture (render it first, e.g. lv_refr_now)
 * @param scale    integer nearest-neighbour upscale factor (1 = none)
 * @return 0 on success, -1 on failure (a reason is printed to stderr)
 */
int screenshot_save_png(const char *filename, lv_display_t *disp, int32_t scale);

/**
 * Save the top-left w x h pixels of `buf` as an RGB PNG (same formats and
 * scaling as screenshot_save_png).
 */
int screenshot_save_draw_buf(const char *filename, const lv_draw_buf_t *buf, int32_t w, int32_t h,
                             int32_t scale);

#endif /* SCREENSHOT_H */
