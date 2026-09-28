/**
 * @file actions.c
 * Parser and executor of action scripts.
 *
 * Timing: a click is press, 60 ms, release, 33 ms. key/focus/load_screen
 * advance 33 ms afterwards, type advances 33 ms after the last character.
 * After every action the event recorder and the keypad group pick up
 * objects that were created by it.
 *
 * Object references ({"name": "..."}) resolve in this order over the active
 * screen, layer_top and layer_sys (pre-order):
 *   1. an object whose lv_obj_set_name() name is exactly the string,
 *   2. a "<type>#<index>" path as printed in the widget tree,
 *   3. lv_obj_find_by_name() (resolved names such as "lv_button_1").
 * The target point is the centre of the object's box.
 */
#include "actions.h"

#include "events.h"
#include "indev.h"
#include "json.h"
#include "sim_runtime.h"
#include "widget_tree.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CLICK_HOLD_MS       60
#define MAX_WAIT_MS         SIM_MAX_TIME_MS
#define MAX_TOTAL_MS        600000
#define MAX_NAMES_LISTED    20

typedef enum {
    ACT_WAIT,
    ACT_CLICK,
    ACT_PRESS,
    ACT_RELEASE,
    ACT_DRAG,
    ACT_KEY,
    ACT_TYPE,
    ACT_FOCUS,
    ACT_CAPTURE,
    ACT_SETTLE,
    ACT_LOAD_SCREEN,
} act_kind_t;

typedef struct {
    bool present;
    char *name;     /* NULL: coordinates */
    int32_t x;
    int32_t y;
} act_target_t;

typedef struct {
    act_kind_t kind;
    int32_t ms;
    act_target_t a;
    act_target_t b;
    int32_t steps;
    uint32_t key;
    char *text;
    lv_screen_load_anim_t anim;
} action_t;

struct sim_actions {
    action_t *items;
    size_t count;
};

static const char *const action_names[] = {
    "wait", "click", "press", "release", "drag", "key", "type", "focus", "capture", "settle", "load_screen",
};

static const struct {
    const char *name;
    uint32_t key;
} key_names[] = {
    {"ENTER", LV_KEY_ENTER}, {"ESC", LV_KEY_ESC},     {"UP", LV_KEY_UP},
    {"DOWN", LV_KEY_DOWN},   {"LEFT", LV_KEY_LEFT},   {"RIGHT", LV_KEY_RIGHT},
    {"NEXT", LV_KEY_NEXT},   {"PREV", LV_KEY_PREV},   {"BACKSPACE", LV_KEY_BACKSPACE},
    {"DEL", LV_KEY_DEL},     {"HOME", LV_KEY_HOME},   {"END", LV_KEY_END},
};

static const struct {
    const char *name;
    lv_screen_load_anim_t anim;
} anim_names[] = {
    {"none", LV_SCREEN_LOAD_ANIM_NONE},
    {"over_left", LV_SCREEN_LOAD_ANIM_OVER_LEFT},
    {"over_right", LV_SCREEN_LOAD_ANIM_OVER_RIGHT},
    {"over_top", LV_SCREEN_LOAD_ANIM_OVER_TOP},
    {"over_bottom", LV_SCREEN_LOAD_ANIM_OVER_BOTTOM},
    {"move_left", LV_SCREEN_LOAD_ANIM_MOVE_LEFT},
    {"move_right", LV_SCREEN_LOAD_ANIM_MOVE_RIGHT},
    {"move_top", LV_SCREEN_LOAD_ANIM_MOVE_TOP},
    {"move_bottom", LV_SCREEN_LOAD_ANIM_MOVE_BOTTOM},
    {"fade", LV_SCREEN_LOAD_ANIM_FADE_IN},
    {"fade_in", LV_SCREEN_LOAD_ANIM_FADE_IN},
    {"fade_out", LV_SCREEN_LOAD_ANIM_FADE_OUT},
    {"out_left", LV_SCREEN_LOAD_ANIM_OUT_LEFT},
    {"out_right", LV_SCREEN_LOAD_ANIM_OUT_RIGHT},
    {"out_top", LV_SCREEN_LOAD_ANIM_OUT_TOP},
    {"out_bottom", LV_SCREEN_LOAD_ANIM_OUT_BOTTOM},
};

/**********************
 *  Parsing
 **********************/

