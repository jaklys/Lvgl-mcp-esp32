/**
 * @file main.c
 * Headless LVGL simulator: runs the user's create_ui(), advances simulated
 * time, then writes a PNG screenshot and a JSON widget tree.
 *
 * Streams: stderr carries every LVGL log line plus "[sim] ..." markers,
 * stdout carries only the user's own printf output.
 *
 * Exit codes: 0 ok, 1 bad arguments, 2 output file write failed,
 * 3 LVGL assertion / argument check failed, anything else = crash.
 */
#include "lvgl.h"
#include "display_driver.h"
#include "screenshot.h"
#include "sim_assert.h"
#include "widget_tree.h"

/* Pending-invalidation counter (inv_p) for --settle */
#include "src/display/lv_display_private.h"

#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <direct.h>
#define sim_chdir  _chdir
#define sim_getcwd _getcwd
#else
#include <unistd.h>
#define sim_chdir  chdir
#define sim_getcwd getcwd
#endif

#define FORMAT_VERSION  2
#define STEP_MS         33      /* one LVGL refresh period (LV_DEF_REFR_PERIOD) */
#define SETTLE_CAP_MS   3000    /* --settle stops at this total simulated time */
#define MAX_TIME_MS     60000
#define MAX_LOG_LINES   200
#define CWD_MAX         4096

/* Provided by user_code.c (compiled separately) */
extern void create_ui(void);

typedef struct {
    int32_t width;
    int32_t height;
    const char *png_path;
    const char *json_path;
    int32_t time_ms;
    bool settle;
    int32_t rotation;       /* degrees */
    bool dark;
    int32_t dpi;
    const char *assets_dir;
} sim_options_t;

/* Current phase, reported by the crash and assert handlers */
static const char *volatile current_phase = "init";

/* LVGL log lines collected for the JSON "logs" array */
static char *log_lines[MAX_LOG_LINES];
static uint32_t log_count;
static uint32_t log_dropped;

/**********************
 *  Diagnostics
 **********************/

static void set_phase(const char *phase)
{
    current_phase = phase;
    fprintf(stderr, "[sim] phase=%s\n", phase);
}

/**
 * LVGL log callback: forward the line verbatim to stderr and keep a copy
 * (without the trailing newline) for the JSON output.
 */
static void log_print_cb(lv_log_level_t level, const char *buf)
{
    LV_UNUSED(level);
    fputs(buf, stderr);

    if (log_count >= MAX_LOG_LINES) {
        log_dropped++;
        return;
    }
    size_t len = strlen(buf);
    while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r')) len--;
    char *line = (char *)malloc(len + 1);
    if (!line) return;
    memcpy(line, buf, len);
    line[len] = '\0';
    log_lines[log_count++] = line;
}

void sim_assert_fail(void)
{
    fprintf(stderr, "[sim] LVGL assertion failed in phase %s\n", current_phase);
    fflush(NULL);
    _exit(3);
}

#ifndef _WIN32
/** Append `s` to buf[*pos] (async-signal-safe helper) */
static void append_str(char *buf, size_t size, size_t *pos, const char *s)
{
    while (*s && *pos + 1 < size) buf[(*pos)++] = *s++;
}

/**
 * Report which phase crashed, then re-raise with the default action so the
 * parent still sees the signal. Only async-signal-safe calls are used.
 */
static void crash_handler(int sig)
{
    char msg[128];
    char num[12];
    size_t pos = 0;
    int n = 0;
    unsigned v = (unsigned)sig;

    do {
        num[n++] = (char)('0' + v % 10);
        v /= 10;
    } while (v && n < (int)sizeof(num));

    append_str(msg, sizeof(msg), &pos, "[sim] crashed: signal ");
    while (n > 0 && pos + 1 < sizeof(msg)) msg[pos++] = num[--n];
    append_str(msg, sizeof(msg), &pos, " in phase ");
    append_str(msg, sizeof(msg), &pos, current_phase);
    append_str(msg, sizeof(msg), &pos, "\n");
    if (write(STDERR_FILENO, msg, pos) < 0) {
        /* nothing else we can do */
    }

    signal(sig, SIG_DFL);
    raise(sig);
}

