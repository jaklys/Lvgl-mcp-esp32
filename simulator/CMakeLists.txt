cmake_minimum_required(VERSION 3.16)
project(lvgl_simulator C)

# ---------- LVGL configuration ----------
# lv_conf.h lives in this directory (next to the lvgl/ folder)
set(LV_CONF_PATH
    "${CMAKE_CURRENT_SOURCE_DIR}/lv_conf.h"
    CACHE STRING "Path to lv_conf.h")
set(LV_CONF_BUILD_DISABLE_EXAMPLES ON CACHE BOOL "" FORCE)
set(LV_CONF_BUILD_DISABLE_DEMOS ON CACHE BOOL "" FORCE)

# Add LVGL as a subdirectory
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
add_executable(lvgl_sim
    main.c
    hal/display_driver.c
    export/screenshot.c
    export/widget_tree.c
    "${USER_CODE_PATH}"
)

target_include_directories(lvgl_sim PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/hal
    ${CMAKE_CURRENT_SOURCE_DIR}/export
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/stb
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/lvgl/src
)

target_link_libraries(lvgl_sim PRIVATE lvgl)

# MinGW needs explicit math library; MSVC includes it in CRT
if(MINGW)
    target_link_libraries(lvgl_sim PRIVATE m)
endif()

# Ensure C99
set_target_properties(lvgl_sim PROPERTIES
    C_STANDARD 99
    C_STANDARD_REQUIRED ON
)
