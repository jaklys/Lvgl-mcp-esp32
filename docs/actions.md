# Action scripts (`actions`, `lvgl_interact`, `lvgl_sim --actions`)

An action script is a JSON array of steps that the simulator runs after the
UI is created (C code, a project or a JSON UI document). Input goes through
real LVGL input devices: a pointer device and a keypad device with a default
`lv_group` holding every focusable object, both created before your UI code
runs, so event callbacks, pressed/checked states, scrolling and focus behave
as on the device.

Simulated time advances in 33 ms steps (one LVGL refresh period). Nothing
waits for wall-clock time.

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
| `{"wait": N}` | advance N ms |
| `{"click": {"x": 10, "y": 20}}` | press, hold 60 ms, release at logical display coordinates |
| `{"click": {"name": "ok_btn"}}` | click the centre of the object with that name (`lv_obj_set_name`, or `name` in a UI document). Also accepts the `type#index` paths the tree and diagnostics print, e.g. `"lv_button#2"` |
| `{"press": {...}}` | press and keep holding (same target forms as `click`) |
| `{"release": {}}` | release a held press |
| `{"drag": {"from": T, "to": T, "steps": 10, "duration": 300}}` | press at `from`, move in `steps` steps over `duration` ms, release at `to`; `T` is `{"x", "y"}` or `{"name"}` |
| `{"key": "ENTER"}` | one key through the keypad device: `ENTER`, `ESC`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `NEXT`, `PREV`, `BACKSPACE`, `DEL`, `HOME`, `END`, or a single UTF-8 character such as `"a"` |
| `{"type": "hello"}` | type the characters one by one through the keypad |
| `{"focus": {"name": "..."}}` | focus that object in the default group (`lv_group_focus_obj`) |
| `{"capture": "label"}` | capture now: `capture-<n>-<label>.png` (plus `annotated-<n>-<label>.png` with `annotate`) and the widget tree at this moment |
| `{"settle": N}` | advance until no animation runs, at most N ms |
| `{"load_screen": {"name": "...", "anim": "fade", "duration": 300}}` | JSON UI documents with `screens`: load that screen (`anim` like `fade`, `move_left`, ...) |

Captures are numbered from 1. The final state is **always** captured last
(label `final`) and is also the render's main PNG; the JSON `screen` is the
final tree, as in 2.1.0.

`frames: [0, 100, 300]` is shorthand for waits and captures at those
simulated times (ascending, labels `t0`, `t100`, `t300`).

## Result

- One image per capture (and its annotated overlay after it with
  `annotate`), then the text summary.
- `captures` in the JSON: `n`, `label`, `elapsed_ms`, `png`, `annotated`,
  and the full `screen` tree (plus `layer_top`) at that moment.
- `events`: LVGL events fired while the actions ran, at most 200:
  `{"t_ms": 93, "name": "ok_btn", "event": "clicked"}`. Reported events:
  clicked, value_changed, pressed, released, focused, screen_loaded.
- `input`: `{"pointer": true, "keypad": true, "focused": "<name>" | null}`.

## Errors

Bad JSON, an unknown step or an object name that does not exist stop the run
with simulator exit code 6 and a message on stderr naming the failing step
and the problem. The tools return it as the error text.