typedef struct {
    char *err;
    size_t errsz;
    bool failed;
} perr_t;

#if defined(__GNUC__) || defined(__clang__)
__attribute__((format(printf, 3, 4)))
#endif
static void perr(perr_t *pe, size_t idx, const char *fmt, ...)
{
    if (pe->failed) return;
    pe->failed = true;
    int n = snprintf(pe->err, pe->errsz, "actions[%u]: ", (unsigned)idx);
    if (n < 0 || (size_t)n >= pe->errsz) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(pe->err + n, pe->errsz - (size_t)n, fmt, ap);
    va_end(ap);
}

static char *dup_str(const char *s)
{
    size_t n = strlen(s);
    char *d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

static bool get_int(const json_value_t *v, int32_t min, int32_t max, int32_t *out)
{
    if (!json_is_int(v) || v->number < min || v->number > max) return false;
    *out = (int32_t)v->number;
    return true;
}

/** {"x":..,"y":..} or {"name":".."} */
static bool parse_target(perr_t *pe, size_t idx, const char *what, const json_value_t *v, act_target_t *t)
{
    if (!v || v->type != JSON_OBJECT) {
        perr(pe, idx, "%s: expected {\"x\": N, \"y\": N} or {\"name\": \"...\"}", what);
        return false;
    }
    json_value_t *name = json_get(v, "name");
    json_value_t *x = json_get(v, "x");
    json_value_t *y = json_get(v, "y");
    for (size_t i = 0; i < v->count; i++) {
        const char *k = v->keys[i];
        if (strcmp(k, "name") != 0 && strcmp(k, "x") != 0 && strcmp(k, "y") != 0) {
            perr(pe, idx, "%s: unknown key \"%s\" (use \"x\"/\"y\" or \"name\")", what, k);
            return false;
        }
    }
    if (name) {
        if (x || y) {
            perr(pe, idx, "%s: give either \"name\" or \"x\"/\"y\", not both", what);
            return false;
        }
        if (name->type != JSON_STRING || !name->string[0]) {
            perr(pe, idx, "%s.name: expected a non-empty string", what);
            return false;
        }
        t->name = dup_str(name->string);
        t->present = true;
        return true;
    }
    if (!x || !y) {
        perr(pe, idx, "%s: expected {\"x\": N, \"y\": N} or {\"name\": \"...\"}", what);
        return false;
    }
    if (!get_int(x, -100000, 100000, &t->x) || !get_int(y, -100000, 100000, &t->y)) {
        perr(pe, idx, "%s: x and y must be integers (logical display coordinates)", what);
        return false;
    }
    t->present = true;
    return true;
}

/** Decode one UTF-8 character; returns its byte length or 0 */
static size_t utf8_char_len(const char *s)
{
    unsigned char c = (unsigned char)s[0];
    size_t n = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
    for (size_t i = 1; i < n; i++) {
        if (((unsigned char)s[i] & 0xC0) != 0x80) return 0;
    }
    return n;
}

/** UTF-8 bytes packed little-endian, as LVGL's keypad/textarea expect */
static uint32_t pack_utf8(const char *s, size_t n)
{
    uint32_t v = 0;
    for (size_t i = 0; i < n; i++) v |= (uint32_t)(unsigned char)s[i] << (8 * i);
    return v;
}

static bool parse_key(perr_t *pe, size_t idx, const json_value_t *v, uint32_t *key)
{
    if (!v || v->type != JSON_STRING || !v->string[0]) {
        perr(pe, idx, "key: expected a key name (ENTER, ESC, UP, DOWN, LEFT, RIGHT, NEXT, PREV, BACKSPACE, "
                      "DEL, HOME, END) or a single character");
        return false;
    }
    for (size_t i = 0; i < sizeof(key_names) / sizeof(key_names[0]); i++) {
        if (strcmp(v->string, key_names[i].name) == 0) {
            *key = key_names[i].key;
            return true;
        }
    }
    size_t n = utf8_char_len(v->string);
    if (n == 0 || v->string[n] != '\0') {
        perr(pe, idx, "key: unknown key \"%s\" (known: ENTER, ESC, UP, DOWN, LEFT, RIGHT, NEXT, PREV, BACKSPACE, "
                      "DEL, HOME, END, or a single character)", v->string);
        return false;
    }
    *key = pack_utf8(v->string, n);
    return true;
}

static bool parse_action(perr_t *pe, size_t idx, const json_value_t *v, action_t *a, int64_t *total_ms)
{
    if (v->type != JSON_OBJECT || v->count != 1) {
        perr(pe, idx, "expected an object with exactly one key, e.g. {\"click\": {\"name\": \"ok_btn\"}}");
        return false;
    }
    const char *k = v->keys[0];
    const json_value_t *arg = v->items[0];
    size_t kind;
    for (kind = 0; kind < sizeof(action_names) / sizeof(action_names[0]); kind++) {
        if (strcmp(k, action_names[kind]) == 0) break;
    }
    if (kind == sizeof(action_names) / sizeof(action_names[0])) {
        perr(pe, idx, "unknown action \"%s\" (known: wait, click, press, release, drag, key, type, focus, capture, "
                      "settle, load_screen)", k);
        return false;
    }
    a->kind = (act_kind_t)kind;

    switch (a->kind) {
        case ACT_WAIT:
        case ACT_SETTLE:
            if (!get_int(arg, 0, MAX_WAIT_MS, &a->ms)) {
                perr(pe, idx, "%s: expected milliseconds as an integer 0..%d", k, MAX_WAIT_MS);
                return false;
            }
            *total_ms += a->ms;
            return true;
        case ACT_CLICK:
        case ACT_PRESS:
            *total_ms += a->kind == ACT_CLICK ? CLICK_HOLD_MS + SIM_STEP_MS : SIM_STEP_MS;
            return parse_target(pe, idx, k, arg, &a->a);
        case ACT_RELEASE:
            *total_ms += SIM_STEP_MS;
            if (!arg || arg->type != JSON_OBJECT) {
                perr(pe, idx, "release: expected {} or a target like {\"x\": N, \"y\": N}");
                return false;
            }
            if (arg->count == 0) return true;
            return parse_target(pe, idx, k, arg, &a->a);
        case ACT_DRAG: {
            if (!arg || arg->type != JSON_OBJECT) {
                perr(pe, idx, "drag: expected {\"from\": {...}, \"to\": {...}, \"steps\": 10, \"duration\": 300}");
                return false;
            }
            for (size_t i = 0; i < arg->count; i++) {
                const char *dk = arg->keys[i];
                if (strcmp(dk, "from") && strcmp(dk, "to") && strcmp(dk, "steps") && strcmp(dk, "duration")) {
                    perr(pe, idx, "drag: unknown key \"%s\" (known: from, to, steps, duration)", dk);
                    return false;
                }
            }
            if (!parse_target(pe, idx, "drag.from", json_get(arg, "from"), &a->a)) return false;
            if (!parse_target(pe, idx, "drag.to", json_get(arg, "to"), &a->b)) return false;
            a->steps = 10;
            a->ms = 300;
            json_value_t *s = json_get(arg, "steps");
            json_value_t *d = json_get(arg, "duration");
            if (s && !get_int(s, 1, 1000, &a->steps)) {
                perr(pe, idx, "drag.steps: expected an integer 1..1000");
                return false;
            }
            if (d && !get_int(d, 0, MAX_WAIT_MS, &a->ms)) {
                perr(pe, idx, "drag.duration: expected milliseconds 0..%d", MAX_WAIT_MS);
                return false;
            }
            *total_ms += a->ms + 2 * SIM_STEP_MS;
            return true;
        }
        case ACT_KEY:
            *total_ms += SIM_STEP_MS;
            return parse_key(pe, idx, arg, &a->key);
        case ACT_TYPE:
            if (!arg || arg->type != JSON_STRING) {
                perr(pe, idx, "type: expected a string");
                return false;
            }
            for (const char *p = arg->string; *p;) {
                size_t n = utf8_char_len(p);
                if (n == 0) {
                    perr(pe, idx, "type: invalid UTF-8");
                    return false;
                }
                p += n;
            }
            a->text = dup_str(arg->string);
            *total_ms += SIM_STEP_MS;
            return true;
        case ACT_FOCUS:
            *total_ms += SIM_STEP_MS;
            if (!parse_target(pe, idx, k, arg, &a->a)) return false;
            if (!a->a.name) {
                perr(pe, idx, "focus: expected {\"name\": \"...\"}");
                return false;
            }
            return true;
        case ACT_CAPTURE:
            if (!arg || arg->type != JSON_STRING || !arg->string[0] || strlen(arg->string) > 64) {
                perr(pe, idx, "capture: expected a label string (1..64 characters)");
                return false;
            }
            a->text = dup_str(arg->string);
            return true;
        case ACT_LOAD_SCREEN: {
            if (!arg || arg->type != JSON_OBJECT) {
                perr(pe, idx, "load_screen: expected {\"name\": \"...\", \"anim\": \"fade\", \"duration\": 300}");
                return false;
            }
            json_value_t *name = json_get(arg, "name");
            json_value_t *anim = json_get(arg, "anim");
            json_value_t *dur = json_get(arg, "duration");
            for (size_t i = 0; i < arg->count; i++) {
                const char *dk = arg->keys[i];
                if (strcmp(dk, "name") && strcmp(dk, "anim") && strcmp(dk, "duration")) {
                    perr(pe, idx, "load_screen: unknown key \"%s\" (known: name, anim, duration)", dk);
                    return false;
                }
            }
            if (!name || name->type != JSON_STRING || !name->string[0]) {
                perr(pe, idx, "load_screen.name: expected the screen's name");
                return false;
            }
            a->text = dup_str(name->string);
            a->anim = LV_SCREEN_LOAD_ANIM_NONE;
            a->ms = 0;
            if (anim) {
                bool found = false;
                for (size_t i = 0; anim->type == JSON_STRING && i < sizeof(anim_names) / sizeof(anim_names[0]); i++) {
                    if (strcmp(anim->string, anim_names[i].name) == 0) {
                        a->anim = anim_names[i].anim;
                        found = true;
                    }
                }
                if (!found) {
                    perr(pe, idx, "load_screen.anim: expected one of none, fade, fade_out, over_left, over_right, "
                                  "over_top, over_bottom, move_left, move_right, move_top, move_bottom, out_left, "
                                  "out_right, out_top, out_bottom");
                    return false;
                }
                a->ms = 300;
            }
            if (dur && !get_int(dur, 0, MAX_WAIT_MS, &a->ms)) {
                perr(pe, idx, "load_screen.duration: expected milliseconds 0..%d", MAX_WAIT_MS);
                return false;
            }
            *total_ms += SIM_STEP_MS;
            return true;
        }
    }
    return false;
}

static void free_target(act_target_t *t)
{
    free(t->name);
}

void actions_free(sim_actions_t *a)
{
    if (!a) return;
    for (size_t i = 0; i < a->count; i++) {
        free_target(&a->items[i].a);
        free_target(&a->items[i].b);
        free(a->items[i].text);
    }
    free(a->items);
    free(a);
}

sim_actions_t *actions_load(const char *path, char *err, size_t errsz)
{
    char jerr[256];
    json_value_t *root = json_parse_file(path, jerr, sizeof(jerr));
    if (!root) {
        snprintf(err, errsz, "invalid action script %s: %s", path, jerr);
        return NULL;
    }
    if (root->type != JSON_ARRAY) {
        snprintf(err, errsz, "invalid action script %s: expected a JSON array of actions", path);
        json_free(root);
        return NULL;
    }
    sim_actions_t *a = (sim_actions_t *)calloc(1, sizeof(*a));
    if (!a || (root->count && !(a->items = (action_t *)calloc(root->count, sizeof(action_t))))) {
        snprintf(err, errsz, "out of memory");
        free(a);
        json_free(root);
        return NULL;
    }
    perr_t pe = {err, errsz, false};
    int64_t total = 0;
    for (size_t i = 0; i < root->count && !pe.failed; i++) {
        a->count = i + 1;
        parse_action(&pe, i, root->items[i], &a->items[i], &total);
    }
    if (!pe.failed && total > MAX_TOTAL_MS) {
        snprintf(err, errsz, "action script advances %lld ms of simulated time in total; the limit is %d ms",
                 (long long)total, MAX_TOTAL_MS);
        pe.failed = true;
    }
    json_free(root);
    if (pe.failed) {
        actions_free(a);
        return NULL;
    }
    return a;
}

sim_actions_t *actions_from_frames(const int32_t *frames, uint32_t count)
{
    sim_actions_t *a = (sim_actions_t *)calloc(1, sizeof(*a));
    if (!a) return NULL;
    a->items = (action_t *)calloc((size_t)count * 2, sizeof(action_t));
    if (!a->items) {
        free(a);
        return NULL;
    }
    int32_t prev = 0;
    for (uint32_t i = 0; i < count; i++) {
        char label[32];
        action_t *w = &a->items[a->count++];
        w->kind = ACT_WAIT;
        w->ms = frames[i] - prev;
        prev = frames[i];
        action_t *c = &a->items[a->count++];
        c->kind = ACT_CAPTURE;
        snprintf(label, sizeof(label), "t%d", (int)frames[i]);
        c->text = dup_str(label);
    }
    return a;
}

bool actions_need_keypad(const sim_actions_t *a)
{
    for (size_t i = 0; a && i < a->count; i++) {
        act_kind_t k = a->items[i].kind;
        if (k == ACT_KEY || k == ACT_TYPE || k == ACT_FOCUS) return true;
    }
    return false;
}

/**********************
 *  Execution
 **********************/

typedef struct {
    const char *name;
    lv_obj_t *found;
} name_ctx_t;

static bool find_name_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    name_ctx_t *c = (name_ctx_t *)user;
    LV_UNUSED(path);
    LV_UNUSED(depth);
#if LV_USE_OBJ_NAME
    const char *n = lv_obj_get_name(obj);
    if (n && strcmp(n, c->name) == 0) {
        c->found = obj;
        return false;
    }
#endif
    return true;
}

