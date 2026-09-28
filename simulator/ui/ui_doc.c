/**
 * @file ui_doc.c
 * JSON UI document interpreter (contract section 10).
 *
 * The document is validated and built in one pass; every problem is
 * collected with its JSON path and printed at the end ("ui: <path>: <msg>",
 * naturally sorted by path), so one run reports all mistakes. Unknown keys
 * are errors. Objects whose type is unknown are replaced by a plain lv_obj
 * placeholder so their children are still checked.
 *
 * Values persist for the lifetime of the process where LVGL keeps pointers
 * (button matrix maps, line points, grid templates, gradient descriptors).
 * All of that memory comes from malloc(), not from the LVGL heap.
 */
#include "ui_doc.h"

#include "json.h"
#include "sim_runtime.h"
#include "widget_tree.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__GNUC__) || defined(__clang__)
#define UI_PRINTF(a, b) __attribute__((format(printf, a, b)))
#else
#define UI_PRINTF(a, b)
#endif

#define UI_PATH_MAX 512

/**********************
 *  Errors
 **********************/

typedef struct {
    char *path;
    char *msg;
} ui_err_t;

typedef struct {
    lv_obj_t *obj;
    char *name;
    char *path;
} ui_named_t;

typedef struct {
    lv_display_t *disp;
    ui_err_t *errs;
    size_t err_count;
    size_t err_cap;
    ui_named_t *named;
    size_t named_count;
    size_t named_cap;
} ui_ctx_t;

static char *dup_str(const char *s)
{
    size_t n = strlen(s);
    char *d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

UI_PRINTF(3, 4)
static void err_at(ui_ctx_t *c, const char *path, const char *fmt, ...)
{
    char msg[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    if (c->err_count == c->err_cap) {
        size_t ncap = c->err_cap ? c->err_cap * 2 : 16;
        ui_err_t *n = (ui_err_t *)realloc(c->errs, ncap * sizeof(*n));
        if (!n) return;
        c->errs = n;
        c->err_cap = ncap;
    }
    c->errs[c->err_count].path = dup_str(path[0] ? path : "$");
    c->errs[c->err_count].msg = dup_str(msg);
    c->err_count++;
}

/** Natural order: digit runs compare numerically ("children[2]" < "children[10]") */
static int natural_cmp(const char *a, const char *b)
{
    while (*a && *b) {
        if (*a >= '0' && *a <= '9' && *b >= '0' && *b <= '9') {
            char *ea, *eb;
            unsigned long x = strtoul(a, &ea, 10);
            unsigned long y = strtoul(b, &eb, 10);
            if (x != y) return x < y ? -1 : 1;
            a = ea;
            b = eb;
            continue;
        }
        if (*a != *b) return (unsigned char)*a < (unsigned char)*b ? -1 : 1;
        a++;
        b++;
    }
    return *a ? 1 : *b ? -1 : 0;
}

static int err_cmp(const void *pa, const void *pb)
{
    const ui_err_t *a = (const ui_err_t *)pa;
    const ui_err_t *b = (const ui_err_t *)pb;
    int r = natural_cmp(a->path, b->path);
    return r ? r : strcmp(a->msg, b->msg);
}

static void path_append(char *out, size_t *len, const char *s)
{
    while (*s && *len + 1 < UI_PATH_MAX) out[(*len)++] = *s++;
    out[*len] = '\0';
}

/** out = base.key (or key at the top level); `out` may not alias `base` */
static void path_key(char *out, const char *base, const char *key)
{
    size_t len = 0;
    out[0] = '\0';
    path_append(out, &len, base);
    if (base[0]) path_append(out, &len, ".");
    path_append(out, &len, key);
}

/** out = base[i] */
static void path_idx(char *out, const char *base, size_t i)
{
    char num[24];
    size_t len = 0;
    snprintf(num, sizeof(num), "[%u]", (unsigned)i);
    out[0] = '\0';
    path_append(out, &len, base);
    path_append(out, &len, num);
}

/** Edit distance with adjacent transpositions (optimal string alignment), for "did you mean" hints */
static size_t edit_distance(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    static size_t d[64][64];
    if (la >= 63 || lb >= 63) return 99;
    for (size_t i = 0; i <= la; i++) d[i][0] = i;
    for (size_t j = 0; j <= lb; j++) d[0][j] = j;
    for (size_t i = 1; i <= la; i++) {
        for (size_t j = 1; j <= lb; j++) {
            size_t cost = a[i - 1] == b[j - 1] ? 0 : 1;
            size_t best = d[i - 1][j - 1] + cost;
            if (d[i - 1][j] + 1 < best) best = d[i - 1][j] + 1;
            if (d[i][j - 1] + 1 < best) best = d[i][j - 1] + 1;
            if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] && d[i - 2][j - 2] + 1 < best) {
                best = d[i - 2][j - 2] + 1;
            }
            d[i][j] = best;
        }
    }
    return d[la][lb];
}

/** " (did you mean \"x\"?)" for the closest candidate, or "" */
static const char *suggest(const char *word, const char *const *cands, size_t n, char *buf, size_t size)
{
    size_t best = 99;
    const char *best_s = NULL;
    for (size_t i = 0; i < n; i++) {
        size_t d = edit_distance(word, cands[i]);
        if (d < best) {
            best = d;
            best_s = cands[i];
        }
    }
    size_t limit = strlen(word) <= 4 ? 1 : 3;
    if (!best_s || best > limit) {
        buf[0] = '\0';
        return buf;
    }
    snprintf(buf, size, " (did you mean \"%s\"?)", best_s);
    return buf;
}

static void join_list(char *buf, size_t size, const char *const *items, size_t n)
{
    size_t len = 0;
    buf[0] = '\0';
    for (size_t i = 0; i < n && len + 1 < size; i++) {
        int w = snprintf(buf + len, size - len, "%s%s", i ? ", " : "", items[i]);
        if (w < 0) break;
        len += (size_t)w;
    }
}

/**********************
 *  Value parsers
 **********************/

static bool v_int(ui_ctx_t *c, const json_value_t *v, const char *path, int32_t min, int32_t max, int32_t *out)
{
    if (!json_is_int(v)) {
        err_at(c, path, "expected integer, got %s", v ? json_type_name(v->type) : "nothing");
        return false;
    }
    if (v->number < min || v->number > max) {
        err_at(c, path, "%d is out of range %d..%d", (int)v->number, (int)min, (int)max);
        return false;
    }
    *out = (int32_t)v->number;
    return true;
}

static bool v_bool(ui_ctx_t *c, const json_value_t *v, const char *path, bool *out)
{
    if (!v || v->type != JSON_BOOL) {
        err_at(c, path, "expected true or false, got %s", v ? json_type_name(v->type) : "nothing");
        return false;
    }
    *out = v->boolean;
    return true;
}

static bool v_str(ui_ctx_t *c, const json_value_t *v, const char *path, const char **out)
{
    if (!v || v->type != JSON_STRING) {
        err_at(c, path, "expected string, got %s", v ? json_type_name(v->type) : "nothing");
        return false;
    }
    *out = v->string;
    return true;
}

static int hexval(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

/** "#rrggbb" or "#rgb" */
static bool v_color(ui_ctx_t *c, const json_value_t *v, const char *path, lv_color_t *out)
{
    if (!v || v->type != JSON_STRING || v->string[0] != '#') {
        err_at(c, path, "expected a colour \"#rrggbb\" or \"#rgb\"");
        return false;
    }
    const char *s = v->string + 1;
    size_t n = strlen(s);
    int d[6];
    for (size_t i = 0; i < n && i < 6; i++) d[i] = hexval(s[i]);
    if (n == 6 && d[0] >= 0 && d[1] >= 0 && d[2] >= 0 && d[3] >= 0 && d[4] >= 0 && d[5] >= 0) {
        *out = lv_color_make((uint8_t)(d[0] * 16 + d[1]), (uint8_t)(d[2] * 16 + d[3]), (uint8_t)(d[4] * 16 + d[5]));
        return true;
    }
    if (n == 3 && d[0] >= 0 && d[1] >= 0 && d[2] >= 0) {
        *out = lv_color_make((uint8_t)(d[0] * 17), (uint8_t)(d[1] * 17), (uint8_t)(d[2] * 17));
        return true;
    }
    err_at(c, path, "invalid colour \"%s\" (expected \"#rrggbb\" or \"#rgb\")", v->string);
    return false;
}

/** "N%" -> N, or -1 */
static int32_t parse_pct(const char *s)
{
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s || strcmp(end, "%") != 0 || v < 0 || v > 1000) return -1;
    return (int32_t)v;
}

/** 0..255 or "N%" (0..100) */
static bool v_opa(ui_ctx_t *c, const json_value_t *v, const char *path, lv_opa_t *out)
{
    if (json_is_int(v) && v->number >= 0 && v->number <= 255) {
        *out = (lv_opa_t)v->number;
        return true;
    }
    if (v && v->type == JSON_STRING) {
        int32_t p = parse_pct(v->string);
        if (p >= 0 && p <= 100) {
            *out = (lv_opa_t)((p * 255 + 50) / 100);
            return true;
        }
    }
    err_at(c, path, "expected opacity 0..255 or \"0%%\"..\"100%%\"");
    return false;
}

/** int px, "N%" or "content" */
static bool v_size(ui_ctx_t *c, const json_value_t *v, const char *path, bool allow_content, int32_t *out)
{
    if (json_is_int(v) && v->number >= -100000 && v->number <= 100000) {
        *out = (int32_t)v->number;
        return true;
    }
    if (v && v->type == JSON_STRING) {
        if (allow_content && strcmp(v->string, "content") == 0) {
            *out = LV_SIZE_CONTENT;
            return true;
        }
        int32_t p = parse_pct(v->string);
        if (p >= 0) {
            *out = lv_pct(p);
            return true;
        }
    }
    err_at(c, path, allow_content ? "expected integer px, \"N%%\" or \"content\"" : "expected integer px or \"N%%\"");
    return false;
}

typedef struct {
    const char *name;
    int32_t value;
} enum_t;

static bool v_enum(ui_ctx_t *c, const json_value_t *v, const char *path, const enum_t *tab, size_t n, int32_t *out)
{
    const char *names[64];
    char list[768];
    char hint[96];
    for (size_t i = 0; i < n && i < 64; i++) names[i] = tab[i].name;
    if (v && v->type == JSON_STRING) {
        for (size_t i = 0; i < n; i++) {
            if (strcmp(v->string, tab[i].name) == 0) {
                *out = tab[i].value;
                return true;
            }
        }
    }
    join_list(list, sizeof(list), names, n < 64 ? n : 64);
    if (v && v->type == JSON_STRING) {
        err_at(c, path, "unknown value \"%s\"%s (known: %s)", v->string, suggest(v->string, names, n, hint, sizeof(hint)),
               list);
    } else {
        err_at(c, path, "expected one of: %s", list);
    }
    return false;
}

#define ENUM_N(t) (sizeof(t) / sizeof((t)[0]))

static const enum_t align_enum[] = {
    {"default", LV_ALIGN_DEFAULT},           {"top_left", LV_ALIGN_TOP_LEFT},
    {"top_mid", LV_ALIGN_TOP_MID},           {"top_right", LV_ALIGN_TOP_RIGHT},
    {"bottom_left", LV_ALIGN_BOTTOM_LEFT},   {"bottom_mid", LV_ALIGN_BOTTOM_MID},
    {"bottom_right", LV_ALIGN_BOTTOM_RIGHT}, {"left_mid", LV_ALIGN_LEFT_MID},
    {"right_mid", LV_ALIGN_RIGHT_MID},       {"center", LV_ALIGN_CENTER},
    {"out_top_left", LV_ALIGN_OUT_TOP_LEFT}, {"out_top_mid", LV_ALIGN_OUT_TOP_MID},
    {"out_top_right", LV_ALIGN_OUT_TOP_RIGHT}, {"out_bottom_left", LV_ALIGN_OUT_BOTTOM_LEFT},
    {"out_bottom_mid", LV_ALIGN_OUT_BOTTOM_MID}, {"out_bottom_right", LV_ALIGN_OUT_BOTTOM_RIGHT},
    {"out_left_top", LV_ALIGN_OUT_LEFT_TOP}, {"out_left_mid", LV_ALIGN_OUT_LEFT_MID},
    {"out_left_bottom", LV_ALIGN_OUT_LEFT_BOTTOM}, {"out_right_top", LV_ALIGN_OUT_RIGHT_TOP},
    {"out_right_mid", LV_ALIGN_OUT_RIGHT_MID}, {"out_right_bottom", LV_ALIGN_OUT_RIGHT_BOTTOM},
};

static const enum_t long_mode_enum[] = {
    {"wrap", LV_LABEL_LONG_MODE_WRAP},     {"dots", LV_LABEL_LONG_MODE_DOTS},
    {"scroll", LV_LABEL_LONG_MODE_SCROLL}, {"scroll_circular", LV_LABEL_LONG_MODE_SCROLL_CIRCULAR},
    {"clip", LV_LABEL_LONG_MODE_CLIP},
};

