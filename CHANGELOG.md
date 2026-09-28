# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version is the
npm version of `lvgl-mcp-server`; release tags are `v<version>`.

## [Unreleased]

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

[Unreleased]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.2...v2.0.0
[1.2.2]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jaklys/Lvgl-mcp-esp32/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jaklys/Lvgl-mcp-esp32/releases/tag/v1.0.0
