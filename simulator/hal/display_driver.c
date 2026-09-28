#include "display_driver.h"
#include <stdlib.h>

/**
 * Flush callback. In DIRECT mode LVGL renders straight into the full-screen
 * draw buffer, which therefore always holds the complete current frame in
 * logical (rotated) orientation. There is no panel to send it to.
 */
static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    LV_UNUSED(area);
    LV_UNUSED(px_map);
    lv_display_flush_ready(disp);
}

lv_display_t *headless_display_init(int32_t width, int32_t height, lv_color_format_t cf)
{
    lv_display_t *display = lv_display_create(width, height);
    if (!display) return NULL;
    lv_display_set_color_format(display, cf);

    /*
     * With auto stride, LVGL reshapes the draw buffer to the logical
     * resolution on every refresh, so after a 90/270 degree rotation the
     * rows are `height` pixels wide. Allocate enough for either orientation.
     */
    uint32_t size_0  = lv_draw_buf_width_to_stride((uint32_t)width, cf) * (uint32_t)height;
    uint32_t size_90 = lv_draw_buf_width_to_stride((uint32_t)height, cf) * (uint32_t)width;
    uint32_t buf_size = size_0 > size_90 ? size_0 : size_90;

    /*
     * Over-allocate so the start can be aligned to LV_DRAW_BUF_ALIGN.
     * Plain malloc(), not lv_malloc(): the frame buffer is not part of the
     * LVGL heap statistics ("mem" in the JSON), just like a frame buffer in
     * PSRAM/DMA memory on the device is not part of LV_MEM_SIZE.
     */
    void *buf_mem = malloc((size_t)buf_size + LV_DRAW_BUF_ALIGN);
    if (!buf_mem) {
        lv_display_delete(display);
        return NULL;
    }

    lv_display_set_buffers(display, lv_draw_buf_align(buf_mem, cf), NULL, buf_size,
                           LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(display, flush_cb);

    return display;
}