static const enum_t flex_flow_enum[] = {
    {"row", LV_FLEX_FLOW_ROW},
    {"column", LV_FLEX_FLOW_COLUMN},
    {"row_wrap", LV_FLEX_FLOW_ROW_WRAP},
    {"row_reverse", LV_FLEX_FLOW_ROW_REVERSE},
    {"row_wrap_reverse", LV_FLEX_FLOW_ROW_WRAP_REVERSE},
    {"column_wrap", LV_FLEX_FLOW_COLUMN_WRAP},
    {"column_reverse", LV_FLEX_FLOW_COLUMN_REVERSE},
    {"column_wrap_reverse", LV_FLEX_FLOW_COLUMN_WRAP_REVERSE},
};

static const enum_t flex_align_enum[] = {
    {"start", LV_FLEX_ALIGN_START},
    {"end", LV_FLEX_ALIGN_END},
    {"center", LV_FLEX_ALIGN_CENTER},
    {"space_evenly", LV_FLEX_ALIGN_SPACE_EVENLY},
    {"space_around", LV_FLEX_ALIGN_SPACE_AROUND},
    {"space_between", LV_FLEX_ALIGN_SPACE_BETWEEN},
};

static const enum_t grid_align_enum[] = {
    {"start", LV_GRID_ALIGN_START},
    {"center", LV_GRID_ALIGN_CENTER},
    {"end", LV_GRID_ALIGN_END},
    {"stretch", LV_GRID_ALIGN_STRETCH},
    {"space_evenly", LV_GRID_ALIGN_SPACE_EVENLY},
    {"space_around", LV_GRID_ALIGN_SPACE_AROUND},
    {"space_between", LV_GRID_ALIGN_SPACE_BETWEEN},
};

static const enum_t grad_dir_enum[] = {
    {"none", LV_GRAD_DIR_NONE},
    {"hor", LV_GRAD_DIR_HOR},
    {"ver", LV_GRAD_DIR_VER},
};

static const enum_t border_side_enum[] = {
    {"full", LV_BORDER_SIDE_FULL}, {"top", LV_BORDER_SIDE_TOP},   {"bottom", LV_BORDER_SIDE_BOTTOM},
    {"left", LV_BORDER_SIDE_LEFT}, {"right", LV_BORDER_SIDE_RIGHT}, {"none", LV_BORDER_SIDE_NONE},
};

static const enum_t text_align_enum[] = {
    {"auto", LV_TEXT_ALIGN_AUTO},
    {"left", LV_TEXT_ALIGN_LEFT},
    {"center", LV_TEXT_ALIGN_CENTER},
    {"right", LV_TEXT_ALIGN_RIGHT},
};

static const enum_t state_enum[] = {
    {"checked", LV_STATE_CHECKED},
    {"disabled", LV_STATE_DISABLED},
    {"focused", LV_STATE_FOCUSED},
};

static const enum_t dir_enum[] = {
    {"top", LV_DIR_TOP},
    {"bottom", LV_DIR_BOTTOM},
    {"left", LV_DIR_LEFT},
    {"right", LV_DIR_RIGHT},
};

static const enum_t scale_mode_enum[] = {
    {"horizontal_top", LV_SCALE_MODE_HORIZONTAL_TOP}, {"horizontal_bottom", LV_SCALE_MODE_HORIZONTAL_BOTTOM},
    {"vertical_left", LV_SCALE_MODE_VERTICAL_LEFT},   {"vertical_right", LV_SCALE_MODE_VERTICAL_RIGHT},
    {"round_inner", LV_SCALE_MODE_ROUND_INNER},       {"round_outer", LV_SCALE_MODE_ROUND_OUTER},
};

static const enum_t chart_type_enum[] = {
    {"line", LV_CHART_TYPE_LINE},
    {"bar", LV_CHART_TYPE_BAR},
};

static const struct {
    const char *name;
    const char *sym;
} symbols[] = {
    {"BULLET", LV_SYMBOL_BULLET},     {"AUDIO", LV_SYMBOL_AUDIO},       {"VIDEO", LV_SYMBOL_VIDEO},
    {"LIST", LV_SYMBOL_LIST},         {"OK", LV_SYMBOL_OK},             {"CLOSE", LV_SYMBOL_CLOSE},
    {"POWER", LV_SYMBOL_POWER},       {"SETTINGS", LV_SYMBOL_SETTINGS}, {"HOME", LV_SYMBOL_HOME},
    {"DOWNLOAD", LV_SYMBOL_DOWNLOAD}, {"DRIVE", LV_SYMBOL_DRIVE},       {"REFRESH", LV_SYMBOL_REFRESH},
    {"MUTE", LV_SYMBOL_MUTE},         {"VOLUME_MID", LV_SYMBOL_VOLUME_MID}, {"VOLUME_MAX", LV_SYMBOL_VOLUME_MAX},
    {"IMAGE", LV_SYMBOL_IMAGE},       {"TINT", LV_SYMBOL_TINT},         {"PREV", LV_SYMBOL_PREV},
    {"PLAY", LV_SYMBOL_PLAY},         {"PAUSE", LV_SYMBOL_PAUSE},       {"STOP", LV_SYMBOL_STOP},
    {"NEXT", LV_SYMBOL_NEXT},         {"EJECT", LV_SYMBOL_EJECT},       {"LEFT", LV_SYMBOL_LEFT},
    {"RIGHT", LV_SYMBOL_RIGHT},       {"PLUS", LV_SYMBOL_PLUS},         {"MINUS", LV_SYMBOL_MINUS},
    {"EYE_OPEN", LV_SYMBOL_EYE_OPEN}, {"EYE_CLOSE", LV_SYMBOL_EYE_CLOSE}, {"WARNING", LV_SYMBOL_WARNING},
    {"SHUFFLE", LV_SYMBOL_SHUFFLE},   {"UP", LV_SYMBOL_UP},             {"DOWN", LV_SYMBOL_DOWN},
    {"LOOP", LV_SYMBOL_LOOP},         {"DIRECTORY", LV_SYMBOL_DIRECTORY}, {"UPLOAD", LV_SYMBOL_UPLOAD},
    {"CALL", LV_SYMBOL_CALL},         {"CUT", LV_SYMBOL_CUT},           {"COPY", LV_SYMBOL_COPY},
    {"SAVE", LV_SYMBOL_SAVE},         {"BARS", LV_SYMBOL_BARS},         {"ENVELOPE", LV_SYMBOL_ENVELOPE},
    {"CHARGE", LV_SYMBOL_CHARGE},     {"PASTE", LV_SYMBOL_PASTE},       {"BELL", LV_SYMBOL_BELL},
    {"KEYBOARD", LV_SYMBOL_KEYBOARD}, {"GPS", LV_SYMBOL_GPS},           {"FILE", LV_SYMBOL_FILE},
    {"WIFI", LV_SYMBOL_WIFI},         {"BATTERY_FULL", LV_SYMBOL_BATTERY_FULL}, {"BATTERY_3", LV_SYMBOL_BATTERY_3},
    {"BATTERY_2", LV_SYMBOL_BATTERY_2}, {"BATTERY_1", LV_SYMBOL_BATTERY_1}, {"BATTERY_EMPTY", LV_SYMBOL_BATTERY_EMPTY},
    {"USB", LV_SYMBOL_USB},           {"BLUETOOTH", LV_SYMBOL_BLUETOOTH}, {"TRASH", LV_SYMBOL_TRASH},
    {"EDIT", LV_SYMBOL_EDIT},         {"BACKSPACE", LV_SYMBOL_BACKSPACE}, {"SD_CARD", LV_SYMBOL_SD_CARD},
    {"NEW_LINE", LV_SYMBOL_NEW_LINE},
};

/** "symbol:NAME" -> LV_SYMBOL_NAME string, else NULL (error reported) */
static const char *v_symbol(ui_ctx_t *c, const char *s, const char *path)
{
    const char *name = s + 7; /* after "symbol:" */
    const char *names[80];
    char hint[96];
    size_t n = sizeof(symbols) / sizeof(symbols[0]);
    for (size_t i = 0; i < n; i++) {
        if (strcmp(name, symbols[i].name) == 0) return symbols[i].sym;
        names[i] = symbols[i].name;
    }
    err_at(c, path, "unknown symbol \"%s\"%s (e.g. OK, CLOSE, SETTINGS, HOME, WIFI, BATTERY_FULL, PLUS, MINUS, "
                    "LEFT, RIGHT, UP, DOWN, BELL, EDIT, TRASH, SAVE, PLAY, PAUSE)",
           name, suggest(name, names, n, hint, sizeof(hint)));
    return NULL;
}

/**********************
 *  Styles
 **********************/

typedef enum {
    SV_COLOR,
    SV_OPA,
    SV_INT,
    SV_SIZE,
    SV_RADIUS,
    SV_BOOL,
    SV_FONT,
    SV_ENUM_GRAD_DIR,
    SV_ENUM_BORDER_SIDE,
    SV_ENUM_TEXT_ALIGN,
    SV_MULTI,       /* shorthand: sets several props */
    SV_GRAD_STOPS,
    SV_READ_ONLY,
} sv_kind_t;

typedef struct {
    const char *key;
    sv_kind_t kind;
    lv_style_prop_t prop;
    int32_t min;
    int32_t max;
    lv_style_prop_t more[3];   /* SV_MULTI: further props */
} style_key_t;

