/**
 * @file diagnostics.c
 * Checks on the final UI state. False positives are worse than misses, so
 * every rule is deliberately narrow. Objects under a hidden ancestor (or
 * hidden themselves) are skipped by every rule except FONT_NOT_ON_DEVICE.
 * Only the active screen and layer_top are checked (layer_sys belongs to the
 * simulator/LVGL internals).
 *
 * Rules:
 *  ZERO_SIZE (warn)        w == 0 or h == 0; not for labels with empty text
 *                          (placeholders filled at runtime) and not below an
 *                          ancestor that is already zero-sized.
 *  OFF_SCREEN (warn)       direct children of the screen / layer_top whose
 *                          box extends beyond the display.
 *  OUTSIDE_PARENT (warn)   a child extends beyond its parent's box, the
 *                          parent clips it (no OVERFLOW_VISIBLE) and cannot
 *                          scroll in that direction. Only for parents that
 *                          are plain containers (lv_obj, lv_button); other
 *                          widgets manage their own children (roller label,
 *                          textarea label, ...). Parents that are the screen
 *                          or a layer are covered by OFF_SCREEN.
 *  OVERLAP (info)          two visible, non-floating siblings of a plain
 *                          container without layout overlap by more than
 *                          4 px^2 and neither contains the other (containment
 *                          is deliberate layering). At most 20 findings.
 *  LABEL_CLIPPED (warn)    lv_label in clip/dots/scroll/scroll_circular mode
 *                          whose single-line text width exceeds the content
 *                          width.
 *  TEXT_OVERFLOW (warn)    lv_label in wrap mode whose wrapped text is taller
 *                          than the content height (lines cut off) or has a
 *                          word wider than the content width; also any
 *                          non-wrap label whose lines are taller than it.
 *  MISSING_GLYPH (error)   a character of a label / checkbox / dropdown /
 *                          buttonmatrix / textarea placeholder text that the
 *                          font (incl. fallbacks) does not contain; LVGL draws
 *                          a placeholder box. Control characters and recolor
 *                          commands are skipped. At most 5 per object.
 *  LOW_CONTRAST (warn)     lv_label with non-empty text, not disabled: the
 *                          text colour (with text_opa and opa) composited
 *                          over what is drawn under the label's centre (all
 *                          earlier objects in draw order whose box contains
 *                          it, starting from white) has a WCAG contrast
 *                          ratio < 3.0. Gradients count with their best end;
 *                          images under the text make the background unknown
 *                          (no finding). Labels with the same colour pair
 *                          are reported once ("; N more labels use the same
 *                          colours").
 *  SMALL_TOUCH_TARGET (info) display dpi <= 160 and an input widget (button,
 *                          image button, or any clickable object with a user
 *                          event handler) whose click area is < 40 px in
 *                          either dimension; other input widgets (switch,
 *                          checkbox, slider, arc, dropdown, roller, textarea,
 *                          buttonmatrix) only when < 40 px in both. Not for
 *                          targets inside another target.
 *  HIDDEN_CLICKABLE (info) an input widget that is clickable, not hidden, but
 *                          fully transparent (opa 0): it catches touches
 *                          nobody can see.
 *  FONT_NOT_ON_DEVICE (error) with --fonts: a text-drawing widget uses a
 *                          built-in font that is not in the list ("custom"
 *                          fonts are the user's own and are accepted).
 * Global findings (no object): MEM_OVER_BUDGET, ANIM_UNFINISHED and
 * APP_LOOP_DETECTED are added by the runtime.
 */
#include "diagnostics.h"
#include "events.h"
#include "widget_tree.h"

/* lv_obj_class_t::base_class */
#include "src/core/lv_obj_class_private.h"
#include "src/misc/lv_area_private.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DIAG_MAX            200
#define OVERLAP_MAX         20
#define GLYPH_MAX_PER_OBJ   5
#define CONTRAST_MIN        3.0
#define TOUCH_MIN           40
#define TOUCH_DPI_MAX       160
#define TEXT_QUOTE_MAX      40

typedef struct {
    const char *code;
    diag_severity_t severity;
    char *name;
    char *path;
    bool has_abs;
    lv_area_t abs;
    char *message;
} diag_t;

static diag_t diags[DIAG_MAX];
static uint32_t diag_count;
static uint32_t diag_dropped;

static const char *fonts_used[64];
static uint32_t fonts_used_count;

/**********************
 *  Helpers
 **********************/

static char *dup_str(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s);
    char *d = (char *)malloc(n + 1);
    if (d) memcpy(d, s, n + 1);
    return d;
}

