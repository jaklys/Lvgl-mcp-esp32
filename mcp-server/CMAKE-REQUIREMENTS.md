# CMake interface required by mcp-server 2.2.0

`simulator/CMakeLists.txt` is owned by the simulator side; this file lists what the server
(`src/simulator/compiler.ts`) passes on the `cmake` configure command line and what the CMake
side must do with it. Integration: paste the snippet below into `simulator/CMakeLists.txt`.

## What the server passes

Every configure (`cmake -S <sim> -B <build> -G Ninja -DCMAKE_BUILD_TYPE=Release ...`) now also gets:

| Argument | Meaning |
|---|---|
| `-DLVGL_PREBUILT_DIR=<sim>/prebuilt/<platform>` | link the prebuilt LVGL (contract section 7) - only when `liblvgl.a` / `liblvgl.lib` / `lvgl.lib` exists there and no earlier link failure disabled it |
| `-ULVGL_PREBUILT_DIR` | otherwise: remove it from the cache, build LVGL from `lib/lvgl` |
| `-DUSER_SOURCES=<abs>;<abs>;...` | extra user sources (project mode: all `.c/.cpp` of the project). Empty string when unused. Forward slashes. |
| `-DUSER_INCLUDE_DIRS=<abs>;...` | include dirs for the user sources (project root, dirs with headers, `include_dirs`, and with ESP shims `<build>/esp_idf_shims` + `<sim>/templates`). Empty when unused. |
| `-DUSER_DEFINES=NAME;NAME=value;...` | compile definitions for the user sources (`defines`, plus `LVGL_SIM_ESP_SHIMS=1` with ESP shims). Empty when unused. |

`user_code.c` stays `USER_CODE_PATH` (`<build>/user_code.c`). In project mode the server writes a
generated wrapper there (`void create_ui(void) { ui_init(); }`), so `create_ui()` keeps coming from
`USER_CODE_PATH`. The server re-runs configure whenever one of the values above changes (switching
between snippet and project mode, other defines, ...), so the CMake code must tolerate repeated
configures with different lists.

## Requirements

1. `USER_SOURCES` are compiled into `lvgl_sim` next to `USER_CODE_PATH`, with the same user warning
   flags (`USER_WARNINGS` / MSVC `/W3;/we4013;/we4047;/we4020`), so diagnostics are identical.
2. `USER_INCLUDE_DIRS` and `USER_DEFINES` apply to `USER_CODE_PATH` **and** `USER_SOURCES` only
   (source-file properties), never to LVGL or the simulator's own sources (a project's headers must not
   shadow simulator headers, and a project `lv_conf.h` must not replace ours - keep `LV_CONF_PATH`
   propagating from the `lvgl` target).
3. `.cpp` files in `USER_SOURCES` compile as C++ (the project already enables `CXX`); C-only warning flags
   must be limited to C (`$<$<COMPILE_LANGUAGE:C>:...>`), otherwise g++/clang++ complain about
   `-Werror=implicit-function-declaration` etc.
4. `simulator/templates` is on the include path of user code (contract section 4: `#include "sim.h"` in
   full mode). The server adds it itself when ESP shims are on, but full-file renders without shims
   depend on the CMake side.
5. The `LVGL_PREBUILT_DIR` block (owned by agent C) must test `if(LVGL_PREBUILT_DIR)` so that
   `-ULVGL_PREBUILT_DIR` switches back to `add_subdirectory(lib/lvgl)` in the same build directory.
   The imported target must be called `lvgl` and carry the LVGL include dirs and `LV_CONF_PATH` (or
   equivalent) as INTERFACE properties, so `target_link_libraries(lvgl_sim PRIVATE lvgl)` is unchanged.
