#include "jw.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

void jw_init_file(jw_t *w, FILE *f)
{
    memset(w, 0, sizeof(*w));
    w->file = f;
}

void jw_init_mem(jw_t *w)
{
    memset(w, 0, sizeof(*w));
}

char *jw_take(jw_t *w)
{
    char *b = w->buf;
    if (!b) {
        b = (char *)malloc(1);
        if (b) b[0] = '\0';
    }
    w->buf = NULL;
    w->len = w->cap = 0;
    return b;
}

static bool reserve(jw_t *w, size_t extra)
{
    if (w->failed) return false;
    if (w->len + extra + 1 <= w->cap) return true;
    size_t ncap = w->cap ? w->cap : 1024;
    while (ncap < w->len + extra + 1) ncap *= 2;
    char *nb = (char *)realloc(w->buf, ncap);
    if (!nb) {
        w->failed = true;
        return false;
    }
    w->buf = nb;
    w->cap = ncap;
    return true;
}

void jw_write(const void *p, size_t size, size_t n, jw_t *w)
{
    size_t bytes = size * n;
    if (w->file) {
        fwrite(p, 1, bytes, w->file);
        return;
    }
    if (!reserve(w, bytes)) return;
    memcpy(w->buf + w->len, p, bytes);
    w->len += bytes;
    w->buf[w->len] = '\0';
}

void jw_puts(const char *s, jw_t *w)
{
    jw_write(s, 1, strlen(s), w);
}

void jw_putc(int c, jw_t *w)
{
    char ch = (char)c;
    jw_write(&ch, 1, 1, w);
}

void jw_printf(jw_t *w, const char *fmt, ...)
{
    va_list ap;
    if (w->file) {
        va_start(ap, fmt);
        vfprintf(w->file, fmt, ap);
        va_end(ap);
        return;
    }
    va_start(ap, fmt);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0 || !reserve(w, (size_t)n)) return;
    va_start(ap, fmt);
    vsnprintf(w->buf + w->len, (size_t)n + 1, fmt, ap);
    va_end(ap);
    w->len += (size_t)n;
}
