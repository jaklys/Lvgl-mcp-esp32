/**
 * @file json.c
 * Recursive-descent JSON parser. Strict RFC 8259 (no comments, no trailing
 * commas), nesting limited to MAX_DEPTH, \u escapes (incl. surrogate pairs)
 * decoded to UTF-8. Duplicate object keys are kept; json_get() returns the
 * first one.
 */
#include "json.h"

#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_DEPTH      128
#define MAX_FILE_BYTES (16u * 1024u * 1024u)

typedef struct {
    const char *text;
    const char *p;
    char *err;
    size_t errsz;
    bool failed;
} parser_t;

static void pos_of(const parser_t *ps, const char *at, int *line, int *col)
{
    int l = 1, c = 1;
    for (const char *q = ps->text; q < at && *q; q++) {
        if (*q == '\n') {
            l++;
            c = 1;
        } else if (((unsigned char)*q & 0xC0) != 0x80) {
            c++;
        }
    }
    *line = l;
    *col = c;
}

static void fail(parser_t *ps, const char *fmt, ...)
{
    if (ps->failed) return;
    ps->failed = true;
    if (!ps->err || ps->errsz == 0) return;

    int line, col;
    pos_of(ps, ps->p, &line, &col);
    int n = snprintf(ps->err, ps->errsz, "line %d, column %d: ", line, col);
    if (n < 0 || (size_t)n >= ps->errsz) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(ps->err + n, ps->errsz - (size_t)n, fmt, ap);
    va_end(ap);
}

static void skip_ws(parser_t *ps)
{
    while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r') ps->p++;
}

static json_value_t *new_value(parser_t *ps, json_type_t type)
{
    json_value_t *v = (json_value_t *)calloc(1, sizeof(*v));
    if (!v) {
        fail(ps, "out of memory");
        return NULL;
    }
    v->type = type;
    pos_of(ps, ps->p, &v->line, &v->col);
    return v;
}

