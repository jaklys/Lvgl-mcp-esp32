# LVGL MCP Server for ESP32 Development

MCP (Model Context Protocol) server that gives Claude visual feedback when writing LVGL UI code for ESP32. It compiles C code snippets in a headless LVGL simulator on Windows, captures a PNG screenshot and a JSON widget tree, and returns them through the MCP protocol. No hardware, no flashing, no SDL window needed.

```
┌─────────────┐     stdio (JSON-RPC)    ┌──────────────────┐
│  Claude Code │◄───────────────────────►│  MCP Server      │
│  (client)    │                         │  (Node.js)       │
└─────────────┘                          └────────┬─────────┘
                                                  │ compile + run
                                         ┌────────▼─────────┐
                                         │  LVGL Simulator   │
                                         │  (headless, MSVC) │
                                         │  → PNG + JSON     │
                                         └──────────────────┘
```

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Windows | 10/11 | No WSL required |
| Visual Studio Build Tools | 2019+ | Only the C/C++ build tools workload (`cl.exe`) |
| CMake | 3.16+ | Included with ESP-IDF (`C:\Espressif\tools\cmake\`) |
| Ninja | 1.10+ | Included with ESP-IDF (`C:\Espressif\tools\ninja\`) |
| Node.js | 18+ | For the MCP server |
| Git | 2.x | For submodules |

If you have ESP-IDF installed, CMake and Ninja are already available.

## Setup

### 1. Clone

```powershell
git clone --recursive https://github.com/jaklys/Lvgl-mcp-esp32.git
cd Lvgl-mcp-esp32
```

If you already cloned without `--recursive`:
```powershell
git submodule update --init --recursive
```

### 2. Build everything

The setup script validates tools, builds the simulator, and builds the MCP server:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Or build manually:

```powershell
# Simulator (opens a VS Developer Command Prompt internally)
scripts\build.bat

# MCP server
cd mcp-server
npm install
npm run build
```

### 3. Configure Claude Code

Add the server to your Claude Code MCP settings. Open `.claude/settings.json` (project-level) or your global settings and add:

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

Replace the path with your actual project location. Forward slashes work on Windows.

You can also set the project root explicitly if the auto-detection doesn't work:

```json
{
  "mcpServers": {
    "lvgl-simulator": {
      "command": "node",
      "args": ["C:/Users/YOUR_USER/path/to/Lvgl-mcp-esp32/mcp-server/dist/index.js"],
      "env": {
        "LVGL_PROJECT_ROOT": "C:/Users/YOUR_USER/path/to/Lvgl-mcp-esp32"
      }
    }
  }
}
```

## Usage

Once configured, Claude has access to these MCP tools:

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
- JSON widget tree with full style information (see [JSON output format](#json-output-format))
- Render time

You can override the resolution per-call:
```
Use lvgl_render with width=320 height=240 and code:
lv_obj_t *label = lv_label_create(screen);
lv_label_set_text(label, "Small display");
lv_obj_center(label);
```

### `lvgl_render_full` — Render a complete C file

For complex UIs with multiple functions, helper code, or custom includes. The file must define `void create_ui(void)`:

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

Returns a JSON representation of every widget: type, position, size, computed styles, plus widget-specific data (label text, slider value/min/max, checkbox state, etc.).

```
Use lvgl_inspect on the last rendered UI
```

Example output:
```json
{
  "type": "obj",
  "x": 0, "y": 0, "w": 800, "h": 480,
  "styles": {
    "bg_color": "#ffffff", "bg_opa": 255,
    "text_color": "#212121", "text_font_size": 16,
    "border_width": 0, "border_color": "#000000",
    "radius": 0,
    "pad_top": 0, "pad_bottom": 0, "pad_left": 0, "pad_right": 0, "pad_gap": 11,
    "opa": 255
  },
  "children": [
    {
      "type": "btn",
      "x": 300, "y": 215, "w": 200, "h": 50,
      "styles": {
        "bg_color": "#2196f3", "bg_opa": 255,
        "text_color": "#ffffff", "text_font_size": 14,
        "border_width": 0, "border_color": "#000000",
        "radius": 12,
        "pad_top": 11, "pad_bottom": 11, "pad_left": 20, "pad_right": 20, "pad_gap": 4,
        "opa": 255
      },
      "children": [
        {
          "type": "label",
          "x": 56, "y": 14, "w": 87, "h": 21,
          "text": "Click Me!",
          "styles": { "text_color": "#ffffff", "text_font_size": 14, "..." : "..." }
        }
      ]
    }
  ]
}
```

### `lvgl_set_resolution` — Change display size

Match your target hardware:

```
Use lvgl_set_resolution with width=320 height=240
```

Common ESP32 display sizes:
- 320x240 (2.4" - 2.8" ILI9341/ST7789)
- 480x320 (3.5" ILI9488)
- 800x480 (5" - 7" displays, **default**)

### `lvgl://api-reference` — LVGL API cheat sheet

MCP resource with a quick reference for LVGL 9.2 widgets, styles, layouts, colors, and symbols. Claude can read this to write correct code without guessing.

## JSON output format

Every widget node in the JSON tree includes:

| Field | Description |
|-------|-------------|
| `type` | Widget class name (`obj`, `btn`, `label`, `slider`, `bar`, `arc`, `switch`, `checkbox`, `dropdown`, `textarea`, `chart`, `table`, ...) |
| `x`, `y` | Position relative to parent (pixels) |
| `w`, `h` | Size (pixels) |
| `styles` | Computed style properties (see below) |
| `text` | Label text (for `label` widgets) |
| `value` | Current value (for `slider`, `bar`, `arc`) |
| `min`, `max` | Range (for `slider`, `bar`, `arc`) |
| `checked` | State (for `checkbox`, `switch`) |
| `children` | Nested child widgets |

### Style properties

Every node includes a `styles` object with computed (resolved) values:

```json
{
  "bg_color": "#2196f3",
  "bg_opa": 255,
  "text_color": "#ffffff",
  "text_font_size": 16,
  "border_width": 2,
  "border_color": "#d4af37",
  "radius": 12,
  "pad_top": 10,
  "pad_bottom": 10,
  "pad_left": 20,
  "pad_right": 20,
  "pad_gap": 8,
  "opa": 255
}
```

Colors are in `#rrggbb` hex format. Opacity values range from 0 (transparent) to 255 (opaque). Font size is in pixels.

## Examples

The [examples/](examples/) directory contains rendered output from the MCP server — PNG screenshots and corresponding JSON widget trees.

### Demo renders

| Screenshot | JSON | Description |
|-----------|------|-------------|
| [01-button-slider.png](examples/01-button-slider.png) | [JSON](examples/01-button-slider.json) | Button + slider basic layout |
| [02-dashboard.png](examples/02-dashboard.png) | [JSON](examples/02-dashboard.json) | Multi-card dashboard |
| [03-esp32-small.png](examples/03-esp32-small.png) | [JSON](examples/03-inspect.json) | ESP32 status at 320x240 |
| [04-esp32-small.png](examples/04-esp32-small.png) | [JSON](examples/04-esp32-small.json) | ESP32 status (alternate) |

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

1. Claude sends C code via the `lvgl_render` tool
2. The MCP server wraps the snippet in a template (adds `#include "lvgl.h"` and `create_ui()` boilerplate)
3. The wrapped code is written to `simulator/build/user_code.c`
4. CMake incrementally recompiles only the changed file and links against the pre-built LVGL library
5. The resulting `lvgl_sim.exe` runs headless: initializes LVGL, creates a framebuffer display, calls `create_ui()`, ticks the timer 10 times, then exports a PNG and a JSON widget tree
6. The MCP server reads the PNG, base64-encodes it, and returns it alongside the widget tree

Compilation uses MSVC (`cl.exe`) via a temporary batch file that sets up the Visual Studio environment. Incremental builds only recompile the user code file (~1-2 seconds).

## Project structure

```
Lvgl-mcp-esp32/
├── simulator/                    Headless LVGL renderer (C)
│   ├── CMakeLists.txt            Build config (Ninja + MSVC)
│   ├── lv_conf.h                 LVGL config (32bpp, all widgets, snapshot)
│   ├── main.c                    CLI: --width --height --output-png --output-json
│   ├── hal/
│   │   └── display_driver.c      Framebuffer-only display (no SDL/window)
│   ├── export/
│   │   ├── screenshot.c          Framebuffer → PNG (stb_image_write)
│   │   └── widget_tree.c         lv_obj tree → JSON (with styles)
│   ├── templates/
│   │   └── user_code_wrapper.c   Template for wrapping code snippets
│   └── lib/
│       ├── lvgl/                  LVGL v9.2 (git submodule)
│       └── stb/stb_image_write.h PNG encoder (single header)
├── mcp-server/                   MCP server (TypeScript)
│   └── src/
│       ├── index.ts              Entry point, stdio transport
│       ├── tools/
│       │   ├── render.ts         lvgl_render + lvgl_render_full
│       │   ├── inspect.ts        lvgl_inspect + lvgl_get_styles
│       │   └── config.ts         lvgl_set_resolution
│       ├── simulator/
│       │   ├── compiler.ts       Invokes CMake/MSVC, manages user code
│       │   └── manager.ts        Orchestrates compile → run → collect
│       └── resources/
│           └── api-reference.ts  LVGL API cheat sheet
├── examples/                     Example renders (PNG + JSON)
│   ├── 01-button-slider.*        Basic widget demo
│   ├── 02-dashboard.*            Multi-card layout
│   └── ebrew-01..08-*.*          E-BREW brewery controller (8 screens)
├── .github/workflows/
│   ├── ci.yml                    CI: build + test on push/PR
│   └── release.yml               Release: build + package on v* tag
├── scripts/
│   ├── setup.ps1                 Full setup (validate tools, build all)
│   └── build.bat                 Quick rebuild (simulator only)
└── README.md
```

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| LVGL version | v9.2 | Git submodule branch |
| Color depth | 32-bit (XRGB8888) | `simulator/lv_conf.h` |
| Display resolution | 800x480 | `lvgl_set_resolution` tool or CLI args |
| Available fonts | Montserrat 12, 14, 16, 20, 24 | `simulator/lv_conf.h` |
| All LVGL widgets | Enabled | `simulator/lv_conf.h` |
| Flex + Grid layouts | Enabled | `simulator/lv_conf.h` |

## Troubleshooting

**"CMake configure failed"** — Make sure Visual Studio Build Tools are installed with the "Desktop development with C++" workload. The setup script looks for `vcvarsall.bat` in standard VS 2019/2022 paths.

**"cl is not recognized"** — The MCP server sets up the MSVC environment automatically via `vcvarsall.bat`. If you're building manually, run `scripts\build.bat` which handles this.

**Render takes >5 seconds** — The first render after server start includes CMake configuration (~1s extra). Subsequent renders are incremental (recompile user_code.c only).

**Wrong colors in PNG** — LVGL uses XRGB8888 which is BGRA in memory on x86. The screenshot exporter handles the byte swizzle. If colors look wrong, check `simulator/export/screenshot.c`.

**"ENOENT: no such file or directory"** — The `LVGL_PROJECT_ROOT` environment variable may be needed. Set it in your MCP server config to the absolute path of the project root.
