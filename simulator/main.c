/**
 * @file main.c
 * Headless LVGL simulator: builds the UI (the user's create_ui() or a JSON
 * UI document), advances simulated time, optionally runs an action script
 * or frame captures, then writes PNG screenshot(s) and a JSON document
 * (widget tree, captures, diagnostics, memory, events).
 *
 * Streams: stderr carries every LVGL log line plus "[sim] ..." markers,
 * stdout carries only the user's own printf output.
 *
 * Exit codes: 0 ok, 1 bad arguments, 2 output file write failed,
 * 3 LVGL assertion / argument check failed, 5 UI document error,
 * 6 action script error, anything else = crash.
 */
#include "lvgl.h"
#include "actions.h"
#include "display_driver.h"
#include "events.h"
#include "indev.h"
#include "sim_assert.h"
#include "sim_runtime.h"
#include "ui_doc.h"

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

/* Provided by user_code.c (compiled separately) */
extern void create_ui(void);

/**********************
 *  Diagnostics
 **********************/

/**
 * LVGL log callback: forward the line verbatim to stderr and keep a copy
 * (without the trailing newline) for the JSON output.
 */
static void log_print_cb(lv_log_level_t level, const char *buf)
{
    LV_UNUSED(level);
    fputs(buf, stderr);
    sim_store_log(buf);
}

void sim_assert_fail(void)
{
    fprintf(stderr, "[sim] LVGL assertion failed in phase %s\n", sim_get_phase());
    fflush(NULL);
    _exit(SIM_EXIT_ASSERT);
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
    append_str(msg, sizeof(msg), &pos, sim_get_phase());
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
            "  --output-png PATH         PNG of the final frame (required)\n"
            "  --output-json PATH        JSON document (required)\n"
            "  --time-ms N               Simulated time to advance after building the UI, in\n"
            "                            33 ms steps, 0..%d (default: 330)\n"
            "  --ticks N                 Alias for --time-ms N*33\n"
            "  --settle                  Keep advancing until animations and redraws are done\n"
            "                            (at most %d ms simulated time in total)\n"
            "  --rotation 0|90|180|270   Display rotation (default: 0); the PNG has the\n"
            "                            rotated size\n"
            "  --theme light|dark        Default theme variant (default: light)\n"
            "  --dpi N                   Display DPI, 1..1000 (default: 130)\n"
            "  --assets-dir PATH         Directory served as LVGL drive 'S:' (default: cwd)\n"
            "  --actions PATH            JSON action script (click, drag, key, type, capture, ...);\n"
            "                            runs after --time-ms/--settle\n"
            "  --frames T1,T2,...        Capture at these simulated times in ms after the UI is\n"
            "                            built (ascending, up to %d); labels \"t<ms>\";\n"
            "                            --time-ms/--settle do not apply\n"
            "  --output-dir DIR          Directory for capture-<n>-<label>.png and\n"
            "                            annotated-<n>-<label>.png (default: directory of\n"
            "                            --output-png)\n"
            "  --annotate                Also write annotated PNGs (outlines + names)\n"
            "  --scale N                 Integer PNG upscale 1..4 (default: 1)\n"
            "  --color-format xrgb8888|rgb565\n"
            "                            Frame buffer format (default: xrgb8888)\n"
            "  --fonts A,B,...           Fonts available on the device (e.g. montserrat_14);\n"
            "                            others are reported as FONT_NOT_ON_DEVICE\n"
            "  --mem-budget-kb N         Device LV_MEM_SIZE in KB; MEM_OVER_BUDGET when the LVGL\n"
            "                            heap peak exceeds it\n"
            "  --ui PATH                 Build the UI from a JSON UI document instead of\n"
            "                            create_ui()\n"
            "  --help                    Show this help\n"
            "Exit codes: 0 ok, 1 bad arguments, 2 output write failed, 3 LVGL assertion,\n"
            "5 UI document error, 6 action script error.\n",
            prog, SIM_MAX_TIME_MS, SIM_SETTLE_CAP_MS, SIM_MAX_FRAMES);
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

/** "0,100,300": ascending integers 0..SIM_MAX_TIME_MS */
static bool parse_frames(const char *s, sim_options_t *opt)
{
    char buf[1024];
    if (strlen(s) >= sizeof(buf)) return false;
    strcpy(buf, s);
    opt->frame_count = 0;
    for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
        int32_t v;
        if (opt->frame_count >= SIM_MAX_FRAMES || !parse_int(tok, 0, SIM_MAX_TIME_MS, &v)) return false;
        if (opt->frame_count > 0 && v < opt->frames[opt->frame_count - 1]) return false;
        opt->frames[opt->frame_count++] = v;
    }
    return opt->frame_count > 0;
}

