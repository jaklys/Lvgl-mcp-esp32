#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"
#include "screenshot.h"

#include <stdio.h>
#include <stdlib.h>

/**
 * Convert one row of `w` pixels in color format `cf` to packed RGB.
 * @return false if the color format is not supported
 */
static bool row_to_rgb(uint8_t *dst, const uint8_t *src, int32_t w, lv_color_format_t cf)
{
    int32_t x;

    switch (cf) {
        case LV_COLOR_FORMAT_XRGB8888:
        case LV_COLOR_FORMAT_ARGB8888:
            /* Little-endian memory order: B, G, R, X/A (alpha ignored) */
            for (x = 0; x < w; x++, src += 4, dst += 3) {
                dst[0] = src[2];
                dst[1] = src[1];
                dst[2] = src[0];
            }
            return true;
        case LV_COLOR_FORMAT_RGB888:
            /* Memory order: B, G, R */
            for (x = 0; x < w; x++, src += 3, dst += 3) {
                dst[0] = src[2];
                dst[1] = src[1];
                dst[2] = src[0];
            }
            return true;
        case LV_COLOR_FORMAT_RGB565:
            for (x = 0; x < w; x++, src += 2, dst += 3) {
                uint16_t px = (uint16_t)(src[0] | (src[1] << 8));
                uint8_t r = (uint8_t)((px >> 11) & 0x1F);
                uint8_t g = (uint8_t)((px >> 5) & 0x3F);
                uint8_t b = (uint8_t)(px & 0x1F);
                dst[0] = (uint8_t)((r << 3) | (r >> 2));
                dst[1] = (uint8_t)((g << 2) | (g >> 4));
                dst[2] = (uint8_t)((b << 3) | (b >> 2));
            }
            return true;
        default:
            return false;
    }
}

int screenshot_save_png(const char *filename, lv_display_t *disp)
{
    lv_draw_buf_t *buf = lv_display_get_buf_active(disp);
    if (!buf || !buf->data) {
        fprintf(stderr, "[sim] screenshot: display has no draw buffer\n");
        return -1;
    }

    /* Logical resolution: already swapped by LVGL for 90/270 rotation */
    int32_t w = lv_display_get_horizontal_resolution(disp);
    int32_t h = lv_display_get_vertical_resolution(disp);
    lv_color_format_t cf = (lv_color_format_t)buf->header.cf;
    uint32_t px_size = lv_color_format_get_size(cf);
    uint32_t stride = buf->header.stride;

    /* The buffer must cover the whole logical frame before we read it */
    if (w <= 0 || h <= 0 || px_size == 0 ||
        (int32_t)buf->header.w < w || (int32_t)buf->header.h < h ||
        stride < (uint32_t)w * px_size ||
        (uint64_t)stride * (uint64_t)(h - 1) + (uint64_t)w * px_size > buf->data_size) {
        fprintf(stderr,
                "[sim] screenshot: draw buffer %ux%u (stride %u, cf %u, %u bytes) "
                "does not cover %dx%d\n",
                (unsigned)buf->header.w, (unsigned)buf->header.h, (unsigned)stride,
                (unsigned)cf, (unsigned)buf->data_size, (int)w, (int)h);
        return -1;
    }

    uint8_t *rgb = (uint8_t *)malloc((size_t)w * (size_t)h * 3);
    if (!rgb) {
        fprintf(stderr, "[sim] screenshot: out of memory\n");
        return -1;
    }

    for (int32_t y = 0; y < h; y++) {
        const uint8_t *src = buf->data + (size_t)y * stride;
        if (!row_to_rgb(rgb + (size_t)y * (size_t)w * 3, src, w, cf)) {
            fprintf(stderr, "[sim] screenshot: unsupported color format %u\n", (unsigned)cf);
            free(rgb);
            return -1;
        }
    }

    /* Encode in memory so that write errors (e.g. disk full) are detected;
     * stbi_write_png() does not check fwrite/fclose. */
    int png_len = 0;
    unsigned char *png = stbi_write_png_to_mem(rgb, (int)(w * 3), (int)w, (int)h, 3, &png_len);
    free(rgb);
    if (!png) {
        fprintf(stderr, "[sim] screenshot: PNG encoding failed\n");
        return -1;
    }

    FILE *f = fopen(filename, "wb");
    bool ok = f != NULL && fwrite(png, 1, (size_t)png_len, f) == (size_t)png_len;
    if (f && fclose(f) != 0) ok = false;
    STBIW_FREE(png);
    return ok ? 0 : -1;
}
