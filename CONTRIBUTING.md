# Contributing

Thanks for helping! Bug reports with a minimal snippet and the server's stderr
are the most useful contribution (see the issue template).

## Build

Prerequisites are listed in the [README](README.md#prerequisites): a C and C++
compiler, CMake >= 3.16, Ninja (or Make on Linux), git and Node.js >= 20.

```bash
git clone --recursive https://github.com/jaklys/Lvgl-mcp-esp32.git
cd Lvgl-mcp-esp32
./scripts/setup.sh                                   # Linux, macOS (experimental)
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1   # Windows
```

The setup scripts build the simulator (`scripts/build.sh` / `scripts\build.bat`,
Release, in `simulator/build/`), run `npm ci --ignore-scripts` and
`npm run build` in `mcp-server/`, and smoke-test the binary.

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
Linux and Windows, plus a check that the LVGL submodule sits exactly on the tag
named by `LVGL_TAG` in `.github/workflows/ci.yml` and that README and CHANGELOG
mention it.

Regenerate the example renders after changes that affect output:

```bash
node mcp-server/scripts/render-examples.mjs
```

## Pull requests

- Keep changes focused; describe user-visible changes under `## [Unreleased]`
  in `CHANGELOG.md` and update the README when behavior or parameters change.
- The widget tree JSON and the simulator CLI are a contract between the C and
  TypeScript sides; change both (and the tests) together.
- Upgrading LVGL: move the submodule to the new tag, update the `.gitmodules`
  branch, `LVGL_TAG` in `ci.yml`, `lv_conf.h`, the `lvgl://api-reference`
  resource, README and CHANGELOG in one PR.

## Release

1. In `mcp-server/`: `npm version X.Y.Z --no-git-tag-version`.
2. Move the `Unreleased` notes in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`
   and add the compare link at the bottom.
3. Merge to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The Release workflow verifies the tag against `package.json`, the
   CHANGELOG, GitHub releases and npm; builds and tests on Linux and Windows;
   creates the GitHub release with slim archives, `SHA256SUMS.txt` and
   provenance attestations; then publishes to npm with provenance.
5. If only a late job failed, fix the cause and use "Re-run failed jobs".

Publishing needs either the `NPM_TOKEN` repository secret (npm automation or
granular token with publish rights for `lvgl-mcp-server`) or npm trusted
publishing configured for this repository and `release.yml`.
