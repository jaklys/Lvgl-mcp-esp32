#include "events.h"
#include "mem.h"
#include "sim_runtime.h"
#include "widget_tree.h"

/* screens array of the display */
#include "src/display/lv_display_private.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    int32_t t_ms;
    const char *event;
    char *name;     /* lv_obj name, or NULL */
    char *path;
    const char *type;
    char *value;    /* JSON literal, or NULL */
} event_entry_t;

static event_entry_t entries[EVENTS_MAX];
static uint32_t entry_count;
static uint32_t entry_dropped;
static lv_display_t *ev_disp;

/**********************
 *  Pointer set (open addressing, malloc'ed)
 **********************/

static const void **set_slots;
static size_t set_cap;
static size_t set_count;
static const void *const SET_TOMB = (const void *)&set_slots; /* deleted-slot marker */

static size_t ptr_hash(const void *p, size_t cap)
{
    uintptr_t v = (uintptr_t)p;
    v ^= v >> 17;
    v *= (uintptr_t)0x9E3779B97F4A7C15ull;
    return (size_t)(v ^ (v >> 29)) & (cap - 1);
}

static bool set_has(const void *p)
{
    if (!set_cap) return false;
    for (size_t i = ptr_hash(p, set_cap), n = 0; n < set_cap; i = (i + 1) & (set_cap - 1), n++) {
        if (set_slots[i] == NULL) return false;
        if (set_slots[i] == p) return true;
    }
    return false;
}

static bool set_add(const void *p);

static bool set_grow(void)
{
    size_t ncap = set_cap ? set_cap * 2 : 256;
    const void **old = set_slots;
    size_t old_cap = set_cap;
    set_slots = (const void **)calloc(ncap, sizeof(*set_slots));
    if (!set_slots) {
        set_slots = old;
        return false;
    }
    set_cap = ncap;
    set_count = 0;
    for (size_t i = 0; i < old_cap; i++) {
        if (old[i] && old[i] != SET_TOMB) set_add(old[i]);
    }
    free((void *)old);
    return true;
}

static bool set_add(const void *p)
{
    if ((set_count + 1) * 2 > set_cap && !set_grow()) return false;
    size_t i = ptr_hash(p, set_cap);
    while (set_slots[i] && set_slots[i] != SET_TOMB) {
        if (set_slots[i] == p) return true;
        i = (i + 1) & (set_cap - 1);
    }
    set_slots[i] = p;
    set_count++;
    return true;
}

static void set_remove(const void *p)
{
    if (!set_cap) return;
    for (size_t i = ptr_hash(p, set_cap), n = 0; n < set_cap; i = (i + 1) & (set_cap - 1), n++) {
        if (set_slots[i] == NULL) return;
        if (set_slots[i] == p) {
            set_slots[i] = SET_TOMB;
            return;
        }
    }
}

/**********************
 *  Recording
 **********************/

static const char *event_name(lv_event_code_t code)
{
    switch (code) {
        case LV_EVENT_CLICKED:       return "clicked";
        case LV_EVENT_VALUE_CHANGED: return "value_changed";
        case LV_EVENT_PRESSED:       return "pressed";
        case LV_EVENT_RELEASED:      return "released";
        case LV_EVENT_FOCUSED:       return "focused";
        case LV_EVENT_DEFOCUSED:     return "defocused";
        case LV_EVENT_SCREEN_LOADED: return "screen_loaded";
        case LV_EVENT_READY:         return "ready";
        case LV_EVENT_CANCEL:        return "cancel";
        default:                     return NULL;
    }
}

static char *dup_str(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s);
    char *d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

