/**
 * @file indev.h
 * Virtual input devices driven by the action script: a POINTER indev whose
 * read callback returns the scripted position/state, and a KEYPAD indev fed
 * from a key queue, attached to a group that holds the focusable objects.
 */
#ifndef SIM_INDEV_H
#define SIM_INDEV_H

#include "lvgl.h"
#include "jw.h"

#include <stdbool.h>
#include <stdint.h>

/** Create the pointer indev, and with `keypad` the keypad indev + group */
void sim_input_init(lv_display_t *disp, bool keypad);

bool sim_input_has_pointer(void);
bool sim_input_has_keypad(void);

/** Set the pointer state and process it immediately */
void sim_input_pointer(int32_t x, int32_t y, bool pressed);

/** Current scripted pointer position/state */
void sim_input_pointer_get(int32_t *x, int32_t *y, bool *pressed);

/**
 * Queue a key press + release and process it immediately.
 * `key` is an LV_KEY_* code or a character as LVGL's keypad expects it
 * (UTF-8 bytes packed little-endian into the uint32).
 */
void sim_input_key(uint32_t key);

/**
 * Add every object that LVGL would put into a default group
 * (lv_obj_is_group_def) and that is not hidden, in tree order, to the
 * keypad group. Objects already in a group are left alone.
 */
void sim_input_sync_group(lv_display_t *disp);

/** Focus `obj` in the keypad group (adds it first if needed) */
void sim_input_focus(lv_obj_t *obj);

/** Write `,"input":{...}` */
void sim_input_write(jw_t *w, lv_display_t *disp);

#endif /* SIM_INDEV_H */
