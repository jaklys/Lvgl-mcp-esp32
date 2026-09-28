/**
 * @file sim_assert.h
 * LVGL assert hook for the simulator.
 *
 * Included by LVGL's lv_conf_internal.h through LV_ASSERT_CUSTOM_INCLUDE
 * (see lv_conf.h), so it must stay self-contained and must not include LVGL.
 */
#ifndef SIM_ASSERT_H
#define SIM_ASSERT_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Called when an LVGL assertion or LV_CHECK_ARG check fails. LVGL has
 * already logged the failed condition. Flushes all streams and terminates
 * the process with exit code 3. Implemented in main.c.
 */
void sim_assert_fail(void);

#ifdef __cplusplus
} /*extern "C"*/
#endif

#define LV_ASSERT_HANDLER sim_assert_fail();

#endif /* SIM_ASSERT_H */