#define PX_MAX 10000
static const style_key_t style_keys[] = {
    {"bg_color", SV_COLOR, LV_STYLE_BG_COLOR, 0, 0, {0}},
    {"bg_opa", SV_OPA, LV_STYLE_BG_OPA, 0, 0, {0}},
    {"bg_grad_color", SV_COLOR, LV_STYLE_BG_GRAD_COLOR, 0, 0, {0}},
    {"bg_grad_dir", SV_ENUM_GRAD_DIR, LV_STYLE_BG_GRAD_DIR, 0, 0, {0}},
    {"bg_grad_stops", SV_GRAD_STOPS, LV_STYLE_BG_GRAD, 0, 0, {0}},
    {"bg_main_stop", SV_INT, LV_STYLE_BG_MAIN_STOP, 0, 255, {0}},
    {"bg_grad_stop", SV_INT, LV_STYLE_BG_GRAD_STOP, 0, 255, {0}},
    {"bg_main_opa", SV_OPA, LV_STYLE_BG_MAIN_OPA, 0, 0, {0}},
    {"bg_grad_opa", SV_OPA, LV_STYLE_BG_GRAD_OPA, 0, 0, {0}},
    {"border_color", SV_COLOR, LV_STYLE_BORDER_COLOR, 0, 0, {0}},
    {"border_width", SV_INT, LV_STYLE_BORDER_WIDTH, 0, PX_MAX, {0}},
    {"border_opa", SV_OPA, LV_STYLE_BORDER_OPA, 0, 0, {0}},
    {"border_side", SV_ENUM_BORDER_SIDE, LV_STYLE_BORDER_SIDE, 0, 0, {0}},
    {"outline_width", SV_INT, LV_STYLE_OUTLINE_WIDTH, 0, PX_MAX, {0}},
    {"outline_color", SV_COLOR, LV_STYLE_OUTLINE_COLOR, 0, 0, {0}},
    {"outline_opa", SV_OPA, LV_STYLE_OUTLINE_OPA, 0, 0, {0}},
    {"outline_pad", SV_INT, LV_STYLE_OUTLINE_PAD, -PX_MAX, PX_MAX, {0}},
    {"radius", SV_RADIUS, LV_STYLE_RADIUS, 0, PX_MAX, {0}},
    {"pad_top", SV_INT, LV_STYLE_PAD_TOP, -PX_MAX, PX_MAX, {0}},
    {"pad_bottom", SV_INT, LV_STYLE_PAD_BOTTOM, -PX_MAX, PX_MAX, {0}},
    {"pad_left", SV_INT, LV_STYLE_PAD_LEFT, -PX_MAX, PX_MAX, {0}},
    {"pad_right", SV_INT, LV_STYLE_PAD_RIGHT, -PX_MAX, PX_MAX, {0}},
    {"pad_row", SV_INT, LV_STYLE_PAD_ROW, -PX_MAX, PX_MAX, {0}},
    {"pad_column", SV_INT, LV_STYLE_PAD_COLUMN, -PX_MAX, PX_MAX, {0}},
    {"pad_all", SV_MULTI, LV_STYLE_PAD_TOP, -PX_MAX, PX_MAX, {LV_STYLE_PAD_BOTTOM, LV_STYLE_PAD_LEFT, LV_STYLE_PAD_RIGHT}},
    {"pad_hor", SV_MULTI, LV_STYLE_PAD_LEFT, -PX_MAX, PX_MAX, {LV_STYLE_PAD_RIGHT, 0, 0}},
    {"pad_ver", SV_MULTI, LV_STYLE_PAD_TOP, -PX_MAX, PX_MAX, {LV_STYLE_PAD_BOTTOM, 0, 0}},
    {"pad_gap", SV_MULTI, LV_STYLE_PAD_ROW, -PX_MAX, PX_MAX, {LV_STYLE_PAD_COLUMN, 0, 0}},
    {"margin_top", SV_INT, LV_STYLE_MARGIN_TOP, -PX_MAX, PX_MAX, {0}},
    {"margin_bottom", SV_INT, LV_STYLE_MARGIN_BOTTOM, -PX_MAX, PX_MAX, {0}},
    {"margin_left", SV_INT, LV_STYLE_MARGIN_LEFT, -PX_MAX, PX_MAX, {0}},
    {"margin_right", SV_INT, LV_STYLE_MARGIN_RIGHT, -PX_MAX, PX_MAX, {0}},
    {"margin_all", SV_MULTI, LV_STYLE_MARGIN_TOP, -PX_MAX, PX_MAX, {LV_STYLE_MARGIN_BOTTOM, LV_STYLE_MARGIN_LEFT, LV_STYLE_MARGIN_RIGHT}},
    {"margin_hor", SV_MULTI, LV_STYLE_MARGIN_LEFT, -PX_MAX, PX_MAX, {LV_STYLE_MARGIN_RIGHT, 0, 0}},
    {"margin_ver", SV_MULTI, LV_STYLE_MARGIN_TOP, -PX_MAX, PX_MAX, {LV_STYLE_MARGIN_BOTTOM, 0, 0}},
    {"shadow_color", SV_COLOR, LV_STYLE_SHADOW_COLOR, 0, 0, {0}},
    {"shadow_width", SV_INT, LV_STYLE_SHADOW_WIDTH, 0, PX_MAX, {0}},
    {"shadow_spread", SV_INT, LV_STYLE_SHADOW_SPREAD, -PX_MAX, PX_MAX, {0}},
    {"shadow_opa", SV_OPA, LV_STYLE_SHADOW_OPA, 0, 0, {0}},
    {"shadow_ofs_x", SV_INT, LV_STYLE_SHADOW_OFFSET_X, -PX_MAX, PX_MAX, {0}},
    {"shadow_ofs_y", SV_INT, LV_STYLE_SHADOW_OFFSET_Y, -PX_MAX, PX_MAX, {0}},
    {"text_color", SV_COLOR, LV_STYLE_TEXT_COLOR, 0, 0, {0}},
    {"text_opa", SV_OPA, LV_STYLE_TEXT_OPA, 0, 0, {0}},
    {"font", SV_FONT, LV_STYLE_TEXT_FONT, 0, 0, {0}},
    {"text_align", SV_ENUM_TEXT_ALIGN, LV_STYLE_TEXT_ALIGN, 0, 0, {0}},
    {"text_letter_space", SV_INT, LV_STYLE_TEXT_LETTER_SPACE, -PX_MAX, PX_MAX, {0}},
    {"text_line_space", SV_INT, LV_STYLE_TEXT_LINE_SPACE, -PX_MAX, PX_MAX, {0}},
    {"line_width", SV_INT, LV_STYLE_LINE_WIDTH, 0, PX_MAX, {0}},
    {"line_color", SV_COLOR, LV_STYLE_LINE_COLOR, 0, 0, {0}},
    {"line_opa", SV_OPA, LV_STYLE_LINE_OPA, 0, 0, {0}},
    {"line_rounded", SV_BOOL, LV_STYLE_LINE_ROUNDED, 0, 0, {0}},
    {"arc_width", SV_INT, LV_STYLE_ARC_WIDTH, 0, PX_MAX, {0}},
    {"arc_color", SV_COLOR, LV_STYLE_ARC_COLOR, 0, 0, {0}},
    {"arc_opa", SV_OPA, LV_STYLE_ARC_OPA, 0, 0, {0}},
    {"arc_rounded", SV_BOOL, LV_STYLE_ARC_ROUNDED, 0, 0, {0}},
    {"image_opa", SV_OPA, LV_STYLE_IMAGE_OPA, 0, 0, {0}},
    {"image_recolor", SV_COLOR, LV_STYLE_IMAGE_RECOLOR, 0, 0, {0}},
    {"image_recolor_opa", SV_OPA, LV_STYLE_IMAGE_RECOLOR_OPA, 0, 0, {0}},
    {"opa", SV_OPA, LV_STYLE_OPA, 0, 0, {0}},
    {"width", SV_SIZE, LV_STYLE_WIDTH, 1, 0, {0}},
    {"height", SV_SIZE, LV_STYLE_HEIGHT, 1, 0, {0}},
    {"min_width", SV_SIZE, LV_STYLE_MIN_WIDTH, 0, 0, {0}},
    {"max_width", SV_SIZE, LV_STYLE_MAX_WIDTH, 0, 0, {0}},
    {"min_height", SV_SIZE, LV_STYLE_MIN_HEIGHT, 0, 0, {0}},
    {"max_height", SV_SIZE, LV_STYLE_MAX_HEIGHT, 0, 0, {0}},
    {"transform_rotation", SV_INT, LV_STYLE_TRANSFORM_ROTATION, -36000, 36000, {0}},
    {"transform_scale", SV_MULTI, LV_STYLE_TRANSFORM_SCALE_X, 1, 65535, {LV_STYLE_TRANSFORM_SCALE_Y, 0, 0}},
    {"transform_scale_x", SV_INT, LV_STYLE_TRANSFORM_SCALE_X, 1, 65535, {0}},
    {"transform_scale_y", SV_INT, LV_STYLE_TRANSFORM_SCALE_Y, 1, 65535, {0}},
    {"transform_pivot_x", SV_SIZE, LV_STYLE_TRANSFORM_PIVOT_X, 0, 0, {0}},
    {"transform_pivot_y", SV_SIZE, LV_STYLE_TRANSFORM_PIVOT_Y, 0, 0, {0}},
    {"translate_x", SV_SIZE, LV_STYLE_TRANSLATE_X, 0, 0, {0}},
    {"translate_y", SV_SIZE, LV_STYLE_TRANSLATE_Y, 0, 0, {0}},
    {"clip_corner", SV_BOOL, LV_STYLE_CLIP_CORNER, 0, 0, {0}},
    {"line_height", SV_READ_ONLY, 0, 0, 0, {0}},
};
#define STYLE_KEY_COUNT (sizeof(style_keys) / sizeof(style_keys[0]))

static void set_prop(lv_obj_t *obj, lv_style_prop_t prop, lv_style_value_t v, lv_style_selector_t sel)
{
    lv_obj_set_local_style_prop(obj, prop, v, sel);
}

static void apply_grad_stops(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const json_value_t *block,
                             const char *path, lv_style_selector_t sel)
{
    lv_color_t colors[LV_GRADIENT_MAX_STOPS];
    lv_opa_t opas[LV_GRADIENT_MAX_STOPS];
    uint8_t fracs[LV_GRADIENT_MAX_STOPS];
    char p[UI_PATH_MAX], q[UI_PATH_MAX];
    bool ok = true;

    if (!v || v->type != JSON_ARRAY || v->count < 2 || v->count > LV_GRADIENT_MAX_STOPS) {
        err_at(c, path, "expected an array of 2..%d stops [{\"color\": \"#rrggbb\", \"frac\": 0..255}]",
               LV_GRADIENT_MAX_STOPS);
        return;
    }
    for (size_t i = 0; i < v->count; i++) {
        const json_value_t *s = v->items[i];
        path_idx(p, path, i);
        if (s->type != JSON_OBJECT) {
            err_at(c, p, "expected {\"color\": \"#rrggbb\", \"frac\": 0..255, \"opa\": 0..255}");
            ok = false;
            continue;
        }
        for (size_t k = 0; k < s->count; k++) {
            if (strcmp(s->keys[k], "color") && strcmp(s->keys[k], "frac") && strcmp(s->keys[k], "opa")) {
                path_key(q, p, s->keys[k]);
                err_at(c, q, "unknown key (known: color, frac, opa)");
                ok = false;
            }
        }
        int32_t frac = (int32_t)((i * 255) / (v->count - 1));
        path_key(q, p, "color");
        if (!v_color(c, json_get(s, "color"), q, &colors[i])) ok = false;
        if (json_get(s, "frac")) {
            path_key(q, p, "frac");
            if (!v_int(c, json_get(s, "frac"), q, 0, 255, &frac)) ok = false;
        }
        fracs[i] = (uint8_t)frac;
        opas[i] = LV_OPA_COVER;
        if (json_get(s, "opa")) {
            path_key(q, p, "opa");
            if (!v_opa(c, json_get(s, "opa"), q, &opas[i])) ok = false;
        }
    }
    if (!ok) return;
    lv_grad_dsc_t *dsc = (lv_grad_dsc_t *)calloc(1, sizeof(*dsc));
    if (!dsc) return;
    int32_t dir = LV_GRAD_DIR_VER;
    const json_value_t *dv = json_get(block, "bg_grad_dir");
    if (dv && dv->type == JSON_STRING && strcmp(dv->string, "hor") == 0) dir = LV_GRAD_DIR_HOR;
    if (dir == LV_GRAD_DIR_HOR) lv_grad_horizontal_init(dsc);
    else lv_grad_vertical_init(dsc);
    lv_grad_init_stops(dsc, colors, opas, fracs, (int)v->count);
    lv_style_value_t sv;
    sv.ptr = dsc;
    set_prop(obj, LV_STYLE_BG_GRAD, sv, sel);
}

/** Apply a style block ({"bg_color": ..., ...}) with `sel` */
static void apply_styles(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *block, const char *path,
                         lv_style_selector_t sel)
{
    char p[UI_PATH_MAX];
    char hint[96];
    const char *names[STYLE_KEY_COUNT];

    if (!block || block->type != JSON_OBJECT) {
        err_at(c, path, "expected an object of style properties, e.g. {\"bg_color\": \"#ffffff\", \"radius\": 8}");
        return;
    }
    for (size_t i = 0; i < STYLE_KEY_COUNT; i++) names[i] = style_keys[i].key;

    for (size_t i = 0; i < block->count; i++) {
        const char *key = block->keys[i];
        const json_value_t *v = block->items[i];
        const style_key_t *sk = NULL;
        path_key(p, path, key);
        for (size_t k = 0; k < STYLE_KEY_COUNT; k++) {
            if (strcmp(style_keys[k].key, key) == 0) sk = &style_keys[k];
        }
        if (!sk) {
            err_at(c, p, "unknown style property%s", suggest(key, names, STYLE_KEY_COUNT, hint, sizeof(hint)));
            continue;
        }
        lv_style_value_t sv;
        memset(&sv, 0, sizeof(sv));
        switch (sk->kind) {
            case SV_COLOR: {
                lv_color_t col;
                if (!v_color(c, v, p, &col)) continue;
                sv.color = col;
                break;
            }
            case SV_OPA: {
                lv_opa_t o;
                if (!v_opa(c, v, p, &o)) continue;
                sv.num = o;
                break;
            }
            case SV_INT:
            case SV_MULTI: {
                int32_t n;
                if (!v_int(c, v, p, sk->min, sk->max, &n)) continue;
                sv.num = n;
                break;
            }
            case SV_SIZE: {
                int32_t n;
                if (!v_size(c, v, p, sk->min == 1, &n)) continue;
                sv.num = n;
                break;
            }
            case SV_RADIUS: {
                if (v && v->type == JSON_STRING && strcmp(v->string, "circle") == 0) {
                    sv.num = LV_RADIUS_CIRCLE;
                    break;
                }
                int32_t n;
                if (json_is_int(v) && v->number == LV_RADIUS_CIRCLE) {
                    sv.num = LV_RADIUS_CIRCLE;
                    break;
                }
                if (!json_is_int(v)) {
                    err_at(c, p, "expected integer px or \"circle\"");
                    continue;
                }
                if (!v_int(c, v, p, 0, PX_MAX, &n)) continue;
                sv.num = n;
                break;
            }
            case SV_BOOL: {
                bool b;
                if (!v_bool(c, v, p, &b)) continue;
                sv.num = b;
                break;
            }
            case SV_FONT: {
                const char *s;
                if (!v_str(c, v, p, &s)) continue;
                const lv_font_t *f = widget_tree_font_by_name(s);
                if (!f) {
                    err_at(c, p, "unknown font \"%s\" (built-in: montserrat_8..montserrat_48 in steps of 2, "
                                 "montserrat_28_compressed, unscii_8, unscii_16)", s);
                    continue;
                }
                sv.ptr = f;
                break;
            }
            case SV_ENUM_GRAD_DIR:
            case SV_ENUM_BORDER_SIDE:
            case SV_ENUM_TEXT_ALIGN: {
                int32_t e;
                const enum_t *tab = sk->kind == SV_ENUM_GRAD_DIR ? grad_dir_enum
                                    : sk->kind == SV_ENUM_BORDER_SIDE ? border_side_enum : text_align_enum;
                size_t n = sk->kind == SV_ENUM_GRAD_DIR ? ENUM_N(grad_dir_enum)
                           : sk->kind == SV_ENUM_BORDER_SIDE ? ENUM_N(border_side_enum) : ENUM_N(text_align_enum);
                if (!v_enum(c, v, p, tab, n, &e)) continue;
                sv.num = e;
                break;
            }
            case SV_GRAD_STOPS:
                apply_grad_stops(c, obj, v, block, p, sel);
                continue;
            case SV_READ_ONLY:
                err_at(c, p, "\"%s\" is read-only (derived from the font); remove it", key);
                continue;
        }
        set_prop(obj, sk->prop, sv, sel);
        if (sk->kind == SV_MULTI) {
            for (size_t m = 0; m < 3 && sk->more[m]; m++) set_prop(obj, sk->more[m], sv, sel);
        }
    }
}

/**********************
 *  Widgets
 **********************/

typedef struct widget_def widget_def_t;
typedef void (*apply_fn_t)(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path);

