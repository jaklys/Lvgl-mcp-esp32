/**
 * @file jw.h
 * Output sink for the JSON writers: either a FILE or a growable in-memory
 * buffer (used to keep a widget tree per capture). The functions mirror the
 * stdio ones (same argument order) so writer code reads like plain stdio.
 * Memory comes from malloc(), not from the LVGL heap.
 */
#ifndef SIM_JW_H
#define SIM_JW_H

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>

typedef struct {
    FILE *file;     /* file sink, or NULL for the memory sink */
    char *buf;      /* memory sink: NUL-terminated contents */
    size_t len;
    size_t cap;
    bool failed;    /* allocation failure (memory sink) */
} jw_t;

void jw_init_file(jw_t *w, FILE *f);
void jw_init_mem(jw_t *w);

/** Memory sink: hand over the buffer (caller frees it) and reset `w` */
char *jw_take(jw_t *w);

#if defined(__GNUC__) || defined(__clang__)
__attribute__((format(printf, 2, 3)))
#endif
void jw_printf(jw_t *w, const char *fmt, ...);
void jw_puts(const char *s, jw_t *w);
void jw_putc(int c, jw_t *w);
void jw_write(const void *p, size_t size, size_t n, jw_t *w);

#endif /* SIM_JW_H */
