# JSON UI documents (`lvgl_render_ui`, `lvgl_sim --ui`)

A JSON UI document describes a screen declaratively. The simulator binary
interprets it at run time and makes the matching LVGL calls, so there is no C
code and no compilation: with the prebuilt `lvgl_sim` shipped in the release
archives it renders on a machine with no compiler, CMake or Ninja.

**LVGL's own XML format is part of LVGL Pro and is not supported here.** The
JSON UI format is this project's own. It maps 1:1 to LVGL calls, and its
vocabulary is the one the widget tree returned by every render uses (same
widget type names, same `styles` keys, same part blocks), so what you read in
a render result is what you write in a document. A UI-mode render
round-trips: names, types and styles set in the document come back in the
tree with the same values.

Diagnostics, `annotate`, `frames`, `actions` and `events` work in UI mode
exactly as they do for C code.

## Example

```json
{ "type": "lv_obj", "name": "screen", "styles": {"bg_color": "#f5f5f5"},
  "children": [
    {"type": "lv_label", "name": "title", "text": "Living room", "align": "top_mid", "x": 0, "y": 12,
     "styles": {"font": "montserrat_24", "text_color": "#111827"}},
    {"type": "lv_slider", "name": "target", "x": 20, "y": 80, "w": 280, "h": 12, "min": 16, "max": 30, "value": 23,
     "styles": {"bg_color": "#e5e7eb"}, "indicator": {"bg_color": "#ff6b3d", "bg_grad_color": "#3b82f6", "bg_grad_dir": "hor"},
     "knob": {"bg_color": "#ffffff", "border_color": "#ff6b3d", "border_width": 3, "shadow_color": "#ff6b3d", "shadow_width": 20, "shadow_opa": 180}},
    {"type": "lv_button", "name": "ok_btn", "align": "bottom_right", "x": -16, "y": -16, "w": 120, "h": 44,
     "children": [{"type": "lv_label", "text": "Heat on", "align": "center"}]}
  ] }
```

This is [`examples/06-ui.json`](../examples/06-ui.json). Render it with the
MCP tool (`lvgl_render_ui` with `ui` = the object above, `width` 320,
`height` 240) or by hand:

```bash
simulator/prebuilt/linux-x64/lvgl_sim --ui examples/06-ui.json --width 320 --height 240 \
  --output-png ui.png --output-json ui.json
```

`lvgl_docs {topic: "ui-json"}` returns this schema with more examples (a card
with a gradient and glow, a flex list, two screens switched by an action).

## Document

The root object is the screen: a node (below) plus these optional top-level
keys.

| Key | Meaning |
|-----|---------|
| `theme` | `"light"` or `"dark"` |
| `layer_top` | array of nodes created on `lv_layer_top()` (message boxes, overlays) |
| `animations` | `[{"target": "<name>", "prop": "x\|y\|w\|h\|opa\|value\|rotation", "from", "to", "duration", "delay", "repeat": N or "infinite", "playback": bool, "path": "linear\|ease_in\|ease_out\|ease_in_out\|overshoot\|bounce"}]`, so `frames` and `settle` show motion |
| `screens` + `active` | several named screens (`{"name": node, ...}`) and the one loaded first; the action `{"load_screen": {"name", "anim", "duration"}}` switches between them |

Only `type` is required on a node. **Unknown keys are errors**, so a typo never
passes silently.

## Nodes

