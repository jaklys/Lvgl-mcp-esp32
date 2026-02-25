#ifndef DISPLAY_DRIVER_H
#define DISPLAY_DRIVER_H

#include "lvgl.h"

/**
 * Initialize a headless display driver that renders to an in-memory framebuffer.
 * @param width  display width in pixels
 * @param height display height in pixels
 * @return the created lv_display_t, or NULL on failure
 */
lv_display_t *headless_display_init(int32_t width, int32_t height);

/**
 * Get a pointer to the rendered framebuffer (XRGB8888 format, 4 bytes/pixel).
 * Valid after at least one call to lv_timer_handler().
 */
uint8_t *headless_display_get_framebuffer(void);

/**
 * Get the current display width.
 */
int32_t headless_display_get_width(void);

/**
 * Get the current display height.
 */
int32_t headless_display_get_height(void);

/**
 * Free resources allocated by the display driver.
 */
void headless_display_deinit(void);

#endif /* DISPLAY_DRIVER_H */