typedef struct {
    uint32_t count;
    uint32_t total;
    char list[1024];
    size_t len;
    bool paths;     /* second pass: fill up with paths */
} names_ctx_t;

static bool list_names_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    names_ctx_t *c = (names_ctx_t *)user;
    const char *n = NULL;
    LV_UNUSED(depth);
#if LV_USE_OBJ_NAME
    n = lv_obj_get_name(obj);
#endif
    if (c->paths) {
        if (n && n[0]) return true;
        n = path;
    } else if (!n || !n[0]) {
        return true;
    }
    c->total++;
    if (c->count >= MAX_NAMES_LISTED) return true;
    int w = snprintf(c->list + c->len, sizeof(c->list) - c->len, "%s\"%s\"", c->count ? ", " : "", n);
    if (w > 0 && c->len + (size_t)w < sizeof(c->list)) {
        c->len += (size_t)w;
        c->count++;
    }
    return true;
}

static lv_obj_t *resolve_name(const char *name)
{
    name_ctx_t c = {name, NULL};
    widget_tree_walk(sim.disp, find_name_cb, &c);
    if (c.found) return c.found;
    if (strchr(name, '#')) {
        lv_obj_t *o = widget_tree_find_path(sim.disp, name);
        if (o) return o;
    }
#if LV_USE_OBJ_NAME
    lv_obj_t *roots[3];
    uint32_t n = widget_tree_roots(sim.disp, roots);
    for (uint32_t i = 0; i < n; i++) {
        lv_obj_t *o = lv_obj_find_by_name(roots[i], name);
        if (o) return o;
    }
#endif
    return NULL;
}

