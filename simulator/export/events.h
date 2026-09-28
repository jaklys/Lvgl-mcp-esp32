/**
 * @file events.h
 * Event log for scripted interaction ("events" in the JSON): an LV_EVENT_ALL
 * callback is attached once to every object (and every screen) and records
 * CLICKED, VALUE_CHANGED, PRESSED, RELEASED, FOCUSED, DEFOCUSED,
 * SCREEN_LOADED, READY and CANCEL at their original target. At most
 * EVENTS_MAX entries are kept.
 */
#ifndef SIM_EVENTS_H
#define SIM_EVENTS_H

#include "lvgl.h"
#include "jw.h"

#define EVENTS_MAX 200

/** Start recording on `disp` (display-level SCREEN_LOADED hook) */
void events_init(lv_display_t *disp);

/** Attach the recorder to every object not seen yet; call after changes */
void events_attach_all(lv_display_t *disp);

/** True for the simulator's own event recorder callback */
bool events_is_recorder(lv_event_cb_t cb);

/** Write `,"events":[...]` */
void events_write(jw_t *w);

#endif /* SIM_EVENTS_H */
