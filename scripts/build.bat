@echo off
REM LVGL simulator build script for Windows (MSVC + CMake + Ninja).
REM
REM   scripts\build.bat           check tools, configure and build (Release)
REM   scripts\build.bat --check   only check the toolchain (used by setup.ps1)
REM
REM MSVC:  cl.exe already on PATH (Developer Prompt), else %VCVARSALL_PATH%,
REM        else the newest Visual Studio / Build Tools found by vswhere
REM        (any edition, 2019, 2022, 2026, ...) with the C++ x64 tools.
REM CMake: %CMAKE_PATH%, else PATH, else ESP-IDF (%IDF_TOOLS_PATH% or
REM        C:\Espressif\tools), else the copy bundled with Visual Studio.
REM Ninja: %NINJA_PATH%, else PATH, else ESP-IDF, else Visual Studio.
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0..\simulator") do set "SIM_DIR=%%~fI"
set "BUILD_DIR=%SIM_DIR%\build"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "IDF_TOOLS=%IDF_TOOLS_PATH%"
if not defined IDF_TOOLS set "IDF_TOOLS=C:\Espressif\tools"
set "VSINSTALL="

REM ---------- MSVC environment ----------
where cl >nul 2>&1
if not errorlevel 1 (
    echo [OK] cl.exe already on PATH
    goto :msvc_ready
)
set "VCVARSALL="
if defined VCVARSALL_PATH if exist "%VCVARSALL_PATH%" set "VCVARSALL=%VCVARSALL_PATH%"
if defined VCVARSALL goto :call_vcvars
if not exist "%VSWHERE%" goto :no_msvc
REM The extra outer quotes survive cmd /c quote stripping ("(x86)" in the path).
for /f "usebackq delims=" %%i in (`""%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`) do set "VSINSTALL=%%i"
if not defined VSINSTALL for /f "usebackq delims=" %%i in (`""%VSWHERE%" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`) do set "VSINSTALL=%%i"
if not defined VSINSTALL goto :no_msvc
set "VCVARSALL=%VSINSTALL%\VC\Auxiliary\Build\vcvarsall.bat"
if not exist "%VCVARSALL%" goto :no_msvc

:call_vcvars
echo [OK] vcvarsall: %VCVARSALL%
REM vcvarsall's own errorlevel is unreliable; check for cl.exe instead.
call "%VCVARSALL%" x64 >nul
where cl >nul 2>&1
if errorlevel 1 (
    echo ERROR: vcvarsall.bat x64 did not put cl.exe on PATH
    exit /b 1
)

:msvc_ready

REM ---------- CMake ----------
set "CMAKE="
if defined CMAKE_PATH if exist "%CMAKE_PATH%" set "CMAKE=%CMAKE_PATH%"
if not defined CMAKE for /f "delims=" %%i in ('where cmake 2^>nul') do if not defined CMAKE set "CMAKE=%%i"
if not defined CMAKE for /d %%d in ("%IDF_TOOLS%\cmake\*") do if exist "%%d\bin\cmake.exe" set "CMAKE=%%d\bin\cmake.exe"
if not defined CMAKE if defined VSINSTALL if exist "%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" set "CMAKE=%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
if not defined CMAKE (
    echo ERROR: CMake not found. Install it ^(https://cmake.org/download/^), ESP-IDF, or the
    echo        "C++ CMake tools for Windows" Visual Studio component, or set CMAKE_PATH.
    exit /b 1
)
echo [OK] CMake: %CMAKE%

REM ---------- Ninja ----------
set "NINJA="
if defined NINJA_PATH if exist "%NINJA_PATH%" set "NINJA=%NINJA_PATH%"
if not defined NINJA for /f "delims=" %%i in ('where ninja 2^>nul') do if not defined NINJA set "NINJA=%%i"
if not defined NINJA for /d %%d in ("%IDF_TOOLS%\ninja\*") do if exist "%%d\ninja.exe" set "NINJA=%%d\ninja.exe"
if not defined NINJA if defined VSINSTALL if exist "%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe" set "NINJA=%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
if not defined NINJA (
    echo ERROR: Ninja not found. Install it ^(winget install Ninja-build.Ninja^), ESP-IDF, or
    echo        the "C++ CMake tools for Windows" Visual Studio component, or set NINJA_PATH.
    exit /b 1
)
echo [OK] Ninja: %NINJA%

if /i "%~1"=="--check" exit /b 0

REM ---------- LVGL submodule ----------
if not exist "%SIM_DIR%\lib\lvgl\CMakeLists.txt" (
    echo Initializing git submodules...
    git -C "%SIM_DIR%\.." submodule update --init --recursive
    if errorlevel 1 (
        echo ERROR: git submodule update failed
        exit /b 1
    )
)

REM ---------- Discard a stale CMake cache (moved checkout) ----------
if exist "%BUILD_DIR%\CMakeCache.txt" (
    set "CACHED_HOME="
    for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"CMAKE_HOME_DIRECTORY:INTERNAL=" "%BUILD_DIR%\CMakeCache.txt"') do set "CACHED_HOME=%%b"
    set "SIM_FWD=!SIM_DIR:\=/!"
    if /i not "!CACHED_HOME!"=="!SIM_FWD!" (
        echo Stale CMake cache from "!CACHED_HOME!"; wiping "%BUILD_DIR%"
        rmdir /s /q "%BUILD_DIR%"
    )
)

REM ---------- Reset the user code ----------
REM The MCP server writes the last rendered code into build\user_code.c. It may
REM not compile; configure regenerates the default placeholder when it is
REM missing. The server rewrites it on every render.
if exist "%BUILD_DIR%\user_code.c" del /f /q "%BUILD_DIR%\user_code.c"
if exist "%BUILD_DIR%\snippet.c" del /f /q "%BUILD_DIR%\snippet.c"

echo Configuring...
"%CMAKE%" -S "%SIM_DIR%" -B "%BUILD_DIR%" -G Ninja -DCMAKE_MAKE_PROGRAM="%NINJA%" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl
if errorlevel 1 (
    echo ERROR: CMake configure failed
    exit /b 1
)

echo Building...
"%CMAKE%" --build "%BUILD_DIR%"
if errorlevel 1 (
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo Build complete: %BUILD_DIR%\lvgl_sim.exe
exit /b 0

:no_msvc
echo ERROR: No Visual Studio / Build Tools installation with the C++ x64 tools was found.
echo        Install "Build Tools for Visual Studio" with the "Desktop development with C++"
echo        workload: https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo        or set VCVARSALL_PATH to your vcvarsall.bat.
exit /b 1
