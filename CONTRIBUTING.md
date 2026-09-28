# Contributing

Thanks for helping! Bug reports with a minimal snippet and the server's stderr
are the most useful contribution (see the issue template).

## Build

Prerequisites are listed in the [README](README.md#prerequisites): a C and C++
compiler, CMake >= 3.16, Ninja (or Make on Linux and macOS), git and Node.js >= 20.

```bash
git clone --recursive https://github.com/jaklys/Lvgl-mcp-esp32.git
cd Lvgl-mcp-esp32
./scripts/setup.sh                                   # Linux, macOS
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1   # Windows
```

The setup scripts build the simulator (`scripts/build.sh` / `scripts\build.bat`,
Release, in `simulator/build/`), run `npm ci --ignore-scripts` and
`npm run build` in `mcp-server/`, and smoke-test the binary.

macOS: install the Xcode Command Line Tools (`xcode-select --install`) and
`brew install cmake ninja node`; the compiler is Apple clang (`cc`/`c++`).
Other compilers are passed through `CC`/`CXX`, e.g.
`CC=clang CXX=clang++ ./scripts/build.sh` on Linux (catches clang-only
warnings before the macOS CI job does) or `CC=gcc-15 CXX=g++-15` with
Homebrew gcc on macOS. Keep `scripts/*.sh` portable to the bash 3.2 and BSD
tools that ship with macOS: no `readlink -f`, `nproc`, `sed -i` or other
GNU-only options (use `cd ... && pwd -P` and `getconf _NPROCESSORS_ONLN`).

Always install the server's dependencies with `--ignore-scripts` in the
checkout. postinstall is for npm users; it detects the checkout and skips
itself, but a downloaded `mcp-server/simulator/` would take precedence over the
simulator you are working on.

## Test

In `mcp-server/`:

```bash
npm run lint
npm run typecheck
npm test                 # unit + contract tests, no toolchain needed
LVGL_E2E=1 npm test      # plus end-to-end tests against ../simulator (needs the toolchain)
```

On Windows PowerShell: `$env:LVGL_E2E = "1"; npm test`.

Scripts: `shellcheck scripts/*.sh` and, for workflow changes,
[`actionlint`](https://github.com/rhysd/actionlint). CI runs all of the above on
Linux, macOS (Apple Silicon; Intel as an informational job) and Windows, a
Linux job that builds and verifies the prebuilt LVGL (gcc build, clang link,
UI render with no toolchain on `PATH`), a PowerShell syntax check of
`scripts/*.ps1`, and a check that the LVGL submodule sits exactly on the tag
named by `LVGL_TAG` in `.github/workflows/ci.yml` and that README and CHANGELOG
mention it.

Smoke-test any simulator binary with
`node scripts/smoke-test.mjs <lvgl_sim> [w] [h] [--ui FILE] [--expect-names a,b] [--no-toolchain]`.

Regenerate the example renders after changes that affect output:

```bash
node mcp-server/scripts/render-examples.mjs
```

## Prebuilt LVGL

Release archives ship `simulator/prebuilt/<platform>/` (`linux-x64`,
`windows-x64`, `macos-arm64`, `macos-x64`): LVGL as a static library built
with `simulator/lv_conf.h`, its headers, `lv_conf.sha256` and a `lvgl_sim`
that runs without a toolchain. The Release workflow builds it on each
runner; to build it locally:

```bash
./scripts/build-prebuilt.sh --verify          # Linux, macOS
```

```powershell
# Windows, from a Developer PowerShell for VS (cl, cmake and ninja on PATH)
powershell -ExecutionPolicy Bypass -File scripts\build-prebuilt.ps1 -Verify
```

`--verify` / `-Verify` configures the simulator with
`-DLVGL_PREBUILT_DIR=simulator/prebuilt/<platform>`, requires byte-identical
PNGs from the source build, the prebuilt link and the shipped `lvgl_sim`, and
checks that a modified `lv_conf.h` makes CMake fall back to the source build.
The logic lives in `simulator/lib/lvgl_prebuilt.cmake`; both scripts must
hash `lv_conf.h` the same way it does (SHA-256 with CR bytes removed).

Rebuild the prebuilt directory after changing `lv_conf.h`, anything it
includes (`hal/sim_assert.h`) or the LVGL submodule. CMake detects a changed
`lv_conf.h` or LVGL version and falls back to the source build with an
`LVGL_PREBUILT: not using ...` warning, but it cannot see changes to
included headers. Linux builds link `lvgl_sim` statically (`--no-static`
turns that off), Windows builds it with the static C runtime (`/MT`, while
`lvgl.lib` stays `/MD` for linking), macOS targets 11.0
(`MACOSX_DEPLOYMENT_TARGET`). `simulator/prebuilt/` and
`simulator/build-prebuilt/` are git-ignored.

## Adding a board preset

1. Add the board to `mcp-server/src/boards.ts` (id in lower-case kebab case,
   display name, width, height, colour format, DPI, default rotation, typical
   `LV_MEM_SIZE` in KB, notes). It is the single source of truth.
2. Regenerate the README boards table (between the `boards:start` and
   `boards:end` markers) with the generator script in `mcp-server/scripts/`.
3. Add or extend a unit test so the preset's defaults are checked, and
   mention the board in `CHANGELOG.md`.

## Adding a diagnostic

1. Detect it in the simulator (`simulator/export/`, where the widget tree is
   written) and emit `{code, severity, name, path, abs, message}`. The code is
   UPPER_SNAKE_CASE, the severity `error`, `warn` or `info`, and the message
   plain English with the measured numbers ("needs 212 px, has 160 px").
   Report only what can be measured, never guesses.
2. Make sure the server groups and prints it (`mcp-server/src/`), and add an
   e2e test with a snippet that triggers it and one that must not.
3. Document it: a row in the table in `docs/diagnostics.md` (meaning and
   typical fix), a row in the README's diagnostics table, the `lvgl_docs`
   topic if it has one, and `CHANGELOG.md`.

## Pull requests

- Keep changes focused; describe user-visible changes under `## [Unreleased]`
  in `CHANGELOG.md` and update the README when behavior or parameters change.
- The widget tree JSON, the JSON UI document format, action scripts and the
  simulator CLI are a contract between the C and TypeScript sides; change
  both (and the tests and `docs/`) together.
- Upgrading LVGL: move the submodule to the new tag, update the `.gitmodules`
  branch, `LVGL_TAG` in `ci.yml`, `lv_conf.h`, the `lvgl://api-reference`
  resource, README and CHANGELOG in one PR, and rebuild any local
  `simulator/prebuilt/` directory.

## Release

1. In `mcp-server/`: `npm version X.Y.Z --no-git-tag-version`.
2. Move the `Unreleased` notes in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`
   and add the compare link at the bottom.
3. Merge to `main`, then run the "Tag release" workflow (Actions -> Tag
   release -> Run workflow, version `X.Y.Z`; or
   `gh workflow run tag.yml -f version=X.Y.Z`). It checks the version, creates
   the annotated tag `vX.Y.Z` on `main` and starts the Release workflow; the
   job summary links the run. Pushing a tag by hand also starts it.
4. The Release workflow verifies the tag against `package.json`, the
   CHANGELOG, GitHub releases and npm; builds and tests on Linux x64, macOS
   arm64, macOS x64 and Windows x64, including the prebuilt LVGL and a
   no-toolchain render of `examples/06-ui.json` with the packaged `lvgl_sim`;
   creates the GitHub release with the four slim archives, `SHA256SUMS.txt`
   and provenance attestations; then publishes to npm with provenance.
5. If only a late job failed, fix the cause and use "Re-run failed jobs".

Publishing needs either the `NPM_TOKEN` repository secret (npm automation or
granular token with publish rights for `lvgl-mcp-server`) or npm trusted
publishing configured for this repository and `release.yml`.