struct widget_def {
    const char *type;
    lv_obj_t *(*create)(lv_obj_t *parent);
    const char *const *keys;    /* NULL-terminated widget-specific keys */
    apply_fn_t apply;
    bool no_children;           /* children go somewhere else (tabs) */
};

/*
 * lv_list is deprecated in 9.6 (its functions log a warning on every call);
 * build the same objects through the class API so the tree still reports
 * lv_list / lv_list_button / lv_list_text.
 */
static lv_obj_t *create_list(lv_obj_t *parent)
{
    lv_obj_t *obj = lv_obj_class_create_obj(&lv_list_class, parent);
    lv_obj_class_init_obj(obj);
    lv_obj_set_flex_flow(obj, LV_FLEX_FLOW_COLUMN);
    return obj;
}

static lv_obj_t *list_add_text(lv_obj_t *list, const char *txt)
{
    lv_obj_t *obj = lv_obj_class_create_obj(&lv_list_text_class, list);
    lv_obj_class_init_obj(obj);
    lv_label_set_text(obj, txt);
    return obj;
}

static lv_obj_t *list_add_button(lv_obj_t *list, const char *icon, const char *txt)
{
    lv_obj_t *obj = lv_obj_class_create_obj(&lv_list_button_class, list);
    lv_obj_class_init_obj(obj);
    lv_obj_set_flex_flow(obj, LV_FLEX_FLOW_ROW);
    if (icon) {
        lv_obj_t *img = lv_image_create(obj);
        lv_image_set_src(img, icon);
    }
    lv_obj_t *label = lv_label_create(obj);
    lv_label_set_text(label, txt);
    lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_SCROLL_CIRCULAR);
    lv_obj_set_flex_grow(label, 1);
    return obj;
}

static lv_obj_t *create_msgbox(lv_obj_t *parent)
{
    return lv_msgbox_create(parent);
}

static const json_value_t *get(const json_value_t *node, const char *key)
{
    return json_get(node, key);
}

static bool is_object(const json_value_t *v)
{
    return v && v->type == JSON_OBJECT;
}

/** Optional int member */
static bool opt_int(ui_ctx_t *c, const json_value_t *node, const char *path, const char *key, int32_t min,
                    int32_t max, int32_t *out)
{
    const json_value_t *v = get(node, key);
    char p[UI_PATH_MAX];
    if (!v) return false;
    path_key(p, path, key);
    return v_int(c, v, p, min, max, out);
}

static bool opt_bool(ui_ctx_t *c, const json_value_t *node, const char *path, const char *key, bool *out)
{
    const json_value_t *v = get(node, key);
    char p[UI_PATH_MAX];
    if (!v) return false;
    path_key(p, path, key);
    return v_bool(c, v, p, out);
}

static bool opt_str(ui_ctx_t *c, const json_value_t *node, const char *path, const char *key, const char **out)
{
    const json_value_t *v = get(node, key);
    char p[UI_PATH_MAX];
    if (!v) return false;
    path_key(p, path, key);
    return v_str(c, v, p, out);
}

/** Array of strings joined with '\n' (malloc'ed), or NULL */
static char *opt_options(ui_ctx_t *c, const json_value_t *node, const char *path, const char *key)
{
    const json_value_t *v = get(node, key);
    char p[UI_PATH_MAX], q[UI_PATH_MAX];
    if (!v) return NULL;
    path_key(p, path, key);
    if (v->type != JSON_ARRAY || v->count == 0) {
        err_at(c, p, "expected a non-empty array of strings");
        return NULL;
    }
    size_t len = 1;
    for (size_t i = 0; i < v->count; i++) {
        if (v->items[i]->type != JSON_STRING) {
            path_idx(q, p, i);
            err_at(c, q, "expected string");
            return NULL;
        }
        len += strlen(v->items[i]->string) + 1;
    }
    char *s = (char *)malloc(len);
    if (!s) return NULL;
    s[0] = '\0';
    for (size_t i = 0; i < v->count; i++) {
        if (i) strcat(s, "\n");
        strcat(s, v->items[i]->string);
    }
    return s;
}

static void apply_range_value(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t min = 0, max = 100, value = 0;
    bool has_min = opt_int(c, node, path, "min", INT32_MIN / 2, INT32_MAX / 2, &min);
    bool has_max = opt_int(c, node, path, "max", INT32_MIN / 2, INT32_MAX / 2, &max);
    bool has_val = opt_int(c, node, path, "value", INT32_MIN / 2, INT32_MAX / 2, &value);
    bool anim = false;
    opt_bool(c, node, path, "anim", &anim);

    if (has_min || has_max) {
        if (lv_obj_has_class(obj, &lv_arc_class)) {
            if (!has_min) min = lv_arc_get_min_value(obj);
            if (!has_max) max = lv_arc_get_max_value(obj);
        } else {
            if (!has_min) min = lv_bar_get_min_value(obj);
            if (!has_max) max = lv_bar_get_max_value(obj);
        }
        if (min > max) {
            char p[UI_PATH_MAX];
            path_key(p, path, "min");
            err_at(c, p, "min (%d) is greater than max (%d)", (int)min, (int)max);
            return;
        }
        if (lv_obj_has_class(obj, &lv_arc_class)) lv_arc_set_range(obj, min, max);
        else lv_bar_set_range(obj, min, max);
    }
    if (has_val) {
        if (lv_obj_has_class(obj, &lv_arc_class)) lv_arc_set_value(obj, value);
        else lv_bar_set_value(obj, value, anim ? LV_ANIM_ON : LV_ANIM_OFF);
    }
}

static void apply_label(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const char *s;
    int32_t e;
    char p[UI_PATH_MAX];
    if (opt_str(c, node, path, "text", &s)) lv_label_set_text(obj, s);
    if (get(node, "long_mode")) {
        path_key(p, path, "long_mode");
        if (v_enum(c, get(node, "long_mode"), p, long_mode_enum, ENUM_N(long_mode_enum), &e)) {
            lv_label_set_long_mode(obj, (lv_label_long_mode_t)e);
        }
    }
}

static void apply_button(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const char *s;
    if (opt_str(c, node, path, "text", &s)) {
        lv_obj_t *label = lv_label_create(obj);
        lv_label_set_text(label, s);
        lv_obj_center(label);
    }
}

static void apply_image(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const char *s;
    char p[UI_PATH_MAX];
    if (!opt_str(c, node, path, "src", &s)) return;
    path_key(p, path, "src");
    if (strncmp(s, "symbol:", 7) == 0) {
        const char *sym = v_symbol(c, s, p);
        if (sym) lv_image_set_src(obj, sym);
    } else if (strncmp(s, "S:", 2) == 0 && s[2]) {
        lv_image_set_src(obj, dup_str(s));
    } else {
        err_at(c, p, "expected \"S:<file in the assets dir>\" or \"symbol:<NAME>\"");
    }
}

static void apply_arc(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t v;
    int32_t bs = 0, be = 0;
    apply_range_value(c, obj, node, path);
    if (opt_int(c, node, path, "rotation", -360, 360, &v)) lv_arc_set_rotation(obj, v);
    bool has_bs = opt_int(c, node, path, "bg_start_angle", 0, 360, &bs);
    bool has_be = opt_int(c, node, path, "bg_end_angle", 0, 360, &be);
    if (has_bs) lv_arc_set_bg_start_angle(obj, bs);
    if (has_be) lv_arc_set_bg_end_angle(obj, be);
}

static void apply_checked(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    bool b;
    const char *s;
    if (lv_obj_has_class(obj, &lv_checkbox_class) && opt_str(c, node, path, "text", &s)) lv_checkbox_set_text(obj, s);
    if (opt_bool(c, node, path, "checked", &b)) lv_obj_set_state(obj, LV_STATE_CHECKED, b);
}

static void apply_dropdown(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t sel;
    char *opts = opt_options(c, node, path, "options");
    if (opts) {
        lv_dropdown_set_options(obj, opts);
        free(opts);
    }
    /* An object "selected" is the LV_PART_SELECTED style block (apply_node_common), a number the index */
    if (!is_object(get(node, "selected")) && opt_int(c, node, path, "selected", 0, 10000, &sel)) {
        lv_dropdown_set_selected(obj, (uint32_t)sel);
    }
}

static void apply_roller(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t v;
    bool inf = false;
    opt_bool(c, node, path, "infinite", &inf);
    char *opts = opt_options(c, node, path, "options");
    if (opts) {
        lv_roller_set_options(obj, opts, inf ? LV_ROLLER_MODE_INFINITE : LV_ROLLER_MODE_NORMAL);
        free(opts);
    }
    if (!is_object(get(node, "selected")) && opt_int(c, node, path, "selected", 0, 10000, &v)) {
        lv_roller_set_selected(obj, (uint32_t)v, LV_ANIM_OFF);
    }
    if (opt_int(c, node, path, "visible_rows", 1, 100, &v)) lv_roller_set_visible_row_count(obj, (uint32_t)v);
}

static void apply_textarea(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const char *s;
    bool b;
    int32_t v;
    if (opt_bool(c, node, path, "one_line", &b)) lv_textarea_set_one_line(obj, b);
    if (opt_bool(c, node, path, "password", &b)) lv_textarea_set_password_mode(obj, b);
    if (opt_int(c, node, path, "max_length", 0, 100000, &v)) lv_textarea_set_max_length(obj, (uint32_t)v);
    if (opt_str(c, node, path, "placeholder", &s)) lv_textarea_set_placeholder_text(obj, s);
    if (opt_str(c, node, path, "text", &s)) lv_textarea_set_text(obj, s);
}

static void apply_spinner(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t d = 1000, a = 200;
    bool hd = opt_int(c, node, path, "duration", 1, 60000, &d);
    bool ha = opt_int(c, node, path, "arc_length", 1, 359, &a);
    if (hd || ha) lv_spinner_set_anim_params(obj, (uint32_t)d, (uint32_t)a);
}

static void apply_led(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t v;
    bool b;
    lv_color_t col;
    char p[UI_PATH_MAX];
    if (get(node, "color")) {
        path_key(p, path, "color");
        if (v_color(c, get(node, "color"), p, &col)) lv_led_set_color(obj, col);
    }
    if (opt_int(c, node, path, "brightness", 0, 255, &v)) lv_led_set_brightness(obj, (uint8_t)v);
    if (opt_bool(c, node, path, "on", &b)) {
        if (b) lv_led_on(obj);
        else lv_led_off(obj);
    }
}

static void apply_line(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const json_value_t *v = get(node, "points");
    char p[UI_PATH_MAX], q[UI_PATH_MAX];
    if (!v) return;
    path_key(p, path, "points");
    if (v->type != JSON_ARRAY || v->count < 2) {
        err_at(c, p, "expected at least 2 points: [[x, y], [x, y], ...]");
        return;
    }
    lv_point_precise_t *pts = (lv_point_precise_t *)calloc(v->count, sizeof(*pts));
    if (!pts) return;
    for (size_t i = 0; i < v->count; i++) {
        const json_value_t *pt = v->items[i];
        path_idx(q, p, i);
        int32_t x, y;
        if (pt->type == JSON_ARRAY && pt->count == 2 && json_is_int(pt->items[0]) && json_is_int(pt->items[1])) {
            x = (int32_t)pt->items[0]->number;
            y = (int32_t)pt->items[1]->number;
        } else if (pt->type == JSON_OBJECT && pt->count == 2 && json_is_int(json_get(pt, "x")) &&
                   json_is_int(json_get(pt, "y"))) {
            x = (int32_t)json_get(pt, "x")->number;
            y = (int32_t)json_get(pt, "y")->number;
        } else {
            err_at(c, q, "expected [x, y] or {\"x\": N, \"y\": N} with integers");
            free(pts);
            return;
        }
        pts[i].x = x;
        pts[i].y = y;
    }
    lv_line_set_points(obj, pts, (uint32_t)v->count);
}

