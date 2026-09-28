# Widget tree JSON (`format_version` 3)

Every render writes one compact JSON document next to the PNG (the tools
return it as `structuredContent` and summarize it in text; `lvgl_inspect`
filters it). A sample is in the [README](../README.md#json-output-format).

Version 3 (2.2.0) only adds fields: everything from version 2 (2.1.0) keeps
its name and meaning.

## Top level

| Field | Since | Description |
|-------|-------|-------------|
| `format_version` | 2 | `3` |
| `lvgl_version` | 2 | e.g. `"9.6.0"` |
| `display` | 2 | `width`, `height` (logical size after rotation), `rotation`, `dpi`, `color_format` (`XRGB8888` or `RGB565`), `theme`; v3 adds `scale` (PNG upscale factor; tree coordinates stay logical) |
| `elapsed_ms` | 2 | simulated time actually advanced |
| `anims_running` | 2 | animations still running at the final capture |
| `logs` | 2 | LVGL log lines (and `sim_log` output), max 200 |
| `screen` | 2 | the final widget tree (node, below) |
| `layer_top`, `layer_sys` | 2 | present when those layers have children |
| `captures` | 3 | only with more than one capture or with `annotate`: `[{n, label, elapsed_ms, png, annotated?, screen, layer_top?}]`; `screen` is the full tree at that moment; the last entry is `final` |
| `mem` | 3 | `peak_bytes`, `used_bytes`, `frag_pct`, and with a budget `budget_bytes`, `over_budget` |
| `fonts_used` | 3 | built-in fonts used by visible objects, e.g. `["montserrat_14", "montserrat_28"]` |
| `diagnostics` | 3 | `[{code, severity, name?, path, abs, message}]`, see [diagnostics.md](diagnostics.md) |
| `input` | 3 | `{pointer, keypad, focused}` (name of the focused object or `null`) |
| `events` | 3 | with actions: `[{t_ms, name, event}]`, max 200, see [actions.md](actions.md) |

## Widget nodes

| Field | Description |
|-------|-------------|
| `type` | Widget class name (`lv_obj`, `lv_button`, `lv_label`, `lv_slider`, `lv_bar`, `lv_arc`, `lv_switch`, `lv_checkbox`, `lv_dropdown`, `lv_roller`, `lv_textarea`, `lv_image`, `lv_chart`, `lv_table`, ...) |
| `name` | Name set with `lv_obj_set_name()` (only when set) |
| `x`, `y`, `w`, `h` | Position relative to the parent's content area, and size (px) |
| `abs` | Absolute screen coordinates `x1`, `y1`, `x2`, `y2` (inclusive) |
| `hidden` / `visible` | `hidden: true` when `LV_OBJ_FLAG_HIDDEN` is set; `visible: false` when the widget is not visible on screen for any reason |
| `states` | Non-default states: `checked`, `disabled`, `focused`, `pressed`, `edited`, ... |
| `flags` | Object flags that are set: `clickable`, `scrollable`, `checkable`, `floating`, `ignore_layout`, ... |
| `text`, `placeholder`, `long_mode` | Label/textarea/checkbox text, textarea placeholder, label long mode |
| `value`, `min`, `max` | Slider, bar, arc, spinbox |
| `checked` | Checkbox, switch |
| `options`, `selected` | Dropdown, roller |
| `src` | Image source: `S:path` for files, `<c-array>` or `<symbol>` |
| `layout` | Flex (`flow`, `main`, `cross`, `track`) or grid, when a layout is set |
| `scroll` | Scroll offset and `overflow_x`/`overflow_y`, when content overflows or is scrolled |
| `styles` | Resolved main-part styles for the current state |
| `indicator`, `knob` | Indicator/knob part colors (slider, bar, arc, switch) |
| `children` | Nested child widgets |

`styles` keys: `bg_color`, `bg_opa`, `border_color`, `border_width`, `radius`,
`pad_top`, `pad_bottom`, `pad_left`, `pad_right`, `pad_row`, `pad_column`,
`text_color`, `font`, `line_height`, `opa`. Trivial values are omitted (for
example `bg_color` when `bg_opa` is 0, zero paddings). Colors are `#rrggbb`,
opacity is 0-255. `font` is the built-in font name (`montserrat_8` ...
`montserrat_48`, `unscii_8`, `unscii_16`, ...) or `custom`; `line_height` is
in px. The same names are the style keys of [JSON UI documents](ui-json.md).

## History

- 3 (2.2.0): `captures`, `mem`, `fonts_used`, `diagnostics`, `input`,
  `events`, `display.scale`.
- 2 (2.1.0): top-level wrapper instead of the bare screen node;
  `text_font_size` (which reported the line height) replaced by `font` +
  `line_height`. See [CHANGELOG.md](../CHANGELOG.md).
