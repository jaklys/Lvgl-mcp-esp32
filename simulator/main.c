#include "lvgl.h"
#include "display_driver.h"
#include "screenshot.h"
#include "widget_tree.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Provided by user_code.c (compiled separately) */
extern void create_ui(void);

static void print_usage(const char *prog)
{
    fprintf(stderr, "Usage: %s [options]\n", prog);
    fprintf(stderr, "  --width N       Display width  (default: 800)\n");
    fprintf(stderr, "  --height N      Display height (default: 480)\n");
    fprintf(stderr, "  --output-png F  PNG output path (default: output.png)\n");
    fprintf(stderr, "  --output-json F JSON output path (default: output.json)\n");
    fprintf(stderr, "  --ticks N       Number of LVGL tick iterations (default: 10)\n");
}

int main(int argc, char *argv[])
{
    int32_t width  = 800;
    int32_t height = 480;
    const char *png_path  = "output.png";
    const char *json_path = "output.json";
    int ticks = 10;

    /* Parse command-line arguments */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--output-png") == 0 && i + 1 < argc) {
            png_path = argv[++i];
        } else if (strcmp(argv[i], "--output-json") == 0 && i + 1 < argc) {
            json_path = argv[++i];
        } else if (strcmp(argv[i], "--ticks") == 0 && i + 1 < argc) {
            ticks = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "Unknown argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }

    if (width < 1 || height < 1 || width > 4096 || height > 4096) {
        fprintf(stderr, "Invalid resolution: %dx%d\n", (int)width, (int)height);
        return 1;
    }

    /* Initialize LVGL */
    lv_init();

    /* Initialize headless display */
    lv_display_t *disp = headless_display_init(width, height);
    if (!disp) {
        fprintf(stderr, "Failed to initialize display\n");
        return 1;
    }

    /* Call user's UI creation function */
    create_ui();

    /* Run LVGL timer handler to process layout and rendering */
    for (int i = 0; i < ticks; i++) {
        lv_tick_inc(33);
        lv_timer_handler();
    }

    /* Export screenshot */
    uint8_t *fb = headless_display_get_framebuffer();
    if (screenshot_save_png(png_path, fb, (uint32_t)width, (uint32_t)height) != 0) {
        fprintf(stderr, "Failed to save screenshot to %s\n", png_path);
        /* Non-fatal: continue to export JSON */
    } else {
        fprintf(stderr, "Screenshot saved: %s (%dx%d)\n", png_path, (int)width, (int)height);
    }

    /* Export widget tree */
    lv_obj_t *screen = lv_screen_active();
    if (widget_tree_dump_json(json_path, screen) != 0) {
        fprintf(stderr, "Failed to save widget tree to %s\n", json_path);
    } else {
        fprintf(stderr, "Widget tree saved: %s\n", json_path);
    }

    /* Cleanup */
    headless_display_deinit();

    return 0;
}