| Key | Value |
|-----|-------|
| `type` | `lv_obj`, `lv_label`, `lv_button`, `lv_image`, `lv_slider`, `lv_bar`, `lv_arc`, `lv_switch`, `lv_checkbox`, `lv_dropdown`, `lv_roller`, `lv_textarea`, `lv_spinner`, `lv_led`, `lv_line`, `lv_chart`, `lv_table`, `lv_buttonmatrix`, `lv_tabview`, `lv_msgbox`, `lv_spinbox`, `lv_scale`, `lv_list` |
| `name` | object name (`lv_obj_set_name`); used by actions, diagnostics and `lvgl_diff` |
| `x`, `y` | integers; offsets from the `align` point when `align` is set |
| `w`, `h` | pixels, `"content"` or a percentage such as `"50%"` |
| `align` | `top_left`, `top_mid`, `top_right`, `left_mid`, `center`, `right_mid`, `bottom_left`, `bottom_mid`, `bottom_right` |
| `hidden` | boolean |
| `states` | subset of `["checked", "disabled", "focused"]` |
| `flags` | `clickable`, `scrollable`, `checkable`, `floating`, `ignore_layout`, `hidden`; prefix with `-` to clear (e.g. `"-scrollable"`) |
| `text`, `placeholder`, `long_mode`, `one_line` | label, textarea and checkbox text options |
| `value`, `min`, `max`, `anim` | slider, bar, arc, spinbox (`anim` defaults to false) |
| `checked` | checkbox, switch |
| `options`, `selected` | dropdown, roller (`options` is an array) |
| `src` | image: `"S:path.png"` (resolved against `assets_dir`) or `"symbol:OK"` for `LV_SYMBOL_OK` and friends |
| widget data | `lv_chart`: chart type `line` or `bar`, `series: [{color, points: [...]}]`, `range`; `lv_table`: `rows: [[...]]`; `lv_buttonmatrix`: `map: [...]`; `lv_tabview`: `tabs: [{title, children}]`; `lv_msgbox`: `title`, `text`, `buttons`; `lv_list`: `items: [{icon?, text}]` |
| `layout` | `{"type": "flex", "flow": "row\|column\|row_wrap\|column_wrap", "main": "start\|end\|center\|space_between\|space_around\|space_evenly", "cross": "start\|end\|center", "track": "start\|end\|center"}` or `{"type": "grid", "cols": [100, "fr1", "content"], "rows": [...]}` |
| `grow` | flex grow on a child of a flex container |
| `cell` | on a child of a grid: `{"col", "col_span", "row", "row_span", "x_align": "stretch\|start\|center\|end", "y_align"}` |
| `styles` | main part, default state (keys below) |
| `indicator`, `knob`, `selected`, `items`, `cursor`, `scrollbar` | the same style keys for that part |
| `styles_pressed`, `styles_checked`, `styles_disabled`, `styles_focused` | state variants; parts too (`indicator_checked`, ...) |
| `children` | array of nodes |

The exact chart key name and the list of widget-specific keys are defined by
the simulator; `lvgl_docs {topic: "ui-json"}` is authoritative for the
installed version.

## Style keys

Exactly the widget-tree names, plus the setters they imply:

| Group | Keys |
|-------|------|
| Background | `bg_color`, `bg_opa`, `bg_grad_color`, `bg_grad_dir` (`hor`, `ver`, `none`), `bg_grad_stops` (`[{color, frac: 0..255}]`, multi-stop) |
| Border, outline | `border_color`, `border_width`, `border_opa`, `border_side` (`full`, `top`, `bottom`, `left`, `right`, `none`), `outline_width`, `outline_color`, `outline_pad` |
| Shape | `radius` (integer or `"circle"`), `clip_corner` |
| Spacing | `pad_top`, `pad_bottom`, `pad_left`, `pad_right`, `pad_all`, `pad_hor`, `pad_ver`, `pad_row`, `pad_column`, `pad_gap`, `margin_*` |
| Shadow | `shadow_color`, `shadow_width`, `shadow_spread`, `shadow_opa`, `shadow_ofs_x`, `shadow_ofs_y` |
| Text | `text_color`, `text_opa`, `font` (`montserrat_8` ... `montserrat_48`, `unscii_8`, `unscii_16`), `text_align` (`left`, `center`, `right`, `auto`), `text_letter_space`, `text_line_space` |
| Lines, arcs | `line_width`, `line_color`, `line_rounded`, `arc_width`, `arc_color`, `arc_opa`, `arc_rounded` |
| Size | `width`, `height`, `min_width`, `max_width`, `min_height`, `max_height` |
| Transform | `opa`, `transform_rotation` (0.1 degree units), `transform_scale` (256 = 1.0), `translate_x`, `translate_y` |

Colours are `"#rrggbb"` or `"#rgb"`. Opacity is 0..255 or a percentage string
such as `"50%"`.

## Errors

A document with problems is not rendered. The simulator exits with code 5 and
prints one line per problem on stderr, all of them, sorted by JSON path:

```
ui: children[0].styles.radius: expected integer
ui: children[2].type: unknown widget "lv_meter" (known: lv_obj, lv_label, ...)
```

`lvgl_render_ui` returns these lines as the tool error.
