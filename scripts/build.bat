@echo off
REM LVGL Simulator build script (MSVC + Ninja)
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to set up MSVC environment
    exit /b 1
)

set CMAKE=C:\Espressif\tools\cmake\3.30.2\bin\cmake.exe
set NINJA=C:\Espressif\tools\ninja\1.12.1\ninja.exe
set SIM_DIR=%~dp0..\simulator
set BUILD_DIR=%SIM_DIR%\build

echo Configuring...
"%CMAKE%" -S "%SIM_DIR%" -B "%BUILD_DIR%" -G Ninja -DCMAKE_MAKE_PROGRAM="%NINJA%" -DCMAKE_C_COMPILER=cl
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
