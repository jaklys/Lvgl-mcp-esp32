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

A small document (320x240):

```json
{ "type": "lv_obj", "name": "screen", "styles": {"bg_color": "#f5f5f5"},
  "children": [
    {"type": "lv_label", "name": "title", "text": "Living room", "align": "top_mid", "x": 0, "y": 12,
     "styles": {"font": "montserrat_24", "text_color": "#111827"}},
    {"type": "lv_slider", "name": "target", "x": 20, "y": 80, "w": 280, "h": 12, "min": 16, "max": 30, "value": 23,
     "styles": {"bg_color": "#e5e7eb"}, "indicator": {"bg_color": "#ff6b3d", "bg_grad_color": "#3b82f6", "bg_grad_dir": "hor"},
     "knob": {"bg_color": "#ffffff", "border_color": "#ff6b3d", "border_width": 3, "shadow_color": "#ff6b3d", "shadow_width": 20, "shadow_opa": 180}},
    {"type": "lv_button", "name": "ok_btn", "align": "bottom_right", "x": -16, "y": -16, "w": 120, "h": 44,
     "text": "Heat on"}
  ] }
```

Render it with the MCP tool (`lvgl_render_ui` with `ui` = the object above,
`width` 320, `height` 240) or by hand:

```bash
simulator/prebuilt/linux-x64/lvgl_sim --ui ui.json --width 320 --height 240 \
  --output-png ui.png --output-json ui.json.out
```

A larger document with two screens, a multi-stop gradient card, a flex row
of checkable buttons and a fade-in animation is
[`examples/06-ui.json`](../examples/06-ui.json) (480x320, rendered as
[`examples/06-ui.png`](../examples/06-ui.png)). `lvgl_docs {topic: "ui-json"}`
returns this schema with three more examples (a card with a gradient and
glow, a flex list, two screens switched by an action).

## Document

The root object is the screen: a node (below) plus these optional top-level
keys.

