/**
 * @file sim_runtime.c
 * Simulated time, captures and the JSON document (format_version 3).
 */
#include "sim_runtime.h"

#include "annotate.h"
#include "diagnostics.h"
#include "events.h"
#include "indev.h"
#include "jw.h"
#include "mem.h"
#include "screenshot.h"
#include "widget_tree.h"

/* inv_p (pending invalidations), anim list, timer/event re-entrancy state */
#include "src/display/lv_display_private.h"
#include "src/core/lv_global.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <direct.h>
#define sim_mkdir(p) _mkdir(p)
#define PATH_SEP '\\'
#else
#include <sys/stat.h>
#include <sys/types.h>
#define sim_mkdir(p) mkdir((p), 0777)
#define PATH_SEP '/'
#endif

#define MAX_LOG_LINES 200

sim_state_t sim;

static const char *volatile current_phase = "init";

static char *log_lines[MAX_LOG_LINES];
static uint32_t log_count;
static uint32_t log_dropped;

static char png_abs[SIM_PATH_MAX];
static char json_abs[SIM_PATH_MAX];
static char out_dir_abs[SIM_PATH_MAX];

/**********************
 *  Phase and logs
 **********************/

void sim_set_phase(const char *phase)
{
    current_phase = phase;
    fprintf(stderr, "[sim] phase=%s\n", phase);
}

const char *sim_get_phase(void)
{
    return current_phase;
}

void sim_store_log(const char *line)
{
    if (log_count >= MAX_LOG_LINES) {
        log_dropped++;
        return;
    }
    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) len--;
    char *copy = (char *)malloc(len + 1);
    if (!copy) return;
    memcpy(copy, line, len);
    copy[len] = '\0';
    log_lines[log_count++] = copy;
}

/**********************
 *  Paths
 **********************/

static bool is_abs_path(const char *p)
{
    if (p[0] == '/' || p[0] == '\\') return true;
    return ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':';
}

static bool make_abs(char *dst, const char *cwd, const char *path)
{
    int n;
    if (is_abs_path(path)) n = snprintf(dst, SIM_PATH_MAX, "%s", path);
    else n = snprintf(dst, SIM_PATH_MAX, "%s%c%s", cwd, PATH_SEP, path);
    return n > 0 && n < SIM_PATH_MAX;
}

bool sim_resolve_paths(const char *cwd)
{
    if (!make_abs(png_abs, cwd, sim.opt.png_path) || !make_abs(json_abs, cwd, sim.opt.json_path)) return false;
    sim.opt.png_path = png_abs;
    sim.opt.json_path = json_abs;

    if (sim.opt.output_dir) {
        if (!make_abs(out_dir_abs, cwd, sim.opt.output_dir)) return false;
    } else {
        /* Default: the directory of --output-png */
        snprintf(out_dir_abs, sizeof(out_dir_abs), "%s", png_abs);
        char *slash = strrchr(out_dir_abs, '/');
        char *bslash = strrchr(out_dir_abs, '\\');
        if (bslash && (!slash || bslash > slash)) slash = bslash;
        if (slash) *slash = '\0';
    }
    size_t len = strlen(out_dir_abs);
    while (len > 1 && (out_dir_abs[len - 1] == '/' || out_dir_abs[len - 1] == '\\')) out_dir_abs[--len] = '\0';
    sim.opt.output_dir = out_dir_abs;
    return true;
}

/**********************
 *  Time
 **********************/

void sim_step(uint32_t ms)
{
    lv_tick_inc(ms);
    lv_timer_handler();
    sim.elapsed_ms += (int32_t)ms;
}

void sim_run_for(int32_t ms)
{
    while (ms > 0) {
        int32_t s = ms < SIM_STEP_MS ? ms : SIM_STEP_MS;
        sim_step((uint32_t)s);
        ms -= s;
    }
}

bool sim_display_dirty(void)
{
    return sim.disp->inv_p > 0;
}

uint32_t sim_finite_anims_running(void)
{
    uint32_t n = 0;
    lv_ll_t *ll = &LV_GLOBAL_DEFAULT()->anim_state.anim_ll;
    for (lv_anim_t *a = (lv_anim_t *)lv_ll_get_head(ll); a; a = (lv_anim_t *)lv_ll_get_next(ll, a)) {
        if (a->repeat_cnt != LV_ANIM_REPEAT_INFINITE) n++;
    }
    return n;
}

int32_t sim_settle(int32_t cap_ms)
{
    int32_t advanced = 0;
    while (advanced < cap_ms && (sim_finite_anims_running() > 0 || sim_display_dirty())) {
        int32_t s = cap_ms - advanced < SIM_STEP_MS ? cap_ms - advanced : SIM_STEP_MS;
        sim_step((uint32_t)s);
        advanced += s;
    }
    return advanced;
}

/**********************
 *  Captures
 **********************/