void diag_add(const char *code, diag_severity_t severity, lv_obj_t *obj, const char *fmt, ...)
{
    char msg[512];
    va_list ap;

    if (diag_count >= DIAG_MAX) {
        diag_dropped++;
        return;
    }
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    diag_t *d = &diags[diag_count++];
    memset(d, 0, sizeof(*d));
    d->code = code;
    d->severity = severity;
    d->message = dup_str(msg);
    if (obj) {
        char path[WIDGET_TREE_PATH_MAX];
#if LV_USE_OBJ_NAME
        d->name = dup_str(lv_obj_get_name(obj));
#endif
        lv_display_t *disp = lv_obj_get_display(obj);
        if (disp && widget_tree_path_of(disp, obj, path, sizeof(path))) d->path = dup_str(path);
        d->has_abs = true;
        lv_obj_get_coords(obj, &d->abs);
    }
}

/** Subclass-aware class check */
static bool is_a(const lv_obj_t *obj, const lv_obj_class_t *cls)
{
    for (const lv_obj_class_t *c = lv_obj_get_class(obj); c; c = c->base_class) {
        if (c == cls) return true;
    }
    return false;
}

static bool hidden_chain(const lv_obj_t *obj)
{
    for (const lv_obj_t *o = obj; o; o = lv_obj_get_parent(o)) {
        if (lv_obj_is_hidden(o)) return true;
    }
    return false;
}

static bool disabled_chain(const lv_obj_t *obj)
{
    for (const lv_obj_t *o = obj; o; o = lv_obj_get_parent(o)) {
        if (lv_obj_has_state(o, LV_STATE_DISABLED)) return true;
    }
    return false;
}

/** A plain container whose children are user-placed */
static bool is_container(const lv_obj_t *obj)
{
    const lv_obj_class_t *c = lv_obj_get_class(obj);
    return c == &lv_obj_class || c == &lv_button_class;
}

/** "name" if set, else the path; for messages */
static const char *label_of(lv_obj_t *obj, char *buf, size_t size)
{
    return widget_tree_label_of(lv_obj_get_display(obj), obj, buf, size);
}

/** Text quoted for a message, shortened to TEXT_QUOTE_MAX bytes on a UTF-8 boundary */
static const char *quote_text(const char *text, char *buf, size_t size)
{
    size_t n = 0;
    const char *p = text ? text : "";
    size_t limit = size - 4 < TEXT_QUOTE_MAX ? size - 4 : TEXT_QUOTE_MAX;

    while (p[n] && n < limit) n++;
    while (n > 0 && p[n] && ((unsigned char)p[n] & 0xC0) == 0x80) n--; /* do not cut a sequence */
    memcpy(buf, p, n);
    buf[n] = '\0';
    if (p[n]) strcat(buf, "...");
    for (size_t i = 0; buf[i]; i++) {
        if (buf[i] == '\n' || buf[i] == '\r' || buf[i] == '\t') buf[i] = ' ';
    }
    return buf;
}

static const char *long_mode_str(lv_label_long_mode_t m)
{
    switch (m) {
        case LV_LABEL_LONG_MODE_WRAP:            return "wrap";
        case LV_LABEL_LONG_MODE_DOTS:            return "dots";
        case LV_LABEL_LONG_MODE_SCROLL:          return "scroll";
        case LV_LABEL_LONG_MODE_SCROLL_CIRCULAR: return "scroll_circular";
        case LV_LABEL_LONG_MODE_CLIP:            return "clip";
        default:                                 return "unknown";
    }
}

/**********************
 *  Per-object checks
 **********************/

#define CONTRAST_PAIRS_MAX 32

typedef struct {
    char text[8];
    char bg[8];
    uint32_t diag_index;
    uint32_t repeats;
} contrast_pair_t;

typedef struct {
    lv_display_t *disp;
    const char *const *device_fonts;
    uint32_t font_count;
    uint32_t overlap_count;
    lv_obj_t *sys_layer;
    contrast_pair_t contrast_pairs[CONTRAST_PAIRS_MAX];
    uint32_t contrast_pair_count;
} check_ctx_t;

static void check_zero_size(lv_obj_t *obj, int depth)
{
    int32_t w = lv_obj_get_width(obj);
    int32_t h = lv_obj_get_height(obj);
    char buf[WIDGET_TREE_PATH_MAX];

    if (depth == 0 || (w != 0 && h != 0)) return;
    if (is_a(obj, &lv_label_class)) {
        const char *t = lv_label_get_text(obj);
        if (!t || !t[0]) return;
    }
    lv_obj_t *parent = lv_obj_get_parent(obj);
    if (parent && (lv_obj_get_width(parent) == 0 || lv_obj_get_height(parent) == 0)) return;
    diag_add("ZERO_SIZE", DIAG_WARN, obj, "%s '%s' has size %dx%d and is not drawn",
             widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)), (int)w, (int)h);
}