static void report_unknown(size_t idx, const char *action, const char *name)
{
    names_ctx_t c;
    memset(&c, 0, sizeof(c));
    widget_tree_walk(sim.disp, list_names_cb, &c);
    uint32_t named = c.total;
    c.paths = true;
    widget_tree_walk(sim.disp, list_names_cb, &c);
    fprintf(stderr, "[sim] actions[%u] (%s): no object named \"%s\" on the active screen or its layers. "
                    "Known names/paths (%u named objects): %s%s\n",
            (unsigned)idx, action, name, (unsigned)named, c.count ? c.list : "(none)",
            c.total > c.count ? ", ..." : "");
}

/** Resolve a target to a point; false (message printed) when the name is unknown */
static bool target_point(size_t idx, const char *action, const act_target_t *t, int32_t *x, int32_t *y)
{
    if (!t->name) {
        *x = t->x;
        *y = t->y;
        return true;
    }
    lv_obj_t *obj = resolve_name(t->name);
    if (!obj) {
        report_unknown(idx, action, t->name);
        return false;
    }
    lv_area_t a;
    lv_obj_update_layout(obj);
    lv_obj_get_coords(obj, &a);
    *x = (a.x1 + a.x2) / 2;
    *y = (a.y1 + a.y2) / 2;
    return true;
}