static void apply_chart(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t e;
    char p[UI_PATH_MAX], q[UI_PATH_MAX], r[UI_PATH_MAX];
    if (get(node, "chart_type")) {
        path_key(p, path, "chart_type");
        if (v_enum(c, get(node, "chart_type"), p, chart_type_enum, ENUM_N(chart_type_enum), &e)) {
            lv_chart_set_type(obj, (lv_chart_type_t)e);
        }
    }
    const json_value_t *range = get(node, "range");
    if (range) {
        path_key(p, path, "range");
        if (range->type == JSON_ARRAY && range->count == 2 && json_is_int(range->items[0]) &&
            json_is_int(range->items[1]) && range->items[0]->number < range->items[1]->number) {
            lv_chart_set_axis_range(obj, LV_CHART_AXIS_PRIMARY_Y, (int32_t)range->items[0]->number,
                                    (int32_t)range->items[1]->number);
        } else {
            err_at(c, p, "expected [min, max] with integers, min < max");
        }
    }
    const json_value_t *div = get(node, "div_lines");
    if (div) {
        path_key(p, path, "div_lines");
        if (div->type == JSON_ARRAY && div->count == 2 && json_is_int(div->items[0]) && json_is_int(div->items[1]) &&
            div->items[0]->number >= 0 && div->items[1]->number >= 0) {
            lv_chart_set_div_line_count(obj, (uint32_t)div->items[0]->number, (uint32_t)div->items[1]->number);
        } else {
            err_at(c, p, "expected [horizontal, vertical] line counts");
        }
    }
    const json_value_t *series = get(node, "series");
    if (!series) return;
    path_key(p, path, "series");
    if (series->type != JSON_ARRAY) {
        err_at(c, p, "expected an array of {\"color\": \"#rrggbb\", \"points\": [..]}");
        return;
    }
    size_t max_points = 0;
    for (size_t i = 0; i < series->count; i++) {
        const json_value_t *pts = json_get(series->items[i], "points");
        if (pts && pts->type == JSON_ARRAY && pts->count > max_points) max_points = pts->count;
    }
    if (max_points > 0 && max_points <= 10000) lv_chart_set_point_count(obj, (uint32_t)max_points);
    for (size_t i = 0; i < series->count; i++) {
        const json_value_t *s = series->items[i];
        path_idx(q, p, i);
        if (s->type != JSON_OBJECT) {
            err_at(c, q, "expected {\"color\": \"#rrggbb\", \"points\": [..]}");
            continue;
        }
        for (size_t k = 0; k < s->count; k++) {
            if (strcmp(s->keys[k], "color") && strcmp(s->keys[k], "points")) {
                path_key(r, q, s->keys[k]);
                err_at(c, r, "unknown key (known: color, points)");
            }
        }
        lv_color_t col = lv_palette_main(LV_PALETTE_BLUE);
        if (json_get(s, "color")) {
            path_key(r, q, "color");
            v_color(c, json_get(s, "color"), r, &col);
        }
        lv_chart_series_t *ser = lv_chart_add_series(obj, col, LV_CHART_AXIS_PRIMARY_Y);
        const json_value_t *pts = json_get(s, "points");
        path_key(r, q, "points");
        if (!pts || pts->type != JSON_ARRAY) {
            err_at(c, r, "expected an array of integers");
            continue;
        }
        for (size_t k = 0; k < pts->count; k++) {
            if (!json_is_int(pts->items[k])) {
                char t[UI_PATH_MAX];
                path_idx(t, r, k);
                err_at(c, t, "expected integer");
                continue;
            }
            lv_chart_set_series_value_by_id(obj, ser, (uint32_t)k, (int32_t)pts->items[k]->number);
        }
    }
    lv_chart_refresh(obj);
}

static void apply_table(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    char p[UI_PATH_MAX], q[UI_PATH_MAX], r[UI_PATH_MAX];
    const json_value_t *rows = get(node, "rows");
    if (rows) {
        path_key(p, path, "rows");
        if (rows->type != JSON_ARRAY) {
            err_at(c, p, "expected [[\"cell\", ...], ...]");
        } else {
            size_t cols = 0;
            for (size_t i = 0; i < rows->count; i++) {
                if (rows->items[i]->type == JSON_ARRAY && rows->items[i]->count > cols) cols = rows->items[i]->count;
            }
            lv_table_set_row_count(obj, (uint32_t)rows->count);
            if (cols) lv_table_set_column_count(obj, (uint32_t)cols);
            for (size_t i = 0; i < rows->count; i++) {
                const json_value_t *row = rows->items[i];
                path_idx(q, p, i);
                if (row->type != JSON_ARRAY) {
                    err_at(c, q, "expected an array of strings");
                    continue;
                }
                for (size_t k = 0; k < row->count; k++) {
                    if (row->items[k]->type != JSON_STRING) {
                        path_idx(r, q, k);
                        err_at(c, r, "expected string");
                        continue;
                    }
                    lv_table_set_cell_value(obj, (uint32_t)i, (uint32_t)k, row->items[k]->string);
                }
            }
        }
    }
    const json_value_t *cw = get(node, "col_widths");
    if (cw) {
        path_key(p, path, "col_widths");
        if (cw->type != JSON_ARRAY) {
            err_at(c, p, "expected an array of integers");
            return;
        }
        for (size_t i = 0; i < cw->count; i++) {
            int32_t w;
            path_idx(q, p, i);
            if (v_int(c, cw->items[i], q, 1, PX_MAX, &w)) lv_table_set_column_width(obj, (uint32_t)i, w);
        }
    }
}

static void apply_buttonmatrix(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    char p[UI_PATH_MAX], q[UI_PATH_MAX];
    const json_value_t *map = get(node, "map");
    if (!map) return;
    path_key(p, path, "map");
    if (map->type != JSON_ARRAY || map->count == 0) {
        err_at(c, p, "expected an array of button texts, \"\\n\" starts a new row");
        return;
    }
    const char **m = (const char **)calloc(map->count + 1, sizeof(*m));
    if (!m) return;
    for (size_t i = 0; i < map->count; i++) {
        path_idx(q, p, i);
        if (map->items[i]->type != JSON_STRING || !map->items[i]->string[0]) {
            err_at(c, q, "expected a non-empty string");
            free(m);
            return;
        }
        m[i] = dup_str(map->items[i]->string);
    }
    m[map->count] = "";
    lv_buttonmatrix_set_map(obj, m);
}

static void apply_spinbox(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t min = -99999, max = 99999, v, digits = 5, sep = 0;
    bool hmin = opt_int(c, node, path, "min", INT32_MIN / 2, INT32_MAX / 2, &min);
    bool hmax = opt_int(c, node, path, "max", INT32_MIN / 2, INT32_MAX / 2, &max);
    if (hmin || hmax) lv_spinbox_set_range(obj, min, max);
    bool hd = opt_int(c, node, path, "digits", 1, 10, &digits);
    bool hs = opt_int(c, node, path, "decimals", 0, 9, &sep);
    if (hd || hs) lv_spinbox_set_digit_format(obj, (uint32_t)digits, (uint32_t)(sep ? digits - sep : 0));
    if (opt_int(c, node, path, "step", 1, 1000000, &v)) lv_spinbox_set_step(obj, (uint32_t)v);
    if (opt_int(c, node, path, "value", INT32_MIN / 2, INT32_MAX / 2, &v)) lv_spinbox_set_value(obj, v);
}

static void apply_scale(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t e, v, min = 0, max = 100;
    bool b;
    char p[UI_PATH_MAX];
    if (get(node, "mode")) {
        path_key(p, path, "mode");
        if (v_enum(c, get(node, "mode"), p, scale_mode_enum, ENUM_N(scale_mode_enum), &e)) {
            lv_scale_set_mode(obj, (lv_scale_mode_t)e);
        }
    }
    bool hmin = opt_int(c, node, path, "min", INT32_MIN / 2, INT32_MAX / 2, &min);
    bool hmax = opt_int(c, node, path, "max", INT32_MIN / 2, INT32_MAX / 2, &max);
    if (hmin || hmax) lv_scale_set_range(obj, min, max);
    if (opt_int(c, node, path, "total_ticks", 0, 1000, &v)) lv_scale_set_total_tick_count(obj, (uint32_t)v);
    if (opt_int(c, node, path, "major_every", 0, 1000, &v)) lv_scale_set_major_tick_every(obj, (uint32_t)v);
    if (opt_bool(c, node, path, "labels", &b)) lv_scale_set_label_show(obj, b);
    if (opt_int(c, node, path, "angle_range", 0, 360, &v)) lv_scale_set_angle_range(obj, (uint32_t)v);
    if (opt_int(c, node, path, "rotation", -360, 360, &v)) lv_scale_set_rotation(obj, v);
}

static void set_name_checked(ui_ctx_t *c, lv_obj_t *obj, const char *name, const char *path);

static void apply_msgbox(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    const char *s;
    bool b;
    char p[UI_PATH_MAX], q[UI_PATH_MAX], r[UI_PATH_MAX];
    if (opt_str(c, node, path, "title", &s)) lv_msgbox_add_title(obj, s);
    if (opt_bool(c, node, path, "close_button", &b) && b) lv_msgbox_add_close_button(obj);
    if (opt_str(c, node, path, "text", &s)) lv_msgbox_add_text(obj, s);
    const json_value_t *btns = get(node, "buttons");
    if (!btns) return;
    path_key(p, path, "buttons");
    if (btns->type != JSON_ARRAY) {
        err_at(c, p, "expected an array of texts or {\"text\": \"OK\", \"name\": \"ok_btn\"}");
        return;
    }
    for (size_t i = 0; i < btns->count; i++) {
        const json_value_t *bv = btns->items[i];
        path_idx(q, p, i);
        if (bv->type == JSON_STRING) {
            lv_msgbox_add_footer_button(obj, bv->string);
        } else if (bv->type == JSON_OBJECT && json_get(bv, "text") && json_get(bv, "text")->type == JSON_STRING) {
            lv_obj_t *btn = lv_msgbox_add_footer_button(obj, json_get(bv, "text")->string);
            for (size_t k = 0; k < bv->count; k++) {
                if (strcmp(bv->keys[k], "text") && strcmp(bv->keys[k], "name")) {
                    path_key(r, q, bv->keys[k]);
                    err_at(c, r, "unknown key (known: text, name)");
                }
            }
            const json_value_t *nm = json_get(bv, "name");
            path_key(r, q, "name");
            if (nm && nm->type == JSON_STRING) set_name_checked(c, btn, nm->string, r);
            else if (nm) err_at(c, r, "expected string");
        } else {
            err_at(c, q, "expected a text or {\"text\": \"OK\", \"name\": \"ok_btn\"}");
        }
    }
}

static void apply_list(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    char p[UI_PATH_MAX], q[UI_PATH_MAX], r[UI_PATH_MAX];
    const json_value_t *items = get(node, "items");
    /* An object "items" is the LV_PART_ITEMS style block (apply_node_common) */
    if (!items || is_object(items)) return;
    path_key(p, path, "items");
    if (items->type != JSON_ARRAY) {
        err_at(c, p, "expected an array of texts or {\"text\": \"..\", \"icon\": \"symbol:NAME\", \"name\": \"..\", "
                     "\"header\": false}");
        return;
    }
    for (size_t i = 0; i < items->count; i++) {
        const json_value_t *it = items->items[i];
        path_idx(q, p, i);
        if (it->type == JSON_STRING) {
            list_add_button(obj, NULL, it->string);
            continue;
        }
        if (it->type != JSON_OBJECT) {
            err_at(c, q, "expected a text or an item object");
            continue;
        }
        const char *text = "";
        const char *icon = NULL;
        bool header = false;
        for (size_t k = 0; k < it->count; k++) {
            const char *key = it->keys[k];
            path_key(r, q, key);
            if (strcmp(key, "text") == 0) {
                v_str(c, it->items[k], r, &text);
            } else if (strcmp(key, "icon") == 0) {
                const char *s;
                if (v_str(c, it->items[k], r, &s)) {
                    if (strncmp(s, "symbol:", 7) == 0) icon = v_symbol(c, s, r);
                    else err_at(c, r, "expected \"symbol:<NAME>\"");
                }
            } else if (strcmp(key, "header") == 0) {
                v_bool(c, it->items[k], r, &header);
            } else if (strcmp(key, "name") != 0) {
                err_at(c, r, "unknown key (known: text, icon, name, header)");
            }
        }
        lv_obj_t *o = header ? list_add_text(obj, text) : list_add_button(obj, icon, text);
        const json_value_t *nm = json_get(it, "name");
        if (nm) {
            path_key(r, q, "name");
            if (nm->type == JSON_STRING) set_name_checked(c, o, nm->string, r);
            else err_at(c, r, "expected string");
        }
    }
}

static void build_children(ui_ctx_t *c, const json_value_t *arr, lv_obj_t *parent, const char *path);
static void apply_node_common(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path,
                              const widget_def_t *wd);

static const char *const tab_keys[] = {"title", "name", "children", "layout", "styles", NULL};

static void apply_tabview(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path)
{
    int32_t e, v;
    char p[UI_PATH_MAX], q[UI_PATH_MAX], r[UI_PATH_MAX];
    if (get(node, "tab_bar")) {
        path_key(p, path, "tab_bar");
        if (v_enum(c, get(node, "tab_bar"), p, dir_enum, ENUM_N(dir_enum), &e)) {
            lv_tabview_set_tab_bar_position(obj, (lv_dir_t)e);
        }
    }
    if (opt_int(c, node, path, "tab_bar_size", 0, 1000, &v)) lv_tabview_set_tab_bar_size(obj, v);
    const json_value_t *tabs = get(node, "tabs");
    if (tabs) {
        path_key(p, path, "tabs");
        if (tabs->type != JSON_ARRAY) {
            err_at(c, p, "expected [{\"title\": \"..\", \"children\": [..]}, ...]");
        } else {
            for (size_t i = 0; i < tabs->count; i++) {
                const json_value_t *t = tabs->items[i];
                path_idx(q, p, i);
                if (t->type != JSON_OBJECT) {
                    err_at(c, q, "expected {\"title\": \"..\", \"children\": [..]}");
                    continue;
                }
                for (size_t k = 0; k < t->count; k++) {
                    bool ok = false;
                    for (size_t m = 0; tab_keys[m]; m++) ok = ok || strcmp(t->keys[k], tab_keys[m]) == 0;
                    if (!ok) {
                        path_key(r, q, t->keys[k]);
                        err_at(c, r, "unknown key (known: title, name, children, layout, styles)");
                    }
                }
                const char *title = "Tab";
                path_key(r, q, "title");
                if (json_get(t, "title")) v_str(c, json_get(t, "title"), r, &title);
                lv_obj_t *page = lv_tabview_add_tab(obj, title);
                const json_value_t *nm = json_get(t, "name");
                if (nm) {
                    path_key(r, q, "name");
                    if (nm->type == JSON_STRING) set_name_checked(c, page, nm->string, r);
                    else err_at(c, r, "expected string");
                }
                if (json_get(t, "styles")) {
                    path_key(r, q, "styles");
                    apply_styles(c, page, json_get(t, "styles"), r, (lv_style_selector_t)LV_PART_MAIN);
                }
                if (json_get(t, "layout")) {
                    /* Reuse the node layout handling on the page */
                    json_value_t tmp;
                    memset(&tmp, 0, sizeof(tmp));
                    tmp.type = JSON_OBJECT;
                    char *key = (char *)"layout";
                    json_value_t *val = json_get(t, "layout");
                    tmp.count = 1;
                    tmp.keys = &key;
                    tmp.items = &val;
                    apply_node_common(c, page, &tmp, q, NULL);
                }
                if (json_get(t, "children")) {
                    path_key(r, q, "children");
                    build_children(c, json_get(t, "children"), page, r);
                }
            }
        }
    }
    if (opt_int(c, node, path, "active_tab", 0, 1000, &v)) {
        if ((uint32_t)v < lv_tabview_get_tab_count(obj)) lv_tabview_set_active(obj, (uint32_t)v, LV_ANIM_OFF);
        else {
            path_key(p, path, "active_tab");
            err_at(c, p, "tab index %d does not exist", (int)v);
        }
    }
}