6. The server recognises a prebuilt link failure by the prebuilt directory/library name on an error line or
   by mismatch signatures (LNK2038/LNK1112/LNK1104, "file format not recognized", "building for ... but
   attempting to link with file built for ...", PIE/LTO errors) and then reconfigures with
   `-ULVGL_PREBUILT_DIR` once per session. Nothing else is needed on the CMake side.

## Snippet (replace the "User code" and "Simulator executable" parts)

```cmake
# ---------- User code ----------
set(USER_CODE_PATH "${CMAKE_CURRENT_BINARY_DIR}/user_code.c"
    CACHE FILEPATH "Path to the user code file")
# Project mode / ESP shims (set by the MCP server on every configure; empty lists when unused)
set(USER_SOURCES "" CACHE STRING "Extra user sources (;-list, absolute paths)")
set(USER_INCLUDE_DIRS "" CACHE STRING "Include directories for the user sources (;-list)")
set(USER_DEFINES "" CACHE STRING "Compile definitions for the user sources (;-list)")

if(NOT EXISTS "${USER_CODE_PATH}")
    file(WRITE "${USER_CODE_PATH}"
        "#include \"lvgl.h\"\n"
        "void create_ui(void) {\n"
        "    lv_obj_t *label = lv_label_create(lv_screen_active());\n"
        "    lv_label_set_text(label, \"LVGL Simulator Ready\");\n"
        "    lv_obj_center(label);\n"
        "}\n"
    )
endif()

set(ALL_USER_SOURCES "${USER_CODE_PATH}" ${USER_SOURCES})

# ---------- Simulator executable ----------
add_executable(lvgl_sim ${SIM_SOURCES} ${ALL_USER_SOURCES})

target_include_directories(lvgl_sim PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/hal
    ${CMAKE_CURRENT_SOURCE_DIR}/export
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/stb
)

# User code only: templates (sim.h, esp_shim.h), project include dirs and defines
set(USER_INCLUDES "${CMAKE_CURRENT_SOURCE_DIR}/templates" ${USER_INCLUDE_DIRS})
set_source_files_properties(${ALL_USER_SOURCES} PROPERTIES
    INCLUDE_DIRECTORIES "${USER_INCLUDES}"
    COMPILE_DEFINITIONS "${USER_DEFINES}")

target_link_libraries(lvgl_sim PRIVATE lvgl)
if(UNIX OR MINGW)
    target_link_libraries(lvgl_sim PRIVATE m)
endif()

# ---------- Warnings ----------
if(MSVC)
    target_compile_options(lvgl_sim PRIVATE /utf-8)
    if(TARGET lvgl AND NOT LVGL_PREBUILT_DIR)
        target_compile_options(lvgl PRIVATE /utf-8)
    endif()
    set_property(SOURCE ${ALL_USER_SOURCES} APPEND PROPERTY COMPILE_OPTIONS
        /W3 "$<$<COMPILE_LANGUAGE:C>:/we4013;/we4047;/we4020>")
else()
    set(SIM_WARNINGS -Wall -Wextra)
    set(USER_WARNINGS -Wall -Wextra -Wno-unused-parameter
        "$<$<COMPILE_LANGUAGE:C>:-Werror=implicit-function-declaration;-Werror=int-conversion;-Werror=incompatible-pointer-types>")
    if(APPLE)
        list(APPEND SIM_WARNINGS -Wno-deprecated-declarations)
        list(APPEND USER_WARNINGS -Wno-deprecated-declarations)
    endif()
    set_source_files_properties(${SIM_SOURCES} PROPERTIES COMPILE_OPTIONS "${SIM_WARNINGS}")
    set_property(SOURCE ${ALL_USER_SOURCES} APPEND PROPERTY COMPILE_OPTIONS ${USER_WARNINGS})
endif()
```

Notes:
- `INCLUDE_DIRECTORIES` as a source-file property needs CMake >= 3.11 (the project requires 3.16).
- Generator expressions in `COMPILE_OPTIONS` source properties are supported by Ninja and Makefile
  generators (CMake >= 3.11).
- Keep `/utf-8` on `lvgl` only when LVGL is built from source (an IMPORTED target has no compile step).
