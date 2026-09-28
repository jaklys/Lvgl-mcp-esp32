# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version is the
npm version of `lvgl-mcp-server`; release tags are `v<version>`.

## [Unreleased]

## [2.2.1] - 2026-09-28

The first published 2.2 build: tag `v2.2.0` has no GitHub release and no npm
package because its release run failed, so everything listed under 2.2.0 ships
with 2.2.1. No other changes.

### Fixed

- **Release workflow, Windows packaging.** The build steps passed the target
  platform in a `PLATFORM` environment variable. The MSVC developer
  environment already sets `Platform=x64`, and Windows environment names are
  case-insensitive, so the two merged and Git Bash never saw `$PLATFORM`: the
  "Stage slim archive" step aborted with `PLATFORM: unbound variable`. The
  variable is now `PREBUILT_PLATFORM`.

## [2.2.0] - 2026-09-28

"Give the AI everything it needs to see and understand": more than one
screenshot per render, a picture of the layout itself, input, measured
problems instead of guesses, the device's real limits, and renders without a
compiler. LVGL stays at v9.6.0.

### Breaking changes

- **Widget tree JSON is now `format_version: 3`.** Every 2.1.0 field keeps its
  name, meaning and position; version 3 only adds fields (`captures`, `mem`,
  `fonts_used`, `diagnostics`, `input`, `events`, `display.scale`). Readers
  that check `format_version == 2` must accept 3. The text part of tool
  results keeps its 2.1.0 lines and gains new ones.
- **Two macOS release archives** replace `lvgl-mcp-esp32-macos.tar.gz`:
  `lvgl-mcp-esp32-macos-arm64.tar.gz` and `lvgl-mcp-esp32-macos-x64.tar.gz`,
  because archives now contain platform binaries. postinstall picks the
  right one; only manual downloads are affected.

### Added

- **New tools.**
  - `lvgl_render_ui` renders a **JSON UI document** (this project's own
    format, same vocabulary as the widget tree the renders return: widget
    types, `name`, geometry, `styles`, part blocks, flex/grid layouts,
    animations, several screens). The simulator interprets it at run time:
    no C code, no compilation, and with the prebuilt `lvgl_sim` no toolchain.
    Mistakes are reported all at once with their JSON path, e.g.
    `children[2].type: unknown widget "lv_meter"`. LVGL's own XML format is
    part of LVGL Pro and is not supported.
  - `lvgl_render_project` compiles a whole UI project (inline `files` or a
    `root` directory inside an MCP root, `LVGL_ALLOWED_ROOTS` (new, a
    PATH-style list) or the server's working directory; `.c` and
    `.cpp`, `include_dirs`, `defines`) and calls its entry function
    (`ui_init` by default). Paths are checked against the allowed roots and
    diagnostics keep the project's file names.
  - `lvgl_interact`: a render with an action script, one image per capture.
  - `lvgl_diff` compares two earlier renders (ids `r1`, `r2`, ...; the last
    20 are kept): changed pixel count, percentage and bounding box, a diff
    image, and an object-level diff by name/path (added, removed, moved,
    resized, text and style changes).
  - `lvgl_docs {topic}` returns focused LVGL 9.6 reference text
    (`widgets` and `widgets/<name>` for 34 widgets, `styles`, `layouts`,
    `events`, `anim`, `fonts`, `symbols`, `v8-migration`, `simulator`,
    `ui-json`, `actions`, `diagnostics`, `esp32`, `boards`); the board
    presets are also the resource `lvgl://boards`.
- **Seeing more.** `frames` captures the screen at several simulated times
  (plus the final state, so `[0, 100, 300]` gives four images);
  `annotate` adds an overlay image with every object's outline (coloured by
  depth) and name; `scale` (1-4) upscales images for small displays;
  `color_format: "rgb565"` renders through a real RGB565 buffer so banding
  looks like the device.
- **Input.** `actions` drives real LVGL pointer and keypad input devices:
  `click`/`press`/`release`/`drag` by coordinates or object name, `key`,
  `type`, `focus`, `wait`, `settle`, `capture`, `load_screen`. Events fired
  (pressed, clicked, value changed with the new value, focused, screen
  loaded, ...) are reported.
- **Diagnostics** computed from the rendered UI, each with object name/path,
  absolute rectangle and a message with numbers: `LABEL_CLIPPED`,
  `TEXT_OVERFLOW`, `MISSING_GLYPH`, `OFF_SCREEN`, `OUTSIDE_PARENT`,
  `OVERLAP`, `LOW_CONTRAST`, `SMALL_TOUCH_TARGET`, `ZERO_SIZE`,
  `FONT_NOT_ON_DEVICE`, `MEM_OVER_BUDGET`, `HIDDEN_CLICKABLE`,
  `ANIM_UNFINISHED`, `APP_LOOP_DETECTED`. See `docs/diagnostics.md`.