static void check_off_screen(check_ctx_t *ctx, lv_obj_t *obj, int depth)
{
    lv_area_t a;
    int32_t dw = lv_display_get_horizontal_resolution(ctx->disp);
    int32_t dh = lv_display_get_vertical_resolution(ctx->disp);
    char buf[WIDGET_TREE_PATH_MAX];
    char sides[96] = "";

    if (depth != 1) return;
    lv_obj_get_coords(obj, &a);
    if (lv_area_get_width(&a) <= 0 || lv_area_get_height(&a) <= 0) return;

    if (a.x2 < 0 || a.y2 < 0 || a.x1 >= dw || a.y1 >= dh) {
        diag_add("OFF_SCREEN", DIAG_WARN, obj, "%s '%s' at (%d,%d) %dx%d is completely outside the %dx%d screen",
                 widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)), (int)a.x1, (int)a.y1,
                 (int)lv_area_get_width(&a), (int)lv_area_get_height(&a), (int)dw, (int)dh);
        return;
    }
    size_t n = 0;
    if (a.x1 < 0) n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px left", n ? ", " : "", (int)-a.x1);
    if (a.x2 >= dw) n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px right", n ? ", " : "", (int)(a.x2 - dw + 1));
    if (a.y1 < 0) n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px top", n ? ", " : "", (int)-a.y1);
    if (a.y2 >= dh) n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px bottom", n ? ", " : "", (int)(a.y2 - dh + 1));
    if (n == 0) return;
    diag_add("OFF_SCREEN", DIAG_WARN, obj, "%s '%s' extends beyond the %dx%d screen (%s)",
             widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)), (int)dw, (int)dh, sides);
}

static void check_outside_parent(lv_obj_t *obj, int depth)
{
    lv_obj_t *parent = lv_obj_get_parent(obj);
    lv_area_t a, p;
    char buf[WIDGET_TREE_PATH_MAX];
    char pbuf[WIDGET_TREE_PATH_MAX];
    char sides[96] = "";
    size_t n = 0;

    if (depth < 2 || !parent || !is_container(parent)) return;
    if (lv_obj_is_overflow_visible(parent)) return;
    lv_obj_get_coords(obj, &a);
    lv_obj_get_coords(parent, &p);
    if (lv_area_get_width(&a) <= 0 || lv_area_get_height(&a) <= 0) return;
    if (lv_area_get_width(&p) <= 0 || lv_area_get_height(&p) <= 0) return;

    lv_dir_t can_scroll = lv_obj_is_scrollable(parent) ? lv_obj_get_scroll_dir(parent) : LV_DIR_NONE;
    if (a.x1 < p.x1 && !(can_scroll & LV_DIR_LEFT))
        n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px left", n ? ", " : "", (int)(p.x1 - a.x1));
    if (a.x2 > p.x2 && !(can_scroll & LV_DIR_RIGHT))
        n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px right", n ? ", " : "", (int)(a.x2 - p.x2));
    if (a.y1 < p.y1 && !(can_scroll & LV_DIR_TOP))
        n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px top", n ? ", " : "", (int)(p.y1 - a.y1));
    if (a.y2 > p.y2 && !(can_scroll & LV_DIR_BOTTOM))
        n += (size_t)snprintf(sides + n, sizeof(sides) - n, "%s%d px bottom", n ? ", " : "", (int)(a.y2 - p.y2));
    if (n == 0) return;

    const char *pl = label_of(parent, pbuf, sizeof(pbuf));
    diag_add("OUTSIDE_PARENT", DIAG_WARN, obj,
             "%s '%s' extends beyond its parent '%s' (%s); the parent is not scrollable in that direction, so it is clipped",
             widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)), pl, sides);
}

static bool sibling_eligible(lv_obj_t *o)
{
    return !lv_obj_is_hidden(o) && !lv_obj_is_floating(o) && lv_obj_get_width(o) > 0 &&
           lv_obj_get_height(o) > 0 && lv_obj_get_style_opa(o, LV_PART_MAIN) > LV_OPA_TRANSP;
}

static void check_overlap(check_ctx_t *ctx, lv_obj_t *parent)
{
    uint32_t n = lv_obj_get_child_count(parent);
    char b1[WIDGET_TREE_PATH_MAX];
    char b2[WIDGET_TREE_PATH_MAX];

    if (!is_container(parent) || n < 2) return;
    if (lv_obj_get_style_layout(parent, LV_PART_MAIN) != LV_LAYOUT_NONE) return;
    for (uint32_t i = 1; i < n; i++) {
        lv_obj_t *b = lv_obj_get_child(parent, (int32_t)i);
        if (!sibling_eligible(b)) continue;
        lv_area_t ab;
        lv_obj_get_coords(b, &ab);
        for (uint32_t j = 0; j < i; j++) {
            lv_obj_t *a = lv_obj_get_child(parent, (int32_t)j);
            lv_area_t aa, is;
            if (!sibling_eligible(a)) continue;
            lv_obj_get_coords(a, &aa);
            if (!lv_area_intersect(&is, &aa, &ab)) continue;
            int32_t iw = lv_area_get_width(&is);
            int32_t ih = lv_area_get_height(&is);
            if ((int64_t)iw * ih <= 4) continue;
            if (lv_area_is_in(&aa, &ab, 0) || lv_area_is_in(&ab, &aa, 0)) continue;
            if (ctx->overlap_count >= OVERLAP_MAX) return;
            ctx->overlap_count++;
            diag_add("OVERLAP", DIAG_INFO, b, "%s '%s' overlaps its sibling %s '%s' by %dx%d px (parent has no layout)",
                     widget_tree_type_name(b), label_of(b, b1, sizeof(b1)), widget_tree_type_name(a),
                     label_of(a, b2, sizeof(b2)), (int)iw, (int)ih);
        }
    }
}

