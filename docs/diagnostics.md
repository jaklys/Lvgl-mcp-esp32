# Diagnostics

Every render measures the finished UI and reports problems it can prove,
instead of leaving them to be spotted in a screenshot. Each diagnostic has a
`code`, a `severity` (`error`, `warn`, `info`), the object's `name` (when it
has one) and `path` (`type#index` as printed in the tree, e.g.
`lv_label#3`), its absolute rectangle `abs`, and a plain-English `message`
with the numbers:

```json
{"code": "LABEL_CLIPPED", "severity": "warn", "name": "title", "path": "lv_label#3",
 "abs": {"x1": 10, "y1": 8, "x2": 169, "y2": 27},
 "message": "label text 'Living room temperature' needs 212 px, has 160 px (long_mode clip)"}
```

The tool result lists them grouped by severity; the JSON has them in
`diagnostics`. Give objects names (`lv_obj_set_name`, or `name` in a UI
document): diagnostics, actions and `lvgl_diff` then refer to them by name.

| Code | Severity | Meaning | Typical fix |
|------|----------|---------|-------------|
| `LABEL_CLIPPED` | warn | A label's text needs more room than it has and is cut off (`long_mode` clip, or a fixed size without wrapping) | Widen the label or its parent, use `LV_LABEL_LONG_MODE_WRAP` / `DOTS` / `SCROLL_CIRCULAR`, shorten the text or use a smaller font |
| `TEXT_OVERFLOW` | warn | Wrapped text is taller (or wider) than the object's content box | Give the object `LV_SIZE_CONTENT` height, more height, less padding, or a smaller font |
| `MISSING_GLYPH` | error | A character (reported as `U+XXXX`) is not in the font, so a placeholder box is drawn | Use a font that contains it (the built-in Montserrat fonts cover ASCII, `°` and the LVGL symbols), generate a custom font with that range, or replace the character |
| `OFF_SCREEN` | warn | The object is partly or fully outside its screen | Check alignment offsets and sizes for this resolution; prefer `lv_obj_align`, flex/grid layouts and `lv_pct()` over absolute coordinates |
| `OUTSIDE_PARENT` | warn | The object lies outside its parent's clip area and the parent does not scroll, so the outside part is invisible | Enlarge the parent, move the child, or make the parent scrollable on purpose |
| `OVERLAP` | info | Two visible siblings overlap and their parent has no layout | Usually unintended stacking from absolute positions: use a flex/grid layout or adjust positions; ignore when the overlap is deliberate |
| `LOW_CONTRAST` | warn | Text colour against the effective background (nearest ancestor with `bg_opa > 0`, including opacity) has a WCAG-style contrast ratio below 3.0 | Darken or lighten the text or background; check both light and dark themes |
| `SMALL_TOUCH_TARGET` | info | A clickable object is smaller than 40x40 px on a display with DPI <= 160 | Enlarge it, or use `lv_obj_set_ext_click_area()` to widen the touch area without changing the look |
| `ZERO_SIZE` | warn | The object is not hidden but has width or height 0 | Set a size, or `LV_SIZE_CONTENT` with content; check percentage sizes against a parent that itself has content size |
| `FONT_NOT_ON_DEVICE` | error | The object uses a built-in font that is not in the device font list (`fonts` parameter or board preset) | Switch to a font the device enables, or enable that font in the device's `lv_conf.h` |
| `MEM_OVER_BUDGET` | error | LVGL's peak heap use is above the device budget (`mem_budget_kb` or the board's `LV_MEM_SIZE`) | Raise `LV_MEM_SIZE` on the device, create fewer objects or screens at once, delete screens you leave, share styles instead of setting local styles per object |
| `HIDDEN_CLICKABLE` | info | A clickable object is hidden or invisible, so it can never receive a click | Remove the clickable flag, show it when needed, or delete it |
| `ANIM_UNFINISHED` | info | Animations were still running at the final capture | Use `settle`, a longer `time_ms`, or `frames` to see the end state; ignore for endless animations such as spinners |
| `APP_LOOP_DETECTED` | info | Firmware-style code ran a `while (1) { lv_timer_handler(); vTaskDelay(...); }` loop; after 5 s of simulated time the simulator captured the screen and stopped | Nothing to fix for a preview; to capture earlier states use `frames` or `sim_capture()` |

Thresholds (40 px, DPI 160, contrast 3.0, 5 s) are fixed in this version.