- **Device limits.** `mem_budget_kb` compares LVGL's peak heap use with the
  device's `LV_MEM_SIZE`; `fonts` lists the fonts enabled on the device and
  flags every other font; `board` applies a preset (resolution, colour
  format, DPI, rotation, memory budget) for common ESP32 display boards.
- **Helpers for user code:** `sim.h` (`sim_advance_ms`, `sim_capture`,
  `sim_log`) and ESP-IDF stand-ins (`simulator/templates/esp_shim.h` and
  `esp_log.h`, `esp_check.h`, `sdkconfig.h`, `freertos/*.h`,
  `esp_lvgl_port.h` ... in `templates/esp_shim/`; `esp_shims`: `ESP_LOGx`,
  `vTaskDelay`, `pdMS_TO_TICKS`, `esp_timer_get_time`, `xTaskCreate`,
  semaphores, queues, ...) so code taken from firmware compiles unchanged; a `while (1) { lv_timer_handler();
  vTaskDelay(...); }` loop is detected, captured and reported.
- **Prebuilt LVGL** in every release archive
  (`simulator/prebuilt/<platform>/`: static library, headers, `lvgl_sim`).
  The first C render links it instead of compiling LVGL, and UI documents
  render without any toolchain. CMake uses it through `-DLVGL_PREBUILT_DIR`
  and falls back to building LVGL from source (with a warning) when
  `lv_conf.h` changed; the server falls back automatically if linking fails.
  `scripts/build-prebuilt.sh` / `.ps1` build it locally.
- New simulator CLI options: `--ui`, `--actions`, `--output-dir`, `--frames`,
  `--annotate`, `--scale`, `--color-format`, `--fonts`, `--mem-budget-kb`;
  exit codes 5 (UI document error) and 6 (action script error).
- **Tag release workflow** (`.github/workflows/tag.yml`): Actions -> "Tag
  release" -> Run workflow with the version creates the annotated tag
  `vX.Y.Z` on `main` after checking `package.json`, the CHANGELOG, existing
  tags, GitHub releases and npm, then starts the Release workflow for it. No
  local `git push` of the tag is needed.

### Changed

- LVGL now uses its built-in allocator with an 8 MB pool
  (`LV_USE_STDLIB_MALLOC LV_STDLIB_BUILTIN`), which is what makes heap
  measurements (`mem`) possible; the budget is checked against the
  device's size, not the pool's.
- `lvgl_inspect` accepts `render_id` to inspect an earlier render.
- User code (snippet, full file, project sources) is compiled as its own
  CMake object library, `lvgl_sim_user`, whose include path holds only the
  project's directories, `simulator/templates` and LVGL, so project headers
  such as `events.h` or `json.h` are not shadowed by the simulator's own.
  Project mode passes `USER_EXTRA_SOURCES`, `USER_INCLUDE_DIRS`,
  `USER_COMPILE_DEFINITIONS` and `LVGL_SIM_ESP_SHIMS` to CMake.
- The Release workflow builds and verifies the prebuilt LVGL on Linux x64,
  macOS arm64 (`macos-latest`), macOS x64 (`macos-26-intel`) and Windows x64,
  and smoke-tests the packaged `lvgl_sim` with no compiler, CMake, Ninja or
  Make on `PATH`. CI adds a Linux job for the prebuilt library (gcc build,
  clang link) and a PowerShell syntax check.
- `scripts/smoke-test.mjs` checks `format_version` 3 and gained `--ui`,
  `--expect-names` and `--no-toolchain`.

## [2.1.0] - 2026-09-27

LVGL 9.6.0, official macOS support, a much richer widget tree, compile-only
checks and a hardened install and release pipeline.

### Breaking changes

- **Widget tree JSON is now `format_version: 2`.** The document has a top-level
  wrapper (`format_version`, `lvgl_version`, `display`, `elapsed_ms`,
  `anims_running`, `logs`, `screen`, optional `layer_top`/`layer_sys`) instead
  of being the screen node itself, and it is written compact (single line).
- **`styles.text_font_size` is removed.** It reported the line height, not the
  font size. Use `styles.font` (built-in font name such as `montserrat_14`, or
  `custom`) and `styles.line_height`.
- **Resolution is no longer sticky.** `width`/`height` passed to a render call
  apply to that call only. `lvgl_set_resolution` sets the defaults used when a
  call omits them.
- **Node.js >= 20** is required (was 18).
- The simulator CLI option `--ticks N` is replaced by `--time-ms`; `--ticks` is
  still accepted as an alias for `N * 33` ms.

### Added

