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
 *  - queues are real FIFOs within the one simulated task: xQueueSend copies
 *    the item in, xQueueReceive copies it out; waiting on an empty queue (or
 *    a full one) advances simulated time by the timeout (at most 1000 ms per
 *    call) and fails, so a receive loop cannot hang the simulator
 *  - ESP_RETURN_ON_ERROR & co. (esp_check.h) behave as in ESP-IDF, logging
 *    through sim_log; sdkconfig.h only provides CONFIG_FREERTOS_HZ and
 *    CONFIG_LOG_DEFAULT_LEVEL
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
#include <stdlib.h>
#include <string.h>

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
/* Functions, not macros, so `xSemaphoreTake(m, portMAX_DELAY);` as a statement does not warn */
static inline BaseType_t xSemaphoreTake(SemaphoreHandle_t sem, TickType_t ticks)
{
    (void)sem;
    (void)ticks;
    return pdTRUE;
}
static inline BaseType_t xSemaphoreGive(SemaphoreHandle_t sem)
{
    (void)sem;
    return pdTRUE;
}
#define xSemaphoreTakeRecursive(sem, ticks) xSemaphoreTake(sem, ticks)
#define xSemaphoreGiveRecursive(sem) xSemaphoreGive(sem)
static inline void vSemaphoreDelete(SemaphoreHandle_t sem)
{
    (void)sem;
}

/* ---- freertos/queue.h ---- */
typedef struct lvgl_sim_queue {
    uint32_t length;
    uint32_t item_size;
    uint32_t head;
    uint32_t count;
    uint8_t *items;
} lvgl_sim_queue_t;

#define errQUEUE_EMPTY          ((BaseType_t)0)
#define errQUEUE_FULL           ((BaseType_t)0)
#define queueSEND_TO_BACK       0
#define queueSEND_TO_FRONT      1
#define queueOVERWRITE          2

/* Nothing else runs while this task waits: let the timeout pass (capped) */
static inline void lvgl_sim_queue_wait_(TickType_t ticks)
{
    if (ticks == 0) return;
    vTaskDelay(ticks > pdMS_TO_TICKS(1000) ? pdMS_TO_TICKS(1000) : ticks);
}

static inline QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t item_size)
{
    if (length == 0) return NULL;
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)calloc(1, sizeof(lvgl_sim_queue_t));
    if (!q) return NULL;
    q->items = (uint8_t *)calloc(length, item_size ? item_size : 1);
    if (!q->items) {
        free(q);
        return NULL;
    }
    q->length = (uint32_t)length;
    q->item_size = (uint32_t)item_size;
    return (QueueHandle_t)q;
}

static inline BaseType_t xQueueGenericSend(QueueHandle_t handle, const void *item, TickType_t ticks, BaseType_t pos)
{
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)handle;
    if (!q) return errQUEUE_FULL;
    if (pos == queueOVERWRITE && q->count == q->length) {
        q->head = (q->head + 1) % q->length;
        q->count--;
    }
    if (q->count == q->length) {
        lvgl_sim_queue_wait_(ticks);
        return errQUEUE_FULL;
    }
    uint32_t slot;
    if (pos == queueSEND_TO_FRONT) {
        q->head = (q->head + q->length - 1) % q->length;
        slot = q->head;
    } else {
        slot = (q->head + q->count) % q->length;
    }
    if (q->item_size && item) memcpy(q->items + (size_t)slot * q->item_size, item, q->item_size);
    q->count++;
    return pdTRUE;
}

static inline BaseType_t lvgl_sim_queue_take_(QueueHandle_t handle, void *out, TickType_t ticks, bool remove)
{
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)handle;
    if (!q || q->count == 0) {
        lvgl_sim_queue_wait_(ticks);
        return errQUEUE_EMPTY;
    }
    if (q->item_size && out) memcpy(out, q->items + (size_t)q->head * q->item_size, q->item_size);
    if (remove) {
        q->head = (q->head + 1) % q->length;
        q->count--;
    }
    return pdTRUE;
}