/** File-name safe copy of a capture label: [A-Za-z0-9._-], others become '_' */
static void safe_label(char *dst, size_t size, const char *label)
{
    size_t n = 0;
    for (const char *p = label; *p && n + 1 < size && n < 48; p++) {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
                  c == '_' || c == '.';
        dst[n++] = ok ? c : '_';
    }
    if (n == 0) dst[n++] = '_';
    dst[n] = '\0';
}

static char *dup_str(const char *s)
{
    size_t n = strlen(s);
    char *d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

static bool ensure_out_dir(void)
{
    static bool done;
    if (done) return true;
    sim_mkdir(sim.opt.output_dir); /* fails harmlessly when it exists */
    done = true;
    return true;
}

static char *tree_json(lv_obj_t *root, widget_tree_paths_t *paths)
{
    jw_t w;
    jw_init_mem(&w);
    widget_tree_write_node(&w, root, paths);
    return jw_take(&w);
}

int sim_capture_frame(const char *label, bool final)
{
    const char *prev_phase = current_phase;
    int rc = SIM_EXIT_OK;
    char safe[64];
    char path[SIM_PATH_MAX];

    sim_set_phase("capture");
    lv_obj_update_layout(lv_display_get_screen_active(sim.disp));
    lv_obj_update_layout(lv_display_get_layer_top(sim.disp));
    lv_refr_now(sim.disp);

    if (sim.capture_count == sim.capture_cap) {
        uint32_t ncap = sim.capture_cap ? sim.capture_cap * 2 : 8;
        sim_capture_t *n = (sim_capture_t *)realloc(sim.captures, ncap * sizeof(*n));
        if (!n) {
            sim_set_phase(prev_phase);
            return SIM_EXIT_WRITE;
        }
        sim.captures = n;
        sim.capture_cap = ncap;
    }
    sim_capture_t *c = &sim.captures[sim.capture_count++];
    memset(c, 0, sizeof(*c));
    c->n = sim.capture_count;
    c->label = dup_str(label);
    c->elapsed_ms = sim.elapsed_ms;

    /* A lone final capture without --annotate keeps the 2.1.0 outputs (no extra files) */
    if (!final || sim.capture_count > 1 || sim.opt.annotate) sim.write_capture_files = true;

    safe_label(safe, sizeof(safe), label);
    if (sim.write_capture_files) {
        ensure_out_dir();
        char name[128];
        snprintf(name, sizeof(name), "capture-%u-%s.png", (unsigned)c->n, safe);
        c->png = dup_str(name);
        snprintf(path, sizeof(path), "%s%c%s", sim.opt.output_dir, PATH_SEP, name);
        if (screenshot_save_png(path, sim.disp, sim.opt.scale) != 0) {
            fprintf(stderr, "[sim] failed to write PNG: %s\n", path);
            rc = SIM_EXIT_WRITE;
        }
        if (sim.opt.annotate) {
            snprintf(name, sizeof(name), "annotated-%u-%s.png", (unsigned)c->n, safe);
            c->annotated = dup_str(name);
            snprintf(path, sizeof(path), "%s%c%s", sim.opt.output_dir, PATH_SEP, name);
            if (annotate_save_png(path, sim.disp, sim.opt.scale) != 0) {
                fprintf(stderr, "[sim] failed to write annotated PNG: %s\n", path);
                rc = SIM_EXIT_WRITE;
            }
        }
    }
    if (final && screenshot_save_png(sim.opt.png_path, sim.disp, sim.opt.scale) != 0) {
        fprintf(stderr, "[sim] failed to write PNG: %s\n", sim.opt.png_path);
        rc = SIM_EXIT_WRITE;
    }

    widget_tree_paths_t paths;
    widget_tree_paths_init(&paths);
    c->screen_json = tree_json(lv_display_get_screen_active(sim.disp), &paths);
    lv_obj_t *top = lv_display_get_layer_top(sim.disp);
    if (lv_obj_get_child_count(top) > 0) c->top_json = tree_json(top, &paths);
    widget_tree_paths_free(&paths);

    fprintf(stderr, "[sim] capture %u '%s' at %d ms\n", (unsigned)c->n, label, (int)sim.elapsed_ms);
    if (rc != SIM_EXIT_OK) sim.exit_code = rc;
    sim_set_phase(prev_phase);
    return rc;
}

/**********************
 *  JSON document
 **********************/

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

static void write_captures(jw_t *w)
{
    jw_puts(",\"captures\":[", w);
    for (uint32_t i = 0; i < sim.capture_count; i++) {
        sim_capture_t *c = &sim.captures[i];
        jw_printf(w, "%s{\"n\":%u,\"label\":", i ? "," : "", (unsigned)c->n);
        widget_tree_write_string(w, c->label);
        jw_printf(w, ",\"elapsed_ms\":%d,\"png\":", (int)c->elapsed_ms);
        widget_tree_write_string(w, c->png ? c->png : "");
        if (c->annotated) {
            jw_puts(",\"annotated\":", w);
            widget_tree_write_string(w, c->annotated);
        }
        jw_printf(w, ",\"screen\":%s", c->screen_json ? c->screen_json : "null");
        if (c->top_json) jw_printf(w, ",\"layer_top\":%s", c->top_json);
        jw_putc('}', w);
    }
    jw_putc(']', w);
}

static int write_json(uint32_t anims_running, const sim_mem_t *mem)
{
    lv_display_t *disp = sim.disp;
    FILE *f = fopen(sim.opt.json_path, "wb");
    if (!f) return -1;
    jw_t jw;
    jw_t *w = &jw;
    jw_init_file(w, f);

    jw_printf(w, "{\"format_version\":%d,\"lvgl_version\":\"%d.%d.%d\"", SIM_FORMAT_VERSION,
              lv_version_major(), lv_version_minor(), lv_version_patch());
    jw_printf(w, ",\"display\":{\"width\":%d,\"height\":%d,\"rotation\":%d,\"dpi\":%d,"
              "\"color_format\":\"%s\",\"theme\":\"%s\",\"scale\":%d}",
              (int)lv_display_get_horizontal_resolution(disp), (int)lv_display_get_vertical_resolution(disp),
              (int)sim.opt.rotation, (int)lv_display_get_dpi(disp),
              color_format_name(lv_display_get_color_format(disp)), sim.opt.dark ? "dark" : "light",
              (int)sim.opt.scale);
    jw_printf(w, ",\"elapsed_ms\":%d,\"anims_running\":%u", (int)sim.elapsed_ms, (unsigned)anims_running);

    jw_puts(",\"logs\":[", w);
    for (uint32_t i = 0; i < log_count; i++) {
        if (i > 0) jw_putc(',', w);
        widget_tree_write_string(w, log_lines[i]);
    }
    if (log_dropped > 0) jw_printf(w, "%s\"... (%u more)\"", log_count > 0 ? "," : "", (unsigned)log_dropped);
    jw_putc(']', w);

    /* The final tree (2.1.0 fields), with paths numbered over screen, layer_top, layer_sys */
    widget_tree_paths_t paths;
    widget_tree_paths_init(&paths);
    jw_puts(",\"screen\":", w);
    widget_tree_write_node(w, lv_display_get_screen_active(disp), &paths);
    lv_obj_t *top = lv_display_get_layer_top(disp);
    if (lv_obj_get_child_count(top) > 0) {
        jw_puts(",\"layer_top\":", w);
        widget_tree_write_node(w, top, &paths);
    } else {
        widget_tree_skip(&paths, top);
    }
    lv_obj_t *sys = lv_display_get_layer_sys(disp);
    if (lv_obj_get_child_count(sys) > 0) {
        jw_puts(",\"layer_sys\":", w);
        widget_tree_write_node(w, sys, &paths);
    }
    widget_tree_paths_free(&paths);

    if (sim.capture_count > 1 || sim.opt.annotate) write_captures(w);
    mem_write(w, mem, sim.opt.mem_budget_kb);
    diag_write_fonts_used(w);
    diag_write(w);
    sim_input_write(w, disp);
    if (sim.actions_given) events_write(w);
    jw_puts("}\n", w);

    bool failed = ferror(f) != 0;
    if (fclose(f) != 0) failed = true;
    return failed ? -1 : 0;
}

int sim_finish(void)
{
    int rc = sim_capture_frame("final", true);

    sim_set_phase("export");
    uint32_t anims_running = lv_anim_count_running();
    uint32_t finite = sim_finite_anims_running();
    if (finite > 0) {
        diag_add("ANIM_UNFINISHED", DIAG_INFO, NULL,
                 "%u animation%s still running at the final capture (%d ms); use settle or a longer time to capture "
                 "the end state",
                 (unsigned)finite, finite == 1 ? " was" : "s were", (int)sim.elapsed_ms);
    }
    /* Global findings first: the per-object checks can fill the diagnostics
     * list (DIAG_MAX), and later entries are dropped */
    sim_mem_t mem;
    mem_snapshot(&mem);
    if (sim.opt.mem_budget_kb > 0 && mem.peak_bytes > (uint32_t)sim.opt.mem_budget_kb * 1024u) {
        uint32_t budget = (uint32_t)sim.opt.mem_budget_kb * 1024u;
        diag_add("MEM_OVER_BUDGET", DIAG_ERROR, NULL,
                 "LVGL heap peak %u bytes (%.1f KB) exceeds the device budget of %u bytes (%d KB) by %u bytes",
                 (unsigned)mem.peak_bytes, mem.peak_bytes / 1024.0, (unsigned)budget, (int)sim.opt.mem_budget_kb,
                 (unsigned)(mem.peak_bytes - budget));
    }

    diag_check_ui(sim.disp, sim.opt.fonts_given ? sim.opt.fonts : NULL, sim.opt.font_count);

    if (write_json(anims_running, &mem) != 0) {
        fprintf(stderr, "[sim] failed to write JSON: %s\n", sim.opt.json_path);
        rc = SIM_EXIT_WRITE;
    }
    if (rc == SIM_EXIT_OK) rc = sim.exit_code;
    return rc;
}

void sim_finish_and_exit(void)
{
    int rc = sim_finish();
    fflush(NULL);
    exit(rc);
}
