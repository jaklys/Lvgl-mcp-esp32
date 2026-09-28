#include "mem.h"

static uint32_t overhead_bytes;     /* simulator-owned bytes currently in the LVGL heap */
static uint32_t overhead_start;
static int overhead_depth;

static uint32_t current_used(void)
{
    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);
    return (uint32_t)(mon.total_size - mon.free_size);
}

void mem_overhead_begin(void)
{
    if (overhead_depth++ == 0) overhead_start = current_used();
}

void mem_overhead_end(void)
{
    if (overhead_depth <= 0) return;
    if (--overhead_depth == 0) {
        uint32_t now = current_used();
        if (now > overhead_start) overhead_bytes += now - overhead_start;
    }
}

void mem_snapshot(sim_mem_t *out)
{
    lv_mem_monitor_t mon;
    lv_mem_monitor(&mon);

    uint32_t used = (uint32_t)(mon.total_size - mon.free_size);
    uint32_t peak = (uint32_t)mon.max_used;
    if (peak < used) peak = used; /* max_used counts payloads only, used includes headers */

    out->used_bytes = used > overhead_bytes ? used - overhead_bytes : 0;
    out->peak_bytes = peak > overhead_bytes ? peak - overhead_bytes : 0;
    out->frag_pct = mon.frag_pct;
    out->total_bytes = (uint32_t)mon.total_size;
}

void mem_write(jw_t *w, const sim_mem_t *m, int32_t budget_kb)
{
    jw_printf(w, ",\"mem\":{\"peak_bytes\":%u,\"used_bytes\":%u,\"frag_pct\":%u",
              (unsigned)m->peak_bytes, (unsigned)m->used_bytes, (unsigned)m->frag_pct);
    if (budget_kb > 0) {
        uint32_t budget = (uint32_t)budget_kb * 1024u;
        jw_printf(w, ",\"budget_bytes\":%u,\"over_budget\":%s", (unsigned)budget,
                  m->peak_bytes > budget ? "true" : "false");
    }
    jw_printf(w, ",\"pool_bytes\":%u,\"note\":\"excludes draw buffers\"}", (unsigned)m->total_bytes);
}
