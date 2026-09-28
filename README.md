# LVGL MCP Server for ESP32 Development

MCP (Model Context Protocol) server that gives an AI assistant everything it needs to see and understand the LVGL UI it writes for ESP32. It renders C snippets, whole UI projects or declarative JSON UI documents in a headless LVGL 9.6 simulator on Windows, macOS (Apple Silicon and Intel) and Linux, and returns screenshots, annotated layout overlays, frame sequences and interaction captures, the widget tree as JSON, measured problems (clipped labels, missing glyphs, low contrast, overlaps, memory over the device budget, fonts the device does not have) and pixel/object diffs between renders. No hardware, no flashing, no SDL window needed.

```
┌─────────────┐     stdio (JSON-RPC)    ┌──────────────────┐
│  Claude Code │◄───────────────────────►│  MCP Server      │
│  (client)    │                         │  (Node.js)       │
└─────────────┘                          └────────┬─────────┘
                                                  │ compile (C) or
                                                  │ interpret (JSON UI) + run
                                         ┌────────▼─────────┐
                                         │  LVGL Simulator   │
                                         │  (headless C)     │
                                         │  → PNGs + JSON    │
                                         └──────────────────┘
```

## Quick start (npm)

1. Install the [prerequisites](#prerequisites). A C/C++ toolchain, CMake and Ninja (or Make) are required to render C code, which is compiled against LVGL on your machine. JSON UI documents ([`lvgl_render_ui`](#render-ui-from-json-no-toolchain-needed)) render without any toolchain.
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

On install, npm runs a postinstall step that downloads the simulator matching the package version from GitHub Releases and verifies it against the release's `SHA256SUMS.txt`. The archive contains the simulator and LVGL sources plus a [prebuilt LVGL library and `lvgl_sim` binary](#prebuilt-lvgl) for your platform. You can also install globally with `npm install -g lvgl-mcp-server` and use `"command": "lvgl-mcp-server"`.

Done. Claude now has the tools listed under [Usage](#usage).

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

The toolchain is needed for every render of C code (`lvgl_render`, `lvgl_render_full`, `lvgl_render_project`, `lvgl_check`), not only when building from source. `lvgl_render_ui` only needs Node.js and the installed simulator.

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
| Linux | x64 (arm64 should work but is untested and has no prebuilt LVGL) | Any modern distribution |
| gcc/g++ or clang/clang++ | recent | C **and** C++ compiler (LVGL 9.6 needs both); `cc` by default, override with `CC` |
| CMake | 3.16+ | Build configuration |
| Ninja or Make | any | Ninja preferred; falls back to Unix Makefiles |
| Node.js | 20+ | For the MCP server |

On Debian/Ubuntu:

```bash
sudo apt install build-essential cmake ninja-build git
```

**macOS**

| Tool | Version | Notes |
|------|---------|-------|
| macOS | 12 or later, Apple Silicon or Intel | Both are built and tested in the release pipeline; Apple Silicon on every CI run, Intel on an informational CI job |
| Xcode Command Line Tools | recent | `xcode-select --install`: Apple clang (C **and** C++) and `make`. A full Xcode works too |
| CMake | 3.16+ | `brew install cmake` (or the cmake.org app) |
| Ninja or Make | any | `brew install ninja` recommended; falls back to Unix Makefiles |
| Node.js | 20+ | `brew install node` or [nodejs.org](https://nodejs.org/) |

```bash
xcode-select --install
brew install cmake ninja node
```

MCP clients started from the Dock (Claude Desktop, VS Code, Cursor) do not see your shell's `PATH`. The server therefore also looks for `cmake` and `ninja` in `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` and `/Applications/CMake.app`; set `CMAKE_PATH` / `NINJA_PATH` if yours are elsewhere.

### First render

With the npm package, the first render of C code configures CMake and links the prebuilt LVGL library: a few seconds. If the prebuilt library cannot be used (you changed `lv_conf.h`, or your MSVC is older than the one that built it), LVGL is compiled once from source instead: about **10–30 s on Linux and macOS** and **30 s or more with MSVC**. After that only your code is recompiled and relinked, typically 1–3 s per render. The compile timeout is 180 s (`LVGL_COMPILE_TIMEOUT_MS`). JSON UI renders never compile anything.

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

Optionally build the [prebuilt LVGL](#prebuilt-lvgl) for your checkout with `./scripts/build-prebuilt.sh` (Windows: `scripts\build-prebuilt.ps1` from a Developer PowerShell for VS).

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
| `lvgl_render` | `code` + [common render parameters](#common-render-parameters) | Render a snippet (body of `create_ui()`); returns one image per capture + summary, diagnostics, tree |
| `lvgl_render_full` | same as `lvgl_render` | Render a complete C file that defines `void create_ui(void)` |
| `lvgl_render_ui` | `ui` (JSON UI document) + common (all except `esp_shims`) | Render a [JSON UI document](#render-ui-from-json-no-toolchain-needed): no C code, no compilation, no toolchain |
| `lvgl_render_project` | `files` (`[{path, content}]`) or `root` (directory), `include_dirs?`, `defines?`, `exclude?` (globs), `entry?` (`ui_init`), `esp_shims?` (true) + common | Compile and render a whole UI project (all `.c`/`.cpp` files) by calling `entry()` |
| `lvgl_interact` | `actions` (required) and one of `code` (+ `full?`), `ui`, or `files`/`root` (+ `include_dirs?`, `defines?`, `exclude?`, `entry?`) + common | Render with an [action script](#seeing-more-captures-annotate-frames) (clicks, keys, drags); one image per capture |
| `lvgl_diff` | `a`, `b` (render ids such as `r3`), `threshold?` (0) | Pixel diff (count, %, bounding box, diff image) and object diff (added, removed, moved, resized, text/style changes) between two renders |
| `lvgl_inspect` | `code?`, `full?`, `render_id?`, `type?`, `name?`, `max_depth?`, `include_styles?` (true) | Widget tree (of the last render, or of `render_id`), filterable |
| `lvgl_check` | `code`, `full?` (false) | Compile only, no run; structured diagnostics |
| `lvgl_docs` | `topic` | LVGL 9.6 reference text: `simulator`, `widgets` (index) and `widgets/<name>` (34 widgets), `layouts`, `styles`, `events`, `anim`, `fonts`, `symbols`, `v8-migration`, `actions`, `ui-json`, `diagnostics`, `esp32`, `boards` |
| `lvgl_set_resolution` | `width`, `height` | Set the **default** resolution for later calls (initially 800x480) |

Every render gets an id (`r1`, `r2`, ...; the last 20 are kept in memory) for `lvgl_diff` and `lvgl_inspect`.

### Common render parameters

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `width`, `height` | `lvgl_set_resolution` default | 16–4096 px; this call only, never sticky |
| `board` | none | [Board preset](#boards): sets resolution, colour format, DPI, rotation and memory budget; explicit parameters override it |
| `time_ms`, `settle` | 330, false | Simulated time before the final capture; `settle` keeps going until animations finish (max 3 s) |
| `rotation`, `theme`, `dpi` | 0, `light`, 130 | Display rotation (0/90/180/270), default theme, DPI |
| `color_format` | `xrgb8888` | `rgb565` renders through a real RGB565 buffer (banding like the device) |
| `scale` | 1 | 1–4, nearest-neighbour upscale of every image (tree coordinates stay logical) |
| `annotate` | false | Also return an overlay image per capture: object outlines coloured by depth, with names |
| `frames` | none | Capture at these simulated times after the UI is built, e.g. `[0, 150, 300]`; the final state is captured last as well (4 images) |
| `actions` | none | [Action script](docs/actions.md): input and captures |
| `fonts` | no restriction | Fonts enabled on the device, e.g. `["montserrat_14", "montserrat_20"]`; others are flagged `FONT_NOT_ON_DEVICE` |
| `mem_budget_kb` | none | The device's `LV_MEM_SIZE`; peak LVGL heap use above it is flagged `MEM_OVER_BUDGET` |
| `esp_shims` | false (true for `lvgl_render_project`) | Include the [ESP-IDF shim](#esp-idf-shims-and-simh) so firmware code compiles unchanged |
| `assets_dir` | `LVGL_ASSETS_DIR` / server working dir | Directory for `S:` image and font paths |
| `include_tree` | `summary` | `summary`, `full` (compact JSON) or `none` in the text result |

### `lvgl_render` — Render a code snippet

The main tool. Send LVGL C code and get back a screenshot. Your code runs inside a `create_ui()` function with a `screen` variable (`lv_obj_t*`) already available:

```
Use lvgl_render with width=320 height=240 to show a button with a label:

lv_obj_t *btn = lv_button_create(screen);
lv_obj_set_name(btn, "ok_btn");
lv_obj_set_size(btn, 200, 50);
lv_obj_center(btn);
lv_obj_t *label = lv_label_create(btn);
lv_label_set_text(label, "Click Me!");
lv_obj_center(label);
```

Returns:
- The PNG of each capture (plus the annotated overlay after it with `annotate`)
- A summary line (size, simulated time, widget count, running animations)
- [Diagnostics](#understanding-more-diagnostics-memory-device-fonts-boards), grouped by severity, each with the object's name/path and a message with numbers
- The memory line (`LVGL heap peak 71 KB / budget 64 KB`), the fonts used, and the events fired by actions
- Compiler warnings as structured diagnostics (`snippet.c:LINE:COL`, lines match your snippet)
- LVGL warnings/errors from the log
- The widget tree: `summary` (default: counts by type, named widgets, hidden/overflowing/off-screen widgets), `full` (compact JSON, see [JSON output format](#json-output-format)) or `none`

`structuredContent` carries everything, including the `render_id`. Name your objects with `lv_obj_set_name()`: diagnostics, actions and diffs then refer to them by name. Images can be C arrays or `S:<file>` paths (PNG, BMP, JPEG) resolved against `assets_dir`.

Errors come back in plain words: compile errors with cleaned diagnostics, "timed out after N s (infinite loop?)", "crashed with SIGSEGV (NULL or deleted object?)" or "LVGL assertion failed: ...", each followed by the tail of the LVGL log.

### `lvgl_render_full` — Render a complete C file

For UIs with multiple functions, helper code, or custom includes. The file must define `void create_ui(void)` and is compiled verbatim (diagnostics reference `user_code.c`):

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

### `lvgl_inspect`, `lvgl_check`, `lvgl_set_resolution`, `lvgl_docs`

- **`lvgl_inspect`** returns the JSON widget tree: type, name, position, size, absolute coordinates, states, flags, computed styles and widget-specific data (label text, slider value/min/max, dropdown options, ...). Filter with `type` (e.g. `lv_button`), `name` (`*` wildcard) and `max_depth`; `include_styles=false` gives a much smaller tree; `render_id` picks an earlier render.
- **`lvgl_check`** compiles a snippet (or a full file with `full=true`) and returns errors and warnings as structured diagnostics (`file`, `line`, `col`, `severity`, `message`). Faster than a render when you only want to know whether code builds.
- **`lvgl_set_resolution`** sets the default used when a render call omits `width`/`height` (320x240 for 2.4"–2.8" ILI9341/ST7789, 480x320 for 3.5" ILI9488, 800x480 for 5"–7" panels, the default). A [`board`](#boards) preset is usually more precise.
- **`lvgl_docs`** returns focused reference text for one topic, so the assistant can look up an API instead of guessing it. The same content is available as resources.

### Resources

- `lvgl://api-reference` — LVGL 9.6 cheat sheet: widgets, styles, layouts, colors, symbols, "deprecated in 9.6 → replacement" notes, a v8 → v9 rename table and the simulator's constraints.
- `lvgl://project-config` — current configuration as JSON: default resolution, LVGL version, color format, timeouts, simulator/build paths, toolchain and prebuilt status.
- `lvgl://boards` — the [board presets](#boards) as JSON (the same data as `lvgl_docs {topic: "boards"}`).

## Seeing more (captures, annotate, frames)

One screenshot of the final state hides most of what goes wrong in embedded UIs: animations, pressed states, what happens after a tap, and which box is which. Every render can return more than one image:

- **`frames: [0, 150, 300]`** captures the screen at those simulated times (measured from the moment the UI is built) and then the final state, so four images: an animation or a screen transition as a strip of images.
- **`annotate: true`** adds an overlay image per capture with a 1 px outline around every visible object, coloured by depth, and its name (or `type#index` path). Padding, alignment and overlaps become visible at a glance. The overlay is drawn on LVGL's system layer and removed again, so the widget tree is unaffected.
- **`actions`** (or `lvgl_interact`) drives real LVGL input devices after `time_ms` has passed, a pointer and (when the script uses `key`, `type` or `focus`) a keypad with a default group, so event callbacks, states, scrolling and focus behave as on the device:

  ```json
  [{"click": {"name": "ok_btn"}}, {"wait": 300}, {"capture": "after_click"},
   {"drag": {"from": {"name": "target"}, "to": {"x": 280, "y": 86}}}, {"key": "ENTER"}]
  ```

  Steps: `wait`, `click`/`press`/`release`/`drag` (by coordinates or object name), `key`, `type`, `focus`, `capture`, `settle`, and `load_screen` for JSON UI documents. The final state is always captured last. The result lists the LVGL events fired (`pressed`, `clicked`, `value_changed` with the new `value`, `focused`, `screen_loaded`, ...). Full reference: [docs/actions.md](docs/actions.md).
- **`scale: 2`** (1–4) upscales images of small displays so details stay readable; coordinates in the tree stay logical.
- **`color_format: "rgb565"`** renders through an RGB565 buffer, so gradients band like they do on most ESP32 panels.
- **`lvgl_diff {a: "r3", b: "r4"}`** compares two renders: changed pixels (count, percentage, bounding box, and an image with changes in magenta over a dimmed base) and changed objects by name/path (added, removed, moved with old → new rectangle, resized, text and style changes). Use it to check that a fix changed only what it should.

## Understanding more (diagnostics, memory, device fonts, boards)

The simulator measures the finished UI and reports problems it can prove, with numbers, so the assistant does not have to guess from pixels.

**Diagnostics.** Each has a code, a severity, the object's name/path and absolute rectangle, and a message such as `label text 'Living room temperature' needs 204 px, has 160 px (long_mode clip)`. Hidden objects are not checked.

| Code | Severity | Reported when |
|------|----------|---------------|
| `LABEL_CLIPPED` | warn | a label in a single-line long mode (`clip`, `dots`, `scroll`, `scroll_circular`) has text wider than its content box |
| `TEXT_OVERFLOW` | warn | wrapped text is taller than the content box (or has a word wider than it); other modes: text taller than the box |
| `MISSING_GLYPH` | error | a character is not in the font (a placeholder box is drawn) |
| `OFF_SCREEN` | warn | a direct child of the screen (or `layer_top`) is partly or fully outside the display |
| `OUTSIDE_PARENT` | warn | a deeper object extends beyond its plain `lv_obj`/`lv_button` parent in a direction the parent cannot scroll |
| `OVERLAP` | info | two visible siblings partly overlap (one fully inside the other does not count) and the parent has no layout |
| `LOW_CONTRAST` | warn | label text vs. the background composed under it has a WCAG contrast ratio below 3.0 (once per colour pair) |
| `SMALL_TOUCH_TARGET` | info | on a display with DPI <= 160, a button's click area is below 40 px in width or height (other input widgets: in both) |
| `ZERO_SIZE` | warn | a visible object has width or height 0 |
| `FONT_NOT_ON_DEVICE` | error | an object uses a font the device does not enable (`fonts`) |
| `MEM_OVER_BUDGET` | error | LVGL's peak heap use exceeds the device budget (`mem_budget_kb`) |
| `HIDDEN_CLICKABLE` | info | a touch target is fully transparent (`opa` 0) but still clickable |
| `ANIM_UNFINISHED` | info | finite animations were still running at the final capture |
| `APP_LOOP_DETECTED` | info | firmware-style `while (1)` loop detected; the simulator left it after 5 s of simulated time and captured |

Meaning and typical fix for each: [docs/diagnostics.md](docs/diagnostics.md).

**Memory.** The simulator runs LVGL with its built-in allocator and reports peak and current heap use and fragmentation (`mem` in the JSON, a `LVGL heap peak 71 KB / budget 64 KB` line in the text). Pass the device's `LV_MEM_SIZE` as `mem_budget_kb` (or pick a board) to find out before flashing whether the screen fits.

**Device fonts.** The simulator enables every Montserrat size from 8 to 48; your firmware probably enables two or three. Pass them as `fonts` and every object using another font is flagged `FONT_NOT_ON_DEVICE`; `fonts_used` lists what the screen actually uses.

### Boards

`board` applies a preset for a common ESP32 display board: resolution, colour format, DPI, default rotation and typical `LV_MEM_SIZE` budget. Explicit parameters override the preset. The presets are defined in `mcp-server/src/boards.ts` (the single source of truth, including the values not shown here); this table is generated from it.

<!-- generated from mcp-server/src/boards.ts by mcp-server/scripts/gen-boards-md.mjs --write; do not edit by hand -->
<!-- BOARDS:BEGIN -->
| id | Board | Resolution | Color | DPI | Rotation | LV_MEM_SIZE | Panel | Notes |
|---|---|---|---|---|---|---|---|---|
| `esp32-2432s028r` | ESP32-2432S028R "Cheap Yellow Display" 2.8" | 320x240 | RGB565 | 143 | 0 | 48 KB | ILI9341 (SPI), XPT2046 resistive touch | ESP32-WROOM, no PSRAM: keep the LVGL heap small, 1/10-screen draw buffers. |
| `esp32-8048s070` | Sunton ESP32-8048S070 7" | 800x480 | RGB565 | 133 | 0 | 64 KB | 16-bit RGB parallel TFT, GT911 capacitive touch | ESP32-S3 with 8 MB PSRAM; framebuffers in PSRAM. |
| `wt32-sc01-plus` | Wireless-Tag WT32-SC01 Plus 3.5" | 480x320 | RGB565 | 165 | 0 | 64 KB | ST7796 (8-bit parallel), FT6336U capacitive touch | ESP32-S3 with 2 MB PSRAM. |
| `lilygo-t-display-s3` | LILYGO T-Display-S3 1.9" | 320x170 | RGB565 | 190 | 0 | 64 KB | ST7789 (8-bit parallel), optional touch | Native panel is 170x320 portrait; most UIs rotate to landscape. Two buttons, often no touch. |
| `lilygo-t-display` | LILYGO T-Display 1.14" | 135x240 | RGB565 | 241 | 0 | 48 KB | ST7789 (SPI) | Classic ESP32, no touch (two buttons): design for keypad/encoder navigation. |
| `m5stack-core2` | M5Stack Core2 2.0" | 320x240 | RGB565 | 200 | 0 | 64 KB | ILI9342C (SPI), FT6336U capacitive touch | ESP32 with 8 MB PSRAM; three touch buttons below the screen. |
| `m5stack-cores3` | M5Stack CoreS3 2.0" | 320x240 | RGB565 | 200 | 0 | 64 KB | ILI9342C (SPI), FT6336U capacitive touch | ESP32-S3 with 8 MB PSRAM. |
| `waveshare-esp32-s3-touch-lcd-1.28` | Waveshare ESP32-S3-Touch-LCD-1.28 (round) | 240x240 | RGB565 | 265 | 0 | 48 KB | GC9A01 round (SPI), CST816S capacitive touch | Round panel: the corners of the 240x240 square are not visible - keep content inside the circle. |
| `esp32-s3-box-3` | Espressif ESP32-S3-BOX-3 2.4" | 320x240 | RGB565 | 167 | 0 | 64 KB | ILI9342C (SPI), capacitive touch | ESP32-S3 with 16 MB flash / 16 MB PSRAM; esp_lvgl_port based BSP. |
| `esp32-c3-0.42-oled` | ESP32-C3 0.42" OLED dev board | 72x40 | RGB565 | 196 | 0 | 32 KB | SSD1306 72x40 monochrome (I2C) | Monochrome panel: rendered as RGB565 here - use only black/white and high contrast; no touch. |
| `ssd1306-128x64` | SSD1306 0.96" OLED 128x64 | 128x64 | RGB565 | 149 | 0 | 32 KB | SSD1306 monochrome (I2C/SPI) | Monochrome panel: rendered as RGB565 here - use only black/white, small fonts (unscii_8, montserrat_10); no touch. |
| `st7735-160x80` | ST7735 0.96" IPS 160x80 | 160x80 | RGB565 | 186 | 0 | 32 KB | ST7735S (SPI) | Tiny color panel, no touch. |
| `generic-320x240` | Generic 320x240 (QVGA) | 320x240 | RGB565 | 130 | 0 | 64 KB | any 2.4"-3.2" SPI panel (ILI9341, ST7789) | LVGL's default DPI. |
| `generic-480x320` | Generic 480x320 (HVGA) | 480x320 | RGB565 | 130 | 0 | 64 KB | any 3.5" panel (ILI9488, ST7796) | LVGL's default DPI. |
| `generic-800x480` | Generic 800x480 (WVGA) | 800x480 | RGB565 | 130 | 0 | 64 KB | any 4.3"-7" RGB parallel panel | LVGL's default DPI. |
<!-- BOARDS:END -->

## Less friction (JSON UI without a toolchain, prebuilt LVGL, render_project, ESP-IDF shims)

### Render UI from JSON, no toolchain needed

`lvgl_render_ui` takes a JSON UI document instead of C code. The simulator binary interprets it at run time and makes the matching LVGL calls: nothing is compiled, so it works on a machine with no compiler, CMake or Ninja, using the prebuilt `lvgl_sim` from the npm install. The vocabulary is the one every render returns in its widget tree (same widget types, `name`, `x`/`y`/`w`/`h`, `align`, the same `styles` keys and part blocks such as `indicator` and `knob`), so the assistant reads and writes one language, and a UI-mode render round-trips: what the document sets comes back in the tree with the same values.

A minimal document (the larger example with two screens, a gradient card and an animation is [`examples/06-ui.json`](examples/06-ui.json), rendered as [`examples/06-ui.png`](examples/06-ui.png)):

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

```
Use lvgl_render_ui with width=320 height=240 and ui = <the document above>
```

Documents also support flex and grid layouts, state variants (`styles_pressed`, `indicator_checked`, ...), widget data (`chart_type` + `series` for `lv_chart`, `rows` for `lv_table`, `tabs` for `lv_tabview`, `items` for `lv_list`, ...), animations, `layer_top` and several screens switched by a `load_screen` action. Unknown keys are errors, and all problems are reported at once with their JSON path (`children[2].type: unknown widget "lv_meter"`). Diagnostics, `annotate`, `frames` and `actions` work exactly as for C code. Schema: [docs/ui-json.md](docs/ui-json.md) (also `lvgl_docs {topic: "ui-json"}`).

LVGL's own XML format is part of LVGL Pro and is not supported here; the JSON UI format is this project's own and maps 1:1 to LVGL calls.

### Prebuilt LVGL

Each release archive contains `simulator/prebuilt/<platform>/` (`linux-x64`, `windows-x64`, `macos-arm64`, `macos-x64`): LVGL compiled in Release as a static library (`liblvgl.a`, `lvgl.lib` with MSVC) with the simulator's `lv_conf.h`, its headers, the `lv_conf.h` checksum and a ready-to-run `lvgl_sim` built from the same tree (fully static on Linux, static C runtime on Windows). postinstall reports whether it is present ("JSON UI rendering (lvgl_render_ui) is available without a toolchain").

- `lvgl_render_ui` runs that `lvgl_sim` directly: no toolchain at all.
- Renders of C code configure CMake with `-DLVGL_PREBUILT_DIR=<simulator>/prebuilt/<platform>` and only compile your code and the simulator's own sources, instead of all of LVGL.
- The library bakes in `lv_conf.h`. If `simulator/lv_conf.h` no longer matches the checksum stored next to the library (or the LVGL version differs), CMake prints `LVGL_PREBUILT: not using the prebuilt LVGL ...` and builds LVGL from source. If linking against it fails (for example with an older MSVC than the one that built it), the server logs a warning, reconfigures without it and builds from source once; that choice is kept for the session.
- In a checkout, `./scripts/build-prebuilt.sh` (Linux, macOS) or `scripts\build-prebuilt.ps1` (Windows, Developer PowerShell for VS) builds it for your machine; `--verify` / `-Verify` also checks that the prebuilt link renders byte-identical PNGs. See [CONTRIBUTING.md](CONTRIBUTING.md#prebuilt-lvgl).

### `lvgl_render_project` — render a real UI project

Pass the UI files of your firmware project, inline (`files: [{path, content}]`) or as a `root` directory that lies inside one of the MCP client's roots, a directory listed in `LVGL_ALLOWED_ROOTS` or the server's working directory. All `.c` and `.cpp` files are compiled with your `include_dirs` and `defines` (C++ files must declare the entry function `extern "C"`), and the wrapper (`simulator/templates/project_wrapper.c`) calls `entry()` (default `ui_init`, what SquareLine Studio and EEZ Studio exports use; `app_main` works too). Project headers win over the ESP-IDF stand-ins and never collide with the simulator's own headers. Paths are checked against the allowed roots; diagnostics keep your file names. `esp_shims` is on by default here.

### ESP-IDF shims and `sim.h`

Code copied from firmware usually logs with `ESP_LOGI`, waits with `vTaskDelay` and sometimes starts tasks. The headers `esp_log.h`, `esp_err.h`, `esp_check.h`, `esp_timer.h`, `esp_system.h`, `sdkconfig.h`, `esp_lvgl_port.h`, `freertos/FreeRTOS.h`, `freertos/task.h`, `freertos/semphr.h` and `freertos/queue.h` resolve to stand-ins in `simulator/templates/esp_shim/` that include `simulator/templates/esp_shim.h`, so that code compiles unchanged. `esp_shims: true` (default for `lvgl_render_project`) configures the build with `-DLVGL_SIM_ESP_SHIMS=ON`, which also makes the snippet wrapper include `esp_shim.h` (snippets have no `#include` lines of their own):

| ESP-IDF / FreeRTOS | In the simulator |
|--------------------|------------------|
| `ESP_LOGI/W/E/D/V(tag, fmt, ...)` | `sim_log` (LVGL log as `[User]`, and the JSON `logs`) |
| `vTaskDelay(ticks)` | `sim_advance_ms(ticks * portTICK_PERIOD_MS)` |
| `pdMS_TO_TICKS(ms)`, `portTICK_PERIOD_MS` (10), `TickType_t`, `portMAX_DELAY` | defined |
| `esp_timer_get_time()` | `lv_tick_get() * 1000` (µs of simulated time) |
| `esp_err_t`, `ESP_OK`, `ESP_ERROR_CHECK` | defined |
| `xTaskCreate(fn, ...)` | runs `fn` once, synchronously |
| `vTaskDelete` | no-op |
| `xSemaphoreCreateMutex`, `xSemaphoreTake/Give`, `lvgl_port_lock/unlock` | always succeed |
| `xQueueCreate`, `xQueueSend`, `xQueueReceive`, `xQueuePeek`, ... | real FIFOs within the one simulated task; waiting on an empty (or full) queue lets the timeout pass (at most 1 s per call) and fails |
| `ESP_RETURN_ON_ERROR`, `ESP_GOTO_ON_ERROR`, ... (`esp_check.h`) | as in ESP-IDF, logging through `sim_log` |
| `while (1) { lv_timer_handler(); vTaskDelay(...); }` | detected at run time: after 5 s of simulated time the screen is captured and the run ends normally with `APP_LOOP_DETECTED` (info) |

Your code can also use the simulator helpers directly. Snippets get `sim.h` from the wrapper; full files and projects add `#include "sim.h"`:

```c
void sim_advance_ms(uint32_t ms);     /* advance simulated time (lv_tick_inc + lv_timer_handler) */
void sim_capture(const char *label);  /* capture now, like the action {"capture": label} */
void sim_log(const char *fmt, ...);   /* LVGL log ("[User]") and JSON logs */
```

### ESP32 compatibility

The simulator runs LVGL **9.6.0**, which is available in the ESP-IDF component registry as `lvgl/lvgl` 9.6.0 since September 2026. If your device firmware is still on 9.5, code that uses 9.6-only API (for example `lv_obj_set_hidden`) will not compile there; APIs deprecated in 9.6 still work in both. Use `fonts`, `mem_budget_kb` and `board` to hold renders to the device's limits.

## JSON output format

The simulator writes the widget tree as compact JSON, `format_version` 3. Version 3 only adds fields to version 2 (2.1.0). Real output (pretty-printed; `"...": "..."` marks trees and styles left out here) of a 320x240 `lvgl_render_ui` call with `annotate: true`, `mem_budget_kb: 48` and one action, `[{"click": {"name": "wifi_sw"}}]`, on this document:

```json
{"type": "lv_obj", "styles": {"bg_color": "#ffffff"}, "children": [
  {"type": "lv_label", "name": "title", "text": "Living room temperature", "x": 10, "y": 10, "w": 160,
   "long_mode": "clip", "styles": {"font": "montserrat_16"}},
  {"type": "lv_label", "name": "hint", "text": "Tap to toggle", "x": 10, "y": 40, "styles": {"text_color": "#c0c0c0"}},
  {"type": "lv_switch", "name": "wifi_sw", "align": "top_right", "x": -10, "y": 10}
]}
```

```json
{
  "format_version": 3,
  "lvgl_version": "9.6.0",
  "display": {"width": 320, "height": 240, "rotation": 0, "dpi": 130, "color_format": "XRGB8888", "theme": "light", "scale": 1},
  "elapsed_ms": 423,
  "anims_running": 3,
  "logs": [],
  "screen": {
    "type": "lv_obj",
    "path": "lv_obj#0",
    "x": 0,
    "y": 0,
    "w": 320,
    "h": 240,
    "abs": {"x1": 0, "y1": 0, "x2": 319, "y2": 239},
    "flags": ["clickable", "scrollable"],
    "styles": {"bg_opa": 255, "bg_color": "#ffffff", "pad_row": 8, "pad_column": 8, "text_color": "#212121", "font": "montserrat_14", "line_height": 16},
    "children": [
      {"type": "lv_label", "name": "title", "path": "lv_label#0", "x": 10, "y": 10, "w": 160, "h": 18, "abs": {"x1": 10, "y1": 10, "x2": 169, "y2": 27}, "flags": ["scrollable"], "text": "Living room temperature", "long_mode": "clip", "scroll": {"x": 0, "y": 0, "overflow_x": true, "overflow_y": false}, "styles": {"bg_opa": 0, "text_color": "#212121", "font": "montserrat_16", "line_height": 18}},
      { "type": "lv_label", "name": "hint", "...": "..." },
      {"type": "lv_switch", "name": "wifi_sw", "path": "lv_switch#0", "x": 258, "y": 10, "w": 52, "h": 30, "abs": {"x1": 258, "y1": 10, "x2": 309, "y2": 39}, "states": ["checked", "focused"], "flags": ["clickable", "checkable"], "checked": true, "styles": { "...": "..." } }
    ]
  },
  "captures": [
    {"n": 1, "label": "final", "elapsed_ms": 423, "png": "capture-1-final.png", "annotated": "annotated-1-final.png", "screen": { "type": "lv_obj", "...": "..." } }
  ],
  "mem": {"peak_bytes": 13224, "used_bytes": 11960, "frag_pct": 1, "budget_bytes": 49152, "over_budget": false, "pool_bytes": 8383208, "note": "excludes draw buffers"},
  "fonts_used": ["montserrat_14", "montserrat_16"],
  "diagnostics": [
    {"code": "LABEL_CLIPPED", "severity": "warn", "name": "title", "path": "lv_label#0", "abs": {"x1": 10, "y1": 10, "x2": 169, "y2": 27}, "message": "label text 'Living room temperature' needs 204 px, has 160 px (long_mode clip)"},
    {"code": "LOW_CONTRAST", "severity": "warn", "name": "hint", "path": "lv_label#1", "abs": {"x1": 10, "y1": 40, "x2": 106, "y2": 55}, "message": "label text 'Tap to toggle' has contrast 1.8:1 (#c0c0c0 on #ffffff), below 3.0:1"},
    {"code": "ANIM_UNFINISHED", "severity": "info", "name": null, "path": null, "abs": null, "message": "3 animations were still running at the final capture (423 ms); use settle or a longer time to capture the end state"}
  ],
  "input": {"pointer": true, "keypad": false, "focused": null},
  "events": [
    {"t_ms": 330, "event": "pressed", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch"},
    {"t_ms": 330, "event": "focused", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch"},
    {"t_ms": 390, "event": "value_changed", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch", "value": true},
    {"t_ms": 390, "event": "released", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch"},
    {"t_ms": 390, "event": "clicked", "name": "wifi_sw", "path": "lv_switch#0", "type": "lv_switch"}
  ]
}
```

Actions start after `time_ms` (330 ms by default), which is why the events begin at 330 ms; the click holds for 60 ms and the capture follows one 33 ms step after the release, so the switch animation is still running (`ANIM_UNFINISHED`; add `{"settle": 1000}` to capture the end state). The pointer device exists because actions were given, the keypad device only when the script uses `key`, `type` or `focus` (so `input.keypad` is false and nothing is focused through a group here). Diagnostics about no particular object have `name`, `path` and `abs` set to `null`. `captures` appears only with more than one capture or with `annotate` (each then has an `annotated` image too); `frames: [0, 100, 300]` gives four captures (`t0`, `t100`, `t300` and `final`). `events` lists what the actions triggered, with `value` for value changes. Every field of the document and of the widget nodes is described in [docs/json-format.md](docs/json-format.md).

> Changed in 2.2.0: `format_version` 3 adds `captures`, `mem`, `fonts_used`, `diagnostics`, `input`, `events` and `display.scale`; nothing was removed or renamed. Changed in 2.1.0: format version 2 replaced the bare screen node. See [CHANGELOG.md](CHANGELOG.md).

## Environment variables

Set these in the `env` block of your MCP client configuration.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LVGL_SIM_PATH` | auto | Simulator directory (contains `CMakeLists.txt`). Overrides auto-detection (npm package's `simulator/`, else `../simulator` in a checkout) |
| `LVGL_PROJECT_ROOT` | auto | Repository root that contains `simulator/` (older alternative to `LVGL_SIM_PATH`) |
| `LVGL_ALLOWED_ROOTS` | (none) | Extra directories `lvgl_render_project` may read a `root` from, separated like `PATH` (`:` on Linux/macOS, `;` on Windows). The MCP client's roots and the server's working directory (unless it is `/` or your home directory) are always allowed |
| `LVGL_BUILD_DIR` | `<simulator>/build` | CMake build directory |
| `LVGL_ASSETS_DIR` | server working dir | Default directory for `S:` file paths (`assets_dir` parameter) |
| `LVGL_COMPILE_TIMEOUT_MS` | `180000` | Time limit for configure + build |
| `LVGL_RUN_TIMEOUT_MS` | `15000` | Time limit for one simulator run |
| `CC` | `cl` (Windows), CMake default, usually `cc` (POSIX: gcc or clang on Linux, Apple clang on macOS) | C compiler |
| `CXX` | `cl` (Windows), CMake default (POSIX) | C++ compiler |
| `CMAKE_PATH` | PATH / ESP-IDF (Windows) / Homebrew, MacPorts, CMake.app (macOS) | Path to `cmake` |
| `NINJA_PATH` | PATH / ESP-IDF (Windows) / Homebrew, MacPorts (macOS) | Path to `ninja` |
| `LVGL_CMAKE_GENERATOR` | Ninja if found, else Unix Makefiles | CMake generator (POSIX) |
| `VCVARSALL_PATH` | found via `vswhere` | Path to `vcvarsall.bat` (Windows) |

The prebuilt LVGL is picked up automatically when `<simulator>/prebuilt/<platform>/` exists; delete that directory to always build LVGL from source.

Install-time only (postinstall):

| Variable | Purpose |
|----------|---------|
| `LVGL_SKIP_DOWNLOAD=1` | Do not download the simulator (e.g. you use `LVGL_SIM_PATH`) |
| `LVGL_FORCE_DOWNLOAD=1` | Download even when `CI` is set |
| `HTTPS_PROXY` / `https_proxy` / `npm_config_https_proxy`, `NO_PROXY` | Proxy for the download |

## Examples

The [examples/](examples/) directory contains rendered output from the MCP server — PNG screenshots and the corresponding JSON widget trees. They are regenerated with `node mcp-server/scripts/render-examples.mjs` against the simulator in the checkout.

### Demo renders

| Screenshot | Source / JSON | Description |
|-----------|---------------|-------------|
| [01-button-slider.png](examples/01-button-slider.png) | [JSON](examples/01-button-slider.json) | Button + slider basic layout at 480x320 |
| [02-dashboard.png](examples/02-dashboard.png) | [JSON](examples/02-dashboard.json) | Multi-card dashboard at 800x480 (`lvgl_render_full`) |
| [04-esp32-small.png](examples/04-esp32-small.png) | [JSON](examples/04-esp32-small.json) | ESP32 status screen at 320x240 |
| [05-annotated.png](examples/05-annotated.png) | [JSON](examples/05-annotated.json) | Thermostat on the `esp32-2432s028r` board preset (320x240, RGB565) with `annotate: true`: the annotated overlay image (outlines coloured by depth, names) |
| [06-ui.png](examples/06-ui.png) | [UI document](examples/06-ui.json) | Home screen from a JSON UI document with two screens, a gradient card and a fade-in animation, at 480x320 (`lvgl_render_ui`, no toolchain) |

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

1. Claude sends C code (`lvgl_render`, `lvgl_render_full`, `lvgl_render_project`, `lvgl_check`) or a JSON UI document (`lvgl_render_ui`)
2. C code: the MCP server wraps a snippet in a template (includes, `sim.h`, optionally the ESP-IDF shim, `create_ui()` boilerplate and a `#line` directive so diagnostics point at your lines); full files and projects are used as they are
3. The code is written into the build directory; CMake/Ninja recompile only that code and relink against LVGL (the prebuilt library, or LVGL compiled once from source). JSON UI documents skip this step: they are written to a file for `lvgl_sim --ui`
4. The simulator binary (`lvgl_sim.exe` on Windows, `lvgl_sim` on Linux and macOS) runs headless with a minimal environment: it initializes LVGL with a framebuffer display and pointer/keypad input devices, applies the theme, DPI, rotation and colour format, builds the UI, runs the actions and frames in 33 ms steps of simulated time, and after each capture exports PNGs (plus annotated overlays) and the widget tree with diagnostics into a fresh temporary directory
5. The MCP server reads the files, deletes the temporary directory, keeps the render in its history (`r1`, `r2`, ...) and returns the images with the summary, diagnostics, memory, events, LVGL logs and tree

Renders are serialized, so parallel tool calls never share a build or output files. Compilation uses MSVC (`cl.exe`) on Windows — the Visual Studio environment is set up automatically — gcc/clang on Linux and Apple clang on macOS.

The simulator can also be run by hand:

```bash
simulator/build/lvgl_sim --width 320 --height 240 --time-ms 330 --theme dark \
  --output-png out.png --output-json out.json
simulator/build/lvgl_sim --ui examples/06-ui.json --width 480 --height 320 --annotate --frames 0,300 \
  --output-dir out/ --output-png out/final.png --output-json out/ui.json
```

Options: `--width`, `--height` (16–4096), `--output-png`, `--output-json` (required), `--time-ms` (default 330; `--ticks N` = N × 33 ms), `--settle`, `--rotation 0|90|180|270`, `--theme light|dark`, `--dpi` (default 130), `--assets-dir`, `--ui PATH` (JSON UI document), `--actions PATH` (action script), `--output-dir DIR` (per-capture images `capture-<n>-<label>.png`, `annotated-<n>-<label>.png`), `--frames 0,100,300` (then the final capture), `--annotate`, `--scale 1..4`, `--color-format xrgb8888|rgb565`, `--fonts a,b,c`, `--mem-budget-kb N`, `--help`. Exit codes: 0 ok, 1 bad arguments, 2 output write failed, 3 LVGL assertion, 5 UI document error, 6 action script error; anything else is a crash in user code. LVGL log lines go to stderr, `printf` output of your code to stdout.

## Project structure

```
Lvgl-mcp-esp32/
├── simulator/                    Headless LVGL renderer (C)
│   ├── CMakeLists.txt            Build config (C + C++, Release, Ninja/Make, MSVC or gcc/clang)
│   ├── lv_conf.h                 LVGL config (XRGB8888/RGB565, built-in heap, all widgets, fonts 8-48, decoders, S: drive)
│   ├── main.c                    CLI (see above), LVGL log capture, assert handler
│   ├── sim_runtime.c             Simulated time, captures, app-loop detection, JSON document
│   ├── hal/                      Framebuffer-only display (no SDL/window)
│   ├── input/                    Pointer/keypad input devices, action scripts
│   ├── export/                   PNG export, annotations, widget tree, diagnostics, events, memory → JSON (format v3)
│   ├── ui/                       JSON UI document interpreter (--ui)
│   ├── util/                     JSON parser and writer
│   ├── templates/
│   │   ├── user_code_wrapper.c   Template for wrapping code snippets
│   │   ├── project_wrapper.c     Entry wrapper for lvgl_render_project (%ENTRY%)
│   │   ├── sim.h / sim.c         sim_advance_ms / sim_capture / sim_log for user code
│   │   ├── esp_shim.h            ESP-IDF / FreeRTOS shim
│   │   └── esp_shim/             Stand-ins for esp_log.h, freertos/*.h, esp_lvgl_port.h, ...
│   ├── prebuilt/<platform>/      Prebuilt LVGL + lvgl_sim (release archives, or scripts/build-prebuilt.*)
│   └── lib/
│       ├── lvgl/                 LVGL v9.6.0 (git submodule)
│       ├── lvgl_prebuilt.cmake   LVGL_PREBUILT_DIR handling (prebuilt or from source)
│       └── stb/stb_image_write.h PNG encoder (single header)
├── mcp-server/                   MCP server (TypeScript)
│   ├── bin/lvgl-mcp-server.mjs   npx entry point
│   ├── scripts/
│   │   ├── postinstall.mjs       Downloads + verifies the matching simulator
│   │   ├── prepack.mjs           Copies README/LICENSE into the npm package
│   │   ├── render-examples.mjs   Regenerates examples/
│   │   └── test.mjs              Test runner (node --test + tsx)
│   ├── src/
│   │   ├── index.ts              Entry point, stdio transport
│   │   ├── boards.ts             Board presets (source of the boards table)
│   │   ├── tools/                lvgl_render(_full/_ui/_project), lvgl_interact, lvgl_diff, lvgl_inspect, lvgl_check, lvgl_docs, lvgl_set_resolution
│   │   ├── simulator/            Toolchain detection, compile (prebuilt or source), run, diagnostics
│   │   └── resources/            lvgl://api-reference, lvgl://project-config, docs topics
│   └── tests/                    unit, contract and e2e tests (node --test)
├── docs/                         Reference: UI JSON, actions, diagnostics, JSON format
├── examples/                     Example renders (PNG + JSON) and 06-ui.json
├── scripts/
│   ├── setup.ps1 / build.bat     Windows: full setup / simulator build
│   ├── setup.sh / build.sh       Linux, macOS: full setup / simulator build
│   ├── build-prebuilt.sh / .ps1  Prebuilt LVGL + lvgl_sim for simulator/prebuilt/<platform>
│   └── smoke-test.mjs            Simulator smoke test (setup scripts, CI, release)
├── .github/workflows/
│   ├── ci.yml                    Lint, unit + e2e tests (Linux, macOS, Windows), prebuilt LVGL (Linux), submodule pin, actionlint
│   ├── release.yml               Tag → verify → build (4 platforms, prebuilt, no-toolchain smoke test) → GitHub release → npm
│   └── tag.yml                   "Tag release": creates the tag and starts release.yml
├── CHANGELOG.md
├── CONTRIBUTING.md
└── README.md
```

## Configuration

| Setting | Default | Location |
|---------|---------|----------|
| LVGL version | v9.6.0 | Git submodule (tag `v9.6.0`, branch `release/v9.6`) |
| Color format | XRGB8888 (32 bpp); RGB565 per call (`color_format`) | `simulator/lv_conf.h`, CLI |
| LVGL heap | Built-in allocator, 8 MB pool (device budget per call: `mem_budget_kb`) | `simulator/lv_conf.h` |
| Display resolution | 800x480 | per call, `board`, `lvgl_set_resolution` default, or CLI args |
| Fonts | Montserrat 8–48 (even sizes), Montserrat 28 compressed, Unscii 8/16 (device subset per call: `fonts`) | `simulator/lv_conf.h` |
| Image decoders | PNG, BMP, JPEG; file access via `S:` | `simulator/lv_conf.h` |
| All LVGL widgets, Flex + Grid | Enabled | `simulator/lv_conf.h` |
| LVGL log level | Warn | `simulator/lv_conf.h` |

Changing `simulator/lv_conf.h` invalidates the prebuilt LVGL library; the build then compiles LVGL from source (see [Prebuilt LVGL](#prebuilt-lvgl)).

## Security

Rendering C code compiles and runs arbitrary C code **locally, with your user's rights**. There is no sandbox: the code can read and write any file your account can. The compiled simulator (which runs your code) is started with a minimal, allow-listed environment, so environment variables such as API keys in your MCP client's configuration are not passed to it; the build tools (CMake, the compiler) inherit the server's environment. None of this is isolation. Only render code you would compile yourself, and use a container or VM if you need a hard boundary. `lvgl_render_project` only reads directories inside the MCP client's roots, `LVGL_ALLOWED_ROOTS` or the server's working directory. JSON UI documents run no user code, but they can reference image files (`S:` paths) under `assets_dir`.

Downloads are pinned to the package version and verified with SHA-256; release archives (including the prebuilt binaries in them) also carry GitHub build provenance (`gh attestation verify <archive> --repo jaklys/Lvgl-mcp-esp32`), and npm packages are published with provenance.

## Release process

Maintainers, see also [CONTRIBUTING.md](CONTRIBUTING.md):

1. Bump `mcp-server/package.json` (`npm version X.Y.Z --no-git-tag-version` in `mcp-server/`) and move the `Unreleased` notes of `CHANGELOG.md` into a `## [X.Y.Z] - YYYY-MM-DD` section.
2. Merge to `main`, then open **Actions → Tag release → Run workflow** and enter the version (`X.Y.Z`, no `v`). `ref` defaults to `main`; a commit that is not on `main` needs `allow_non_default`. From a terminal: `gh workflow run tag.yml -f version=X.Y.Z`.
3. **Tag release** checks the version against `package.json`, the CHANGELOG, existing tags, GitHub releases and npm, creates the annotated tag `vX.Y.Z` and starts the Release workflow for it (the job summary links the run). Pushing a tag by hand (`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`) still works and starts the Release workflow directly.
4. The Release workflow then runs:
   - **verify-version** — the tag is `vX.Y.Z`, equals the `package.json` version, has a CHANGELOG section, and is neither released on GitHub nor published on npm yet
   - **build** (Linux x64, macOS arm64 on `macos-latest`, macOS x64 on `macos-26-intel`, Windows x64) — Release build, smoke test, prebuilt LVGL (`scripts/build-prebuilt.*` with verification), unit + e2e tests, slim archive with `simulator/prebuilt/<platform>/`, a check that the slim tree builds from source and against the prebuilt library, and a smoke test that renders `examples/06-ui.json` with the packaged `lvgl_sim` and no compiler, CMake, Ninja or Make on `PATH`
   - **create-release** — `SHA256SUMS.txt`, build provenance attestations, GitHub release with notes from the CHANGELOG
   - **publish-npm** — `npm publish --provenance`, only after the release exists (postinstall of the new version needs its assets)
5. Publishing to npm needs the `NPM_TOKEN` repository secret or npm trusted publishing configured for `release.yml`. If a late job fails (for example npm authentication), fix the cause and use **Re-run failed jobs**. Running the Release workflow by hand with an existing tag re-runs the whole flow for a tag that has no release yet.

## Troubleshooting

**"No Visual Studio / Build Tools installation with the C++ x64 tools was found"** — Install "Build Tools for Visual Studio" (2019, 2022 or 2026) with the "Desktop development with C++" workload. Detection uses `vswhere.exe` (`%ProgramFiles(x86)%\Microsoft Visual Studio\Installer`); if yours is somewhere unusual, set `VCVARSALL_PATH`. JSON UI renders (`lvgl_render_ui`) work without it.

**"cl is not recognized"** — The MCP server and `scripts\build.bat` set up the MSVC environment themselves. If you run CMake by hand, use a "Developer PowerShell for VS" or run `scripts\build.bat`.

**"cc: command not found" / "no C++ compiler found" (Linux)** — Install `build-essential` (Debian/Ubuntu) or `gcc gcc-c++` (Fedora). LVGL 9.6 needs a C++ compiler too. Override the compiler with `CC`.

**`xcrun: error: invalid active developer path` (macOS)** — The Xcode Command Line Tools are missing, which is common after a macOS upgrade (`/usr/bin/cc` and `make` exist but do nothing without them). Run `xcode-select --install` and restart the MCP client. With a full Xcode that is not selected, run `sudo xcode-select --switch /Applications/Xcode.app` and `sudo xcodebuild -license accept`.

**"CMake not found" on macOS although Homebrew installed it** — See the `PATH` note under [Prerequisites](#prerequisites); set `CMAKE_PATH` (e.g. `/opt/homebrew/bin/cmake`) and `NINJA_PATH` in the `env` block of the MCP configuration.

**`lvgl_render_ui` works but C renders fail** — Expected without a toolchain: JSON UI documents run on the prebuilt `lvgl_sim`, C code has to be compiled. Install the [prerequisites](#prerequisites).

**CMake warning `LVGL_PREBUILT: not using the prebuilt LVGL in ... : .../lv_conf.h changed since the library was built`** — The prebuilt library was compiled with a different `lv_conf.h` (or LVGL version), so it cannot be linked safely. The build falls back to compiling LVGL from source, which only makes the first build slower. Rebuild the prebuilt library with `scripts/build-prebuilt.sh` / `.ps1`, restore `lv_conf.h`, or delete `simulator/prebuilt/` to silence the warning.

**Server warning that linking against the prebuilt LVGL failed** — Typically an MSVC older than the one used for the release (static libraries are only forward-compatible). The server switches to the source build automatically for the rest of the session; update Visual Studio to make the prebuilt library usable.

**Gatekeeper (macOS)** — The prebuilt `lvgl_sim` is downloaded by npm, not by a browser, so it has no quarantine attribute and runs without an "unidentified developer" prompt. If you downloaded the archive with a browser, run `xattr -dr com.apple.quarantine <simulator>/prebuilt` once. A crash in your code (reported as `crashed with SIGSEGV` or `SIGBUS (invalid memory access ...)`) may leave a report in `~/Library/Logs/DiagnosticReports`; that is harmless.

**"UI document error" (exit code 5)** — The JSON UI document has unknown keys, wrong types or unknown widget types. Every problem is listed with its JSON path; fix them all and render again. See [docs/ui-json.md](docs/ui-json.md).

**"action script error" (exit code 6)** — An action has bad JSON, an unknown step or names an object that does not exist. Name objects with `lv_obj_set_name()` (or `name` in a UI document), or use the `type#index` path printed in the tree. See [docs/actions.md](docs/actions.md).

**`APP_LOOP_DETECTED`** — Your code runs a firmware main loop. The simulator captured the screen after 5 s of simulated time and ended the run; nothing is wrong. Use `frames` or `sim_capture()` for earlier states.

**"pkg-config not found" CMake warning** — Harmless: the simulator uses no system libraries.

**"ninja: command not found" (Linux)** — Ninja is optional; the build falls back to Unix Makefiles. Install it with `sudo apt install ninja-build` for faster builds.

**"The current CMakeCache.txt directory ... is different"** — The checkout was moved or copied. The server and the build scripts detect this and wipe the stale cache; if you run CMake manually, delete `simulator/build/`.

**The first render is slow or times out** — Without a usable prebuilt library the first build compiles all of LVGL (about 10–30 s on Linux and macOS, 30 s or more with MSVC, longer on slow disks or with antivirus scanning). Raise `LVGL_COMPILE_TIMEOUT_MS` if needed. Later renders only recompile your code.

**No simulator after installing with pnpm, bun, or `--ignore-scripts`** — These skip the postinstall step (pnpm 10 and bun block dependency install scripts by default). Allow it (`pnpm approve-builds`, bun `trustedDependencies`) or run it once by hand: `node node_modules/lvgl-mcp-server/scripts/postinstall.mjs` (global install: `npm rebuild -g lvgl-mcp-server`).

**postinstall download fails behind a proxy** — The download honors `HTTPS_PROXY`, `https_proxy`, `npm_config_https_proxy` and `NO_PROXY`. With a TLS-intercepting proxy, point Node at your company CA: `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. Then retry with `npm rebuild lvgl-mcp-server`. The error message also lists the manual download + checksum steps.

**"checksum mismatch" or "no SHA256SUMS.txt"** — The download was corrupted or the release is incomplete; nothing was installed. Retry, or download and verify the archive manually as described in the message.

**Wrong colors in PNG** — LVGL uses XRGB8888, which is BGRA in memory on little-endian CPUs (x86, ARM). The screenshot exporter handles the byte swizzle (and converts RGB565 buffers). If colors look wrong, check `simulator/export/screenshot.c`.

**The server cannot find the simulator** — Check the `[lvgl-mcp] Simulator directory:` line in the server's stderr and set `LVGL_SIM_PATH` to a directory containing the simulator's `CMakeLists.txt`.

## Author

[Jan Machaček](https://www.linkedin.com/in/jan-machacek-164255108)
