/**
 * @file mem.h
 * LVGL heap statistics (LV_STDLIB_BUILTIN pool) for the JSON "mem" block.
 *
 * The display draw buffer is allocated with malloc() (hal/display_driver.c),
 * so the numbers cover widgets, styles, timers, animations, image caches and
 * draw layers, but not the frame buffer. Memory the simulator itself takes
 * from the LVGL heap (event hooks, input group) is measured and subtracted.
 */
#ifndef SIM_MEM_H
#define SIM_MEM_H

#include "lvgl.h"
#include "jw.h"

#include <stdint.h>

typedef struct {
    uint32_t peak_bytes;
    uint32_t used_bytes;
    uint32_t frag_pct;
    uint32_t total_bytes;
} sim_mem_t;

/** Bracket simulator-owned LVGL allocations so they can be subtracted */
void mem_overhead_begin(void);
void mem_overhead_end(void);

void mem_snapshot(sim_mem_t *out);

/** Write `"mem":{...}`; budget_kb 0 = no budget */
void mem_write(jw_t *w, const sim_mem_t *m, int32_t budget_kb);

#endif /* SIM_MEM_H */