static void check_label_text(lv_obj_t *obj)
{
    const char *text = lv_label_get_text(obj);
    char buf[WIDGET_TREE_PATH_MAX];
    char q[TEXT_QUOTE_MAX + 8];
    lv_point_t size;

    if (!text || !text[0]) return;
    const lv_font_t *font = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
    if (!font) return;
    int32_t ls = lv_obj_get_style_text_letter_space(obj, LV_PART_MAIN);
    int32_t lns = lv_obj_get_style_text_line_space(obj, LV_PART_MAIN);
    int32_t cw = lv_obj_get_content_width(obj);
    int32_t ch = lv_obj_get_content_height(obj);
    lv_label_long_mode_t mode = lv_label_get_long_mode(obj);
    lv_text_flag_t flag = LV_TEXT_FLAG_NONE;
    if (lv_label_get_recolor(obj)) flag = (lv_text_flag_t)(flag | LV_TEXT_FLAG_RECOLOR);

    if (cw <= 0 || ch <= 0) return; /* ZERO_SIZE covers it */

    if (mode == LV_LABEL_LONG_MODE_WRAP) {
        lv_text_get_size(&size, text, font, ls, lns, cw, flag);
        if (size.x > cw) {
            diag_add("TEXT_OVERFLOW", DIAG_WARN, obj,
                     "label text '%s' has a word %d px wide, content width is %d px (long_mode wrap does not break words)",
                     quote_text(text, q, sizeof(q)), (int)size.x, (int)cw);
        } else if (size.y > ch) {
            int32_t line_h = lv_font_get_line_height(font) + lns;
            int32_t lines = line_h > 0 ? (size.y + lns) / line_h : 0;
            diag_add("TEXT_OVERFLOW", DIAG_WARN, obj,
                     "label text '%s' wraps to %d lines (%d px high), content height is %d px (long_mode wrap)",
                     quote_text(text, q, sizeof(q)), (int)lines, (int)size.y, (int)ch);
        }
        (void)buf;
        return;
    }

    lv_text_get_size(&size, text, font, ls, lns, LV_COORD_MAX, flag);
    if (size.x > cw) {
        diag_add("LABEL_CLIPPED", DIAG_WARN, obj, "label text '%s' needs %d px, has %d px (long_mode %s)",
                 quote_text(text, q, sizeof(q)), (int)size.x, (int)cw, long_mode_str(mode));
    }
    if (size.y > ch) {
        diag_add("TEXT_OVERFLOW", DIAG_WARN, obj, "label text '%s' needs %d px height, has %d px (long_mode %s)",
                 quote_text(text, q, sizeof(q)), (int)size.y, (int)ch, long_mode_str(mode));
    }
}

/**********************
 *  Glyphs
 **********************/

static uint32_t utf8_next(const char **pp)
{
    const unsigned char *p = (const unsigned char *)*pp;
    uint32_t c = p[0];
    int n = 0;

    if (c < 0x80) n = 0;
    else if ((c & 0xE0) == 0xC0) { c &= 0x1F; n = 1; }
    else if ((c & 0xF0) == 0xE0) { c &= 0x0F; n = 2; }
    else if ((c & 0xF8) == 0xF0) { c &= 0x07; n = 3; }
    else { *pp += 1; return 0xFFFD; }
    for (int i = 1; i <= n; i++) {
        if ((p[i] & 0xC0) != 0x80) {
            *pp += i;
            return 0xFFFD;
        }
        c = (c << 6) | (p[i] & 0x3F);
    }
    *pp += n + 1;
    return c;
}

