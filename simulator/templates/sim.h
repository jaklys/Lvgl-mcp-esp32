/**
 * @file sim.h
 * Helpers for user code running in the LVGL simulator (lvgl-mcp-esp32).
 * The snippet wrapper includes this header; full files and projects can
 * `#include "sim.h"`. On the device, guard the calls with
 * `#ifdef LVGL_SIMULATOR` (defined by the simulator build).
 */
#ifndef LVGL_SIM_H
#define LVGL_SIM_H

#include <stdint.h>

#ifndef LVGL_SIMULATOR
#define LVGL_SIMULATOR 1
#endif

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Advance simulated time by `ms`: lv_tick_inc() + lv_timer_handler() in
 * 33 ms steps, so timers, animations and rendering run.
 * Inside create_ui()/the entry function the total is capped at 5000 ms:
 * after that the simulator treats the code as an endless application loop
 * (e.g. `while (1) { lv_timer_handler(); vTaskDelay(10); }`), leaves it,
 * reports APP_LOOP_DETECTED (info) and continues with the capture.
 */
void sim_advance_ms(uint32_t ms);

/**
 * Capture the current frame like the action {"capture": label}: writes
 * capture-<n>-<label>.png into the output directory and records the widget
 * tree in the JSON "captures" array.
 */
void sim_capture(const char *label);

/**
 * printf-style log line; appears in the LVGL log ("[User]") and in the JSON
 * "logs" array.
 */
void sim_log(const char *fmt, ...)
#if defined(__GNUC__) || defined(__clang__)
    __attribute__((format(printf, 1, 2)))
#endif
    ;

#ifdef __cplusplus
} /*extern "C"*/
#endif

#endif /* LVGL_SIM_H */