static const char *const k_none[] = {NULL};
static const char *const k_label[] = {"text", "long_mode", NULL};
static const char *const k_button[] = {"text", NULL};
static const char *const k_image[] = {"src", NULL};
static const char *const k_range[] = {"value", "min", "max", "anim", NULL};
static const char *const k_arc[] = {"value", "min", "max", "rotation", "bg_start_angle", "bg_end_angle", NULL};
static const char *const k_switch[] = {"checked", NULL};
static const char *const k_checkbox[] = {"text", "checked", NULL};
static const char *const k_dropdown[] = {"options", "selected", NULL};
static const char *const k_roller[] = {"options", "selected", "visible_rows", "infinite", NULL};
static const char *const k_textarea[] = {"text", "placeholder", "one_line", "password", "max_length", NULL};
static const char *const k_spinner[] = {"duration", "arc_length", NULL};
static const char *const k_led[] = {"color", "brightness", "on", NULL};
static const char *const k_line[] = {"points", NULL};
static const char *const k_chart[] = {"chart_type", "series", "range", "div_lines", NULL};
static const char *const k_table[] = {"rows", "col_widths", NULL};
static const char *const k_btnm[] = {"map", NULL};
static const char *const k_tabview[] = {"tabs", "tab_bar", "tab_bar_size", "active_tab", NULL};
static const char *const k_msgbox[] = {"title", "text", "buttons", "close_button", NULL};
static const char *const k_spinbox[] = {"value", "min", "max", "digits", "decimals", "step", NULL};
static const char *const k_scale[] = {"mode", "min", "max", "total_ticks", "major_every", "labels", "angle_range",
                                      "rotation", NULL};
static const char *const k_list[] = {"items", NULL};

static const widget_def_t widgets[] = {
    {"lv_obj", lv_obj_create, k_none, NULL, false},
    {"lv_label", lv_label_create, k_label, apply_label, false},
    {"lv_button", lv_button_create, k_button, apply_button, false},
    {"lv_image", lv_image_create, k_image, apply_image, false},
    {"lv_slider", lv_slider_create, k_range, apply_range_value, false},
    {"lv_bar", lv_bar_create, k_range, apply_range_value, false},
    {"lv_arc", lv_arc_create, k_arc, apply_arc, false},
    {"lv_switch", lv_switch_create, k_switch, apply_checked, false},
    {"lv_checkbox", lv_checkbox_create, k_checkbox, apply_checked, false},
    {"lv_dropdown", lv_dropdown_create, k_dropdown, apply_dropdown, false},
    {"lv_roller", lv_roller_create, k_roller, apply_roller, false},
    {"lv_textarea", lv_textarea_create, k_textarea, apply_textarea, false},
    {"lv_spinner", lv_spinner_create, k_spinner, apply_spinner, false},
    {"lv_led", lv_led_create, k_led, apply_led, false},
    {"lv_line", lv_line_create, k_line, apply_line, false},
    {"lv_chart", lv_chart_create, k_chart, apply_chart, false},
    {"lv_table", lv_table_create, k_table, apply_table, false},
    {"lv_buttonmatrix", lv_buttonmatrix_create, k_btnm, apply_buttonmatrix, false},
    {"lv_tabview", lv_tabview_create, k_tabview, apply_tabview, true},
    {"lv_msgbox", create_msgbox, k_msgbox, apply_msgbox, false},
    {"lv_spinbox", lv_spinbox_create, k_spinbox, apply_spinbox, false},
    {"lv_scale", lv_scale_create, k_scale, apply_scale, false},
    {"lv_list", create_list, k_list, apply_list, false},
};
#define WIDGET_COUNT (sizeof(widgets) / sizeof(widgets[0]))

/** Keys every node accepts (besides the widget-specific ones) */
static const char *const common_keys[] = {
    "type", "name", "x", "y", "w", "h", "align", "hidden", "states", "flags", "layout", "grow", "flex_grow",
    "cell", "grid_cell", "styles", "styles_pressed", "styles_checked", "styles_disabled", "styles_focused",
    "indicator", "knob", "selected", "items", "cursor", "scrollbar", "children",
};

static const struct {
    const char *name;
    lv_part_t part;
} part_blocks[] = {
    {"styles", LV_PART_MAIN},        {"indicator", LV_PART_INDICATOR}, {"knob", LV_PART_KNOB},
    {"selected", LV_PART_SELECTED},  {"items", LV_PART_ITEMS},         {"cursor", LV_PART_CURSOR},
    {"scrollbar", LV_PART_SCROLLBAR},
};

static const struct {
    const char *suffix;
    lv_state_t state;
} state_suffixes[] = {
    {"pressed", LV_STATE_PRESSED},
    {"checked", LV_STATE_CHECKED},
    {"disabled", LV_STATE_DISABLED},
    {"focused", LV_STATE_FOCUSED},
};

/** "indicator_checked" -> part/state; "styles" -> MAIN/DEFAULT */
static bool style_block_selector(const char *key, lv_style_selector_t *sel)
{
    for (size_t i = 0; i < sizeof(part_blocks) / sizeof(part_blocks[0]); i++) {
        size_t n = strlen(part_blocks[i].name);
        if (strncmp(key, part_blocks[i].name, n) != 0) continue;
        if (key[n] == '\0') {
            *sel = (lv_style_selector_t)part_blocks[i].part;
            return true;
        }
        if (key[n] != '_') continue;
        for (size_t s = 0; s < sizeof(state_suffixes) / sizeof(state_suffixes[0]); s++) {
            if (strcmp(key + n + 1, state_suffixes[s].suffix) == 0) {
                *sel = (lv_style_selector_t)part_blocks[i].part | state_suffixes[s].state;
                return true;
            }
        }
    }
    return false;
}

static bool is_known_key(const widget_def_t *w, const char *key)
{
    lv_style_selector_t sel;
    for (size_t i = 0; i < sizeof(common_keys) / sizeof(common_keys[0]); i++) {
        if (strcmp(common_keys[i], key) == 0) return true;
    }
    if (style_block_selector(key, &sel)) return true;
    for (size_t i = 0; w && w->keys[i]; i++) {
        if (strcmp(w->keys[i], key) == 0) return true;
    }
    return false;
}

static void report_unknown_key(ui_ctx_t *c, const widget_def_t *w, const char *key, const char *path)
{
    const char *cands[128];
    size_t n = 0;
    char hint[96];
    char list[512];
    for (size_t i = 0; i < sizeof(common_keys) / sizeof(common_keys[0]); i++) cands[n++] = common_keys[i];
    size_t first_w = n;
    for (size_t i = 0; w && w->keys[i] && n < 128; i++) cands[n++] = w->keys[i];
    join_list(list, sizeof(list), cands + first_w, n - first_w);
    err_at(c, path, "unknown key%s (%s%s%s; common: type, name, x, y, w, h, align, hidden, states, flags, layout, "
                    "grow, cell, styles, styles_<state>, <part>, <part>_<state>, children)",
           suggest(key, cands, n, hint, sizeof(hint)), w ? w->type : "node", n > first_w ? " keys: " : " has no own keys",
           list);
}

/**********************
 *  Names
 **********************/

static void set_name_checked(ui_ctx_t *c, lv_obj_t *obj, const char *name, const char *path)
{
    if (!name[0]) {
        err_at(c, path, "name must not be empty");
        return;
    }
    for (size_t i = 0; i < c->named_count; i++) {
        if (strcmp(c->named[i].name, name) == 0) {
            err_at(c, path, "duplicate name \"%s\" (also used at %s)", name, c->named[i].path);
            return;
        }
    }
    if (c->named_count == c->named_cap) {
        size_t ncap = c->named_cap ? c->named_cap * 2 : 32;
        ui_named_t *n = (ui_named_t *)realloc(c->named, ncap * sizeof(*n));
        if (!n) return;
        c->named = n;
        c->named_cap = ncap;
    }
    c->named[c->named_count].obj = obj;
    c->named[c->named_count].name = dup_str(name);
    c->named[c->named_count].path = dup_str(path);
    c->named_count++;
    lv_obj_set_name(obj, name);
}

static lv_obj_t *find_named(ui_ctx_t *c, const char *name)
{
    for (size_t i = 0; i < c->named_count; i++) {
        if (strcmp(c->named[i].name, name) == 0) return c->named[i].obj;
    }
    return NULL;
}

/**********************
 *  Layout, flags, states, geometry
 **********************/

/** [100, "fr1", "content"] -> persistent template array */
static int32_t *grid_template(ui_ctx_t *c, const json_value_t *v, const char *path)
{
    char p[UI_PATH_MAX];
    if (!v || v->type != JSON_ARRAY || v->count == 0 || v->count > 64) {
        err_at(c, path, "expected an array of track sizes: integers px, \"frN\" or \"content\"");
        return NULL;
    }
    int32_t *t = (int32_t *)calloc(v->count + 1, sizeof(*t));
    if (!t) return NULL;
    for (size_t i = 0; i < v->count; i++) {
        const json_value_t *x = v->items[i];
        path_idx(p, path, i);
        if (json_is_int(x) && x->number >= 0 && x->number <= PX_MAX) {
            t[i] = (int32_t)x->number;
        } else if (x->type == JSON_STRING && strcmp(x->string, "content") == 0) {
            t[i] = LV_GRID_CONTENT;
        } else if (x->type == JSON_STRING && strncmp(x->string, "fr", 2) == 0 && x->string[2]) {
            char *end = NULL;
            long n = strtol(x->string + 2, &end, 10);
            if (*end || n < 1 || n > 99) {
                err_at(c, p, "invalid track \"%s\" (use fr1..fr99)", x->string);
                free(t);
                return NULL;
            }
            t[i] = LV_GRID_FR(n);
        } else {
            err_at(c, p, "expected integer px, \"frN\" or \"content\"");
            free(t);
            return NULL;
        }
    }
    t[v->count] = LV_GRID_TEMPLATE_LAST;
    return t;
}

static void apply_grow(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const char *path)
{
    int32_t g;
    if (v_int(c, v, path, 0, 255, &g)) lv_obj_set_flex_grow(obj, (uint8_t)g);
}

static void apply_cell(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const char *path)
{
    char p[UI_PATH_MAX];
    int32_t col = 0, row = 0, col_span = 1, row_span = 1, xa = LV_GRID_ALIGN_STRETCH, ya = LV_GRID_ALIGN_STRETCH;
    if (!v || v->type != JSON_OBJECT) {
        err_at(c, path, "expected {\"col\": 0, \"row\": 0, \"col_span\": 1, \"row_span\": 1, \"x_align\": \"stretch\", "
                        "\"y_align\": \"stretch\"}");
        return;
    }
    for (size_t i = 0; i < v->count; i++) {
        const char *k = v->keys[i];
        path_key(p, path, k);
        if (strcmp(k, "col") == 0) v_int(c, v->items[i], p, 0, 255, &col);
        else if (strcmp(k, "row") == 0) v_int(c, v->items[i], p, 0, 255, &row);
        else if (strcmp(k, "col_span") == 0) v_int(c, v->items[i], p, 1, 255, &col_span);
        else if (strcmp(k, "row_span") == 0) v_int(c, v->items[i], p, 1, 255, &row_span);
        else if (strcmp(k, "x_align") == 0) v_enum(c, v->items[i], p, grid_align_enum, ENUM_N(grid_align_enum), &xa);
        else if (strcmp(k, "y_align") == 0) v_enum(c, v->items[i], p, grid_align_enum, ENUM_N(grid_align_enum), &ya);
        else err_at(c, p, "unknown key (known: col, row, col_span, row_span, x_align, y_align)");
    }
    lv_obj_set_grid_cell(obj, (lv_grid_align_t)xa, col, col_span, (lv_grid_align_t)ya, row, row_span);
}