/** Current value of input widgets as a JSON literal, or NULL */
static char *value_of(lv_obj_t *obj)
{
    jw_t w;
    jw_init_mem(&w);
    if (lv_obj_has_class(obj, &lv_slider_class)) {
        jw_printf(&w, "%d", (int)lv_slider_get_value(obj));
    } else if (lv_obj_has_class(obj, &lv_bar_class)) {
        jw_printf(&w, "%d", (int)lv_bar_get_value(obj));
    } else if (lv_obj_has_class(obj, &lv_arc_class)) {
        jw_printf(&w, "%d", (int)lv_arc_get_value(obj));
    } else if (lv_obj_has_class(obj, &lv_switch_class) || lv_obj_has_class(obj, &lv_checkbox_class) ||
               lv_obj_is_checkable(obj)) {
        jw_puts(lv_obj_has_state(obj, LV_STATE_CHECKED) ? "true" : "false", &w);
    } else if (lv_obj_has_class(obj, &lv_dropdown_class)) {
        jw_printf(&w, "%u", (unsigned)lv_dropdown_get_selected(obj));
    } else if (lv_obj_has_class(obj, &lv_roller_class)) {
        jw_printf(&w, "%u", (unsigned)lv_roller_get_selected(obj));
    } else if (lv_obj_has_class(obj, &lv_spinbox_class)) {
        jw_printf(&w, "%d", (int)lv_spinbox_get_value(obj));
    } else if (lv_obj_has_class(obj, &lv_textarea_class)) {
        widget_tree_write_string(&w, lv_textarea_get_text(obj));
    } else if (lv_obj_has_class(obj, &lv_buttonmatrix_class)) {
        uint32_t id = lv_buttonmatrix_get_selected_button(obj);
        if (id == LV_BUTTONMATRIX_BUTTON_NONE) jw_puts("null", &w);
        else widget_tree_write_string(&w, lv_buttonmatrix_get_button_text(obj, id));
    } else {
        free(jw_take(&w));
        return NULL;
    }
    return jw_take(&w);
}

static void record(lv_obj_t *obj, const char *event)
{
    if (entry_count >= EVENTS_MAX) {
        entry_dropped++;
        return;
    }
    char path[WIDGET_TREE_PATH_MAX];
    event_entry_t *e = &entries[entry_count++];
    e->t_ms = sim.elapsed_ms;
    e->event = event;
    e->type = widget_tree_type_name(obj);
#if LV_USE_OBJ_NAME
    e->name = dup_str(lv_obj_get_name(obj));
#else
    e->name = NULL;
#endif
    if (!widget_tree_path_of(ev_disp, obj, path, sizeof(path))) {
        /* A screen that is not active (yet): no path in the current tree */
        path[0] = '\0';
    }
    e->path = path[0] ? dup_str(path) : NULL;
    e->value = strcmp(event, "value_changed") == 0 ? value_of(obj) : NULL;
}

static void obj_event_cb(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    lv_obj_t *obj = lv_event_get_current_target_obj(e);

    if (code == LV_EVENT_DELETE) {
        set_remove(obj);
        return;
    }
    const char *name = event_name(code);
    if (!name) return;
    /* Bubbled events are recorded at their original target only */
    if (lv_event_get_target_obj(e) != obj) return;
    record(obj, name);
}

/** SCREEN_LOADED for screens that were created and loaded inside one action */
static void display_event_cb(lv_event_t *e)
{
    lv_obj_t *scr = (lv_obj_t *)lv_event_get_param(e);
    if (scr && !set_has(scr)) record(scr, "screen_loaded");
}

void events_init(lv_display_t *disp)
{
    ev_disp = disp;
    mem_overhead_begin();
    lv_display_add_event_cb(disp, display_event_cb, LV_EVENT_SCREEN_LOADED, NULL);
    mem_overhead_end();
}

static void attach(lv_obj_t *obj)
{
    if (set_has(obj)) return;
    if (!set_add(obj)) return;
    lv_obj_add_event_cb(obj, obj_event_cb, LV_EVENT_ALL, NULL);
}

static bool attach_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    LV_UNUSED(path);
    LV_UNUSED(depth);
    LV_UNUSED(user);
    attach(obj);
    return true;
}

void events_attach_all(lv_display_t *disp)
{
    if (!ev_disp) return;
    mem_overhead_begin();
    widget_tree_walk(disp, attach_cb, NULL);
    for (uint32_t i = 0; i < disp->screen_cnt; i++) attach(disp->screens[i]);
    mem_overhead_end();
}

bool events_is_recorder(lv_event_cb_t cb)
{
    return cb == obj_event_cb;
}

void events_write(jw_t *w)
{
    jw_puts(",\"events\":[", w);
    for (uint32_t i = 0; i < entry_count; i++) {
        event_entry_t *e = &entries[i];
        jw_printf(w, "%s{\"t_ms\":%d,\"event\":\"%s\",\"name\":", i ? "," : "", (int)e->t_ms, e->event);
        widget_tree_write_string(w, e->name ? e->name : (e->path ? e->path : e->type));
        jw_puts(",\"path\":", w);
        if (e->path) widget_tree_write_string(w, e->path);
        else jw_puts("null", w);
        jw_puts(",\"type\":", w);
        widget_tree_write_string(w, e->type);
        if (e->value) jw_printf(w, ",\"value\":%s", e->value);
        jw_putc('}', w);
    }
    jw_putc(']', w);
    if (entry_dropped) jw_printf(w, ",\"events_dropped\":%u", (unsigned)entry_dropped);
}