- **LVGL 9.6.0** (submodule pinned to tag `v9.6.0`, branch `release/v9.6`).
- **Official macOS support** (Apple Silicon and Intel, macOS 12+): Xcode
  Command Line Tools (Apple clang) plus `brew install cmake ninja`. CI builds
  the simulator and runs the end-to-end tests on `macos-latest` (Apple
  Silicon) and, as an informational job, on `macos-26-intel`. Releases ship
  `lvgl-mcp-esp32-macos.tar.gz` (built and tested on Apple Silicon, used by
  postinstall on both `darwin-arm64` and `darwin-x64`). The server finds
  Homebrew/MacPorts/CMake.app tools even when the MCP client was started from
  the Dock with launchd's minimal `PATH`, the toolchain check recognizes the
  `xcrun: error: invalid active developer path` stub and suggests
  `xcode-select --install`, crashes reported as `SIGBUS` (and `SIGTRAP`) are
  explained like `SIGSEGV`, and Apple linker "Undefined symbols" errors are
  parsed into diagnostics with hints. `scripts/setup.sh` and
  `scripts/build.sh` check for the Command Line Tools.
- Linux arm64 installs now get the (architecture-neutral) Linux source
  archive instead of no simulator; untested.
- **New simulator CLI options:** `--time-ms N` (simulated time before capture,
  default 330 ms), `--settle` (keep advancing until animations finish, max
  3 s), `--rotation 0|90|180|270`, `--theme light|dark`, `--dpi N`,
  `--assets-dir PATH` and `--help`. Layout is updated and the display refreshed
  right before capture.
- **Richer widget tree nodes:** `name` (from `lv_obj_set_name`), absolute
  coordinates `abs {x1,y1,x2,y2}`, `hidden`, `visible`, `states`, `flags`,
  `placeholder`, `long_mode`, `options`/`selected` (dropdown, roller), image
  `src`, `layout` (flex/grid), `scroll` (offset and overflow), `indicator` and
  `knob` part styles, plus style keys `font`, `line_height`, `pad_row`,
  `pad_column`. Trivial style values are omitted.
- **`lvgl_check` tool:** compiles a snippet or full file without running it and
  returns structured diagnostics.
- **Render parameters** `time_ms`, `settle`, `rotation`, `theme`, `dpi`,
  `assets_dir` and `include_tree` (`summary` default, `full`, `none`) on
  `lvgl_render` and `lvgl_render_full`; `lvgl_inspect` gained `type`, `name`,
  `max_depth` and `include_styles` filters and `full` (treat `code` as a
  complete C file).
- **Structured diagnostics:** compiler warnings and errors as
  `file:line:col severity message`, with paths shortened to `snippet.c` /
  `user_code.c` and snippet line numbers matching your code (`#line`
  directive in the wrapper).
- **LVGL logs:** every LVGL warning/error is captured (stderr and the `logs`
  array of the tree) and shown in tool results.
- **Fonts:** Montserrat 8 to 48 (all even sizes), Montserrat 28 compressed,
  Unscii 8/16, placeholder glyphs for missing characters.
- **Images and files:** PNG (lodepng), BMP and JPEG (TJPGD) decoders, QR code
  and barcode widgets, and a stdio filesystem driver on drive letter `S:`
  rooted at `--assets-dir`.
- Snapshot, gridnav, fragment and imgfont support enabled in `lv_conf.h`.
- Environment variables: `LVGL_SIM_PATH` (path to a simulator directory,
  overrides auto-detection), `LVGL_BUILD_DIR` (CMake build directory),
  `LVGL_ASSETS_DIR` (default for `assets_dir`), `LVGL_CMAKE_GENERATOR`
  (POSIX), `LVGL_COMPILE_TIMEOUT_MS` (default 180 s) and
  `LVGL_RUN_TIMEOUT_MS` (default 15 s). `LVGL_PROJECT_ROOT` still works.
- `lvgl://project-config` resource documented; `lvgl://api-reference` updated to
  9.6 with deprecation notes, a v8 to v9 rename table and simulator constraints.
- MCP tools registered with titles, annotations (`readOnlyHint`), output schemas
  and structured content.
- `CHANGELOG.md`, `CONTRIBUTING.md`, issue/PR templates, `.editorconfig`,
  `.gitattributes`, Dependabot configuration.

### Changed

- **Readable runtime errors:** timeouts ("timed out after N s (infinite
  loop?)"), crashes ("crashed with SIGSEGV (NULL or deleted object?)") and
  LVGL assertion failures are reported in plain words, followed by the tail of
  the LVGL log.
- **LVGL asserts fail fast:** an assertion or argument check failure exits the
  simulator with code 3 immediately instead of hanging in an endless loop,
  matching a crash on a 9.5/9.6 device.
- **Renders are serialized** and every run writes to its own temporary output
  directory, so concurrent tool calls can no longer mix up screenshots and
  trees.
- **Czech and other UTF-8 text on MSVC:** sources are compiled with `/utf-8`,
  so string literals render correctly on Windows.