static void install_crash_handlers(void)
{
    signal(SIGSEGV, crash_handler);
    signal(SIGABRT, crash_handler);
    signal(SIGFPE, crash_handler);
    signal(SIGILL, crash_handler);
#ifdef SIGBUS
    signal(SIGBUS, crash_handler);   /* macOS reports some bad accesses as SIGBUS */
#endif
#ifdef SIGTRAP
    signal(SIGTRAP, crash_handler);  /* __builtin_trap() is brk on arm64 */
#endif
}
#endif /* _WIN32 */

/**********************
 *  Arguments
 **********************/

static void print_usage(FILE *out, const char *prog)
{
    fprintf(out,
            "Usage: %s --output-png PATH --output-json PATH [options]\n"
            "  --width N                 Display width, 16..4096 (default: 800)\n"
            "  --height N                Display height, 16..4096 (default: 480)\n"
            "  --output-png PATH         PNG screenshot path (required)\n"
            "  --output-json PATH        JSON widget tree path (required)\n"
            "  --time-ms N               Simulated time to advance before capture, in 33 ms\n"
            "                            steps, 0..%d (default: 330)\n"
            "  --ticks N                 Alias for --time-ms N*33\n"
            "  --settle                  Keep advancing until animations and redraws are done\n"
            "                            (at most %d ms simulated time in total)\n"
            "  --rotation 0|90|180|270   Display rotation (default: 0); the PNG has the\n"
            "                            rotated size\n"
            "  --theme light|dark        Default theme variant (default: light)\n"
            "  --dpi N                   Display DPI, 1..1000 (default: 130)\n"
            "  --assets-dir PATH         Directory served as LVGL drive 'S:' (default: cwd)\n"
            "  --help                    Show this help\n",
            prog, MAX_TIME_MS, SETTLE_CAP_MS);
}

/** Parse a decimal integer in [min, max]; the whole string must be consumed */
static bool parse_int(const char *s, long min, long max, int32_t *out)
{
    char *end = NULL;
    long v;

    if (!s || !*s) return false;
    v = strtol(s, &end, 10);
    if (*end != '\0' || v < min || v > max) return false;
    *out = (int32_t)v;
    return true;
}

/**
 * Parse argv into `opt`.
 * @return -1 to continue, otherwise the process exit code (0 for --help)
 */
static int parse_args(int argc, char *argv[], sim_options_t *opt)
{
    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        const char *val = NULL;
        bool ok = true;

        if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
            print_usage(stdout, argv[0]);
            return 0;
        }
        if (strcmp(arg, "--settle") == 0) {
            opt->settle = true;
            continue;
        }

        /* Every other option takes a value */
        if (strcmp(arg, "--width") != 0 && strcmp(arg, "--height") != 0 &&
            strcmp(arg, "--output-png") != 0 && strcmp(arg, "--output-json") != 0 &&
            strcmp(arg, "--time-ms") != 0 && strcmp(arg, "--ticks") != 0 &&
            strcmp(arg, "--rotation") != 0 && strcmp(arg, "--theme") != 0 &&
            strcmp(arg, "--dpi") != 0 && strcmp(arg, "--assets-dir") != 0) {
            fprintf(stderr, "Unknown argument: %s\n", arg);
            print_usage(stderr, argv[0]);
            return 1;
        }
        if (i + 1 >= argc) {
            fprintf(stderr, "Missing value for %s\n", arg);
            print_usage(stderr, argv[0]);
            return 1;
        }
        val = argv[++i];

        if (strcmp(arg, "--width") == 0) {
            ok = parse_int(val, 16, 4096, &opt->width);
        } else if (strcmp(arg, "--height") == 0) {
            ok = parse_int(val, 16, 4096, &opt->height);
        } else if (strcmp(arg, "--output-png") == 0) {
            opt->png_path = val;
        } else if (strcmp(arg, "--output-json") == 0) {
            opt->json_path = val;
        } else if (strcmp(arg, "--time-ms") == 0) {
            ok = parse_int(val, 0, MAX_TIME_MS, &opt->time_ms);
        } else if (strcmp(arg, "--ticks") == 0) {
            int32_t ticks;
            ok = parse_int(val, 0, MAX_TIME_MS / STEP_MS, &ticks);
            if (ok) opt->time_ms = ticks * STEP_MS;
        } else if (strcmp(arg, "--rotation") == 0) {
            ok = parse_int(val, 0, 270, &opt->rotation) && opt->rotation % 90 == 0;
        } else if (strcmp(arg, "--theme") == 0) {
            ok = strcmp(val, "light") == 0 || strcmp(val, "dark") == 0;
            opt->dark = strcmp(val, "dark") == 0;
        } else if (strcmp(arg, "--dpi") == 0) {
            ok = parse_int(val, 1, 1000, &opt->dpi);
        } else {
            opt->assets_dir = val;
        }

        if (!ok || !*val) {
            fprintf(stderr, "Invalid value for %s: '%s'\n", arg, val);
            print_usage(stderr, argv[0]);
            return 1;
        }
    }

    if (!opt->png_path || !opt->json_path) {
        fprintf(stderr, "Missing required option: %s\n",
                !opt->png_path ? "--output-png" : "--output-json");
        print_usage(stderr, argv[0]);
        return 1;
    }
    return -1;
}