#define xQueueSend(q, item, ticks)              xQueueGenericSend((q), (item), (ticks), queueSEND_TO_BACK)
#define xQueueSendToBack(q, item, ticks)        xQueueGenericSend((q), (item), (ticks), queueSEND_TO_BACK)
#define xQueueSendToFront(q, item, ticks)       xQueueGenericSend((q), (item), (ticks), queueSEND_TO_FRONT)
#define xQueueOverwrite(q, item)                xQueueGenericSend((q), (item), 0, queueOVERWRITE)
#define xQueueSendFromISR(q, item, woken)       xQueueGenericSend((q), (item), 0, ((void)(woken), queueSEND_TO_BACK))
#define xQueueSendToBackFromISR(q, item, woken) xQueueSendFromISR((q), (item), (woken))
#define xQueueReceive(q, out, ticks)            lvgl_sim_queue_take_((q), (out), (ticks), true)
#define xQueuePeek(q, out, ticks)               lvgl_sim_queue_take_((q), (out), (ticks), false)
#define xQueueReceiveFromISR(q, out, woken)     lvgl_sim_queue_take_((q), (out), 0, ((void)(woken), true))

static inline UBaseType_t uxQueueMessagesWaiting(QueueHandle_t handle)
{
    return handle ? (UBaseType_t)((lvgl_sim_queue_t *)handle)->count : 0;
}

static inline UBaseType_t uxQueueSpacesAvailable(QueueHandle_t handle)
{
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)handle;
    return q ? (UBaseType_t)(q->length - q->count) : 0;
}

static inline BaseType_t xQueueReset(QueueHandle_t handle)
{
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)handle;
    if (q) q->head = q->count = 0;
    return pdPASS;
}

static inline void vQueueDelete(QueueHandle_t handle)
{
    lvgl_sim_queue_t *q = (lvgl_sim_queue_t *)handle;
    if (!q) return;
    free(q->items);
    free(q);
}

/* ---- esp_check.h ---- */
#define ESP_RETURN_ON_ERROR(x, tag, fmt, ...) do {                                  \
        esp_err_t err_rc_ = (x);                                                    \
        if (err_rc_ != ESP_OK) {                                                    \
            ESP_LOGE(tag, "%s(%d): " fmt, __func__, __LINE__, ##__VA_ARGS__);       \
            return err_rc_;                                                         \
        }                                                                           \
    } while (0)
#define ESP_GOTO_ON_ERROR(x, goto_tag, log_tag, fmt, ...) do {                      \
        esp_err_t err_rc_ = (x);                                                    \
        if (err_rc_ != ESP_OK) {                                                    \
            ESP_LOGE(log_tag, "%s(%d): " fmt, __func__, __LINE__, ##__VA_ARGS__);   \
            ret = err_rc_;                                                          \
            goto goto_tag;                                                          \
        }                                                                           \
    } while (0)
#define ESP_RETURN_ON_FALSE(a, err_code, tag, fmt, ...) do {                        \
        if (!(a)) {                                                                 \
            ESP_LOGE(tag, "%s(%d): " fmt, __func__, __LINE__, ##__VA_ARGS__);       \
            return (err_code);                                                      \
        }                                                                           \
    } while (0)
#define ESP_GOTO_ON_FALSE(a, err_code, goto_tag, log_tag, fmt, ...) do {            \
        if (!(a)) {                                                                 \
            ESP_LOGE(log_tag, "%s(%d): " fmt, __func__, __LINE__, ##__VA_ARGS__);   \
            ret = (err_code);                                                       \
            goto goto_tag;                                                          \
        }                                                                           \
    } while (0)

/* ---- sdkconfig.h ---- */
#ifndef CONFIG_LOG_DEFAULT_LEVEL
#define CONFIG_LOG_DEFAULT_LEVEL 3
#endif

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
static inline esp_err_t esp_timer_start_periodic(esp_timer_handle_t t, uint64_t period_us)
{
    (void)t;
    (void)period_us;
    return ESP_OK;
}
static inline esp_err_t esp_timer_start_once(esp_timer_handle_t t, uint64_t timeout_us)
{
    (void)t;
    (void)timeout_us;
    return ESP_OK;
}
static inline esp_err_t esp_timer_stop(esp_timer_handle_t t)
{
    (void)t;
    return ESP_OK;
}
static inline esp_err_t esp_timer_delete(esp_timer_handle_t t)
{
    (void)t;
    return ESP_OK;
}

/* ---- esp_lvgl_port.h ---- */
static inline bool lvgl_port_lock(uint32_t timeout_ms)
{
    (void)timeout_ms;
    return true;
}
static inline void lvgl_port_unlock(void)
{
}

#ifdef __cplusplus
} /*extern "C"*/
#endif

#endif /* LVGL_SIM_ESP_SHIM_H */
