/**
 * @file json.h
 * Small JSON DOM parser (RFC 8259) for action scripts and UI documents.
 *
 * Everything is allocated with malloc(), never with lv_malloc(), so parsing
 * does not show up in the LVGL heap statistics.
 */
#ifndef SIM_JSON_H
#define SIM_JSON_H

#include <stdbool.h>
#include <stddef.h>

typedef enum {
    JSON_NULL,
    JSON_BOOL,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT,
} json_type_t;

typedef struct json_value json_value_t;

struct json_value {
    json_type_t type;
    bool boolean;
    double number;
    char *string;           /* JSON_STRING: NUL-terminated UTF-8 */
    size_t count;           /* JSON_ARRAY / JSON_OBJECT: number of items */
    json_value_t **items;   /* JSON_ARRAY / JSON_OBJECT: values */
    char **keys;            /* JSON_OBJECT: keys, in document order */
    int line;               /* 1-based position of the value in the text */
    int col;
};

/**
 * Parse a complete JSON text.
 * @param text   NUL-terminated input
 * @param err    receives "line L, column C: message" on failure
 * @param errsz  size of `err`
 * @return the root value (free with json_free), or NULL on error
 */
json_value_t *json_parse(const char *text, char *err, size_t errsz);

/** Read a whole file and parse it; `err` also covers I/O errors */
json_value_t *json_parse_file(const char *path, char *err, size_t errsz);

void json_free(json_value_t *v);

/** Member of an object by key, or NULL (also NULL when `obj` is not an object) */
json_value_t *json_get(const json_value_t *obj, const char *key);

/** True when `v` is a number with an integral value in the int32 range */
bool json_is_int(const json_value_t *v);

/** Human-readable name of a type ("string", "object", ...) */
const char *json_type_name(json_type_t t);

#endif /* SIM_JSON_H */