static void check_glyphs(lv_obj_t *obj, const char *text, const lv_font_t *font, bool recolor, uint32_t *reported,
                         uint32_t *reported_count)
{
    const char *p = text;

    if (!text || !font) return;
    while (*p && *reported_count < GLYPH_MAX_PER_OBJ) {
        if (recolor && *p == '#') {
            /* "#rrggbb text#": skip the command */
            p++;
            const char *q = p;
            int hex = 0;
            while (hex < 6 && ((*q >= '0' && *q <= '9') || (*q >= 'a' && *q <= 'f') || (*q >= 'A' && *q <= 'F'))) {
                q++;
                hex++;
            }
            if (hex == 6 && *q == ' ') p = q + 1;
            continue;
        }
        const char *start = p;
        uint32_t cp = utf8_next(&p);
        if (cp < 0x20 || cp == 0x7F || (cp >= 0x80 && cp < 0xA0) || cp == 0x200B || cp == 0xFEFF) continue;
        const char *peek = p;
        uint32_t next = *peek ? utf8_next(&peek) : 0;
        lv_font_glyph_dsc_t dsc;
        bool found = lv_font_get_glyph_dsc(font, &dsc, cp, next);
        if (found && !dsc.is_placeholder) continue;

        bool dup = false;
        for (uint32_t i = 0; i < *reported_count; i++) dup = dup || reported[i] == cp;
        if (dup) continue;
        reported[(*reported_count)++] = cp;

        char ch[8] = {0};
        size_t len = (size_t)(p - start) < sizeof(ch) - 1 ? (size_t)(p - start) : sizeof(ch) - 1;
        memcpy(ch, start, len);
        diag_add("MISSING_GLYPH", DIAG_ERROR, obj, "char '%s' (U+%04X) not in font %s — placeholder box drawn",
                 cp == 0xFFFD ? "?" : ch, (unsigned)cp, widget_tree_font_name(font));
    }
}

static void check_obj_glyphs(lv_obj_t *obj)
{
    uint32_t reported[GLYPH_MAX_PER_OBJ];
    uint32_t count = 0;
    const lv_font_t *main_font = lv_obj_get_style_text_font(obj, LV_PART_MAIN);

    if (is_a(obj, &lv_label_class)) {
        check_glyphs(obj, lv_label_get_text(obj), main_font, lv_label_get_recolor(obj), reported, &count);
    } else if (is_a(obj, &lv_textarea_class)) {
        /* The text itself is drawn by the textarea's internal label (checked as a label) */
        check_glyphs(obj, lv_textarea_get_placeholder_text(obj), main_font, false, reported, &count);
    } else if (is_a(obj, &lv_checkbox_class)) {
        check_glyphs(obj, lv_checkbox_get_text(obj), main_font, false, reported, &count);
    } else if (is_a(obj, &lv_dropdown_class)) {
        check_glyphs(obj, lv_dropdown_get_options(obj), main_font, false, reported, &count);
    } else if (is_a(obj, &lv_buttonmatrix_class)) {
        const char *const *map = lv_buttonmatrix_get_map(obj);
        const lv_font_t *f = lv_obj_get_style_text_font(obj, LV_PART_ITEMS);
        for (uint32_t i = 0; map && map[i] && map[i][0] && i < 512; i++) {
            if (strcmp(map[i], "\n") == 0) continue;
            check_glyphs(obj, map[i], f, false, reported, &count);
        }
    }
}

/**********************
 *  Contrast
 **********************/

typedef struct {
    double r, g, b;     /* 0..255 */
} rgb_t;

static rgb_t to_rgb(lv_color_t c)
{
    rgb_t r = {c.red, c.green, c.blue};
    return r;
}

static rgb_t mix(rgb_t fg, rgb_t bg, double a)
{
    rgb_t r = {fg.r * a + bg.r * (1 - a), fg.g * a + bg.g * (1 - a), fg.b * a + bg.b * (1 - a)};
    return r;
}

static double channel_lin(double v)
{
    v /= 255.0;
    return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}

static double luminance(rgb_t c)
{
    return 0.2126 * channel_lin(c.r) + 0.7152 * channel_lin(c.g) + 0.0722 * channel_lin(c.b);
}

