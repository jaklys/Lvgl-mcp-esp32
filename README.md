# LVGL MCP Server for ESP32 Development

MCP (Model Context Protocol) server that gives Claude visual feedback when writing LVGL UI code for ESP32. It compiles C code snippets in a headless LVGL 9.6 simulator on Windows and Linux, captures a PNG screenshot and a JSON widget tree, and returns them through the MCP protocol. No hardware, no flashing, no SDL window needed.

```
┌─────────────┐     stdio (JSON-RPC)    ┌──────────────────┐
│  Claude Code │◄───────────────────────►│  MCP Server      │
│  (client)    │                         │  (Node.js)       │
└─────────────┘                          └────────┬─────────┘
                                                  │ compile + run
                                         ┌────────▼─────────┐
                                         │  LVGL Simulator   │
                                         │  (headless C)     │
                                         │  → PNG + JSON     │
                                         └──────────────────┘
```

## Quick start (npm)

1. Install the [prerequisites](#prerequisites). A C/C++ toolchain, CMake and Ninja (or Make) are **always** required: every render compiles your code against LVGL on your machine.
2. Register the server with Claude Code, inside your ESP32 project:

   ```bash
   claude mcp add lvgl-simulator -- npx -y lvgl-mcp-server@2
   ```

   Or commit a `.mcp.json` to the project root so everyone on the team gets it:

   ```json
   {
     "mcpServers": {
       "lvgl-simulator": {
         "command": "npx",
         "args": ["-y", "lvgl-mcp-server@2"]
       }
     }
   }
   ```

On install, npm runs a postinstall step that downloads the simulator sources matching the package version from GitHub Releases and verifies them against the release's `SHA256SUMS.txt`. You can also install globally with `npm install -g lvgl-mcp-server` and use `"command": "lvgl-mcp-server"`.

Done. Claude now has `lvgl_render`, `lvgl_render_full`, `lvgl_inspect`, `lvgl_check` and `lvgl_set_resolution`.

**Other MCP clients** use the same stdio command. Cursor (`.cursor/mcp.json`) takes the `mcpServers` shape above; VS Code (`.vscode/mcp.json`) uses:

```json
{
  "servers": {
    "lvgl-simulator": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lvgl-mcp-server@2"]
    }
  }
}
```

### Prerequisites

The toolchain is needed for every render, not only when building from source.

**Windows**

| Tool | Version | Notes |
|------|---------|-------|
| Windows | 10/11 x64 | No WSL required |
| Visual Studio or Build Tools | 2019, 2022 or 2026 (any edition) | "Desktop development with C++" workload (`cl.exe`, C and C++). Found automatically via `vswhere` |
| CMake | 3.16+ | From PATH, ESP-IDF, or the copy bundled with Visual Studio |
| Ninja | 1.10+ | From PATH, ESP-IDF, or the copy bundled with Visual Studio |
| Node.js | 20+ | For the MCP server |

If you have ESP-IDF installed, CMake and Ninja are already available.

**Linux**

| Tool | Version | Notes |
|------|---------|-------|
| Linux | x64 | Any modern distribution |
| gcc/g++ or clang/clang++ | recent | C **and** C++ compiler (LVGL 9.6 needs both); `cc` by default, override with `CC` |
| CMake | 3.16+ | Build configuration |
| Ninja or Make | any | Ninja preferred; falls back to Unix Makefiles |
| Node.js | 20+ | For the MCP server |

On Debian/Ubuntu:

```bash
sudo apt install build-essential cmake ninja-build git
```

**macOS (experimental)**: there is no prebuilt package yet, but the source setup works with the Xcode command line tools (`xcode-select --install`) and `brew install cmake ninja node`. Build from source as below and point `LVGL_SIM_PATH` at the checkout's `simulator/` directory.

### First render

The first render after installing (or after a toolchain change) configures CMake and compiles all of LVGL: about **10 s on Linux** and **30 s or more with MSVC**. After that only your code is recompiled and relinked, typically 1–3 s per render. The compile timeout is 180 s (`LVGL_COMPILE_TIMEOUT_MS`).

## Setup from source (alternative)

If you prefer to build from source instead of using npm:

### 1. Clone

```bash
git clone --recursive https://github.com/jaklys/Lvgl-mcp-esp32.git
cd Lvgl-mcp-esp32
```

If you already cloned without `--recursive`:
```bash
git submodule update --init --recursive
```

### 2. Build everything

The setup script validates the toolchain, builds the simulator (Release), builds the MCP server, runs a smoke test that fails the setup on error, and prints the MCP configuration.

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Or build manually:

```powershell
# Simulator (finds Visual Studio via vswhere and sets up the MSVC environment)
scripts\build.bat

# MCP server
cd mcp-server
npm ci --ignore-scripts
npm run build
```

Linux / macOS (bash):
```bash
./scripts/setup.sh
```

Or build manually:

```bash
# Simulator (cc/c++ by default; Ninja if available, else Make)
./scripts/build.sh

# MCP server
cd mcp-server
npm ci --ignore-scripts
npm run build
```

`--ignore-scripts` matters in a checkout: postinstall is meant for npm installs (it skips itself when it detects the checkout, but older versions did not).

### 3. Configure your MCP client

```bash
claude mcp add lvgl-simulator -- node /absolute/path/to/Lvgl-mcp-esp32/mcp-server/dist/index.js
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "lvgl-simulator": {
      "command": "node",
      "args": ["C:/Users/YOUR_USER/path/to/Lvgl-mcp-esp32/mcp-server/dist/index.js"]
    }
  }
}
```

Forward slashes work on Windows too. In a checkout the server finds `../simulator` next to `mcp-server/` automatically; set `LVGL_SIM_PATH` (see [Environment variables](#environment-variables)) to use a simulator directory somewhere else.

## Usage

Once configured, Claude has access to these MCP tools:

| Tool | Parameters | Purpose |
|------|------------|---------|
| `lvgl_render` | `code`, `width?`, `height?`, `time_ms?` (330), `settle?` (false), `rotation?` (0/90/180/270), `theme?` (`light`/`dark`), `dpi?` (130), `assets_dir?`, `include_tree?` (`summary`/`full`/`none`) | Render a snippet (body of `create_ui()`); returns PNG + summary |
| `lvgl_render_full` | same as `lvgl_render` | Render a complete C file that defines `void create_ui(void)` |
| `lvgl_inspect` | `code?`, `full?`, `type?`, `name?`, `max_depth?`, `include_styles?` (true) | Widget tree (of the last render when `code` is omitted), filterable |
| `lvgl_check` | `code`, `full?` (false) | Compile only, no run; structured diagnostics |
| `lvgl_set_resolution` | `width`, `height` | Set the **default** resolution for later calls (initially 800x480) |

`width`/`height` are integers from 16 to 4096 and apply to that call only; they are never sticky.

### `lvgl_render` — Render a code snippet

The main tool. Send LVGL C code and get back a screenshot. Your code runs inside a `create_ui()` function with a `screen` variable (`lv_obj_t*`) already available:

```
Use lvgl_render to show a button with a label:

lv_obj_t *btn = lv_button_create(screen);
lv_obj_set_size(btn, 200, 50);
lv_obj_center(btn);
lv_obj_t *label = lv_label_create(btn);
lv_label_set_text(label, "Click Me!");
lv_obj_center(label);
```

Returns:
- PNG screenshot of the rendered UI
- A summary line (size, simulated time, widget count, running animations)
- Compiler warnings as structured diagnostics (`snippet.c:LINE:COL`, lines match your snippet)
- LVGL warnings/errors from the log
- The widget tree: `summary` (default: counts by type, named widgets, hidden/overflowing/off-screen widgets), `full` (compact JSON, see [JSON output format](#json-output-format)) or `none`

Resolution per call:
```
Use lvgl_render with width=320 height=240 and code:
lv_obj_t *label = lv_label_create(screen);
lv_label_set_text(label, "Small display");
lv_obj_center(label);
```

About 330 ms of simulated time pass before the capture (`time_ms`); `settle=true` keeps going until animations finish (max 3 s). There are no input devices, so set states such as `LV_STATE_PRESSED` or `LV_STATE_CHECKED` in code to preview them. Images can be C arrays or `S:<file>` paths (PNG, BMP, JPEG) resolved against `assets_dir`.

Errors come back in plain words: compile errors with cleaned diagnostics, "timed out after N s (infinite loop?)", "crashed with SIGSEGV (NULL or deleted object?)" or "LVGL assertion failed: ...", each followed by the tail of the LVGL log.

### `lvgl_render_full` — Render a complete C file

For complex UIs with multiple functions, helper code, or custom includes. The file must define `void create_ui(void)` and is compiled verbatim (diagnostics reference `user_code.c`):

```c
#include "lvgl.h"

static void build_header(lv_obj_t *parent) {
    lv_obj_t *header = lv_obj_create(parent);
    lv_obj_set_size(header, lv_pct(100), 50);
    lv_obj_set_style_bg_color(header, lv_color_hex(0x003a57), 0);

    lv_obj_t *title = lv_label_create(header);
    lv_label_set_text(title, "My App");
    lv_obj_set_style_text_color(title, lv_color_white(), 0);
    lv_obj_center(title);
}

void create_ui(void) {
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
    build_header(screen);

    lv_obj_t *body = lv_label_create(screen);
    lv_label_set_text(body, "Content area");
    lv_obj_set_flex_grow(body, 1);
}
```

### `lvgl_inspect` — Get the widget tree

Returns the JSON widget tree: type, name, position, size, absolute coordinates, states, flags, computed styles and widget-specific data (label text, slider value/min/max, dropdown options, ...). Filter with `type` (e.g. `lv_button`), `name` (set with `lv_obj_set_name`, `*` wildcard) and `max_depth`; `include_styles=false` gives a much smaller tree.

```
Use lvgl_inspect with type="lv_label" on the last rendered UI
```

### `lvgl_check` — Compile without running

Compiles a snippet (or a full file with `full=true`) and returns the errors and warnings as structured diagnostics (`file`, `line`, `col`, `severity`, `message`). Faster than a render when you only want to know whether code builds.

### `lvgl_set_resolution` — Default display size

Sets the default used when a render call omits `width`/`height`:

```
Use lvgl_set_resolution with width=320 height=240
```

Common ESP32 display sizes:
- 320x240 (2.4" - 2.8" ILI9341/ST7789)
- 480x320 (3.5" ILI9488)
- 800x480 (5" - 7" displays, **default**)

### Resources

- `lvgl://api-reference` — LVGL 9.6 cheat sheet: widgets, styles, layouts, colors, symbols, "deprecated in 9.6 → replacement" notes, a v8 → v9 rename table and the simulator's constraints.
- `lvgl://project-config` — current configuration as JSON: default resolution, LVGL version, color format, timeouts, simulator/build paths and toolchain status.

### ESP32 compatibility

The simulator runs LVGL **9.6.0**, which is available in the ESP-IDF component registry as `lvgl/lvgl` 9.6.0 since September 2026. If your device firmware is still on 9.5, code that uses 9.6-only API (for example `lv_obj_set_hidden`) will not compile there; APIs deprecated in 9.6 still work in both. The simulator enables every Montserrat size from 8 to 48; on the device only the fonts enabled in its `lv_conf.h` exist.

## JSON output format

The simulator writes the widget tree as compact JSON, `format_version` 2 (pretty-printed here):

```json
{
  "format_version": 2,
  "lvgl_version": "9.6.0",
  "display": { "width": 320, "height": 240, "rotation": 0, "dpi": 130, "color_format": "XRGB8888", "theme": "light" },
  "elapsed_ms": 330,
  "anims_running": 0,
  "logs": [],
  "screen": {
    "type": "lv_obj",
    "x": 0, "y": 0, "w": 320, "h": 240,
    "abs": { "x1": 0, "y1": 0, "x2": 319, "y2": 239 },
    "flags": ["clickable", "scrollable"],
    "styles": { "bg_opa": 255, "bg_color": "#f5f5f5", "pad_row": 8, "pad_column": 8,
                "text_color": "#212121", "font": "montserrat_14", "line_height": 16 },
    "children": [
      {
        "type": "lv_button",
        "name": "ok_btn",
        "x": 100, "y": 68, "w": 120, "h": 44,
        "abs": { "x1": 100, "y1": 68, "x2": 219, "y2": 111 },
        "flags": ["clickable"],
        "styles": { "bg_opa": 255, "bg_color": "#2196f3", "radius": 7,
                    "pad_top": 8, "pad_bottom": 8, "pad_left": 13, "pad_right": 13,
                    "pad_row": 4, "pad_column": 4,
                    "text_color": "#ffffff", "font": "montserrat_14", "line_height": 16 },
        "children": [
          {
            "type": "lv_label",
            "x": 36, "y": 6, "w": 22, "h": 16,
            "abs": { "x1": 149, "y1": 82, "x2": 170, "y2": 97 },
            "flags": ["scrollable"],
            "text": "OK",
            "long_mode": "wrap",
            "styles": { "bg_opa": 0, "text_color": "#ffffff", "font": "montserrat_14", "line_height": 16 }
          }
        ]
      },
      {
        "type": "lv_slider",
        "x": 60, "y": 154, "w": 200, "h": 13,
        "abs": { "x1": 60, "y1": 154, "x2": 259, "y2": 166 },
        "flags": ["clickable"],
        "value": 40, "min": 0, "max": 100,
        "styles": { "bg_opa": 51, "bg_color": "#2196f3", "radius": 32767,
                    "text_color": "#2196f3", "font": "montserrat_14", "line_height": 16 },
        "indicator": { "bg_opa": 255, "bg_color": "#2196f3" },
        "knob": { "bg_opa": 255, "bg_color": "#2196f3" }
      }
    ]
  }
}
```

Top level: `display` (logical size after rotation), `elapsed_ms` (simulated time actually advanced), `anims_running` (animations still running at capture), `logs` (LVGL log lines, max 200), `screen`, and `layer_top`/`layer_sys` when those layers have children.

Every widget node can contain:

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

`styles` keys: `bg_color`, `bg_opa`, `border_color`, `border_width`, `radius`, `pad_top`, `pad_bottom`, `pad_left`, `pad_right`, `pad_row`, `pad_column`, `text_color`, `font`, `line_height`, `opa`. Trivial values are omitted (for example `bg_color` when `bg_opa` is 0, zero paddings). Colors are `#rrggbb`, opacity is 0–255. `font` is the built-in font name (`montserrat_8` … `montserrat_48`, `unscii_8`, `unscii_16`, …) or `custom`; `line_height` is in px.

> Changed in 2.1.0: format version 2 replaces the bare screen node, and `text_font_size` (which actually reported the line height) is replaced by `font` + `line_height`. See [CHANGELOG.md](CHANGELOG.md).

## Environment variables

Set these in the `env` block of your MCP client configuration.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LVGL_SIM_PATH` | auto | Simulator directory (contains `CMakeLists.txt`). Overrides auto-detection (npm package's `simulator/`, else `../simulator` in a checkout) |
| `LVGL_PROJECT_ROOT` | auto | Repository root that contains `simulator/` (older alternative to `LVGL_SIM_PATH`) |
| `LVGL_BUILD_DIR` | `<simulator>/build` | CMake build directory |
| `LVGL_ASSETS_DIR` | server working dir | Default directory for `S:` file paths (`assets_dir` parameter) |
| `LVGL_COMPILE_TIMEOUT_MS` | `180000` | Time limit for configure + build |
| `LVGL_RUN_TIMEOUT_MS` | `15000` | Time limit for one simulator run |
| `CC` | `cl` (Windows), `cc` (POSIX) | C compiler |
| `CMAKE_PATH` | PATH / ESP-IDF | Path to `cmake` |
| `NINJA_PATH` | PATH / ESP-IDF | Path to `ninja` |
| `LVGL_CMAKE_GENERATOR` | Ninja if found, else Unix Makefiles | CMake generator (POSIX) |
| `VCVARSALL_PATH` | found via `vswhere` | Path to `vcvarsall.bat` (Windows) |

Install-time only (postinstall):

| Variable | Purpose |
|----------|---------|
| `LVGL_SKIP_DOWNLOAD=1` | Do not download the simulator (e.g. you use `LVGL_SIM_PATH`) |
| `LVGL_FORCE_DOWNLOAD=1` | Download even when `CI` is set |
| `HTTPS_PROXY` / `https_proxy` / `npm_config_https_proxy`, `NO_PROXY` | Proxy for the download |

## Examples

The [examples/](examples/) directory contains rendered output from the MCP server — PNG screenshots and the corresponding JSON widget trees. They are regenerated with `node mcp-server/scripts/render-examples.mjs` against the simulator in the checkout.

### Demo renders

| Screenshot | JSON | Description |
|-----------|------|-------------|
| [01-button-slider.png](examples/01-button-slider.png) | [JSON](examples/01-button-slider.json) | Button + slider basic layout |
| [02-dashboard.png](examples/02-dashboard.png) | [JSON](examples/02-dashboard.json) | Multi-card dashboard |
| [04-esp32-small.png](examples/04-esp32-small.png) | [JSON](examples/04-esp32-small.json) | ESP32 status screen at 320x240 |

### E-BREW brewery control screens (real project)

All 8 screens from the [E-BREW](https://github.com/jaklys/New-EbrewDisplay) brewery controller rendered through the simulator at 800x480:

| Screenshot | JSON | Screen |
|-----------|------|--------|
| [ebrew-01-menu.png](examples/ebrew-01-menu.png) | [JSON](examples/ebrew-01-menu.json) | Main menu (3x2 tile grid) |
| [ebrew-02-overview.png](examples/ebrew-02-overview.png) | [JSON](examples/ebrew-02-overview.json) | Overview (temperatures + controls) |
| [ebrew-03-loading.png](examples/ebrew-03-loading.png) | [JSON](examples/ebrew-03-loading.json) | Loading splash screen |
| [ebrew-04-pump.png](examples/ebrew-04-pump.png) | [JSON](examples/ebrew-04-pump.json) | Pump control |
| [ebrew-05-control.png](examples/ebrew-05-control.png) | [JSON](examples/ebrew-05-control.json) | Relay switches |
| [ebrew-06-thermostats.png](examples/ebrew-06-thermostats.png) | [JSON](examples/ebrew-06-thermostats.json) | Thermostat settings |
| [ebrew-07-graphs.png](examples/ebrew-07-graphs.png) | [JSON](examples/ebrew-07-graphs.json) | Temperature graphs |
| [ebrew-08-sysinfo.png](examples/ebrew-08-sysinfo.png) | [JSON](examples/ebrew-08-sysinfo.json) | System info |

## How it works internally

1. Claude sends C code via `lvgl_render` (or `lvgl_render_full` / `lvgl_check`)
2. The MCP server wraps a snippet in a template (includes, `create_ui()` boilerplate and a `#line` directive so diagnostics point at your lines); full files are used verbatim
3. The code is written to `user_code.c` in the build directory
4. CMake/Ninja recompile only that file and relink against the already built LVGL library (the first build compiles LVGL itself)
5. The simulator binary (`lvgl_sim.exe` on Windows, `lvgl_sim` on Linux) runs headless with a minimal environment: it initializes LVGL with a framebuffer display, applies the theme, DPI and rotation, calls `create_ui()`, advances simulated time in 33 ms steps (`--time-ms`, optionally `--settle`), updates the layout, refreshes, and exports a PNG and the JSON widget tree into a fresh temporary directory
6. The MCP server reads both files, deletes the temporary directory, and returns the image with the summary, diagnostics, LVGL logs and tree

Renders are serialized, so parallel tool calls never share a build or output files. Compilation uses MSVC (`cl.exe`) on Windows — the Visual Studio environment is set up automatically — and gcc/clang on Linux.

The simulator can also be run by hand:

```bash
simulator/build/lvgl_sim --width 320 --height 240 --time-ms 330 --theme dark \
  --output-png out.png --output-json out.json
```

Options: `--width`, `--height` (16–4096), `--output-png`, `--output-json` (required), `--time-ms` (default 330; `--ticks N` = N × 33 ms), `--settle`, `--rotation 0|90|180|270`, `--theme light|dark`, `--dpi` (default 130), `--assets-dir`, `--help`. Exit codes: 0 ok, 1 bad arguments, 2 output write failed, 3 LVGL assertion; anything else is a crash in user code. LVGL log lines go to stderr, `printf` output of your code to stdout.

## Project structure

```
Lvgl-mcp-esp32/
├── simulator/                    Headless LVGL renderer (C)
│   ├── CMakeLists.txt            Build config (C + C++, Release, Ninja/Make, MSVC or gcc/clang)
│   ├── lv_conf.h                 LVGL config (XRGB8888, all widgets, fonts 8-48, decoders, S: drive)
│   ├── main.c                    CLI (see above), LVGL log capture, assert handler
│   ├── hal/
│   │   └── display_driver.c      Framebuffer-only display (no SDL/window)
│   ├── export/
│   │   ├── screenshot.c          Framebuffer → PNG (stb_image_write)
│   │   └── widget_tree.c         lv_obj tree → JSON (format v2)
│   ├── templates/
│   │   └── user_code_wrapper.c   Template for wrapping code snippets
│   └── lib/
│       ├── lvgl/                 LVGL v9.6.0 (git submodule)
│       └── stb/stb_image_write.h PNG encoder (single header)
├── mcp-server/                   MCP server (TypeScript)
│   ├── bin/lvgl-mcp-server.mjs   npx entry point
│   ├── scripts/
│   │   ├── postinstall.mjs       Downloads + verifies the matching simulator
│   │   └── render-examples.mjs   Regenerates examples/
│   ├── src/
│   │   ├── index.ts              Entry point, stdio transport
│   │   ├── tools/                lvgl_render(_full), lvgl_inspect, lvgl_check, lvgl_set_resolution
│   │   ├── simulator/            Toolchain detection, compile, run, diagnostics
│   │   └── resources/            lvgl://api-reference, lvgl://project-config
│   └── tests/                    unit, contract and e2e tests (node --test)
├── examples/                     Example renders (PNG + JSON)
├── scripts/
│   ├── setup.ps1 / build.bat     Windows: full setup / simulator build
│   ├── setup.sh / build.sh       Linux, macOS (experimental): full setup / simulator build
│   └── smoke-test.mjs            Simulator smoke test used by the setup scripts
├── .github/workflows/
│   ├── ci.yml                    Lint, unit + e2e tests (Linux, Windows), submodule pin, actionlint
│   └── release.yml               Tag → verify → build → GitHub release → npm
├── CHANGELOG.md
├── CONTRIBUTING.md
└── README.md
```

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| LVGL version | v9.6.0 | Git submodule (tag `v9.6.0`, branch `release/v9.6`) |
| Color format | XRGB8888 (32 bpp) | `simulator/lv_conf.h` |
| Display resolution | 800x480 | per call, `lvgl_set_resolution` default, or CLI args |
| Fonts | Montserrat 8–48 (even sizes), Montserrat 28 compressed, Unscii 8/16 | `simulator/lv_conf.h` |
| Image decoders | PNG, BMP, JPEG; file access via `S:` | `simulator/lv_conf.h` |
| All LVGL widgets, Flex + Grid | Enabled | `simulator/lv_conf.h` |
| LVGL log level | Warn | `simulator/lv_conf.h` |

## Security

Rendering compiles and runs arbitrary C code **locally, with your user's rights**. There is no sandbox: the code can read and write any file your account can. The simulator and build tools are started with a minimal, allow-listed environment (so your MCP client's secrets are not passed on), but that is not isolation. Only render code you would compile yourself, and use a container or VM if you need a hard boundary.

Downloads are pinned to the package version and verified with SHA-256; release archives also carry GitHub build provenance (`gh attestation verify <archive> --repo jaklys/Lvgl-mcp-esp32`), and npm packages are published with provenance.

## Release process

Maintainers, see also [CONTRIBUTING.md](CONTRIBUTING.md):

1. Bump `mcp-server/package.json` (`npm version X.Y.Z --no-git-tag-version` in `mcp-server/`) and move the `Unreleased` notes of `CHANGELOG.md` into a `## [X.Y.Z] - YYYY-MM-DD` section.
2. Merge to `main`, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The Release workflow then runs:
   - **verify-version** — the tag is `vX.Y.Z`, equals the `package.json` version, has a CHANGELOG section, and is neither released on GitHub nor published on npm yet
   - **build** (Linux, Windows) — Release build, smoke test, unit + e2e tests, slim source archive, and a check that the slim tree still builds
   - **create-release** — `SHA256SUMS.txt`, build provenance attestations, GitHub release with notes from the CHANGELOG
   - **publish-npm** — `npm publish --provenance`, only after the release exists (postinstall of the new version needs its assets)
4. If a late job fails (for example npm authentication), fix the cause and use **Re-run failed jobs**. `workflow_dispatch` with an existing tag re-runs the whole flow for a tag that has no release yet.

## Troubleshooting

**"No Visual Studio / Build Tools installation with the C++ x64 tools was found"** — Install "Build Tools for Visual Studio" (2019, 2022 or 2026) with the "Desktop development with C++" workload. Detection uses `vswhere.exe` (`%ProgramFiles(x86)%\Microsoft Visual Studio\Installer`); if yours is somewhere unusual, set `VCVARSALL_PATH`.

**"cl is not recognized"** — The MCP server and `scripts\build.bat` set up the MSVC environment themselves. If you run CMake by hand, use a "Developer PowerShell for VS" or run `scripts\build.bat`.

**"cc: command not found" / "no C++ compiler found" (Linux)** — Install `build-essential` (Debian/Ubuntu) or `gcc gcc-c++` (Fedora). LVGL 9.6 needs a C++ compiler too. Override the compiler with `CC`.

**"ninja: command not found" (Linux)** — Ninja is optional; the build falls back to Unix Makefiles. Install it with `sudo apt install ninja-build` for faster builds.

**"The current CMakeCache.txt directory ... is different"** — The checkout was moved or copied. The server and the build scripts detect this and wipe the stale cache; if you run CMake manually, delete `simulator/build/`.

**The first render is slow or times out** — The first build compiles all of LVGL (about 10 s on Linux, 30 s or more with MSVC, longer on slow disks or with antivirus scanning). Raise `LVGL_COMPILE_TIMEOUT_MS` if needed. Later renders only recompile your code.

**No simulator after installing with pnpm, bun, or `--ignore-scripts`** — These skip the postinstall step (pnpm 10 and bun block dependency install scripts by default). Allow it (`pnpm approve-builds`, bun `trustedDependencies`) or run it once by hand: `node node_modules/lvgl-mcp-server/scripts/postinstall.mjs` (global install: `npm rebuild -g lvgl-mcp-server`).

**postinstall download fails behind a proxy** — The download honors `HTTPS_PROXY`, `https_proxy`, `npm_config_https_proxy` and `NO_PROXY`. With a TLS-intercepting proxy, point Node at your company CA: `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Then retry with `npm rebuild lvgl-mcp-server`. The error message also lists the manual download + checksum steps.

**"checksum mismatch" or "no SHA256SUMS.txt"** — The download was corrupted or the release is incomplete; nothing was installed. Retry, or download and verify the archive manually as described in the message.

**Wrong colors in PNG** — LVGL uses XRGB8888, which is BGRA in memory on x86. The screenshot exporter handles the byte swizzle. If colors look wrong, check `simulator/export/screenshot.c`.

**The server cannot find the simulator** — Check the `[lvgl-mcp] Simulator directory:` line in the server's stderr and set `LVGL_SIM_PATH` to a directory containing the simulator's `CMakeLists.txt`.

## Author

[Jan Machaček](https://www.linkedin.com/in/jan-machacek-164255108)
