# LVGL library: prebuilt static library or build from source.
#
# Included from simulator/CMakeLists.txt in place of add_subdirectory(lib/lvgl).
# Expects LV_BUILD_CONF_PATH (the simulator's lv_conf.h) to be set.
#
#   -DLVGL_PREBUILT_DIR=<dir>   link <dir>/liblvgl.a (lvgl.lib with MSVC)
#                               instead of compiling LVGL (~600 files)
#
# <dir> is what scripts/build-prebuilt.sh / .ps1 produce (and what release
# archives ship as simulator/prebuilt/<platform>/):
#
#   liblvgl.a | lvgl.lib   LVGL built in Release from lib/lvgl with lv_conf.h
#   include/               lvgl.h, lv_version.h, lvgl_private.h, include/**,
#                          src/**.h (the lib/lvgl layout, headers only)
#   lv_conf.sha256         SHA-256 of the lv_conf.h the library was built with
#                          (CR bytes removed, so CRLF checkouts match)
#   lvgl_sim(.exe)         simulator built from the same tree (not used here)
#
# The library bakes in lv_conf.h. When simulator/lv_conf.h (or the LVGL
# version) differs from what the library was built with, or the directory is
# incomplete, configure prints a warning starting with "LVGL_PREBUILT:" and
# falls back to add_subdirectory(lib/lvgl). Success prints
# "LVGL_PREBUILT: using <dir>".
#
# Sets LVGL_USING_PREBUILT (ON/OFF) and, like lib/lvgl does for its parent,
# LVGL_CONF_INC_DIR, LVGL_CONF_PATH and LVGL_COMPILER_DEFINES.
# The `lvgl` target is IMPORTED when LVGL_USING_PREBUILT is ON: only
# INTERFACE properties may be set on it (no target_compile_options(lvgl
# PRIVATE ...)).

set(LVGL_PREBUILT_DIR "" CACHE PATH
    "Prebuilt LVGL directory (liblvgl.a/lvgl.lib + include/ + lv_conf.sha256); empty = build LVGL from lib/lvgl")

set(LVGL_USING_PREBUILT OFF)
set(_lvgl_prebuilt_reason "")

# SHA-256 of a text file with CR bytes removed (matches build-prebuilt.sh/.ps1).
function(_lvgl_text_sha256 file out_var)
    file(READ "${file}" _content)
    string(REPLACE "\r" "" _content "${_content}")
    string(SHA256 _hash "${_content}")
    set(${out_var} "${_hash}" PARENT_SCOPE)
endfunction()

