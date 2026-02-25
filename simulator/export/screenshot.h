#ifndef SCREENSHOT_H
#define SCREENSHOT_H

#include <stdint.h>

/**
 * Save the framebuffer as a PNG file.
 *
 * The framebuffer is expected to be in XRGB8888 format (LVGL 32-bit color depth)
 * with little-endian byte order: B, G, R, X per pixel in memory.
 *
 * @param filename   output PNG path
 * @param framebuffer raw pixel data
 * @param width      image width
 * @param height     image height
 * @return 0 on success, -1 on failure
 */
int screenshot_save_png(const char *filename, const uint8_t *framebuffer,
                        uint32_t width, uint32_t height);

#endif /* SCREENSHOT_H */