| Key | Meaning |
|-----|---------|
| `theme` | `"light"` or `"dark"` (the default theme's mode) |
| `layer_top` | array of nodes created on `lv_layer_top()` (message boxes, overlays); they are part of the tree as `layer_top` |
| `animations` | `[{"target": "<name>", "prop": "x\|y\|w\|h\|opa\|value\|rotation", "from": N, "to": N, "duration": 500, "delay": 0, "repeat": 1 or "infinite", "playback": false, "path": "linear\|ease_in\|ease_out\|ease_in_out\|overshoot\|bounce\|step"}]`. `target`, `prop`, `from` and `to` are required; the defaults are shown. They start when the document is loaded, so `frames` and `settle` show the motion |
| `screens` + `active` | several screens: `{"screens": {"home": node, "settings": node}, "active": "home"}`. Each screen is named after its key (`name` may be omitted, or must equal the key) and its `type` may be omitted (screens are always `lv_obj`). `active` is the one loaded first (default: the first). With `screens`, no node keys are allowed at the top level. The action `{"load_screen": {"name": "settings", "anim": "move_left", "duration": 300}}` switches screens |

Only `type` is required on a node. **Unknown keys are errors**, so a typo never
passes silently (the message suggests the closest known key).

## Nodes

Keys every node accepts:

| Key | Value |
|-----|-------|
| `type` | `lv_obj`, `lv_label`, `lv_button`, `lv_image`, `lv_slider`, `lv_bar`, `lv_arc`, `lv_switch`, `lv_checkbox`, `lv_dropdown`, `lv_roller`, `lv_textarea`, `lv_spinner`, `lv_led`, `lv_line`, `lv_chart`, `lv_table`, `lv_buttonmatrix`, `lv_tabview`, `lv_msgbox`, `lv_spinbox`, `lv_scale`, `lv_list` |
| `name` | object name (`lv_obj_set_name`), unique in the document; used by actions, animations, diagnostics, annotations and `lvgl_diff` |
| `x`, `y` | integer px or `"N%"`; offsets from the `align` point when `align` is set |
| `w`, `h` | integer px, `"content"` or `"N%"` |
| `align` | `default`, `top_left`, `top_mid`, `top_right`, `left_mid`, `center`, `right_mid`, `bottom_left`, `bottom_mid`, `bottom_right` and the `out_*` variants (`out_top_left`, `out_bottom_mid`, `out_right_mid`, ...), relative to the parent |
| `hidden` | boolean |
| `states` | subset of `["checked", "disabled", "focused"]` |
| `flags` | `clickable`, `scrollable`, `checkable`, `floating`, `ignore_layout`, `hidden`, `overflow_visible`, `click_focusable`, `event_bubble`, `scroll_on_focus`, `scroll_elastic`, `scroll_momentum`, `snappable`, `press_lock`, `adv_hittest`; prefix with `-` to clear (e.g. `"-scrollable"`) |
| `layout` | `{"type": "flex", "flow": "row\|column\|row_wrap\|column_wrap\|row_reverse\|column_reverse\|row_wrap_reverse\|column_wrap_reverse", "main": "start\|end\|center\|space_between\|space_around\|space_evenly", "cross": "start\|end\|center", "track": "start\|end\|center\|space_*"}` (without `track`, the track is placed like `cross`), `{"type": "grid", "cols": [100, "fr1", "content"], "rows": [...], "col_align": "start\|center\|end\|stretch\|space_*", "row_align": ...}` (`cols` and `rows` required; tracks are px, `"frN"` or `"content"`), or `{"type": "none"}` |
| `grow` (alias `flex_grow`) | flex grow (0..255) on a child of a flex container |
| `cell` (alias `grid_cell`) | on a child of a grid: `{"col": 0, "col_span": 1, "row": 0, "row_span": 1, "x_align": "stretch\|start\|center\|end", "y_align": ...}` |
| `styles` | style properties of the main part, default state (keys below) |
| `indicator`, `knob`, `selected`, `items`, `cursor`, `scrollbar` | the same style keys for that part. On `lv_dropdown`/`lv_roller`, `selected` given as a **number** is the selected index and as an **object** the style block; on `lv_list`, `items` given as an **array** is the list content and as an **object** the style block |
| `styles_pressed`, `styles_checked`, `styles_disabled`, `styles_focused` | state variants of the main part; part blocks take the same suffixes (`indicator_checked`, `knob_pressed`, ...) |
| `children` | array of nodes (not on `lv_tabview`: use `tabs`) |

Widget-specific keys (anything else is an error):

| Type | Keys |
|------|------|
| `lv_obj` | none |
| `lv_label` | `text`, `long_mode` (`wrap`, `dots`, `scroll`, `scroll_circular`, `clip`) |
| `lv_button` | `text` (shortcut: adds a centred `lv_label` child) |
| `lv_image` | `src`: `"S:path.png"` (a file in `assets_dir`) or `"symbol:OK"` (`LV_SYMBOL_OK`; any `LV_SYMBOL_*` name: `SETTINGS`, `HOME`, `WIFI`, `BATTERY_FULL`, `BELL`, ...) |
| `lv_slider`, `lv_bar` | `value`, `min`, `max`, `anim` (bool, default false) |
| `lv_arc` | `value`, `min`, `max`, `rotation`, `bg_start_angle`, `bg_end_angle` |
| `lv_switch` | `checked` |
| `lv_checkbox` | `text`, `checked` |
| `lv_dropdown` | `options` (array of strings), `selected` (index) |
| `lv_roller` | `options` (array of strings), `selected` (index), `visible_rows`, `infinite` |
| `lv_textarea` | `text`, `placeholder`, `one_line`, `password`, `max_length` |
| `lv_spinner` | `duration` (ms per turn), `arc_length` (degrees) |
| `lv_led` | `color`, `brightness` (0..255), `on` |
| `lv_line` | `points`: `[[x, y], ...]` or `[{"x": .., "y": ..}, ...]` (at least 2) |
| `lv_chart` | `chart_type` (`line` or `bar`), `series` (`[{"color": "#rrggbb", "points": [10, 20, ...]}]`), `range` (`[min, max]` of the primary Y axis), `div_lines` (`[horizontal, vertical]`) |
| `lv_table` | `rows` (`[["cell", ...], ...]`), `col_widths` (`[px, ...]`) |
| `lv_buttonmatrix` | `map` (`["1", "2", "\n", "3", "4"]`; `"\n"` starts a new row) |
| `lv_tabview` | `tabs` (`[{"title": "..", "name": "..", "children": [..], "layout": {..}, "styles": {..}}]`), `tab_bar` (`top`, `bottom`, `left`, `right`), `tab_bar_size`, `active_tab` (index) |
| `lv_msgbox` | `title`, `text`, `close_button` (bool), `buttons` (`["OK", {"text": "Cancel", "name": "cancel_btn"}]`) |
| `lv_spinbox` | `value`, `min`, `max`, `digits`, `decimals`, `step` |
| `lv_scale` | `mode` (`horizontal_top`, `horizontal_bottom`, `vertical_left`, `vertical_right`, `round_inner`, `round_outer`), `min`, `max`, `total_ticks`, `major_every`, `labels` (bool), `angle_range`, `rotation` |
| `lv_list` | `items`: strings or `{"text": "..", "icon": "symbol:WIFI", "name": "..", "header": false}` (`header: true` adds a section title) |

## Style keys

Exactly the widget-tree names, plus the shorthands:

| Group | Keys |
|-------|------|
| Background | `bg_color`, `bg_opa`, `bg_grad_color`, `bg_grad_dir` (`hor`, `ver`, `none`), `bg_main_stop`, `bg_grad_stop`, `bg_main_opa`, `bg_grad_opa`, `bg_grad_stops` (2..8 stops `[{"color": "#rrggbb", "frac": 0..255, "opa": 0..255}]`; `frac` defaults to even spacing, direction from `bg_grad_dir`: `hor` or vertical) |
| Border, outline | `border_color`, `border_width`, `border_opa`, `border_side` (`full`, `top`, `bottom`, `left`, `right`, `none`), `outline_width`, `outline_color`, `outline_opa`, `outline_pad` |
| Shape | `radius` (integer or `"circle"`), `clip_corner` (bool) |
| Spacing | `pad_top`, `pad_bottom`, `pad_left`, `pad_right`, `pad_row`, `pad_column`, `margin_top`, `margin_bottom`, `margin_left`, `margin_right`; shorthands `pad_all`, `pad_hor`, `pad_ver`, `pad_gap` (row + column), `margin_all`, `margin_hor`, `margin_ver` (the tree reports the individual properties) |
| Shadow | `shadow_color`, `shadow_width`, `shadow_spread`, `shadow_opa`, `shadow_ofs_x`, `shadow_ofs_y` |
| Text | `text_color`, `text_opa`, `font` (`montserrat_8` ... `montserrat_48` in steps of 2, `montserrat_28_compressed`, `unscii_8`, `unscii_16`), `text_align` (`left`, `center`, `right`, `auto`), `text_letter_space`, `text_line_space`. `line_height` appears in the tree but is read-only (derived from the font): setting it is an error |
| Lines, arcs | `line_width`, `line_color`, `line_opa`, `line_rounded`, `arc_width`, `arc_color`, `arc_opa`, `arc_rounded` |
| Images | `image_opa`, `image_recolor`, `image_recolor_opa` |
| Size | `width`, `height` (px, `"N%"` or `"content"`), `min_width`, `max_width`, `min_height`, `max_height` (px or `"N%"`) |
| Transform | `opa`, `transform_rotation` (0.1 degree units), `transform_scale` (256 = 1.0; sets x and y), `transform_scale_x`, `transform_scale_y`, `transform_pivot_x`, `transform_pivot_y`, `translate_x`, `translate_y` |

Colours are `"#rrggbb"` or `"#rgb"`. Opacity is 0..255 or a percentage string
such as `"50%"`.

## Errors

A document with problems is not rendered. The simulator exits with code 5 and
prints one line per problem on stderr, all of them, sorted by JSON path (paths
start at the root node, without a `$.` prefix; `$` is the document itself, for
example a JSON syntax error):

```
ui: children[0].styles.radius: expected integer px or "circle"
ui: children[1].styles.line_height: "line_height" is read-only (derived from the font); remove it
ui: children[2].type: unknown widget "lv_meter" (known: lv_obj, lv_label, ...)
ui: children[3].txt: unknown key (did you mean "text"?) (lv_label keys: text, long_mode; common: ...)
```

`lvgl_render_ui` returns these lines as the tool error.
