/**
 * @file sim.c
 * Implementation of the user-code helpers declared in sim.h.
 */
#include "sim.h"

#include "diagnostics.h"
#include "sim_runtime.h"

/* timer re-entrancy flag and the event stack */
#include "src/core/lv_global.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

/** True when no LVGL timer handler or event dispatch is on the call stack */
static bool lvgl_idle(void)
{
    return !LV_GLOBAL_DEFAULT()->timer_state.already_running && LV_GLOBAL_DEFAULT()->event_header == NULL;
}

static void loop_detected(void)
{
    sim.loop_detected = true;
    sim.in_user_entry = false;
    diag_add("APP_LOOP_DETECTED", DIAG_INFO, NULL,
             "user code was still running after %d ms of simulated time (an endless application loop such as "
             "while (1) { lv_timer_handler(); vTaskDelay(...); }); the simulator left the loop there and "
             "captured the UI",
             SIM_LOOP_BUDGET_MS);
    fprintf(stderr, "[sim] application loop detected after %d ms of simulated time\n", SIM_LOOP_BUDGET_MS);
    if (lvgl_idle()) longjmp(sim.loop_escape, 1);
    /* Called from inside an LVGL callback: unwinding would corrupt LVGL's state, so finish here */
    sim_finish_and_exit();
}

void sim_advance_ms(uint32_t ms)
{
    if (!sim.in_user_entry) {
        sim_run_for((int32_t)(ms > (uint32_t)SIM_MAX_TIME_MS ? (uint32_t)SIM_MAX_TIME_MS : ms));
        return;
    }
    int32_t left = SIM_LOOP_BUDGET_MS - sim.user_entry_ms;
    int32_t adv = (int64_t)ms < (int64_t)left ? (int32_t)ms : left;
    if (adv > 0) {
        sim_run_for(adv);
        sim.user_entry_ms += adv;
    }
    if (sim.user_entry_ms >= SIM_LOOP_BUDGET_MS) loop_detected();
}

void sim_capture(const char *label)
{
    sim_capture_frame(label ? label : "user", false);
}

void sim_log(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    /* Same "[User]" prefix as LVGL's LV_LOG_USER, without LVGL's file:line suffix */
    char line[560];
    uint32_t t = lv_tick_get();
    snprintf(line, sizeof(line), "[User]\t(%u.%03u)\t %s", (unsigned)(t / 1000), (unsigned)(t % 1000), buf);
    fprintf(stderr, "%s\n", line);
    sim_store_log(line);
}
