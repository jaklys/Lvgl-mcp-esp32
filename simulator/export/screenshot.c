#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
#include "screenshot.h"
#include <stdlib.h>

int screenshot_save_png(const char *filename, const uint8_t *framebuffer,
                        uint32_t width, uint32_t height)
{
    /*
     * LVGL XRGB8888 on little-endian x86:
     *   byte[0] = Blue
     *   byte[1] = Green
     *   byte[2] = Red
     *   byte[3] = X (unused / padding)
     *
     * stb_image_write expects RGB (3 channels) or RGBA (4 channels).
     * We convert to RGB to keep PNG size smaller.
     */
    uint32_t pixel_count = width * height;
    uint8_t *rgb = (uint8_t *)malloc(pixel_count * 3);
    if (!rgb) return -1;

    for (uint32_t i = 0; i < pixel_count; i++) {
        uint32_t src = i * 4;
        uint32_t dst = i * 3;
        rgb[dst + 0] = framebuffer[src + 2]; /* R */
        rgb[dst + 1] = framebuffer[src + 1]; /* G */
        rgb[dst + 2] = framebuffer[src + 0]; /* B */
    }

    int result = stbi_write_png(filename, (int)width, (int)height, 3, rgb,
                                (int)(width * 3));
    free(rgb);
    return result ? 0 : -1;
}
