#include "indev.h"
#include "mem.h"
#include "widget_tree.h"

#include <stdlib.h>

#define KEY_QUEUE_LEN 64

typedef struct {
    uint32_t key;
    bool pressed;
} key_event_t;

static lv_indev_t *pointer_indev;
static lv_indev_t *keypad_indev;
static lv_group_t *keypad_group;

static int32_t ptr_x;
static int32_t ptr_y;
static bool ptr_pressed;

static key_event_t key_queue[KEY_QUEUE_LEN];
static uint32_t key_head;
static uint32_t key_count;
static uint32_t last_key;
static bool last_key_pressed;

static void pointer_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    LV_UNUSED(indev);
    data->point.x = ptr_x;
    data->point.y = ptr_y;
    data->state = ptr_pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

static void keypad_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    LV_UNUSED(indev);
    if (key_count > 0) {
        key_event_t ev = key_queue[key_head];
        key_head = (key_head + 1) % KEY_QUEUE_LEN;
        key_count--;
        last_key = ev.key;
        last_key_pressed = ev.pressed;
    }
    data->key = last_key;
    data->state = last_key_pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
    data->continue_reading = key_count > 0;
}

void sim_input_init(lv_display_t *disp, bool keypad)
{
    mem_overhead_begin();
    if (!pointer_indev) {
        pointer_indev = lv_indev_create();
        lv_indev_set_type(pointer_indev, LV_INDEV_TYPE_POINTER);
        lv_indev_set_read_cb(pointer_indev, pointer_read_cb);
        lv_indev_set_display(pointer_indev, disp);
    }
    if (keypad && !keypad_indev) {
        keypad_indev = lv_indev_create();
        lv_indev_set_type(keypad_indev, LV_INDEV_TYPE_KEYPAD);
        lv_indev_set_read_cb(keypad_indev, keypad_read_cb);
        lv_indev_set_display(keypad_indev, disp);
        keypad_group = lv_group_create();
        lv_indev_set_group(keypad_indev, keypad_group);
    }
    mem_overhead_end();
}

bool sim_input_has_pointer(void)
{
    return pointer_indev != NULL;
}

bool sim_input_has_keypad(void)
{
    return keypad_indev != NULL;
}

void sim_input_pointer(int32_t x, int32_t y, bool pressed)
{
    ptr_x = x;
    ptr_y = y;
    ptr_pressed = pressed;
    if (pointer_indev) lv_indev_read(pointer_indev);
}

void sim_input_pointer_get(int32_t *x, int32_t *y, bool *pressed)
{
    *x = ptr_x;
    *y = ptr_y;
    *pressed = ptr_pressed;
}

static void queue_key(uint32_t key, bool pressed)
{
    if (key_count >= KEY_QUEUE_LEN) return;
    key_queue[(key_head + key_count) % KEY_QUEUE_LEN] = (key_event_t){key, pressed};
    key_count++;
}

void sim_input_key(uint32_t key)
{
    if (!keypad_indev) return;
    queue_key(key, true);
    queue_key(key, false);
    lv_indev_read(keypad_indev);
}

typedef struct {
    lv_obj_t **objs;
    size_t count;
    size_t cap;
} obj_list_t;

static bool sync_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    obj_list_t *list = (obj_list_t *)user;
    LV_UNUSED(path);
    LV_UNUSED(depth);
    if (lv_obj_get_group(obj) != NULL || !lv_obj_is_group_def(obj) || lv_obj_is_hidden(obj)) return true;
    if (list->count == list->cap) {
        size_t ncap = list->cap ? list->cap * 2 : 32;
        lv_obj_t **n = (lv_obj_t **)realloc(list->objs, ncap * sizeof(*n));
        if (!n) return false;
        list->objs = n;
        list->cap = ncap;
    }
    list->objs[list->count++] = obj;
    return true;
}

void sim_input_sync_group(lv_display_t *disp)
{
    obj_list_t list = {NULL, 0, 0};

    if (!keypad_group) return;
    /* Collect first: adding to a group sends FOCUSED, whose handlers may change the tree */
    widget_tree_walk(disp, sync_cb, &list);
    mem_overhead_begin();
    for (size_t i = 0; i < list.count; i++) lv_group_add_obj(keypad_group, list.objs[i]);
    mem_overhead_end();
    free(list.objs);
}

void sim_input_focus(lv_obj_t *obj)
{
    if (!keypad_group) return;
    mem_overhead_begin();
    if (lv_obj_get_group(obj) != keypad_group) {
        lv_group_t *g = lv_obj_get_group(obj);
        if (g) lv_group_remove_obj(obj);
        lv_group_add_obj(keypad_group, obj);
    }
    mem_overhead_end();
    lv_group_focus_obj(obj);
}

void sim_input_write(jw_t *w, lv_display_t *disp)
{
    jw_printf(w, ",\"input\":{\"pointer\":%s,\"keypad\":%s,\"focused\":",
              pointer_indev ? "true" : "false", keypad_indev ? "true" : "false");
    lv_obj_t *focused = keypad_group ? lv_group_get_focused(keypad_group) : NULL;
    if (focused) {
        char buf[WIDGET_TREE_PATH_MAX];
        widget_tree_write_string(w, widget_tree_label_of(disp, focused, buf, sizeof(buf)));
    } else {
        jw_puts("null", w);
    }
    jw_putc('}', w);
}