/** "a,b,c" -> opt->fonts (points into argv) */
static bool parse_fonts(char *s, sim_options_t *opt)
{
    opt->font_count = 0;
    opt->fonts_given = true;
    for (char *tok = strtok(s, ","); tok; tok = strtok(NULL, ",")) {
        while (*tok == ' ') tok++;
        size_t n = strlen(tok);
        while (n > 0 && tok[n - 1] == ' ') tok[--n] = '\0';
        if (!n) continue;
        if (opt->font_count >= SIM_MAX_FONTS) return false;
        opt->fonts[opt->font_count++] = tok;
    }
    return true;
}

static const char *const value_options[] = {
    "--width", "--height", "--output-png", "--output-json", "--time-ms", "--ticks", "--rotation", "--theme",
    "--dpi", "--assets-dir", "--actions", "--output-dir", "--frames", "--scale", "--color-format", "--fonts",
    "--mem-budget-kb", "--ui",
};

/**
 * Parse argv into `opt`.
 * @return -1 to continue, otherwise the process exit code (0 for --help)
 */
static int parse_args(int argc, char *argv[], sim_options_t *opt)
{
    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        char *val = NULL;
        bool ok = true;
        bool known = false;

        if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
            print_usage(stdout, argv[0]);
            return 0;
        }
        if (strcmp(arg, "--settle") == 0) {
            opt->settle = true;
            continue;
        }
        if (strcmp(arg, "--annotate") == 0) {
            opt->annotate = true;
            continue;
        }

        /* Every other option takes a value */
        for (size_t k = 0; k < sizeof(value_options) / sizeof(value_options[0]); k++) {
            known = known || strcmp(arg, value_options[k]) == 0;
        }
        if (!known) {
            fprintf(stderr, "Unknown argument: %s\n", arg);
            print_usage(stderr, argv[0]);
            return SIM_EXIT_ARGS;
        }
        if (i + 1 >= argc) {
            fprintf(stderr, "Missing value for %s\n", arg);
            print_usage(stderr, argv[0]);
            return SIM_EXIT_ARGS;
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
            ok = parse_int(val, 0, SIM_MAX_TIME_MS, &opt->time_ms);
        } else if (strcmp(arg, "--ticks") == 0) {
            int32_t ticks;
            ok = parse_int(val, 0, SIM_MAX_TIME_MS / SIM_STEP_MS, &ticks);
            if (ok) opt->time_ms = ticks * SIM_STEP_MS;
        } else if (strcmp(arg, "--rotation") == 0) {
            ok = parse_int(val, 0, 270, &opt->rotation) && opt->rotation % 90 == 0;
        } else if (strcmp(arg, "--theme") == 0) {
            ok = strcmp(val, "light") == 0 || strcmp(val, "dark") == 0;
            opt->dark = strcmp(val, "dark") == 0;
        } else if (strcmp(arg, "--dpi") == 0) {
            ok = parse_int(val, 1, 1000, &opt->dpi);
        } else if (strcmp(arg, "--assets-dir") == 0) {
            opt->assets_dir = val;
        } else if (strcmp(arg, "--actions") == 0) {
            opt->actions_path = val;
        } else if (strcmp(arg, "--output-dir") == 0) {
            opt->output_dir = val;
        } else if (strcmp(arg, "--frames") == 0) {
            ok = parse_frames(val, opt);
        } else if (strcmp(arg, "--scale") == 0) {
            ok = parse_int(val, 1, 4, &opt->scale);
        } else if (strcmp(arg, "--color-format") == 0) {
            ok = strcmp(val, "xrgb8888") == 0 || strcmp(val, "rgb565") == 0;
            opt->rgb565 = strcmp(val, "rgb565") == 0;
        } else if (strcmp(arg, "--fonts") == 0) {
            ok = parse_fonts(val, opt);
            if (!ok) {
                fprintf(stderr, "Invalid value for --fonts: at most %d fonts\n", SIM_MAX_FONTS);
                return SIM_EXIT_ARGS;
            }
            continue; /* an empty list is allowed: no built-in font on the device */
        } else if (strcmp(arg, "--mem-budget-kb") == 0) {
            ok = parse_int(val, 1, 1024 * 1024, &opt->mem_budget_kb);
        } else if (strcmp(arg, "--ui") == 0) {
            opt->ui_path = val;
        }

        if (!ok || !*val) {
            fprintf(stderr, "Invalid value for %s: '%s'\n", arg, val);
            print_usage(stderr, argv[0]);
            return SIM_EXIT_ARGS;
        }
    }

    if (!opt->png_path || !opt->json_path) {
        fprintf(stderr, "Missing required option: %s\n", !opt->png_path ? "--output-png" : "--output-json");
        print_usage(stderr, argv[0]);
        return SIM_EXIT_ARGS;
    }
    if (opt->actions_path && opt->frame_count > 0) {
        fprintf(stderr, "--frames and --actions cannot be combined; use wait + capture actions instead\n");
        return SIM_EXIT_ARGS;
    }
    return -1;
}

