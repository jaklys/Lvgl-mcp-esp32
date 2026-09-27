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

# Add LVGL as a subdirectory (exports its own include directories)
add_subdirectory(lib/lvgl)

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

# ---------- Simulator executable ----------
set(SIM_SOURCES
    main.c
    hal/display_driver.c
    export/screenshot.c
    export/widget_tree.c
)

add_executable(lvgl_sim ${SIM_SOURCES} "${USER_CODE_PATH}")

target_include_directories(lvgl_sim PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/hal
    ${CMAKE_CURRENT_SOURCE_DIR}/export
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
    target_compile_options(lvgl PRIVATE /utf-8)
    set_source_files_properties("${USER_CODE_PATH}" PROPERTIES
        COMPILE_OPTIONS "/W3;/we4013;/we4047;/we4020")
else()
    set_source_files_properties(${SIM_SOURCES} PROPERTIES
        COMPILE_OPTIONS "-Wall;-Wextra")
    set_source_files_properties("${USER_CODE_PATH}" PROPERTIES
        COMPILE_OPTIONS "-Wall;-Wextra;-Wno-unused-parameter;-Werror=implicit-function-declaration;-Werror=int-conversion;-Werror=incompatible-pointer-types")
endif()