- The compile timeout is 180 s for configure + build together (previously
  60 s per step), so the first full build of LVGL has room to finish.
- User code is compiled with stricter warnings
  (`-Werror=implicit-function-declaration`, `int-conversion`,
  `incompatible-pointer-types`; MSVC `/we4013 /we4047 /we4020`), catching the
  mistakes that crash on the device.
- The simulator is built in Release mode by default; the project is now
  `C CXX` (LVGL 9.6 needs a C++ compiler).
- **Security:** the simulator binary (your code) runs with an allow-listed
  environment instead of inheriting every variable of the MCP client (the
  build tools still inherit the server's environment).
- **postinstall hardening:** downloads the release that exactly matches the
  package version from a direct URL (no GitHub API, no rate limit, no fallback
  to "latest"), verifies it against `SHA256SUMS.txt`, honors
  `HTTPS_PROXY`/`NO_PROXY`, uses timeouts, retries and a `.part` file, writes
  `simulator/.version` and re-downloads on version change, logs only to
  stderr, and is skipped in a git checkout, when `CI` is set, when
  `LVGL_SKIP_DOWNLOAD=1` or when `LVGL_SIM_PATH` is set. Previously `npm ci`
  in the repository silently replaced the source-built simulator with a
  downloaded one.
- **Release pipeline:** only `v*` tags (and a manual re-run for an existing
  tag) trigger a release; the tag must equal the `package.json` version and
  must not be released or published yet; archives are slim (no LVGL tests,
  demos, docs, examples or scripts: about 15 MB instead of 105 MB) and
  ship with `SHA256SUMS.txt` and build provenance attestations; release notes
  come from this changelog; npm publishing runs only after the GitHub release
  exists and publishes with provenance.
- CI runs lint, typecheck and unit tests, builds the simulator on Linux,
  macOS and Windows, runs the end-to-end tests against it, checks the LVGL submodule pin
  and lints workflows and shell scripts.
- `scripts/setup.*` and `scripts/build.*`: Visual Studio detection via
  `vswhere` (any edition, including VS 2026), CMake/Ninja from PATH before
  ESP-IDF, exit codes checked after every native command, C and C++ compiler
  and CMake >= 3.16 checks, stale CMake caches from moved checkouts are
  discarded, Release builds, parallel Make builds (the server also passes
  `--parallel` to CMake for its Unix Makefiles fallback), the last rendered
  code in `build/user_code.c` is
  reset to the default placeholder (a broken snippet no longer breaks the
  build), and the smoke test fails the setup on error.

### Removed

- `styles.text_font_size` (see Breaking changes).
- Duplicate example files `examples/03-inspect.json` and
  `examples/03-esp32-small.png`.

## [2.0.0] - 2026-07-08

### Added

- Linux support: GCC/Clang toolchain in the MCP server, CMake generator
  autodetection (Ninja with Unix Makefiles fallback), `scripts/build.sh` and
  `scripts/setup.sh`.
- Linux x64 release archive `lvgl-mcp-esp32-linux-x64.tar.gz` and Linux CI jobs.
- Manual release via `workflow_dispatch`.

### Changed

- **LVGL 9.5.0** (from 9.2); widget types are reported with their class names
  (`lv_obj`, `lv_button`, `lv_label`, ...) instead of short names.
- postinstall downloads the release matching the package version (falling back
  to the latest release) and picks the archive for the current platform.
- Foreign CMake caches in the build directory are detected and discarded.

### Known issues

- The release run failed at the npm publish step; 2.0.0 was published to npm
  manually, without provenance.

## [1.2.2] - 2026-02-25

### Fixed

- postinstall is skipped while packaging the release archives.

Note: `package.json` still said 1.2.0, so this release run published npm
1.2.0. The release pipeline now refuses a tag that does not match
`package.json`.

## [1.2.1] - 2026-02-25

### Changed

- Removed the `os` restriction from `package.json` (tag only, no release).

## [1.2.0] - 2026-02-25

### Added

- Automated npm publishing from the release pipeline (`npx lvgl-mcp-server`)
  (tag only; npm 1.2.0 was published by the v1.2.2 run).

## [1.1.0] - 2026-02-25

### Added

- npm package with a postinstall step that downloads the prebuilt simulator
  (tag only, no release).

## [1.0.0] - 2026-02-25

### Added

- First release: headless LVGL 9.2 simulator (framebuffer display, PNG export,
  JSON widget tree with styles), MCP server with `lvgl_render`,
  `lvgl_render_full`, `lvgl_inspect` and `lvgl_set_resolution`, the
  `lvgl://api-reference` resource, Windows (MSVC) build scripts, CI and a
  tag-triggered release pipeline.

[Unreleased]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.2...v2.0.0
[1.2.2]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jaklys/Lvgl-mcp-esp32/releases/tag/v1.0.0
