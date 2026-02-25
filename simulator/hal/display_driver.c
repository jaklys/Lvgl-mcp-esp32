#include "display_driver.h"
#include <stdlib.h>
#include <string.h>

static uint8_t *framebuffer = NULL;
static uint8_t *draw_buf    = NULL;
static int32_t disp_width   = 0;
static int32_t disp_height  = 0;
static lv_display_t *display = NULL;

/**
 * Flush callback: copy rendered pixels from LVGL draw buffer into our
 * persistent framebuffer. With FULL render mode the area covers the
 * entire display, so px_map contains a complete frame.
 */
static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    int32_t w = lv_area_get_width(area);
    int32_t h = lv_area_get_height(area);
    int32_t stride = disp_width * 4; /* 4 bytes per pixel (XRGB8888) */

    for (int32_t y = 0; y < h; y++) {
        int32_t fb_offset = ((area->y1 + y) * disp_width + area->x1) * 4;
        int32_t px_offset = y * w * 4;
        memcpy(&framebuffer[fb_offset], &px_map[px_offset], (size_t)(w * 4));
    }

    lv_display_flush_ready(disp);
    (void)stride;
}

lv_display_t *headless_display_init(int32_t width, int32_t height)
{
    disp_width  = width;
    disp_height = height;

    uint32_t buf_size = (uint32_t)(width * height * 4);

    framebuffer = (uint8_t *)malloc(buf_size);
    if (!framebuffer) return NULL;
    memset(framebuffer, 0xFF, buf_size); /* white background */

    draw_buf = (uint8_t *)malloc(buf_size);
    if (!draw_buf) {
        free(framebuffer);
        framebuffer = NULL;
        return NULL;
    }

    display = lv_display_create(width, height);
    lv_display_set_buffers(display, draw_buf, NULL, buf_size,
                           LV_DISPLAY_RENDER_MODE_FULL);
    lv_display_set_flush_cb(display, flush_cb);

    return display;
}

uint8_t *headless_display_get_framebuffer(void)
{
    return framebuffer;
}

int32_t headless_display_get_width(void)
{
    return disp_width;
}

int32_t headless_display_get_height(void)
{
    return disp_height;
}

void headless_display_deinit(void)
{
    if (display) {
        lv_display_delete(display);
        display = NULL;
    }
    free(draw_buf);
    draw_buf = NULL;
    free(framebuffer);
    framebuffer = NULL;
    disp_width  = 0;
    disp_height = 0;
}
