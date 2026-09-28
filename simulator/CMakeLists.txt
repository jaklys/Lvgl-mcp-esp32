cmake_minimum_required(VERSION 3.16)
project(lvgl_simulator C CXX)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# C11 with compiler extensions for LVGL and the simulator alike
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

# ---------- LVGL configuration ----------
# lv_conf.h lives in this directory (next to the lib/ folder). LVGL adds this
# directory to its public include path, which is also how lv_conf.h finds
# hal/sim_assert.h.
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h" CACHE PATH "Path to lv_conf.h")
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
# ThorVG and every external dependency are disabled in lv_conf.h; make sure
# LVGL's CMake does not try to build or download them either.
set(CONFIG_LV_USE_THORVG OFF CACHE BOOL "" FORCE)
set(LV_FETCH_DEPENDENCIES OFF CACHE BOOL "" FORCE)

# ---------- LVGL library (prebuilt or from source) ----------
# -DLVGL_PREBUILT_DIR=<dir> links a prebuilt static LVGL (release archives ship
# one in prebuilt/<platform>/, scripts/build-prebuilt.sh|.ps1 make one);
# without it, or when <dir> does not match lv_conf.h / lib/lvgl, LVGL is
# compiled from lib/lvgl. Sets LVGL_USING_PREBUILT. See lib/lvgl_prebuilt.cmake.
include("${CMAKE_CURRENT_SOURCE_DIR}/lib/lvgl_prebuilt.cmake")

# ---------- User code ----------
# The MCP server writes user_code.c into the build directory before each build.
# A default placeholder is created during cmake configure if it does not exist.
set(USER_CODE_PATH "${CMAKE_CURRENT_BINARY_DIR}/user_code.c"
    CACHE FILEPATH "Path to the user code file")

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

# ---------- Extra user sources (render_project) ----------
# USER_EXTRA_SOURCES:        more user .c/.cpp files compiled with the user warnings
# USER_INCLUDE_DIRS:         include directories for the user files
# USER_COMPILE_DEFINITIONS:  preprocessor definitions for the user files (NAME or NAME=VALUE)
# LVGL_SIM_ESP_SHIMS:        defines LVGL_SIM_ESP_SHIMS=1 for the user files, so the snippet
#                            wrapper includes templates/esp_shim.h. The stand-in headers in
#                            templates/esp_shim/ (freertos/FreeRTOS.h, esp_log.h, ...) are
#                            always on the include path; they only pull in esp_shim.h.
set(USER_EXTRA_SOURCES "" CACHE STRING "Additional user source files (;-separated)")
set(USER_INCLUDE_DIRS "" CACHE STRING "Additional include directories for user code (;-separated)")
set(USER_COMPILE_DEFINITIONS "" CACHE STRING "Preprocessor definitions for user code (;-separated)")
option(LVGL_SIM_ESP_SHIMS "Compile user code with the ESP-IDF shims" OFF)
set(USER_SOURCES "${USER_CODE_PATH}" ${USER_EXTRA_SOURCES})

# ---------- Simulator executable ----------
set(SIM_SOURCES
    main.c
    sim_runtime.c
    hal/display_driver.c
    export/screenshot.c
    export/widget_tree.c
    export/annotate.c
    export/diagnostics.c
    export/events.c
    export/mem.c
    input/actions.c
    input/indev.c
    ui/ui_doc.c
    util/json.c
    util/jw.c
    templates/sim.c
)

# User code is its own object library so that its include path holds only
# the project's directories, the helper headers (sim.h, esp_shim.h) and LVGL:
# a project header named e.g. events.h or json.h must not be shadowed by the
# simulator's internal headers (and vice versa).
add_library(lvgl_sim_user OBJECT ${USER_SOURCES})
target_include_directories(lvgl_sim_user PRIVATE
    ${USER_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}/templates
    # Last, so a project's own headers win: ESP-IDF stand-ins such as
    # freertos/FreeRTOS.h and esp_log.h (they only pull in esp_shim.h)
    ${CMAKE_CURRENT_SOURCE_DIR}/templates/esp_shim
)
target_link_libraries(lvgl_sim_user PRIVATE lvgl)

add_executable(lvgl_sim ${SIM_SOURCES} $<TARGET_OBJECTS:lvgl_sim_user>)

target_include_directories(lvgl_sim PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/hal
    ${CMAKE_CURRENT_SOURCE_DIR}/export
    ${CMAKE_CURRENT_SOURCE_DIR}/input
    ${CMAKE_CURRENT_SOURCE_DIR}/ui
    ${CMAKE_CURRENT_SOURCE_DIR}/util
    ${CMAKE_CURRENT_SOURCE_DIR}/templates
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/stb
)

target_link_libraries(lvgl_sim PRIVATE lvgl)

# Unix/MinGW need explicit math library; MSVC includes it in CRT
if(UNIX OR MINGW)
    target_link_libraries(lvgl_sim PRIVATE m)
endif()

# ---------- Warnings ----------
# Calls to undeclared functions (e.g. a misspelled LVGL API) and bad pointer or
# integer conversions in user code must fail at compile time, not at link time
# or at runtime.
if(MSVC)
    # Sources and user snippets are UTF-8 (e.g. "°C" in label text)
    target_compile_options(lvgl_sim PRIVATE /utf-8)
    target_compile_options(lvgl_sim_user PRIVATE /utf-8)
    if(NOT LVGL_USING_PREBUILT) # an IMPORTED lvgl takes INTERFACE options only
        target_compile_options(lvgl PRIVATE /utf-8)
    endif()
    set_source_files_properties(${USER_SOURCES} PROPERTIES
        COMPILE_OPTIONS "/W3;/we4013;/we4047;/we4020")
else()
    # gcc, clang and Apple clang
    set(SIM_WARNINGS -Wall -Wextra)
    # The -Werror= flags below are C-only; user projects may contain C++ files
    set(USER_WARNINGS -Wall -Wextra -Wno-unused-parameter
        "$<$<COMPILE_LANGUAGE:C>:-Werror=implicit-function-declaration>"
        "$<$<COMPILE_LANGUAGE:C>:-Werror=int-conversion>"
        "$<$<COMPILE_LANGUAGE:C>:-Werror=incompatible-pointer-types>")
    if(APPLE)
        # The macOS SDK marks sprintf/vsprintf as deprecated. They are fine on
        # the ESP32 (and in stb_image_write), so keep the diagnostics the same
        # as on Linux. LVGL itself does not use deprecation attributes.
        list(APPEND SIM_WARNINGS -Wno-deprecated-declarations)
        list(APPEND USER_WARNINGS -Wno-deprecated-declarations)
    endif()
    set_source_files_properties(${SIM_SOURCES} PROPERTIES
        COMPILE_OPTIONS "${SIM_WARNINGS}")
    set_source_files_properties(${USER_SOURCES} PROPERTIES
        COMPILE_OPTIONS "${USER_WARNINGS}")
endif()

# ---------- User code definitions ----------
set(USER_DEFS LVGL_SIMULATOR=1 ${USER_COMPILE_DEFINITIONS})
if(LVGL_SIM_ESP_SHIMS)
    list(APPEND USER_DEFS LVGL_SIM_ESP_SHIMS=1)
endif()
set_property(SOURCE ${USER_SOURCES} APPEND PROPERTY COMPILE_DEFINITIONS ${USER_DEFS})
