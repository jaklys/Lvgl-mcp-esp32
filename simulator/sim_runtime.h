/**
 * @file sim_runtime.h
 * Shared simulator state and the time/capture/output primitives used by
 * main.c, the action executor, the user-code helpers (sim.h) and the UI
 * document loader.
 */
#ifndef SIM_RUNTIME_H
#define SIM_RUNTIME_H

#include "lvgl.h"

#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>

#define SIM_FORMAT_VERSION  3
#define SIM_STEP_MS         33      /* one LVGL refresh period (LV_DEF_REFR_PERIOD) */
#define SIM_SETTLE_CAP_MS   3000    /* --settle stops at this total simulated time */
#define SIM_MAX_TIME_MS     60000
#define SIM_MAX_FRAMES      64
#define SIM_MAX_FONTS       64
#define SIM_LOOP_BUDGET_MS  5000    /* simulated time user code may spend before APP_LOOP_DETECTED */
#define SIM_PATH_MAX        4096

/* Exit codes (contract section 1) */
#define SIM_EXIT_OK         0
#define SIM_EXIT_ARGS       1
#define SIM_EXIT_WRITE      2
#define SIM_EXIT_ASSERT     3
#define SIM_EXIT_UI         5
#define SIM_EXIT_ACTIONS    6

typedef struct {
    int32_t width;
    int32_t height;
    const char *png_path;           /* absolute after sim_resolve_paths() */
    const char *json_path;          /* absolute after sim_resolve_paths() */
    int32_t time_ms;
    bool settle;
    int32_t rotation;               /* degrees */
    bool dark;
    int32_t dpi;
    const char *assets_dir;
    /* 2.2.0 */
    const char *actions_path;
    const char *output_dir;         /* absolute after sim_resolve_paths() */
    int32_t frames[SIM_MAX_FRAMES];
    uint32_t frame_count;
    bool annotate;
    int32_t scale;                  /* 1..4 */
    bool rgb565;
    const char *fonts[SIM_MAX_FONTS];
    uint32_t font_count;
    bool fonts_given;               /* --fonts was passed (even if empty) */
    int32_t mem_budget_kb;          /* 0 = none */
    const char *ui_path;
} sim_options_t;

typedef struct {
    uint32_t n;
    char *label;
    int32_t elapsed_ms;
    char *png;          /* file name inside the output dir */
    char *annotated;    /* file name, or NULL */
    char *screen_json;  /* widget tree of the active screen */
    char *top_json;     /* widget tree of layer_top, or NULL when empty */
} sim_capture_t;

typedef struct {
    sim_options_t opt;
    lv_display_t *disp;
    int32_t elapsed_ms;             /* simulated time since the start (incl. user code) */

    sim_capture_t *captures;
    uint32_t capture_count;
    uint32_t capture_cap;
    bool write_capture_files;       /* multi-capture mode: write capture-<n>-<label>.png */

    /* Loop detection inside the user's create_ui()/entry */
    bool in_user_entry;
    int32_t user_entry_ms;
    bool loop_detected;
    jmp_buf loop_escape;

    bool actions_given;
    int exit_code;                  /* worst output error so far */
} sim_state_t;

extern sim_state_t sim;

/** Set the reported phase ("[sim] phase=..." on stderr) */
void sim_set_phase(const char *phase);
const char *sim_get_phase(void);

/** Make png/json/output-dir absolute against the start directory */
bool sim_resolve_paths(const char *cwd);

/** Advance simulated time by `ms` (<= one step) and run due timers */
void sim_step(uint32_t ms);

/** Advance `ms` of simulated time in SIM_STEP_MS steps */
void sim_run_for(int32_t ms);

/**
 * Advance until no animation runs and nothing waits to be redrawn, at most
 * `cap_ms` more.
 * @return the simulated time advanced
 */
int32_t sim_settle(int32_t cap_ms);

/** True while invalidated areas wait to be redrawn */
bool sim_display_dirty(void);

/** Count running animations that are not infinite */
uint32_t sim_finite_anims_running(void);

/**
 * Capture the current frame: render, write the PNG(s), record the trees.
 * `final` also writes --output-png. Returns 0 or SIM_EXIT_WRITE.
 */
int sim_capture_frame(const char *label, bool final);

/** Store a log line for the JSON "logs" array (without trailing newline) */
void sim_store_log(const char *line);

/**
 * Final capture, diagnostics, memory stats and the JSON document.
 * @return the process exit code
 */
int sim_finish(void);

/** Final capture + JSON + exit(0) from anywhere (loop fallback). Never returns. */
void sim_finish_and_exit(void);

#endif /* SIM_RUNTIME_H */