static void apply_layout(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const char *path)
{
    char p[UI_PATH_MAX];
    int32_t e;
    if (!v || v->type != JSON_OBJECT) {
        err_at(c, path, "expected {\"type\": \"flex\", \"flow\": \"row\", ...} or {\"type\": \"grid\", \"cols\": [..], "
                        "\"rows\": [..]}");
        return;
    }
    const json_value_t *type = json_get(v, "type");
    const char *t = type && type->type == JSON_STRING ? type->string : NULL;

    if (!type) {
        /* Child-only parameters: {"grow": 1} or {"cell": {...}} */
        for (size_t i = 0; i < v->count; i++) {
            path_key(p, path, v->keys[i]);
            if (strcmp(v->keys[i], "grow") == 0) apply_grow(c, obj, v->items[i], p);
            else if (strcmp(v->keys[i], "cell") == 0) apply_cell(c, obj, v->items[i], p);
            else err_at(c, p, "unknown key (a layout needs \"type\": \"flex\"|\"grid\"|\"none\"; a child may give "
                              "\"grow\" or \"cell\")");
        }
        return;
    }
    path_key(p, path, "type");
    if (!t || (strcmp(t, "flex") && strcmp(t, "grid") && strcmp(t, "none"))) {
        err_at(c, p, "expected \"flex\", \"grid\" or \"none\"");
        return;
    }
    if (strcmp(t, "none") == 0) {
        for (size_t i = 0; i < v->count; i++) {
            if (strcmp(v->keys[i], "type")) {
                path_key(p, path, v->keys[i]);
                err_at(c, p, "unknown key for layout \"none\"");
            }
        }
        lv_obj_set_layout(obj, LV_LAYOUT_NONE);
        return;
    }
    if (strcmp(t, "flex") == 0) {
        lv_obj_set_layout(obj, LV_LAYOUT_FLEX);
        int32_t main_p = LV_FLEX_ALIGN_START, cross = LV_FLEX_ALIGN_START, track = LV_FLEX_ALIGN_START;
        bool place = false;
        for (size_t i = 0; i < v->count; i++) {
            const char *k = v->keys[i];
            path_key(p, path, k);
            if (strcmp(k, "type") == 0) continue;
            if (strcmp(k, "flow") == 0) {
                if (v_enum(c, v->items[i], p, flex_flow_enum, ENUM_N(flex_flow_enum), &e)) {
                    lv_obj_set_flex_flow(obj, (lv_flex_flow_t)e);
                }
            } else if (strcmp(k, "main") == 0) {
                place = v_enum(c, v->items[i], p, flex_align_enum, ENUM_N(flex_align_enum), &main_p) || place;
            } else if (strcmp(k, "cross") == 0) {
                place = v_enum(c, v->items[i], p, flex_align_enum, 3, &cross) || place;
            } else if (strcmp(k, "track") == 0) {
                place = v_enum(c, v->items[i], p, flex_align_enum, ENUM_N(flex_align_enum), &track) || place;
            } else if (strcmp(k, "grow") == 0) {
                apply_grow(c, obj, v->items[i], p);
            } else {
                err_at(c, p, "unknown key (flex: type, flow, main, cross, track)");
            }
        }
        if (place) {
            /* A single-track flex row/column is only centred when the track is: without an explicit
             * "track", place the track like the items ("cross") */
            if (!json_get(v, "track")) track = cross;
            lv_obj_set_flex_align(obj, (lv_flex_align_t)main_p, (lv_flex_align_t)cross, (lv_flex_align_t)track);
        }
        return;
    }
    /* grid */
    lv_obj_set_layout(obj, LV_LAYOUT_GRID);
    int32_t *cols = NULL, *rows = NULL;
    for (size_t i = 0; i < v->count; i++) {
        const char *k = v->keys[i];
        path_key(p, path, k);
        if (strcmp(k, "type") == 0) continue;
        if (strcmp(k, "cols") == 0) cols = grid_template(c, v->items[i], p);
        else if (strcmp(k, "rows") == 0) rows = grid_template(c, v->items[i], p);
        else if (strcmp(k, "col_align") == 0) {
            if (v_enum(c, v->items[i], p, grid_align_enum, ENUM_N(grid_align_enum), &e)) {
                lv_obj_set_style_grid_column_align(obj, (lv_grid_align_t)e, 0);
            }
        } else if (strcmp(k, "row_align") == 0) {
            if (v_enum(c, v->items[i], p, grid_align_enum, ENUM_N(grid_align_enum), &e)) {
                lv_obj_set_style_grid_row_align(obj, (lv_grid_align_t)e, 0);
            }
        } else if (strcmp(k, "cell") == 0) {
            apply_cell(c, obj, v->items[i], p);
        } else {
            err_at(c, p, "unknown key (grid: type, cols, rows, col_align, row_align)");
        }
    }
    if (!json_get(v, "cols") || !json_get(v, "rows")) {
        err_at(c, path, "a grid layout needs both \"cols\" and \"rows\"");
        return;
    }
    if (cols && rows) lv_obj_set_grid_dsc_array(obj, cols, rows);
}

typedef struct {
    const char *name;
    void (*set)(lv_obj_t *obj, bool en);
} flag_def_t;

static const flag_def_t flag_defs[] = {
    {"clickable", lv_obj_set_clickable},
    {"scrollable", lv_obj_set_scrollable},
    {"checkable", lv_obj_set_checkable},
    {"floating", lv_obj_set_floating},
    {"ignore_layout", lv_obj_set_ignore_layout},
    {"hidden", lv_obj_set_hidden},
    {"overflow_visible", lv_obj_set_overflow_visible},
    {"click_focusable", lv_obj_set_click_focusable},
    {"event_bubble", lv_obj_set_event_bubble},
    {"scroll_on_focus", lv_obj_set_scroll_on_focus},
    {"scroll_elastic", lv_obj_set_scroll_elastic},
    {"scroll_momentum", lv_obj_set_scroll_momentum},
    {"snappable", lv_obj_set_snappable},
    {"press_lock", lv_obj_set_press_lock},
    {"adv_hittest", lv_obj_set_adv_hittest},
};

static void apply_flags(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const char *path)
{
    char p[UI_PATH_MAX];
    char hint[96];
    const char *names[32];
    size_t nf = sizeof(flag_defs) / sizeof(flag_defs[0]);
    for (size_t i = 0; i < nf; i++) names[i] = flag_defs[i].name;
    if (!v || v->type != JSON_ARRAY) {
        err_at(c, path, "expected an array like [\"clickable\", \"-scrollable\"]");
        return;
    }
    for (size_t i = 0; i < v->count; i++) {
        path_idx(p, path, i);
        if (v->items[i]->type != JSON_STRING) {
            err_at(c, p, "expected string");
            continue;
        }
        const char *f = v->items[i]->string;
        bool en = true;
        if (f[0] == '-') {
            en = false;
            f++;
        }
        size_t k;
        for (k = 0; k < nf; k++) {
            if (strcmp(f, flag_defs[k].name) == 0) break;
        }
        if (k == nf) {
            char list[512];
            join_list(list, sizeof(list), names, nf);
            err_at(c, p, "unknown flag \"%s\"%s (known: %s; prefix with \"-\" to clear)", f,
                   suggest(f, names, nf, hint, sizeof(hint)), list);
            continue;
        }
        flag_defs[k].set(obj, en);
    }
}

static void apply_states(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *v, const char *path)
{
    char p[UI_PATH_MAX];
    int32_t e;
    if (!v || v->type != JSON_ARRAY) {
        err_at(c, path, "expected an array like [\"checked\", \"disabled\"]");
        return;
    }
    for (size_t i = 0; i < v->count; i++) {
        path_idx(p, path, i);
        if (v_enum(c, v->items[i], p, state_enum, ENUM_N(state_enum), &e)) lv_obj_add_state(obj, (lv_state_t)e);
    }
}

static bool widget_has_key(const widget_def_t *w, const char *key)
{
    for (size_t i = 0; w && w->keys[i]; i++) {
        if (strcmp(w->keys[i], key) == 0) return true;
    }
    return false;
}

/** Keys shared by every node: geometry, flags, layout, styles */
static void apply_node_common(ui_ctx_t *c, lv_obj_t *obj, const json_value_t *node, const char *path,
                              const widget_def_t *wd)
{
    char p[UI_PATH_MAX];
    int32_t x = 0, y = 0, w, h;
    bool has_x = false, has_y = false, has_align = false;
    int32_t align = LV_ALIGN_DEFAULT;
    bool b;
    lv_style_selector_t sel;

    for (size_t i = 0; i < node->count; i++) {
        const char *k = node->keys[i];
        const json_value_t *v = node->items[i];
        path_key(p, path, k);
        if (strcmp(k, "x") == 0) {
            has_x = v_size(c, v, p, false, &x);
        } else if (strcmp(k, "y") == 0) {
            has_y = v_size(c, v, p, false, &y);
        } else if (strcmp(k, "w") == 0) {
            if (v_size(c, v, p, true, &w)) lv_obj_set_width(obj, w);
        } else if (strcmp(k, "h") == 0) {
            if (v_size(c, v, p, true, &h)) lv_obj_set_height(obj, h);
        } else if (strcmp(k, "align") == 0) {
            has_align = v_enum(c, v, p, align_enum, ENUM_N(align_enum), &align);
        } else if (strcmp(k, "hidden") == 0) {
            if (v_bool(c, v, p, &b)) lv_obj_set_hidden(obj, b);
        } else if (strcmp(k, "flags") == 0) {
            apply_flags(c, obj, v, p);
        } else if (strcmp(k, "states") == 0) {
            apply_states(c, obj, v, p);
        } else if (strcmp(k, "layout") == 0) {
            apply_layout(c, obj, v, p);
        } else if (strcmp(k, "grow") == 0 || strcmp(k, "flex_grow") == 0) {
            apply_grow(c, obj, v, p);
        } else if (strcmp(k, "cell") == 0 || strcmp(k, "grid_cell") == 0) {
            apply_cell(c, obj, v, p);
        } else if (style_block_selector(k, &sel)) {
            /* "items" (lv_list) and "selected" (dropdown, roller) are also widget keys: a non-object
             * value belongs to the widget, an object is the LV_PART_ITEMS/SELECTED style block */
            if (v->type != JSON_OBJECT && widget_has_key(wd, k)) continue;
            apply_styles(c, obj, v, p, sel);
        }
    }
    if (has_align) lv_obj_align(obj, (lv_align_t)align, x, y);
    else {
        if (has_x) lv_obj_set_x(obj, x);
        if (has_y) lv_obj_set_y(obj, y);
    }
}

/**********************
 *  Nodes
 **********************/

static const widget_def_t *find_widget(const char *type)
{
    for (size_t i = 0; i < WIDGET_COUNT; i++) {
        if (strcmp(widgets[i].type, type) == 0) return &widgets[i];
    }
    return NULL;
}

/**
 * Build one node. With `existing` (a screen), the node's properties are
 * applied to it instead of creating a new object (type must be lv_obj).
 */
static lv_obj_t *build_node(ui_ctx_t *c, const json_value_t *node, lv_obj_t *parent, const char *path,
                            lv_obj_t *existing)
{
    char p[UI_PATH_MAX];
    char hint[96];
    const widget_def_t *w = NULL;

    if (!node || node->type != JSON_OBJECT) {
        err_at(c, path, "expected a node object {\"type\": \"lv_...\", ...}");
        return NULL;
    }
    const json_value_t *type = json_get(node, "type");
    path_key(p, path, "type");
    if (!type) {
        /* Screens are always lv_obj: "type" may be omitted there */
        if (existing) w = &widgets[0];
        else err_at(c, p, "missing (every node needs \"type\", e.g. \"lv_obj\", \"lv_label\", \"lv_button\")");
    } else if (type->type != JSON_STRING) {
        err_at(c, p, "expected string");
    } else if (!(w = find_widget(type->string))) {
        const char *names[WIDGET_COUNT];
        char list[1024];
        for (size_t i = 0; i < WIDGET_COUNT; i++) names[i] = widgets[i].type;
        join_list(list, sizeof(list), names, WIDGET_COUNT);
        err_at(c, p, "unknown widget \"%s\"%s (known: %s)", type->string,
               suggest(type->string, names, WIDGET_COUNT, hint, sizeof(hint)), list);
    } else if (existing && strcmp(w->type, "lv_obj") != 0) {
        err_at(c, p, "a screen must be \"lv_obj\", not \"%s\"", w->type);
        w = NULL;
    }

    /* Unknown keys (checked against the placeholder lv_obj when the type is bad) */
    for (size_t i = 0; i < node->count; i++) {
        const char *k = node->keys[i];
        if (!is_known_key(w ? w : &widgets[0], k)) {
            path_key(p, path, k);
            report_unknown_key(c, w, k, p);
        }
    }

    lv_obj_t *obj = existing;
    if (!obj) obj = (w ? w->create : lv_obj_create)(parent);

    const json_value_t *name = json_get(node, "name");
    if (name) {
        path_key(p, path, "name");
        if (name->type == JSON_STRING) set_name_checked(c, obj, name->string, p);
        else err_at(c, p, "expected string");
    }
    if (w && w->apply) w->apply(c, obj, node, path);
    apply_node_common(c, obj, node, path, w);

    const json_value_t *children = json_get(node, "children");
    if (children) {
        path_key(p, path, "children");
        if (w && w->no_children) {
            err_at(c, p, "%s takes no \"children\"; put them into \"tabs\": [{\"title\": \"..\", \"children\": [..]}]",
                   w->type);
        } else {
            build_children(c, children, obj, p);
        }
    }
    return obj;
}

