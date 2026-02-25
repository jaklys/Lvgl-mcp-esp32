# LVGL MCP Server - Setup Script
# Validates build tools (MSVC, CMake, Ninja, Node.js), builds simulator and MCP server.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SimulatorDir = Join-Path $ProjectRoot "simulator"
$BuildDir = Join-Path $SimulatorDir "build"
$McpServerDir = Join-Path $ProjectRoot "mcp-server"

Write-Host "=== LVGL MCP Server Setup ===" -ForegroundColor Cyan

# --- Check MSVC ---
$VcvarsallPath = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $VcvarsallPath)) {
    $VcvarsallPath = "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
}
if (-not (Test-Path $VcvarsallPath)) {
    $VcvarsallPath = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
}
if (-not (Test-Path $VcvarsallPath)) {
    Write-Host "[ERROR] Visual Studio Build Tools not found." -ForegroundColor Red
    Write-Host "  Install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
    exit 1
}
Write-Host "[OK] MSVC Build Tools: $VcvarsallPath" -ForegroundColor Green

# --- Check CMake ---
$CmakePath = "C:\Espressif\tools\cmake\3.30.2\bin\cmake.exe"
if (-not (Test-Path $CmakePath)) {
    $cmake = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cmake) { $CmakePath = $cmake.Source }
    else { Write-Host "[ERROR] CMake not found." -ForegroundColor Red; exit 1 }
}
Write-Host "[OK] CMake: $CmakePath" -ForegroundColor Green

# --- Check Ninja ---
$NinjaPath = "C:\Espressif\tools\ninja\1.12.1\ninja.exe"
if (-not (Test-Path $NinjaPath)) {
    $ninja = Get-Command ninja -ErrorAction SilentlyContinue
    if ($ninja) { $NinjaPath = $ninja.Source }
    else { Write-Host "[ERROR] Ninja not found." -ForegroundColor Red; exit 1 }
}
Write-Host "[OK] Ninja: $NinjaPath" -ForegroundColor Green

# --- Check Node.js ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "[ERROR] Node.js not found." -ForegroundColor Red; exit 1
}
Write-Host "[OK] Node.js: $(node --version)" -ForegroundColor Green

# --- Initialize git submodules ---
$lvglSrc = Join-Path $SimulatorDir "lib\lvgl\src"
if (-not (Test-Path $lvglSrc)) {
    Write-Host "Initializing git submodules..."
    Push-Location $ProjectRoot
    git submodule update --init --recursive
    Pop-Location
}
Write-Host "[OK] LVGL submodule present" -ForegroundColor Green

# --- Build simulator ---
Write-Host ""
Write-Host "Building simulator..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

$batchContent = @"
@echo off
call "$VcvarsallPath" x64 >nul 2>&1
"$CmakePath" -S "$SimulatorDir" -B "$BuildDir" -G Ninja -DCMAKE_MAKE_PROGRAM="$NinjaPath" -DCMAKE_C_COMPILER=cl
if errorlevel 1 exit /b 1
"$CmakePath" --build "$BuildDir"
"@
$batchPath = Join-Path $BuildDir "_setup_build.bat"
$batchContent | Set-Content -Path $batchPath -Encoding ASCII
& cmd.exe /c $batchPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Simulator build failed." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Simulator built: $BuildDir\lvgl_sim.exe" -ForegroundColor Green

# --- Install and build MCP server ---
Write-Host ""
Write-Host "Building MCP server..." -ForegroundColor Cyan
Push-Location $McpServerDir
npm install
npm run build
Pop-Location
Write-Host "[OK] MCP server built: $McpServerDir\dist\index.js" -ForegroundColor Green

# --- Quick test ---
Write-Host ""
Write-Host "Running quick test..." -ForegroundColor Cyan
& "$BuildDir\lvgl_sim.exe" --output-png "$BuildDir\test.png" --output-json "$BuildDir\test.json" 2>&1
if (Test-Path "$BuildDir\test.png") {
    Write-Host "[OK] Test screenshot generated." -ForegroundColor Green
} else {
    Write-Host "[WARN] Test screenshot not generated." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Add this to your Claude Code MCP settings:" -ForegroundColor Cyan
$McpServerPath = "$McpServerDir\dist\index.js" -replace '\\','/'
Write-Host @"
{
  "mcpServers": {
    "lvgl-simulator": {
      "command": "node",
      "args": ["$McpServerPath"]
    }
  }
}
"@
