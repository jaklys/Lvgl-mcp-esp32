/**
 * @file diagnostics.h
 * Static checks on the final UI state ("diagnostics" in the JSON, contract
 * section 3) and the "fonts_used" list. The rules are documented in
 * diagnostics.c; they are tuned to avoid false positives.
 */
#ifndef SIM_DIAGNOSTICS_H
#define SIM_DIAGNOSTICS_H

#include "lvgl.h"
#include "jw.h"

typedef enum {
    DIAG_INFO,
    DIAG_WARN,
    DIAG_ERROR,
} diag_severity_t;

/**
 * Record one diagnostic. `obj` (may be NULL for global findings) supplies
 * name/path/abs; the message is printf-formatted.
 */
#if defined(__GNUC__) || defined(__clang__)
__attribute__((format(printf, 4, 5)))
#endif
void diag_add(const char *code, diag_severity_t severity, lv_obj_t *obj, const char *fmt, ...);

/**
 * Run every object check on the current state of `disp` and collect the
 * fonts used by text-drawing widgets.
 * @param device_fonts  fonts available on the device (NULL = no restriction)
 * @param font_count    number of entries in device_fonts
 */
void diag_check_ui(lv_display_t *disp, const char *const *device_fonts, uint32_t font_count);

/** Write `"diagnostics":[...]` (sorted: errors, warnings, info) */
void diag_write(jw_t *w);

/** Write `"fonts_used":[...]` (collected by diag_check_ui) */
void diag_write_fonts_used(jw_t *w);

#endif /* SIM_DIAGNOSTICS_H */