static double contrast(rgb_t a, rgb_t b)
{
    double la = luminance(a), lb = luminance(b);
    return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

typedef struct {
    lv_obj_t *target;
    lv_point_t center;
    lv_obj_t *sys_layer;
    rgb_t bg_a;     /* background at the gradient's main color */
    rgb_t bg_b;     /* ... and at its gradient color */
    bool unknown;   /* an image is under the text */
    bool done;
} contrast_ctx_t;

static bool draws_image(lv_obj_t *obj)
{
    return is_a(obj, &lv_image_class) || is_a(obj, &lv_canvas_class) || is_a(obj, &lv_imagebutton_class) ||
           lv_obj_get_style_bg_image_src(obj, LV_PART_MAIN) != NULL;
}

static bool contrast_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    contrast_ctx_t *c = (contrast_ctx_t *)user;
    lv_area_t a;
    LV_UNUSED(path);
    LV_UNUSED(depth);

    if (obj == c->sys_layer) return false; /* the label lives on screen or layer_top */
    if (hidden_chain(obj)) return true;
    lv_obj_get_coords(obj, &a);
    if (lv_area_is_point_on(&a, &c->center, 0)) {
        double opa = lv_obj_get_style_opa_recursive(obj, LV_PART_MAIN) / 255.0;
        if (draws_image(obj) && obj != c->target) {
            c->unknown = true;
        }
        lv_opa_t bg_opa = lv_obj_get_style_bg_opa(obj, LV_PART_MAIN);
        if (bg_opa > LV_OPA_TRANSP && opa > 0) {
            double alpha = (bg_opa / 255.0) * opa;
            rgb_t main_c = to_rgb(lv_obj_get_style_bg_color(obj, LV_PART_MAIN));
            rgb_t grad_c = main_c;
            const lv_grad_dsc_t *grad = lv_obj_get_style_bg_grad(obj, LV_PART_MAIN);
            if (grad && grad->stops_count > 0) {
                main_c = to_rgb(grad->stops[0].color);
                grad_c = to_rgb(grad->stops[grad->stops_count - 1].color);
            } else if (lv_obj_get_style_bg_grad_dir(obj, LV_PART_MAIN) != LV_GRAD_DIR_NONE) {
                grad_c = to_rgb(lv_obj_get_style_bg_grad_color(obj, LV_PART_MAIN));
            }
            c->bg_a = mix(main_c, c->bg_a, alpha);
            c->bg_b = mix(grad_c, c->bg_b, alpha);
            if (alpha >= 0.999) c->unknown = false;
        }
    }
    if (obj == c->target) {
        c->done = true;
        return false;
    }
    return true;
}

static void hex_of(rgb_t c, char *buf)
{
    snprintf(buf, 8, "#%02x%02x%02x", (unsigned)lround(c.r), (unsigned)lround(c.g), (unsigned)lround(c.b));
}

static void check_contrast(check_ctx_t *ctx, lv_obj_t *obj)
{
    const char *text = lv_label_get_text(obj);
    lv_area_t a;
    char q[TEXT_QUOTE_MAX + 8];

    if (!text || !text[0] || disabled_chain(obj)) return;
    lv_obj_get_coords(obj, &a);
    if (lv_area_get_width(&a) <= 0 || lv_area_get_height(&a) <= 0) return;

    double opa = lv_obj_get_style_opa_recursive(obj, LV_PART_MAIN) / 255.0;
    double text_opa = lv_obj_get_style_text_opa(obj, LV_PART_MAIN) / 255.0 * opa;
    if (text_opa <= 0) return;

    contrast_ctx_t c;
    memset(&c, 0, sizeof(c));
    c.target = obj;
    c.sys_layer = ctx->sys_layer;
    c.center.x = (a.x1 + a.x2) / 2;
    c.center.y = (a.y1 + a.y2) / 2;
    c.bg_a.r = c.bg_a.g = c.bg_a.b = 255;
    c.bg_b = c.bg_a;
    widget_tree_walk(ctx->disp, contrast_cb, &c);
    if (!c.done || c.unknown) return;

    rgb_t tc = to_rgb(lv_obj_get_style_text_color(obj, LV_PART_MAIN));
    rgb_t ta = mix(tc, c.bg_a, text_opa);
    rgb_t tb = mix(tc, c.bg_b, text_opa);
    double ca = contrast(ta, c.bg_a);
    double cb = contrast(tb, c.bg_b);
    double best = ca > cb ? ca : cb;
    if (best >= CONTRAST_MIN) return;

    char th[8], bh[8];
    hex_of(ca >= cb ? ta : tb, th);
    hex_of(ca >= cb ? c.bg_a : c.bg_b, bh);

    /* One finding per colour pair: further labels with the same colours are counted on the first */
    for (uint32_t i = 0; i < ctx->contrast_pair_count; i++) {
        contrast_pair_t *pr = &ctx->contrast_pairs[i];
        if (strcmp(pr->text, th) == 0 && strcmp(pr->bg, bh) == 0) {
            pr->repeats++;
            return;
        }
    }
    if (ctx->contrast_pair_count < CONTRAST_PAIRS_MAX) {
        contrast_pair_t *pr = &ctx->contrast_pairs[ctx->contrast_pair_count++];
        memcpy(pr->text, th, sizeof(th));
        memcpy(pr->bg, bh, sizeof(bh));
        pr->diag_index = diag_count;
        pr->repeats = 0;
    }
    diag_add("LOW_CONTRAST", DIAG_WARN, obj, "label text '%s' has contrast %.1f:1 (%s on %s), below %.1f:1",
             quote_text(text, q, sizeof(q)), best, th, bh, CONTRAST_MIN);
}

/** Append "(N more labels ...)" to the first finding of each repeated colour pair */
static void finish_contrast(check_ctx_t *ctx)
{
    for (uint32_t i = 0; i < ctx->contrast_pair_count; i++) {
        contrast_pair_t *pr = &ctx->contrast_pairs[i];
        if (pr->repeats == 0 || pr->diag_index >= diag_count) continue;
        diag_t *d = &diags[pr->diag_index];
        char msg[640];
        snprintf(msg, sizeof(msg), "%s; %u more label%s use%s the same colours", d->message ? d->message : "",
                 (unsigned)pr->repeats, pr->repeats == 1 ? "" : "s", pr->repeats == 1 ? "s" : "");
        free(d->message);
        d->message = dup_str(msg);
    }
}