static void after_action(void)
{
    events_attach_all(sim.disp);
    sim_input_sync_group(sim.disp);
}

int actions_run(sim_actions_t *acts)
{
    int rc = SIM_EXIT_OK;

    for (size_t i = 0; i < acts->count; i++) {
        action_t *a = &acts->items[i];
        const char *kname = action_names[a->kind];
        int32_t x, y, x2, y2;
        bool pressed;

        fprintf(stderr, "[sim] action %u: %s at %d ms\n", (unsigned)i, kname, (int)sim.elapsed_ms);
        switch (a->kind) {
            case ACT_WAIT:
                sim_run_for(a->ms);
                break;
            case ACT_SETTLE:
                sim_settle(a->ms);
                sim_step(SIM_STEP_MS); /* render the settled state */
                break;
            case ACT_CLICK:
                if (!target_point(i, kname, &a->a, &x, &y)) return SIM_EXIT_ACTIONS;
                sim_input_pointer(x, y, true);
                sim_run_for(CLICK_HOLD_MS);
                sim_input_pointer(x, y, false);
                sim_run_for(SIM_STEP_MS);
                break;
            case ACT_PRESS:
                if (!target_point(i, kname, &a->a, &x, &y)) return SIM_EXIT_ACTIONS;
                sim_input_pointer(x, y, true);
                sim_run_for(SIM_STEP_MS);
                break;
            case ACT_RELEASE:
                sim_input_pointer_get(&x, &y, &pressed);
                if (a->a.present && !target_point(i, kname, &a->a, &x, &y)) return SIM_EXIT_ACTIONS;
                sim_input_pointer(x, y, false);
                sim_run_for(SIM_STEP_MS);
                break;
            case ACT_DRAG: {
                if (!target_point(i, kname, &a->a, &x, &y)) return SIM_EXIT_ACTIONS;
                if (!target_point(i, kname, &a->b, &x2, &y2)) return SIM_EXIT_ACTIONS;
                sim_input_pointer(x, y, true);
                sim_run_for(SIM_STEP_MS);
                int32_t done = 0;
                for (int32_t s = 1; s <= a->steps; s++) {
                    int32_t px = x + (int32_t)((int64_t)(x2 - x) * s / a->steps);
                    int32_t py = y + (int32_t)((int64_t)(y2 - y) * s / a->steps);
                    int32_t t = (int32_t)((int64_t)a->ms * s / a->steps);
                    sim_input_pointer(px, py, true);
                    if (t > done) sim_run_for(t - done);
                    done = t;
                }
                sim_input_pointer(x2, y2, false);
                sim_run_for(SIM_STEP_MS);
                break;
            }
            case ACT_KEY:
                sim_input_key(a->key);
                sim_run_for(SIM_STEP_MS);
                break;
            case ACT_TYPE:
                for (const char *p = a->text; *p;) {
                    size_t n = utf8_char_len(p);
                    sim_input_key(pack_utf8(p, n));
                    p += n;
                }
                sim_run_for(SIM_STEP_MS);
                break;
            case ACT_FOCUS: {
                lv_obj_t *obj = resolve_name(a->a.name);
                if (!obj) {
                    report_unknown(i, kname, a->a.name);
                    return SIM_EXIT_ACTIONS;
                }
                sim_input_focus(obj);
                sim_run_for(SIM_STEP_MS);
                break;
            }
            case ACT_CAPTURE: {
                int r = sim_capture_frame(a->text, false);
                if (r != SIM_EXIT_OK) rc = r;
                break;
            }
            case ACT_LOAD_SCREEN: {
                lv_obj_t *scr = lv_display_get_screen_by_name(sim.disp, a->text);
                if (!scr) {
                    fprintf(stderr, "[sim] actions[%u] (load_screen): no screen named \"%s\" "
                                    "(name the screen objects with lv_obj_set_name, or use \"screens\" in a UI document)\n",
                            (unsigned)i, a->text);
                    return SIM_EXIT_ACTIONS;
                }
                lv_screen_load_anim(scr, a->anim, (uint32_t)a->ms, 0, false);
                sim_run_for(SIM_STEP_MS);
                break;
            }
        }
        after_action();
    }
    return rc;
}