/**********************
 *  Simulation
 **********************/

/** Advance simulated time by `ms` and run due LVGL timers (rendering included) */
static void step(uint32_t ms)
{
    lv_tick_inc(ms);
    lv_timer_handler();
}

/**
 * Run `time_ms` of simulated time, then (with `settle`) continue until no
 * animation runs and nothing is waiting to be redrawn.
 * @return the simulated time actually advanced, in ms
 */
static int32_t advance(lv_display_t *disp, int32_t time_ms, bool settle)
{
    int32_t elapsed = 0;

    while (elapsed < time_ms) {
        int32_t ms = time_ms - elapsed < STEP_MS ? time_ms - elapsed : STEP_MS;
        step((uint32_t)ms);
        elapsed += ms;
    }

    if (settle) {
        while (elapsed < SETTLE_CAP_MS &&
               (lv_anim_count_running() > 0 || disp->inv_p > 0)) {
            int32_t ms = SETTLE_CAP_MS - elapsed < STEP_MS ? SETTLE_CAP_MS - elapsed : STEP_MS;
            step((uint32_t)ms);
            elapsed += ms;
        }
    }
    return elapsed;
}

static const char *color_format_name(lv_color_format_t cf)
{
    switch (cf) {
        case LV_COLOR_FORMAT_XRGB8888: return "XRGB8888";
        case LV_COLOR_FORMAT_ARGB8888: return "ARGB8888";
        case LV_COLOR_FORMAT_RGB888:   return "RGB888";
        case LV_COLOR_FORMAT_RGB565:   return "RGB565";
        default:                       return "other";
    }
}

/**
 * Write the JSON document (format_version 2). The layers are included only
 * when they have children.
 * @return 0 on success, -1 if the file could not be written
 */
static int write_json(const char *path, lv_display_t *disp, const sim_options_t *opt,
                      int32_t elapsed_ms, uint32_t anims_running)
{
    FILE *f = fopen(path, "wb");
    if (!f) return -1;

    fprintf(f, "{\"format_version\":%d,\"lvgl_version\":\"%d.%d.%d\"", FORMAT_VERSION,
            lv_version_major(), lv_version_minor(), lv_version_patch());
    fprintf(f, ",\"display\":{\"width\":%d,\"height\":%d,\"rotation\":%d,\"dpi\":%d,"
            "\"color_format\":\"%s\",\"theme\":\"%s\"}",
            (int)lv_display_get_horizontal_resolution(disp),
            (int)lv_display_get_vertical_resolution(disp),
            (int)opt->rotation, (int)lv_display_get_dpi(disp),
            color_format_name(lv_display_get_color_format(disp)),
            opt->dark ? "dark" : "light");
    fprintf(f, ",\"elapsed_ms\":%d,\"anims_running\":%u", (int)elapsed_ms, (unsigned)anims_running);

    fputs(",\"logs\":[", f);
    for (uint32_t i = 0; i < log_count; i++) {
        if (i > 0) fputc(',', f);
        widget_tree_write_string(f, log_lines[i]);
    }
    if (log_dropped > 0) {
        fprintf(f, "%s\"... (%u more)\"", log_count > 0 ? "," : "", (unsigned)log_dropped);
    }
    fputc(']', f);

    fputs(",\"screen\":", f);
    widget_tree_write_node(f, lv_display_get_screen_active(disp));

    lv_obj_t *top = lv_display_get_layer_top(disp);
    if (lv_obj_get_child_count(top) > 0) {
        fputs(",\"layer_top\":", f);
        widget_tree_write_node(f, top);
    }
    lv_obj_t *sys = lv_display_get_layer_sys(disp);
    if (lv_obj_get_child_count(sys) > 0) {
        fputs(",\"layer_sys\":", f);
        widget_tree_write_node(f, sys);
    }
    fputs("}\n", f);

    bool failed = ferror(f) != 0;
    if (fclose(f) != 0) failed = true;
    return failed ? -1 : 0;
}

