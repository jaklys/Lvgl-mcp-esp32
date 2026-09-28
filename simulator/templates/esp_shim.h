/**
 * @file esp_shim.h
 * Minimal ESP-IDF / FreeRTOS stand-ins so typical ESP32 LVGL code runs in
 * the simulator unchanged. Included by the snippet wrapper when
 * LVGL_SIM_ESP_SHIMS is defined; the headers in templates/esp_shim/
 * (freertos/FreeRTOS.h, esp_log.h, ...) include it for full files and
 * projects.
 *
 * Semantics:
 *  - ESP_LOGE/W/I/D/V(tag, fmt, ...)  -> sim_log("E (tag) fmt", ...)
 *  - vTaskDelay(ticks)                -> sim_advance_ms(ticks * portTICK_PERIOD_MS)
 *  - portTICK_PERIOD_MS is 10 (CONFIG_FREERTOS_HZ 100); pdMS_TO_TICKS(ms)
 *  - xTaskGetTickCount(), esp_timer_get_time() follow the simulated clock
 *  - xTaskCreate(PinnedToCore) runs the task function once, synchronously,
 *    and returns pdPASS; vTaskDelete is a no-op
 *  - mutexes/semaphores always succeed; esp_timer_* and the esp_lvgl_port
 *    lock are no-ops (the simulator drives lv_tick itself)
 *  - an endless `while (1) { lv_timer_handler(); vTaskDelay(..); }` loop is
 *    left after 5 s of simulated time (diagnostic APP_LOOP_DETECTED)
 */
#ifndef LVGL_SIM_ESP_SHIM_H
#define LVGL_SIM_ESP_SHIM_H

#include "lvgl.h"
#include "sim.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- esp_err.h ---- */
typedef int esp_err_t;
#define ESP_OK                  0
#define ESP_FAIL                (-1)
#define ESP_ERR_NO_MEM          0x101
#define ESP_ERR_INVALID_ARG     0x102
#define ESP_ERR_INVALID_STATE   0x103
#define ESP_ERR_NOT_FOUND       0x105
#define ESP_ERR_TIMEOUT         0x107

static inline const char *esp_err_to_name(esp_err_t err)
{
    switch (err) {
        case ESP_OK:                return "ESP_OK";
        case ESP_FAIL:              return "ESP_FAIL";
        case ESP_ERR_NO_MEM:        return "ESP_ERR_NO_MEM";
        case ESP_ERR_INVALID_ARG:   return "ESP_ERR_INVALID_ARG";
        case ESP_ERR_INVALID_STATE: return "ESP_ERR_INVALID_STATE";
        case ESP_ERR_NOT_FOUND:     return "ESP_ERR_NOT_FOUND";
        case ESP_ERR_TIMEOUT:       return "ESP_ERR_TIMEOUT";
        default:                    return "ESP_ERR_UNKNOWN";
    }
}

#define ESP_ERROR_CHECK(x) do {                                                     \
        esp_err_t err_rc_ = (x);                                                    \
        if (err_rc_ != ESP_OK) {                                                    \
            sim_log("ESP_ERROR_CHECK failed: %s (%d) at %s:%d", esp_err_to_name(err_rc_), \
                    (int)err_rc_, __FILE__, __LINE__);                              \
        }                                                                           \
    } while (0)
#define ESP_ERROR_CHECK_WITHOUT_ABORT(x) ESP_ERROR_CHECK(x)

/* ---- esp_log.h ---- */
#define ESP_LOGE(tag, fmt, ...) sim_log("E (%s) " fmt, tag, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) sim_log("W (%s) " fmt, tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) sim_log("I (%s) " fmt, tag, ##__VA_ARGS__)
#define ESP_LOGD(tag, fmt, ...) sim_log("D (%s) " fmt, tag, ##__VA_ARGS__)
#define ESP_LOGV(tag, fmt, ...) sim_log("V (%s) " fmt, tag, ##__VA_ARGS__)

/* ---- FreeRTOS ---- */
typedef uint32_t TickType_t;
typedef int BaseType_t;
typedef unsigned int UBaseType_t;
typedef void *TaskHandle_t;
typedef void *SemaphoreHandle_t;
typedef void *QueueHandle_t;
typedef void (*TaskFunction_t)(void *);

