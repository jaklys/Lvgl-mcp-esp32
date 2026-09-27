---
name: Bug report
about: Something renders wrong, fails to compile, or the server misbehaves
labels: bug
---

**What happened**
<!-- What did you expect, and what did you get instead? -->

**Environment**
- OS and version: <!-- e.g. Windows 11 24H2, Ubuntu 24.04 -->
- Node.js version (`node --version`):
- lvgl-mcp-server version (`npm ls -g lvgl-mcp-server`, or the git commit):
- Installed via: <!-- npm / npx / git checkout; pnpm, bun or --ignore-scripts? -->
- Toolchain: <!-- e.g. VS 2026 Build Tools / gcc 13.2 / clang 18, plus `cmake --version` and `ninja --version` -->
- LVGL version (the `lvgl_version` field of the widget tree, e.g. 9.6.0):
- MCP client: <!-- Claude Code, Cursor, VS Code, ... -->

**Code snippet**
```c
// The smallest snippet that reproduces the problem (lvgl_render / lvgl_render_full input)
```

**Tool parameters**
<!-- width/height/time_ms/settle/rotation/theme/include_tree, if not the defaults -->

**Server stderr**
<!-- The server logs to stderr with the [lvgl-mcp] prefix (Claude Code: `claude --debug`, or the MCP log). -->
```
paste here
```

**Screenshot / widget tree**
<!-- Attach the PNG and/or the JSON if relevant. -->
