# Diagnostics

Every render measures the finished UI and reports problems it can prove,
instead of leaving them to be spotted in a screenshot. Each diagnostic has a
`code`, a `severity` (`error`, `warn`, `info`), the object's `name` (`null`
when it has none) and `path` (`type#index` as printed in the tree, e.g.
`lv_label#3`), its absolute rectangle `abs`, and a plain-English `message`
with the numbers. Findings about no particular object (`MEM_OVER_BUDGET`,
`ANIM_UNFINISHED`, `APP_LOOP_DETECTED`) have `name`, `path` and `abs` set to
`null`.

```json
{"code": "LABEL_CLIPPED", "severity": "warn", "name": "title", "path": "lv_label#0",
 "abs": {"x1": 10, "y1": 10, "x2": 169, "y2": 27},
 "message": "label text 'Living room temperature' needs 204 px, has 160 px (long_mode clip)"}
```

The checks run on the final state; hidden objects (and everything below a
hidden object) are skipped, except for `FONT_NOT_ON_DEVICE`. The JSON lists
errors first, then warnings, then info, at most 200 (`diagnostics_dropped`
counts the rest); the tool result groups them by severity. Give objects names
(`lv_obj_set_name`, or `name` in a UI document): diagnostics, actions and
`lvgl_diff` then refer to them by name.

| Code | Severity | Reported when | Typical fix |
|------|----------|---------------|-------------|
| `LABEL_CLIPPED` | warn | A label in a single-line long mode (`clip`, `dots`, `scroll`, `scroll_circular`) has text wider than its content box, so it is cut off, shortened or only visible while scrolling. The labels inside rollers and textareas are not checked | Widen the label or its parent, use `LV_LABEL_LONG_MODE_WRAP`, shorten the text or use a smaller font; ignore for a deliberate marquee |
| `TEXT_OVERFLOW` | warn | Wrap mode: a single word is wider than the content box, or the wrapped text is taller than it. Other modes: the text is taller than the content box | Give the object `LV_SIZE_CONTENT` height, more height, less padding, or a smaller font; break long words |
| `MISSING_GLYPH` | error | A character (reported as `U+XXXX`) is not in the font, so a placeholder box is drawn. Checked in labels, textarea placeholders, checkbox texts, dropdown options and button matrix maps (at most 5 characters per object; recolor commands are skipped) | Use a font that contains it (the built-in Montserrat fonts cover ASCII, `°`, `•` and the LVGL symbols), generate a custom font with that range, or replace the character |
| `OFF_SCREEN` | warn | A direct child of the screen (or of `layer_top`) is partly or completely outside the display. Deeper objects are covered by `OUTSIDE_PARENT` | Check alignment offsets and sizes for this resolution; prefer `lv_obj_align`, flex/grid layouts and `lv_pct()` over absolute coordinates |
| `OUTSIDE_PARENT` | warn | An object extends beyond its parent's box in a direction in which the parent cannot scroll, so the outside part is clipped. Only for parents that are plain `lv_obj` or `lv_button` containers without `overflow_visible` | Enlarge the parent, move the child, make the parent scrollable on purpose or set `LV_OBJ_FLAG_OVERFLOW_VISIBLE` |
| `OVERLAP` | info | Two visible, non-floating siblings intersect by more than 4 px² in a plain `lv_obj`/`lv_button` parent without a layout. One object lying completely inside the other (a badge on a card) is not reported. At most 20 | Usually unintended stacking from absolute positions: use a flex/grid layout or adjust positions; ignore when the overlap is deliberate |
| `LOW_CONTRAST` | warn | A visible, enabled label's text colour (with `text_opa` and `opa`) against the background composed from every object under the label's centre (`bg_color`, `bg_opa`, `opa`, both gradient ends: the better one counts) has a WCAG contrast ratio below 3.0. Skipped when an image is under the text. Reported once per colour pair; the message says how many more labels use the same colours | Darken or lighten the text or background; check both light and dark themes |
| `SMALL_TOUCH_TARGET` | info | On a display with DPI <= 160, a button (or a clickable object with its own event handler) whose click area is narrower or lower than 40 px, or another input widget (switch, checkbox, slider, arc, dropdown, roller, textarea, button matrix) whose click area is below 40 px in both directions. Children of a clickable target are not checked; `lv_obj_set_ext_click_area()` counts | Enlarge it, or widen the touch area with `lv_obj_set_ext_click_area()` without changing the look |
| `ZERO_SIZE` | warn | The object is not hidden but has width or height 0 (empty labels, and children of a zero-size parent, are not reported) | Set a size, or `LV_SIZE_CONTENT` with content; check percentage sizes against a parent that itself has content size |
| `FONT_NOT_ON_DEVICE` | error | With a device font list (`fonts` parameter): an object draws text with a built-in font that is not in the list (labels, checkboxes, dropdowns, span groups, textarea placeholders, roller main and selected parts, button matrix and table items, scale labels). Custom fonts are not checked | Switch to a font the device enables, or enable that font in the device's `lv_conf.h` |
| `MEM_OVER_BUDGET` | error | LVGL's peak heap use is above the device budget (`mem_budget_kb` or the board's `LV_MEM_SIZE`). The peak excludes draw buffers and the simulator's own input devices | Raise `LV_MEM_SIZE` on the device, create fewer objects or screens at once, delete screens you leave, share styles instead of setting local styles per object |
| `HIDDEN_CLICKABLE` | info | A touch target (as for `SMALL_TOUCH_TARGET`) is fully transparent (effective `opa` 0) but still clickable, so invisible taps land on it | Remove the clickable flag, hide it with `hidden`/`LV_OBJ_FLAG_HIDDEN`, or delete it |
| `ANIM_UNFINISHED` | info | Finite animations were still running at the final capture (endless ones such as spinners are not counted) | Use `settle`, a longer `time_ms`, or `frames` to see the end state |
| `APP_LOOP_DETECTED` | info | Firmware-style code in `create_ui()` or the project entry spent 5 s of simulated time (`vTaskDelay`, `sim_advance_ms`), e.g. `while (1) { lv_timer_handler(); vTaskDelay(...); }`. The simulator leaves the loop (with `longjmp`, only at a point where no LVGL timer or event handler is running; from inside an LVGL callback it finishes the render right there), captures the screen and exits normally | Nothing to fix for a preview; to capture earlier states use `frames` or `sim_capture()`. In C++ code, destructors of locals in the abandoned loop do not run |

Thresholds (40 px, DPI 160, contrast 3.0, 5 s) are fixed in this version.