if(LVGL_PREBUILT_DIR)
    get_filename_component(_lvgl_pre_dir "${LVGL_PREBUILT_DIR}" ABSOLUTE
        BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    if(MSVC)
        set(_lvgl_pre_lib "${_lvgl_pre_dir}/lvgl.lib")
    else()
        set(_lvgl_pre_lib "${_lvgl_pre_dir}/liblvgl.a")
    endif()
    set(_lvgl_pre_inc "${_lvgl_pre_dir}/include")
    set(_lvgl_pre_sha "${_lvgl_pre_dir}/lv_conf.sha256")

    if(NOT EXISTS "${_lvgl_pre_lib}")
        set(_lvgl_prebuilt_reason "${_lvgl_pre_lib} not found")
    elseif(NOT EXISTS "${_lvgl_pre_inc}/lvgl.h" OR NOT EXISTS "${_lvgl_pre_inc}/include/lvgl/lv_version.h")
        set(_lvgl_prebuilt_reason "${_lvgl_pre_inc} does not contain the LVGL headers")
    elseif(NOT EXISTS "${_lvgl_pre_sha}")
        set(_lvgl_prebuilt_reason "${_lvgl_pre_sha} not found")
    elseif(NOT EXISTS "${LV_BUILD_CONF_PATH}")
        set(_lvgl_prebuilt_reason "lv_conf.h not found at ${LV_BUILD_CONF_PATH}")
    else()
        file(READ "${_lvgl_pre_sha}" _lvgl_pre_expected)
        string(REGEX MATCH "[0-9a-fA-F]+" _lvgl_pre_expected "${_lvgl_pre_expected}")
        string(TOLOWER "${_lvgl_pre_expected}" _lvgl_pre_expected)
        _lvgl_text_sha256("${LV_BUILD_CONF_PATH}" _lvgl_pre_actual)
        if(NOT _lvgl_pre_expected STREQUAL _lvgl_pre_actual)
            set(_lvgl_prebuilt_reason
                "${LV_BUILD_CONF_PATH} changed since the library was built (SHA-256 ${_lvgl_pre_actual}, library built with ${_lvgl_pre_expected})")
        else()
            # The LVGL sources next to us (when present) must be the version
            # the library was built from.
            set(_lvgl_src_ver "${CMAKE_CURRENT_SOURCE_DIR}/lib/lvgl/include/lvgl/lv_version.h")
            if(EXISTS "${_lvgl_src_ver}")
                _lvgl_text_sha256("${_lvgl_src_ver}" _lvgl_src_ver_hash)
                _lvgl_text_sha256("${_lvgl_pre_inc}/include/lvgl/lv_version.h" _lvgl_pre_ver_hash)
                if(NOT _lvgl_src_ver_hash STREQUAL _lvgl_pre_ver_hash)
                    set(_lvgl_prebuilt_reason
                        "the LVGL version in ${_lvgl_pre_inc} differs from lib/lvgl")
                endif()
            endif()
        endif()
    endif()

    if(_lvgl_prebuilt_reason)
        message(WARNING
            "LVGL_PREBUILT: not using the prebuilt LVGL in ${_lvgl_pre_dir}: ${_lvgl_prebuilt_reason}. "
            "Building LVGL from source instead (lib/lvgl; slower first build). "
            "Rebuild the prebuilt library with scripts/build-prebuilt.sh (or .ps1), "
            "or configure with -DLVGL_PREBUILT_DIR= to silence this.")
    else()
        set(LVGL_USING_PREBUILT ON)
    endif()
endif()

if(LVGL_USING_PREBUILT)
    message(STATUS "LVGL_PREBUILT: using ${_lvgl_pre_dir}")
    get_filename_component(_lvgl_conf_path "${LV_BUILD_CONF_PATH}" ABSOLUTE
        BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    get_filename_component(_lvgl_conf_dir "${_lvgl_conf_path}" DIRECTORY)

    add_library(lvgl STATIC IMPORTED GLOBAL)
    add_library(lvgl::lvgl ALIAS lvgl)
    # LVGL has C++ sources, so the source build links with the C++ driver;
    # do the same (libstdc++/libc++ when any object needs it).
    set_target_properties(lvgl PROPERTIES
        IMPORTED_LOCATION "${_lvgl_pre_lib}"
        IMPORTED_LINK_INTERFACE_LANGUAGES "C;CXX")
    # Same consumer interface as lib/lvgl's target (env_support/cmake/main.cmake):
    # the lib/lvgl root (lvgl.h, src/...), its include/ tree and the lv_conf.h
    # directory (lv_conf.h includes hal/sim_assert.h relative to it).
    # Imported include directories are SYSTEM, like LVGL's own.
    target_include_directories(lvgl INTERFACE
        "${_lvgl_pre_inc}"
        "${_lvgl_pre_inc}/include"
        "${_lvgl_conf_dir}")
    set(LVGL_COMPILER_DEFINES
        LV_KCONFIG_IGNORE
        "LV_CONF_PATH=\"${_lvgl_conf_path}\""
        LV_LVGL_H_INCLUDE_SIMPLE)
    target_compile_definitions(lvgl INTERFACE ${LVGL_COMPILER_DEFINES})
    if(MSVC)
        # lib/lvgl sets this PUBLIC: LVGL's variadic macros need it.
        target_compile_options(lvgl INTERFACE /Zc:preprocessor)
    endif()
    if(UNIX)
        target_link_libraries(lvgl INTERFACE m)
    endif()

    set(LVGL_CONF_INC_DIR "${_lvgl_conf_dir}")
    set(LVGL_CONF_PATH "${_lvgl_conf_path}")
else()
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/lvgl/CMakeLists.txt")
        message(FATAL_ERROR
            "LVGL sources not found in ${CMAKE_CURRENT_SOURCE_DIR}/lib/lvgl "
            "(run: git submodule update --init --recursive)")
    endif()
    # Exports its own include directories and compile definitions.
    add_subdirectory(lib/lvgl)
endif()