static void build_children(ui_ctx_t *c, const json_value_t *arr, lv_obj_t *parent, const char *path)
{
    char p[UI_PATH_MAX];
    if (arr->type != JSON_ARRAY) {
        err_at(c, path, "expected an array of nodes");
        return;
    }
    for (size_t i = 0; i < arr->count; i++) {
        path_idx(p, path, i);
        build_node(c, arr->items[i], parent, p, NULL);
    }
}

/**********************
 *  Animations
 **********************/

static void anim_x(void *o, int32_t v) { lv_obj_set_x((lv_obj_t *)o, v); }
static void anim_y(void *o, int32_t v) { lv_obj_set_y((lv_obj_t *)o, v); }
static void anim_w(void *o, int32_t v) { lv_obj_set_width((lv_obj_t *)o, v); }
static void anim_h(void *o, int32_t v) { lv_obj_set_height((lv_obj_t *)o, v); }
static void anim_opa(void *o, int32_t v) { lv_obj_set_style_opa((lv_obj_t *)o, (lv_opa_t)LV_CLAMP(0, v, 255), 0); }
static void anim_rotation(void *o, int32_t v) { lv_obj_set_style_transform_rotation((lv_obj_t *)o, v, 0); }

static void anim_value(void *o, int32_t v)
{
    lv_obj_t *obj = (lv_obj_t *)o;
    if (lv_obj_has_class(obj, &lv_arc_class)) lv_arc_set_value(obj, v);
    else if (lv_obj_has_class(obj, &lv_bar_class) || lv_obj_has_class(obj, &lv_slider_class)) {
        lv_bar_set_value(obj, v, LV_ANIM_OFF);
    } else if (lv_obj_has_class(obj, &lv_spinbox_class)) {
        lv_spinbox_set_value(obj, v);
    }
}

static const struct {
    const char *name;
    lv_anim_exec_xcb_t cb;
} anim_props[] = {
    {"x", anim_x}, {"y", anim_y}, {"w", anim_w}, {"h", anim_h}, {"opa", anim_opa}, {"value", anim_value},
    {"rotation", anim_rotation},
};

static const struct {
    const char *name;
    lv_anim_path_cb_t cb;
} anim_paths[] = {
    {"linear", lv_anim_path_linear},       {"ease_in", lv_anim_path_ease_in},
    {"ease_out", lv_anim_path_ease_out},   {"ease_in_out", lv_anim_path_ease_in_out},
    {"overshoot", lv_anim_path_overshoot}, {"bounce", lv_anim_path_bounce},
    {"step", lv_anim_path_step},
};

static void build_animations(ui_ctx_t *c, const json_value_t *arr, const char *path)
{
    char p[UI_PATH_MAX], q[UI_PATH_MAX];
    if (arr->type != JSON_ARRAY) {
        err_at(c, path, "expected an array of animations");
        return;
    }
    for (size_t i = 0; i < arr->count; i++) {
        const json_value_t *a = arr->items[i];
        path_idx(p, path, i);
        if (a->type != JSON_OBJECT) {
            err_at(c, p, "expected {\"target\": \"name\", \"prop\": \"x\", \"from\": 0, \"to\": 100, \"duration\": 500}");
            continue;
        }
        static const char *const keys[] = {"target", "prop", "from", "to", "duration", "delay", "repeat",
                                           "playback", "path"};
        bool ok = true;
        for (size_t k = 0; k < a->count; k++) {
            bool known = false;
            for (size_t m = 0; m < sizeof(keys) / sizeof(keys[0]); m++) known = known || !strcmp(a->keys[k], keys[m]);
            if (!known) {
                char hint[96];
                path_key(q, p, a->keys[k]);
                err_at(c, q, "unknown key%s (known: target, prop, from, to, duration, delay, repeat, playback, path)",
                       suggest(a->keys[k], keys, sizeof(keys) / sizeof(keys[0]), hint, sizeof(hint)));
                ok = false;
            }
        }
        const char *target = NULL, *prop = NULL;
        path_key(q, p, "target");
        if (!json_get(a, "target")) {
            err_at(c, q, "missing (the name of the object to animate)");
            ok = false;
        } else if (!v_str(c, json_get(a, "target"), q, &target)) {
            ok = false;
        }
        lv_obj_t *obj = target ? find_named(c, target) : NULL;
        if (target && !obj) {
            err_at(c, q, "no object named \"%s\" in the document", target);
            ok = false;
        }
        path_key(q, p, "prop");
        lv_anim_exec_xcb_t cb = NULL;
        if (!json_get(a, "prop") || !v_str(c, json_get(a, "prop"), q, &prop)) {
            if (!json_get(a, "prop")) err_at(c, q, "missing (x, y, w, h, opa, value or rotation)");
            ok = false;
        } else {
            for (size_t k = 0; k < sizeof(anim_props) / sizeof(anim_props[0]); k++) {
                if (!strcmp(prop, anim_props[k].name)) cb = anim_props[k].cb;
            }
            if (!cb) {
                err_at(c, q, "unknown property \"%s\" (known: x, y, w, h, opa, value, rotation)", prop);
                ok = false;
            }
        }
        int32_t from = 0, to = 0, duration = 500, delay = 0, repeat = 1;
        bool playback = false;
        path_key(q, p, "from");
        if (!json_get(a, "from")) {
            err_at(c, q, "missing");
            ok = false;
        } else if (!v_int(c, json_get(a, "from"), q, -100000, 100000, &from)) {
            ok = false;
        }
        path_key(q, p, "to");
        if (!json_get(a, "to")) {
            err_at(c, q, "missing");
            ok = false;
        } else if (!v_int(c, json_get(a, "to"), q, -100000, 100000, &to)) {
            ok = false;
        }
        if (json_get(a, "duration") && !opt_int(c, a, p, "duration", 0, 60000, &duration)) ok = false;
        if (json_get(a, "delay") && !opt_int(c, a, p, "delay", 0, 60000, &delay)) ok = false;
        const json_value_t *rep = json_get(a, "repeat");
        if (rep) {
            path_key(q, p, "repeat");
            if (rep->type == JSON_STRING && !strcmp(rep->string, "infinite")) repeat = -1;
            else if (!v_int(c, rep, q, 1, 10000, &repeat)) ok = false;
        }
        if (json_get(a, "playback") && !opt_bool(c, a, p, "playback", &playback)) ok = false;
        lv_anim_path_cb_t path_cb = lv_anim_path_linear;
        const json_value_t *pv = json_get(a, "path");
        if (pv) {
            path_key(q, p, "path");
            bool found = false;
            for (size_t k = 0; pv->type == JSON_STRING && k < sizeof(anim_paths) / sizeof(anim_paths[0]); k++) {
                if (!strcmp(pv->string, anim_paths[k].name)) {
                    path_cb = anim_paths[k].cb;
                    found = true;
                }
            }
            if (!found) {
                err_at(c, q, "expected one of: linear, ease_in, ease_out, ease_in_out, overshoot, bounce, step");
                ok = false;
            }
        }
        if (!ok) continue;

        lv_anim_t an;
        lv_anim_init(&an);
        lv_anim_set_var(&an, obj);
        lv_anim_set_exec_cb(&an, cb);
        lv_anim_set_values(&an, from, to);
        lv_anim_set_duration(&an, (uint32_t)duration);
        lv_anim_set_delay(&an, (uint32_t)delay);
        lv_anim_set_path_cb(&an, path_cb);
        lv_anim_set_repeat_count(&an, repeat < 0 ? LV_ANIM_REPEAT_INFINITE : (uint32_t)repeat);
        if (playback) lv_anim_set_reverse_duration(&an, (uint32_t)duration);
        lv_anim_set_early_apply(&an, true);
        lv_anim_start(&an);
    }
}

/**********************
 *  Document
 **********************/

static const char *const doc_keys[] = {"theme", "layer_top", "animations", "screens", "active"};

static bool is_doc_key(const char *k)
{
    for (size_t i = 0; i < sizeof(doc_keys) / sizeof(doc_keys[0]); i++) {
        if (!strcmp(k, doc_keys[i])) return true;
    }
    return false;
}

/** Node object without the document-level keys (shallow view, no copies) */
static json_value_t node_view(const json_value_t *root, json_value_t **items, char **keys)
{
    json_value_t v;
    memset(&v, 0, sizeof(v));
    v.type = JSON_OBJECT;
    v.items = items;
    v.keys = keys;
    for (size_t i = 0; i < root->count; i++) {
        if (is_doc_key(root->keys[i])) continue;
        items[v.count] = root->items[i];
        keys[v.count] = root->keys[i];
        v.count++;
    }
    return v;
}

static void apply_theme(ui_ctx_t *c, lv_display_t *disp, const json_value_t *v)
{
    if (!v) return;
    if (v->type != JSON_STRING || (strcmp(v->string, "light") && strcmp(v->string, "dark"))) {
        err_at(c, "theme", "expected \"light\" or \"dark\"");
        return;
    }
    sim.opt.dark = strcmp(v->string, "dark") == 0;
#if LV_USE_THEME_DEFAULT
    lv_theme_t *theme = lv_theme_default_init(disp, lv_palette_main(LV_PALETTE_BLUE), lv_palette_main(LV_PALETTE_RED),
                                              sim.opt.dark, LV_FONT_DEFAULT);
    lv_display_set_theme(disp, theme);
#else
    LV_UNUSED(disp);
#endif
}

int ui_doc_load(const char *path, lv_display_t *disp)
{
    ui_ctx_t ctx;
    ui_ctx_t *c = &ctx;
    char jerr[256];
    char p[UI_PATH_MAX];

    memset(&ctx, 0, sizeof(ctx));
    ctx.disp = disp;

    json_value_t *root = json_parse_file(path, jerr, sizeof(jerr));
    if (!root) {
        fprintf(stderr, "ui: $: %s\n", jerr);
        return SIM_EXIT_UI;
    }
    if (root->type != JSON_OBJECT) {
        fprintf(stderr, "ui: $: expected a JSON object (the screen node, or {\"screens\": {...}})\n");
        json_free(root);
        return SIM_EXIT_UI;
    }

    apply_theme(c, disp, json_get(root, "theme"));

    json_value_t **items = (json_value_t **)calloc(root->count + 1, sizeof(*items));
    char **keys = (char **)calloc(root->count + 1, sizeof(*keys));
    json_value_t view = node_view(root, items, keys);
    const json_value_t *screens = json_get(root, "screens");
    const json_value_t *active = json_get(root, "active");

    if (screens) {
        if (view.count > 0) {
            for (size_t i = 0; i < view.count; i++) {
                err_at(c, view.keys[i], "node keys are not allowed at the top level when \"screens\" is used; put "
                                        "every screen under \"screens\"");
            }
        }
        if (screens->type != JSON_OBJECT || screens->count == 0) {
            err_at(c, "screens", "expected {\"<name>\": <screen node>, ...} with at least one screen");
        } else {
            lv_obj_t *first = NULL;
            lv_obj_t *to_load = NULL;
            lv_obj_t *old = lv_display_get_screen_active(disp);
            for (size_t i = 0; i < screens->count; i++) {
                const char *sname = screens->keys[i];
                const json_value_t *sn = screens->items[i];
                path_key(p, "screens", sname);
                const json_value_t *nm = json_get(sn, "name");
                if (nm && (nm->type != JSON_STRING || strcmp(nm->string, sname) != 0)) {
                    char q[UI_PATH_MAX];
                    path_key(q, p, "name");
                    err_at(c, q, "must equal the key \"%s\" or be omitted", sname);
                }
                lv_obj_t *scr = lv_obj_create(NULL);
                if (!nm) set_name_checked(c, scr, sname, p);
                build_node(c, sn, NULL, p, scr);
                if (!first) first = scr;
                if (active && active->type == JSON_STRING && !strcmp(active->string, sname)) to_load = scr;
            }
            if (active && !to_load) err_at(c, "active", "expected the name of one of the \"screens\"");
            if (!to_load) to_load = first;
            if (to_load) {
                lv_screen_load(to_load);
                if (old && old != to_load) lv_obj_delete(old);
            }
        }
    } else {
        if (active) err_at(c, "active", "only valid together with \"screens\"");
        build_node(c, &view, NULL, "", lv_display_get_screen_active(disp));
    }

    const json_value_t *top = json_get(root, "layer_top");
    if (top) build_children(c, top, lv_display_get_layer_top(disp), "layer_top");

    const json_value_t *anims = json_get(root, "animations");
    if (anims) build_animations(c, anims, "animations");

    free(items);
    free(keys);
    json_free(root);

    if (c->err_count == 0) return SIM_EXIT_OK;
    qsort(c->errs, c->err_count, sizeof(c->errs[0]), err_cmp);
    for (size_t i = 0; i < c->err_count; i++) fprintf(stderr, "ui: %s: %s\n", c->errs[i].path, c->errs[i].msg);
    fprintf(stderr, "[sim] UI document %s has %u error%s\n", path, (unsigned)c->err_count, c->err_count == 1 ? "" : "s");
    return SIM_EXIT_UI;
}