#define pdTRUE                  1
#define pdFALSE                 0
#define pdPASS                  1
#define pdFAIL                  0
#define configTICK_RATE_HZ      100
#define CONFIG_FREERTOS_HZ      100
#define portTICK_PERIOD_MS      ((TickType_t)(1000 / configTICK_RATE_HZ))
#define portTICK_RATE_MS        portTICK_PERIOD_MS
#define portMAX_DELAY           ((TickType_t)0xffffffffUL)
#define pdMS_TO_TICKS(ms)       ((TickType_t)(((TickType_t)(ms)) / portTICK_PERIOD_MS))
#define pdTICKS_TO_MS(t)        ((TickType_t)(t) * portTICK_PERIOD_MS)
#define tskIDLE_PRIORITY        0
#define tskNO_AFFINITY          0x7FFFFFFF
#define configMAX_PRIORITIES    25

static inline void vTaskDelay(TickType_t ticks)
{
    uint64_t ms = (uint64_t)ticks * portTICK_PERIOD_MS;
    sim_advance_ms(ms > 0x7fffffffULL ? 0x7fffffffU : (uint32_t)ms);
}

static inline TickType_t xTaskGetTickCount(void)
{
    return (TickType_t)(lv_tick_get() / portTICK_PERIOD_MS);
}

static inline void vTaskDelayUntil(TickType_t *prev_wake, TickType_t increment)
{
    TickType_t now = xTaskGetTickCount();
    TickType_t target = *prev_wake + increment;
    if (target > now) vTaskDelay(target - now);
    *prev_wake = target;
}
#define xTaskDelayUntil(prev, inc) (vTaskDelayUntil((prev), (inc)), pdTRUE)

static inline BaseType_t xTaskCreate(TaskFunction_t fn, const char *name, uint32_t stack, void *param,
                                     UBaseType_t prio, TaskHandle_t *handle)
{
    (void)name;
    (void)stack;
    (void)prio;
    if (handle) *handle = (TaskHandle_t)fn;
    fn(param); /* runs once, synchronously */
    return pdPASS;
}

static inline BaseType_t xTaskCreatePinnedToCore(TaskFunction_t fn, const char *name, uint32_t stack, void *param,
                                                 UBaseType_t prio, TaskHandle_t *handle, BaseType_t core)
{
    (void)core;
    return xTaskCreate(fn, name, stack, param, prio, handle);
}

static inline void vTaskDelete(TaskHandle_t task)
{
    (void)task;
}

static inline SemaphoreHandle_t xSemaphoreCreateMutex(void)
{
    return (SemaphoreHandle_t)1;
}
#define xSemaphoreCreateRecursiveMutex() xSemaphoreCreateMutex()
#define xSemaphoreCreateBinary() xSemaphoreCreateMutex()
#define xSemaphoreTake(sem, ticks) ((void)(sem), (void)(ticks), pdTRUE)
#define xSemaphoreGive(sem) ((void)(sem), pdTRUE)
#define xSemaphoreTakeRecursive(sem, ticks) xSemaphoreTake(sem, ticks)
#define xSemaphoreGiveRecursive(sem) xSemaphoreGive(sem)
#define vSemaphoreDelete(sem) ((void)(sem))

/* ---- esp_timer.h ---- */
typedef void *esp_timer_handle_t;
typedef void (*esp_timer_cb_t)(void *arg);
typedef struct {
    esp_timer_cb_t callback;
    void *arg;
    int dispatch_method;
    const char *name;
    bool skip_unhandled_events;
} esp_timer_create_args_t;

static inline int64_t esp_timer_get_time(void)
{
    return (int64_t)lv_tick_get() * 1000;
}

static inline esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *out)
{
    (void)args;
    if (out) *out = (esp_timer_handle_t)1;
    return ESP_OK;
}
#define esp_timer_start_periodic(t, us) ((void)(t), (void)(us), ESP_OK)
#define esp_timer_start_once(t, us) ((void)(t), (void)(us), ESP_OK)
#define esp_timer_stop(t) ((void)(t), ESP_OK)
#define esp_timer_delete(t) ((void)(t), ESP_OK)

/* ---- esp_lvgl_port.h ---- */
#define lvgl_port_lock(timeout_ms) ((void)(timeout_ms), true)
#define lvgl_port_unlock() ((void)0)

#ifdef __cplusplus
} /*extern "C"*/
#endif

#endif /* LVGL_SIM_ESP_SHIM_H */
