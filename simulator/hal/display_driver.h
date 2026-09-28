#ifndef DISPLAY_DRIVER_H
#define DISPLAY_DRIVER_H

#include "lvgl.h"

/**
 * Initialize a headless display that renders into one full-screen draw
 * buffer (LV_DISPLAY_RENDER_MODE_DIRECT). The buffer is sized so that it can
 * hold the frame in either orientation, so lv_display_set_rotation() may be
 * called afterwards. Read the rendered frame with lv_display_get_buf_active().
 * The buffer lives for the rest of the process.
 * @param width  physical display width in pixels
 * @param height physical display height in pixels
 * @param cf     color format of the frame buffer (XRGB8888 or RGB565)
 * @return the created lv_display_t, or NULL on failure
 */
lv_display_t *headless_display_init(int32_t width, int32_t height, lv_color_format_t cf);

#endif /* DISPLAY_DRIVER_H */