/**********************
 *  Touch targets
 **********************/

static bool has_user_input_handler(lv_obj_t *obj)
{
    uint32_t n = lv_obj_get_event_count(obj);
    for (uint32_t i = 0; i < n; i++) {
        lv_event_dsc_t *d = lv_obj_get_event_dsc(obj, i);
        if (d && !events_is_recorder(lv_event_dsc_get_cb(d))) return true;
    }
    return false;
}

/** 2 = button-like target, 1 = other input widget, 0 = not a touch target */
static int target_kind(lv_obj_t *obj)
{
    if (is_a(obj, &lv_button_class) || is_a(obj, &lv_imagebutton_class)) return 2;
    if (is_a(obj, &lv_switch_class) || is_a(obj, &lv_checkbox_class) || is_a(obj, &lv_slider_class) ||
        is_a(obj, &lv_arc_class) || is_a(obj, &lv_dropdown_class) || is_a(obj, &lv_roller_class) ||
        is_a(obj, &lv_textarea_class) || is_a(obj, &lv_buttonmatrix_class)) {
        return 1;
    }
    if (lv_obj_is_clickable(obj) && has_user_input_handler(obj)) return 2;
    return 0;
}

static void check_touch(check_ctx_t *ctx, lv_obj_t *obj)
{
    char buf[WIDGET_TREE_PATH_MAX];
    int kind = target_kind(obj);

    if (kind == 0 || !lv_obj_is_clickable(obj)) return;

    if (lv_obj_get_style_opa_recursive(obj, LV_PART_MAIN) == LV_OPA_TRANSP) {
        diag_add("HIDDEN_CLICKABLE", DIAG_INFO, obj, "%s '%s' is fully transparent (opa 0) but still receives touches",
                 widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)));
        return;
    }

    if (lv_display_get_dpi(ctx->disp) > TOUCH_DPI_MAX) return;
    for (lv_obj_t *p = lv_obj_get_parent(obj); p; p = lv_obj_get_parent(p)) {
        if (lv_obj_get_parent(p) && lv_obj_is_clickable(p) && target_kind(p) != 0) return;
    }
    lv_area_t click;
    lv_obj_get_click_area(obj, &click);
    int32_t w = lv_area_get_width(&click);
    int32_t h = lv_area_get_height(&click);
    if (w <= 0 || h <= 0) return;
    bool small = kind == 2 ? (w < TOUCH_MIN || h < TOUCH_MIN) : (w < TOUCH_MIN && h < TOUCH_MIN);
    if (!small) return;
    diag_add("SMALL_TOUCH_TARGET", DIAG_INFO, obj,
             "%s '%s' touch area is %dx%d px, below %dx%d px (display %d dpi)", widget_tree_type_name(obj),
             label_of(obj, buf, sizeof(buf)), (int)w, (int)h, TOUCH_MIN, TOUCH_MIN,
             (int)lv_display_get_dpi(ctx->disp));
}

/**********************
 *  Fonts
 **********************/

static void note_font(check_ctx_t *ctx, lv_obj_t *obj, const lv_font_t *font)
{
    if (!font) return;
    const char *name = widget_tree_font_name(font);
    bool known = false;
    for (uint32_t i = 0; i < fonts_used_count; i++) known = known || strcmp(fonts_used[i], name) == 0;
    if (!known && fonts_used_count < sizeof(fonts_used) / sizeof(fonts_used[0])) fonts_used[fonts_used_count++] = name;

    if (!ctx->device_fonts || strcmp(name, "custom") == 0) return;
    for (uint32_t i = 0; i < ctx->font_count; i++) {
        if (strcmp(ctx->device_fonts[i], name) == 0) return;
    }
    char buf[WIDGET_TREE_PATH_MAX];
    char list[256] = "";
    size_t n = 0;
    for (uint32_t i = 0; i < ctx->font_count && n < sizeof(list) - 1; i++) {
        n += (size_t)snprintf(list + n, sizeof(list) - n, "%s%s", i ? ", " : "", ctx->device_fonts[i]);
    }
    diag_add("FONT_NOT_ON_DEVICE", DIAG_ERROR, obj, "%s '%s' uses font %s, which is not on the device (available: %s)",
             widget_tree_type_name(obj), label_of(obj, buf, sizeof(buf)), name, ctx->font_count ? list : "none");
}

