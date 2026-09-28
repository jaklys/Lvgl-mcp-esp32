# Action scripts (`actions`, `lvgl_interact`, `lvgl_sim --actions`)

An action script is a JSON array of steps that the simulator runs after the
UI is created (C code, a project or a JSON UI document) and after `time_ms`
(330 ms by default) has passed, so the first action happens at 330 ms. Input
goes through real LVGL input devices, created before your UI code runs so
event callbacks, pressed/checked states, scrolling and focus behave as on the
device: a pointer device whenever actions are given, and a keypad device with
a default `lv_group` holding every focusable object when the script uses
`key`, `type` or `focus` (without them no group exists, so the theme's focus
styling does not change the picture).

Simulated time advances in 33 ms steps (one LVGL refresh period). Nothing
waits for wall-clock time. A click is press, 60 ms, release, then one 33 ms
step; `key`, `focus` and `load_screen` advance one step afterwards, `type` one
step after the last character.

```json
[
  {"capture": "start"},
  {"click": {"name": "ok_btn"}},
  {"wait": 300},
  {"capture": "after_click"},
  {"drag": {"from": {"name": "target"}, "to": {"x": 280, "y": 86}, "duration": 300}},
  {"key": "ENTER"},
  {"settle": 3000}
]
```

## Steps

| Step | Meaning |
|------|---------|
| `{"wait": N}` | advance N ms (0..60000) |
| `{"click": {"x": 10, "y": 20}}` | press, hold 60 ms, release at logical display coordinates |
| `{"click": {"name": "ok_btn"}}` | click the centre of the object with that name. Names resolve over the active screen, `layer_top` and `layer_sys`, in this order: an exact `lv_obj_set_name` name (or `name` in a UI document; with duplicate names in C code the first one in tree order wins), a `type#index` path as printed by the tree and diagnostics (e.g. `"lv_button#2"`), then `lv_obj_find_by_name()` |
| `{"press": {...}}` | press and keep holding (same target forms as `click`) |
| `{"release": {}}` | release a held press |
| `{"drag": {"from": T, "to": T, "steps": 10, "duration": 300}}` | press at `from`, move in `steps` steps over `duration` ms, release at `to`; `T` is `{"x", "y"}` or `{"name"}` |
| `{"key": "ENTER"}` | one key through the keypad device: `ENTER`, `ESC`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `NEXT`, `PREV`, `BACKSPACE`, `DEL`, `HOME`, `END`, or a single UTF-8 character such as `"a"` |
| `{"type": "hello"}` | type the characters one by one through the keypad |
| `{"focus": {"name": "..."}}` | focus that object in the default group (`lv_group_focus_obj`) |
| `{"capture": "label"}` | capture now: `capture-<n>-<label>.png` (plus `annotated-<n>-<label>.png` with `annotate`) and the widget tree at this moment |
| `{"settle": N}` | advance until no animation runs, at most N ms |
| `{"load_screen": {"name": "...", "anim": "fade", "duration": 300}}` | JSON UI documents with `screens`: load that screen. `anim`: `none`, `fade` (= `fade_in`), `fade_out`, `over_left`, `over_right`, `over_top`, `over_bottom`, `move_left`, `move_right`, `move_top`, `move_bottom`, `out_left`, `out_right`, `out_top`, `out_bottom` |

Captures are numbered from 1. The final state is **always** captured last
(label `final`) and is also the render's main PNG; the JSON `screen` is the
final tree, as in 2.1.0.

`frames: [0, 100, 300]` is shorthand for waits and captures at those
simulated times, measured from the moment the UI is built (ascending, up to
64, labels `t0`, `t100`, `t300`; `time_ms` and `settle` do not apply). The
final capture is still appended, so that gives four captures: `t0`, `t100`,
`t300` and `final` (at 300 ms). `frames` and `actions` cannot be combined: use
`wait` + `capture` steps instead. The whole script may advance at most 600 s
of simulated time.

## Result

- One image per capture (and its annotated overlay after it with
  `annotate`), then the text summary.
- `captures` in the JSON: `n`, `label`, `elapsed_ms`, `png`, `annotated`,
  and the full `screen` tree (plus `layer_top`) at that moment.
- `events`: LVGL events fired while the actions ran, at most 200
  (`events_dropped` counts the rest):
  `{"t_ms": 390, "event": "value_changed", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch", "value": true}`.
  Reported events: `pressed`, `released`, `clicked`, `value_changed` (with
  `value`: the new value of a slider/bar/arc/spinbox, the checked state, the
  selected index of a dropdown/roller/button matrix), `focused`, `defocused`,
  `screen_loaded`, `ready`, `cancel`. `name` falls back to the path for
  unnamed objects.
- `input`: `{"pointer": true, "keypad": true, "focused": "<name>" | null}`
  (`keypad` is false and `focused` null unless the script uses `key`, `type`
  or `focus`).

## Errors

Bad JSON, an unknown step or an object name that does not exist stop the run
with simulator exit code 6 and a message on stderr naming the failing step
(`actions[2]: ...`) and the problem; for an unknown name it lists the names
that exist (up to 20). The tools return it as the error text.