/**********************
 *  Main
 **********************/

int main(int argc, char *argv[])
{
    static char orig_cwd[SIM_PATH_MAX];
    sim_options_t *opt = &sim.opt;
    static sim_actions_t *script; /* static: survives the longjmp out of create_ui() */
    char err[1024];

    opt->width = 800;
    opt->height = 480;
    opt->time_ms = 10 * SIM_STEP_MS;
    opt->dpi = LV_DPI_DEF;
    opt->scale = 1;

    /* User printf output must survive a crash right after it */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    int rc = parse_args(argc, argv, opt);
    if (rc >= 0) return rc;

    /*
     * Relative "S:" paths resolve against the assets directory. Output
     * paths are made absolute first so they keep pointing to the original
     * directory.
     */
    if (!sim_getcwd(orig_cwd, SIM_PATH_MAX)) {
        fprintf(stderr, "Cannot determine the current directory\n");
        return SIM_EXIT_ARGS;
    }
    if (!sim_resolve_paths(orig_cwd)) {
        fprintf(stderr, "Output path too long\n");
        return SIM_EXIT_ARGS;
    }

    /* Validate the script before anything runs: exit 6 on any error */
    if (opt->actions_path) {
        script = actions_load(opt->actions_path, err, sizeof(err));
        if (!script) {
            fprintf(stderr, "[sim] %s\n", err);
            return SIM_EXIT_ACTIONS;
        }
        sim.actions_given = true;
    } else if (opt->frame_count > 0) {
        script = actions_from_frames(opt->frames, opt->frame_count);
    }

    if (opt->assets_dir && sim_chdir(opt->assets_dir) != 0) {
        fprintf(stderr, "Cannot open assets directory: %s\n", opt->assets_dir);
        return SIM_EXIT_ARGS;
    }

#ifndef _WIN32
    install_crash_handlers();
#endif

    lv_init();
    lv_log_register_print_cb(log_print_cb); /* after lv_init, which resets globals */

    lv_display_t *disp = headless_display_init(opt->width, opt->height,
                                               opt->rgb565 ? LV_COLOR_FORMAT_RGB565 : LV_COLOR_FORMAT_XRGB8888);
    if (!disp) {
        fprintf(stderr, "Failed to initialize display\n");
        return SIM_EXIT_ARGS;
    }
    sim.disp = disp;
    lv_display_set_dpi(disp, opt->dpi);
    lv_display_set_rotation(disp, (lv_display_rotation_t)(opt->rotation / 90));

#if LV_USE_THEME_DEFAULT
    /* Re-init the theme so it picks up the DPI, rotated size and variant */
    lv_theme_t *theme = lv_theme_default_init(disp, lv_palette_main(LV_PALETTE_BLUE),
                                              lv_palette_main(LV_PALETTE_RED), opt->dark,
                                              LV_FONT_DEFAULT);
    lv_display_set_theme(disp, theme);
#endif

    /* Input devices exist before the UI is built (contract section 2) */
    if (sim.actions_given) sim_input_init(disp, actions_need_keypad(script));

    if (opt->ui_path) {
        sim_set_phase("ui_load");
        rc = ui_doc_load(opt->ui_path, disp);
        if (rc != SIM_EXIT_OK) return rc;
    } else {
        sim_set_phase("create_ui");
        if (setjmp(sim.loop_escape) == 0) {
            sim.in_user_entry = true;
            create_ui();
        }
        sim.in_user_entry = false;
    }

    /*
     * 2.1.0 behaviour: advance --time-ms (and --settle). With --frames the
     * frame times are measured from here instead. After a detected
     * application loop the UI has already run for 5 s.
     */
    sim_set_phase("advance");
    if (!sim.loop_detected && opt->frame_count == 0) {
        int32_t start = sim.elapsed_ms;
        sim_run_for(opt->time_ms);
        /* 2.1.0 criterion: any animation (incl. infinite ones) or a pending redraw */
        while (opt->settle && sim.elapsed_ms - start < SIM_SETTLE_CAP_MS &&
               (lv_anim_count_running() > 0 || sim_display_dirty())) {
            int32_t left = SIM_SETTLE_CAP_MS - (sim.elapsed_ms - start);
            sim_step((uint32_t)(left < SIM_STEP_MS ? left : SIM_STEP_MS));
        }
    }

    if (script) {
        sim_set_phase("actions");
        if (sim.actions_given) {
            events_init(disp);
            events_attach_all(disp);
            sim_input_sync_group(disp);
        }
        rc = actions_run(script);
        actions_free(script);
        if (rc == SIM_EXIT_ACTIONS) return rc;
    }

    rc = sim_finish();

    /*
     * No LVGL teardown: deleting the widgets would run user delete callbacks
     * after the outputs are written, and the OS reclaims everything anyway.
     */
    return rc;
}