/** Append `cp` as UTF-8 to buf; returns bytes written */
static size_t put_utf8(char *buf, uint32_t cp)
{
    if (cp < 0x80) {
        buf[0] = (char)cp;
        return 1;
    }
    if (cp < 0x800) {
        buf[0] = (char)(0xC0 | (cp >> 6));
        buf[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        buf[0] = (char)(0xE0 | (cp >> 12));
        buf[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        buf[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    buf[0] = (char)(0xF0 | (cp >> 18));
    buf[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    buf[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    buf[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static int hex4(const char *s, uint32_t *out)
{
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        char c = s[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (uint32_t)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (uint32_t)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (uint32_t)(c - 'A' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

/** Parse a string starting at the opening quote; returns malloc'ed UTF-8 */
static char *parse_string_raw(parser_t *ps)
{
    size_t cap = 16;
    size_t len = 0;
    char *buf = (char *)malloc(cap);
    ps->p++; /* skip '"' */
    if (!buf) {
        fail(ps, "out of memory");
        return NULL;
    }

    for (;;) {
        unsigned char c = (unsigned char)*ps->p;
        if (len + 8 >= cap) {
            cap *= 2;
            char *nb = (char *)realloc(buf, cap);
            if (!nb) {
                free(buf);
                fail(ps, "out of memory");
                return NULL;
            }
            buf = nb;
        }
        if (c == '\0') {
            fail(ps, "unterminated string");
            free(buf);
            return NULL;
        }
        if (c == '"') {
            ps->p++;
            break;
        }
        if (c < 0x20) {
            fail(ps, "control character in string (escape it as \\n, \\t, ...)");
            free(buf);
            return NULL;
        }
        if (c != '\\') {
            buf[len++] = (char)c;
            ps->p++;
            continue;
        }
        /* Escape sequence */
        ps->p++;
        char e = *ps->p;
        switch (e) {
            case '"':  buf[len++] = '"'; ps->p++; break;
            case '\\': buf[len++] = '\\'; ps->p++; break;
            case '/':  buf[len++] = '/'; ps->p++; break;
            case 'b':  buf[len++] = '\b'; ps->p++; break;
            case 'f':  buf[len++] = '\f'; ps->p++; break;
            case 'n':  buf[len++] = '\n'; ps->p++; break;
            case 'r':  buf[len++] = '\r'; ps->p++; break;
            case 't':  buf[len++] = '\t'; ps->p++; break;
            case 'u': {
                uint32_t cp;
                if (hex4(ps->p + 1, &cp) != 0) {
                    fail(ps, "invalid \\u escape");
                    free(buf);
                    return NULL;
                }
                ps->p += 5;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    uint32_t lo;
                    if (ps->p[0] == '\\' && ps->p[1] == 'u' && hex4(ps->p + 2, &lo) == 0 &&
                        lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        ps->p += 6;
                    } else {
                        cp = 0xFFFD;
                    }
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    cp = 0xFFFD;
                }
                if (cp == 0) {
                    fail(ps, "\\u0000 is not allowed in strings");
                    free(buf);
                    return NULL;
                }
                len += put_utf8(buf + len, cp);
                break;
            }
            default:
                fail(ps, "invalid escape '\\%c'", e ? e : '0');
                free(buf);
                return NULL;
        }
    }
    buf[len] = '\0';
    return buf;
}

static json_value_t *parse_value(parser_t *ps, int depth);

static bool push_item(parser_t *ps, json_value_t *v, json_value_t *item, char *key, size_t *cap)
{
    if (v->count == *cap) {
        size_t ncap = *cap ? *cap * 2 : 4;
        json_value_t **ni = (json_value_t **)realloc(v->items, ncap * sizeof(*ni));
        if (!ni) {
            fail(ps, "out of memory");
            return false;
        }
        v->items = ni;
        if (v->type == JSON_OBJECT) {
            char **nk = (char **)realloc(v->keys, ncap * sizeof(*nk));
            if (!nk) {
                fail(ps, "out of memory");
                return false;
            }
            v->keys = nk;
        }
        *cap = ncap;
    }
    v->items[v->count] = item;
    if (v->type == JSON_OBJECT) v->keys[v->count] = key;
    v->count++;
    return true;
}

static json_value_t *parse_container(parser_t *ps, int depth, bool object)
{
    json_value_t *v = new_value(ps, object ? JSON_OBJECT : JSON_ARRAY);
    size_t cap = 0;
    char close = object ? '}' : ']';
    if (!v) return NULL;

    if (depth > MAX_DEPTH) {
        fail(ps, "nesting deeper than %d levels", MAX_DEPTH);
        return v;
    }
    ps->p++; /* '{' or '[' */
    skip_ws(ps);
    if (*ps->p == close) {
        ps->p++;
        return v;
    }
    for (;;) {
        char *key = NULL;
        skip_ws(ps);
        if (object) {
            if (*ps->p != '"') {
                fail(ps, "expected a \"key\" string");
                return v;
            }
            key = parse_string_raw(ps);
            if (!key) return v;
            skip_ws(ps);
            if (*ps->p != ':') {
                free(key);
                fail(ps, "expected ':' after key");
                return v;
            }
            ps->p++;
        }
        json_value_t *item = parse_value(ps, depth + 1);
        if (!item || !push_item(ps, v, item, key, &cap)) {
            json_free(item);
            free(key);
            return v;
        }
        if (ps->failed) return v;
        skip_ws(ps);
        if (*ps->p == ',') {
            ps->p++;
            skip_ws(ps);
            if (*ps->p == close) {
                fail(ps, "trailing comma before '%c'", close);
                return v;
            }
            continue;
        }
        if (*ps->p == close) {
            ps->p++;
            return v;
        }
        fail(ps, "expected ',' or '%c'", close);
        return v;
    }
}

static json_value_t *parse_number(parser_t *ps)
{
    const char *s = ps->p;
    const char *q = s;
    json_value_t *v;

    if (*q == '-') q++;
    if (*q == '0') {
        q++;
    } else if (*q >= '1' && *q <= '9') {
        while (*q >= '0' && *q <= '9') q++;
    } else {
        fail(ps, "invalid number");
        return NULL;
    }
    if (*q == '.') {
        q++;
        if (!(*q >= '0' && *q <= '9')) {
            fail(ps, "invalid number");
            return NULL;
        }
        while (*q >= '0' && *q <= '9') q++;
    }
    if (*q == 'e' || *q == 'E') {
        q++;
        if (*q == '+' || *q == '-') q++;
        if (!(*q >= '0' && *q <= '9')) {
            fail(ps, "invalid number");
            return NULL;
        }
        while (*q >= '0' && *q <= '9') q++;
    }
    v = new_value(ps, JSON_NUMBER);
    if (!v) return NULL;
    v->number = strtod(s, NULL);
    ps->p = q;
    return v;
}

static json_value_t *parse_value(parser_t *ps, int depth)
{
    json_value_t *v;

    skip_ws(ps);
    switch (*ps->p) {
        case '{': return parse_container(ps, depth, true);
        case '[': return parse_container(ps, depth, false);
        case '"':
            v = new_value(ps, JSON_STRING);
            if (!v) return NULL;
            v->string = parse_string_raw(ps);
            if (!v->string) {
                free(v);
                return NULL;
            }
            return v;
        case 't':
            if (strncmp(ps->p, "true", 4) == 0) {
                v = new_value(ps, JSON_BOOL);
                if (v) v->boolean = true;
                ps->p += 4;
                return v;
            }
            break;
        case 'f':
            if (strncmp(ps->p, "false", 5) == 0) {
                v = new_value(ps, JSON_BOOL);
                ps->p += 5;
                return v;
            }
            break;
        case 'n':
            if (strncmp(ps->p, "null", 4) == 0) {
                v = new_value(ps, JSON_NULL);
                ps->p += 4;
                return v;
            }
            break;
        case '\0':
            fail(ps, "unexpected end of input");
            return NULL;
        default:
            if (*ps->p == '-' || (*ps->p >= '0' && *ps->p <= '9')) return parse_number(ps);
            break;
    }
    fail(ps, "unexpected character '%c'", *ps->p);
    return NULL;
}

json_value_t *json_parse(const char *text, char *err, size_t errsz)
{
    parser_t ps = {text, text, err, errsz, false};

    if (err && errsz) err[0] = '\0';
    /* Skip a UTF-8 BOM (common in files written on Windows) */
    if ((unsigned char)ps.p[0] == 0xEF && (unsigned char)ps.p[1] == 0xBB && (unsigned char)ps.p[2] == 0xBF) {
        ps.p += 3;
    }
    json_value_t *root = parse_value(&ps, 0);
    if (!ps.failed) {
        skip_ws(&ps);
        if (*ps.p != '\0') fail(&ps, "unexpected data after the JSON value");
    }
    if (ps.failed) {
        json_free(root);
        return NULL;
    }
    return root;
}

json_value_t *json_parse_file(const char *path, char *err, size_t errsz)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        snprintf(err, errsz, "cannot open %s", path);
        return NULL;
    }
    size_t cap = 4096, len = 0;
    char *buf = (char *)malloc(cap);
    while (buf) {
        if (len + 1 >= cap) {
            if (cap >= MAX_FILE_BYTES) {
                free(buf);
                fclose(f);
                snprintf(err, errsz, "%s is larger than %u bytes", path, MAX_FILE_BYTES);
                return NULL;
            }
            char *nb = (char *)realloc(buf, cap * 2);
            if (!nb) {
                free(buf);
                buf = NULL;
                break;
            }
            buf = nb;
            cap *= 2;
        }
        size_t n = fread(buf + len, 1, cap - 1 - len, f);
        len += n;
        if (n == 0) break;
    }
    bool io_err = ferror(f) != 0;
    fclose(f);
    if (!buf || io_err) {
        free(buf);
        snprintf(err, errsz, "cannot read %s", path);
        return NULL;
    }
    buf[len] = '\0';
    if (strlen(buf) != len) {
        free(buf);
        snprintf(err, errsz, "%s contains a NUL byte (not a text file?)", path);
        return NULL;
    }
    json_value_t *v = json_parse(buf, err, errsz);
    free(buf);
    return v;
}

void json_free(json_value_t *v)
{
    if (!v) return;
    for (size_t i = 0; i < v->count; i++) {
        json_free(v->items[i]);
        if (v->keys) free(v->keys[i]);
    }
    free(v->items);
    free(v->keys);
    free(v->string);
    free(v);
}

json_value_t *json_get(const json_value_t *obj, const char *key)
{
    if (!obj || obj->type != JSON_OBJECT) return NULL;
    for (size_t i = 0; i < obj->count; i++) {
        if (strcmp(obj->keys[i], key) == 0) return obj->items[i];
    }
    return NULL;
}

bool json_is_int(const json_value_t *v)
{
    return v && v->type == JSON_NUMBER && v->number == floor(v->number) &&
           v->number >= -2147483648.0 && v->number <= 2147483647.0;
}

const char *json_type_name(json_type_t t)
{
    switch (t) {
        case JSON_NULL:   return "null";
        case JSON_BOOL:   return "boolean";
        case JSON_NUMBER: return "number";
        case JSON_STRING: return "string";
        case JSON_ARRAY:  return "array";
        case JSON_OBJECT: return "object";
        default:          return "?";
    }
}