static void check_fonts(check_ctx_t *ctx, lv_obj_t *obj)
{
    if (is_a(obj, &lv_label_class) || is_a(obj, &lv_checkbox_class) || is_a(obj, &lv_dropdown_class) ||
        is_a(obj, &lv_spangroup_class)) {
        note_font(ctx, obj, lv_obj_get_style_text_font(obj, LV_PART_MAIN));
    } else if (is_a(obj, &lv_textarea_class)) {
        const char *ph = lv_textarea_get_placeholder_text(obj);
        if (ph && ph[0]) note_font(ctx, obj, lv_obj_get_style_text_font(obj, LV_PART_MAIN));
    } else if (is_a(obj, &lv_roller_class)) {
        const lv_font_t *m = lv_obj_get_style_text_font(obj, LV_PART_MAIN);
        const lv_font_t *s = lv_obj_get_style_text_font(obj, LV_PART_SELECTED);
        note_font(ctx, obj, m);
        if (s != m) note_font(ctx, obj, s);
    } else if (is_a(obj, &lv_buttonmatrix_class) || is_a(obj, &lv_table_class)) {
        note_font(ctx, obj, lv_obj_get_style_text_font(obj, LV_PART_ITEMS));
    } else if (is_a(obj, &lv_scale_class)) {
        note_font(ctx, obj, lv_obj_get_style_text_font(obj, LV_PART_INDICATOR));
    }
}

/**********************
 *  Driver
 **********************/

static bool check_cb(lv_obj_t *obj, const char *path, int depth, void *user)
{
    check_ctx_t *ctx = (check_ctx_t *)user;
    LV_UNUSED(path);

    if (obj == ctx->sys_layer) return false; /* layer_sys is walked last */
    check_fonts(ctx, obj);
    if (hidden_chain(obj)) return true;

    check_zero_size(obj, depth);
    check_off_screen(ctx, obj, depth);
    check_outside_parent(obj, depth);
    check_overlap(ctx, obj);
    if (is_a(obj, &lv_label_class) && !is_a(lv_obj_get_parent(obj) ? lv_obj_get_parent(obj) : obj, &lv_roller_class) &&
        !(lv_obj_get_parent(obj) && is_a(lv_obj_get_parent(obj), &lv_textarea_class))) {
        /* Roller and textarea labels are scrolled by their widget: not checked for size */
        check_label_text(obj);
        check_contrast(ctx, obj);
    }
    check_obj_glyphs(obj);
    if (depth > 0) check_touch(ctx, obj);
    return true;
}

static int font_cmp(const void *a, const void *b)
{
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

void diag_check_ui(lv_display_t *disp, const char *const *device_fonts, uint32_t font_count)
{
    check_ctx_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.disp = disp;
    ctx.device_fonts = device_fonts;
    ctx.font_count = font_count;
    ctx.sys_layer = lv_display_get_layer_sys(disp);
    widget_tree_walk(disp, check_cb, &ctx);
    finish_contrast(&ctx);
    qsort((void *)fonts_used, fonts_used_count, sizeof(fonts_used[0]), font_cmp);
}

static int severity_rank(diag_severity_t s)
{
    return s == DIAG_ERROR ? 0 : s == DIAG_WARN ? 1 : 2;
}

static const char *severity_name(diag_severity_t s)
{
    return s == DIAG_ERROR ? "error" : s == DIAG_WARN ? "warn" : "info";
}

void diag_write(jw_t *w)
{
    bool first = true;

    jw_puts(",\"diagnostics\":[", w);
    for (int rank = 0; rank < 3; rank++) {
        for (uint32_t i = 0; i < diag_count; i++) {
            diag_t *d = &diags[i];
            if (severity_rank(d->severity) != rank) continue;
            jw_printf(w, "%s{\"code\":\"%s\",\"severity\":\"%s\",\"name\":", first ? "" : ",", d->code,
                      severity_name(d->severity));
            first = false;
            if (d->name) widget_tree_write_string(w, d->name);
            else jw_puts("null", w);
            jw_puts(",\"path\":", w);
            if (d->path) widget_tree_write_string(w, d->path);
            else jw_puts("null", w);
            jw_puts(",\"abs\":", w);
            if (d->has_abs) {
                jw_printf(w, "{\"x1\":%d,\"y1\":%d,\"x2\":%d,\"y2\":%d}", (int)d->abs.x1, (int)d->abs.y1,
                          (int)d->abs.x2, (int)d->abs.y2);
            } else {
                jw_puts("null", w);
            }
            jw_puts(",\"message\":", w);
            widget_tree_write_string(w, d->message);
            jw_putc('}', w);
        }
    }
    jw_putc(']', w);
    if (diag_dropped) jw_printf(w, ",\"diagnostics_dropped\":%u", (unsigned)diag_dropped);
}

void diag_write_fonts_used(jw_t *w)
{
    jw_puts(",\"fonts_used\":[", w);
    for (uint32_t i = 0; i < fonts_used_count; i++) {
        jw_printf(w, "%s\"%s\"", i ? "," : "", fonts_used[i]);
    }
    jw_putc(']', w);
}