int main(int argc, char *argv[])
{
    sim_options_t opt = {
        .width = 800,
        .height = 480,
        .time_ms = 10 * STEP_MS,
        .dpi = LV_DPI_DEF,
    };
    char orig_cwd[CWD_MAX];
    int exit_code = 0;

    /* User printf output must survive a crash right after it */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    int rc = parse_args(argc, argv, &opt);
    if (rc >= 0) return rc;

    /*
     * Relative "S:" paths resolve against the assets directory. Remember the
     * original directory so relative output paths keep working.
     */
    if (!sim_getcwd(orig_cwd, CWD_MAX)) {
        fprintf(stderr, "Cannot determine the current directory\n");
        return 1;
    }
    if (opt.assets_dir && sim_chdir(opt.assets_dir) != 0) {
        fprintf(stderr, "Cannot open assets directory: %s\n", opt.assets_dir);
        return 1;
    }

#ifndef _WIN32
    install_crash_handlers();
#endif

    lv_init();
    lv_log_register_print_cb(log_print_cb); /* after lv_init, which resets globals */

    lv_display_t *disp = headless_display_init(opt.width, opt.height);
    if (!disp) {
        fprintf(stderr, "Failed to initialize display\n");
        return 1;
    }
    lv_display_set_dpi(disp, opt.dpi);
    lv_display_set_rotation(disp, (lv_display_rotation_t)(opt.rotation / 90));

#if LV_USE_THEME_DEFAULT
    /* Re-init the theme so it picks up the DPI, rotated size and variant */
    lv_theme_t *theme = lv_theme_default_init(disp, lv_palette_main(LV_PALETTE_BLUE),
                                              lv_palette_main(LV_PALETTE_RED), opt.dark,
                                              LV_FONT_DEFAULT);
    lv_display_set_theme(disp, theme);
#endif

    set_phase("create_ui");
    create_ui();

    set_phase("advance");
    int32_t elapsed_ms = advance(disp, opt.time_ms, opt.settle);

    set_phase("capture");
    lv_obj_update_layout(lv_display_get_screen_active(disp));
    lv_refr_now(disp);
    uint32_t anims_running = lv_anim_count_running();

    /* Rendering (and image decoding) is done; outputs are relative to the original cwd */
    if (opt.assets_dir && sim_chdir(orig_cwd) != 0) {
        fprintf(stderr, "Cannot return to directory: %s\n", orig_cwd);
        return 2;
    }

    if (screenshot_save_png(opt.png_path, disp) != 0) {
        fprintf(stderr, "[sim] failed to write PNG: %s\n", opt.png_path);
        exit_code = 2;
    }

    set_phase("export");
    if (write_json(opt.json_path, disp, &opt, elapsed_ms, anims_running) != 0) {
        fprintf(stderr, "[sim] failed to write JSON: %s\n", opt.json_path);
        exit_code = 2;
    }

    /*
     * No LVGL teardown: deleting the widgets would run user delete callbacks
     * after the outputs are written, and the OS reclaims everything anyway.
     */
    return exit_code;
}
