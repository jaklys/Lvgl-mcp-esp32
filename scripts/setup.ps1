# LVGL MCP Server - setup script for Windows.
# Validates the toolchain (Visual Studio C++ tools via vswhere, CMake, Ninja,
# git, Node.js 20+), builds the simulator (scripts\build.bat) and the MCP
# server, smoke-tests the binary and prints the MCP client configuration.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SimulatorDir = Join-Path $ProjectRoot "simulator"
$BuildDir = Join-Path $SimulatorDir "build"
$McpServerDir = Join-Path $ProjectRoot "mcp-server"
$BuildBat = Join-Path $PSScriptRoot "build.bat"

function Fail([string]$Message) {
    Write-Host "[ERROR] $Message" -ForegroundColor Red
    exit 1
}

# Runs a native command and stops the script if it exits non-zero.
function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)." }
}

Write-Host "=== LVGL MCP Server Setup ===" -ForegroundColor Cyan

# --- git ---
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git not found. Install it from https://git-scm.com/download/win"
}
Write-Host "[OK] $(git --version)" -ForegroundColor Green

# --- Node.js 20+ ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js not found. Install Node.js 20+ from https://nodejs.org/"
}
$nodeVersion = (node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js 20+ required, found $nodeVersion." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm not found." }
Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green

# --- MSVC, CMake, Ninja (detection lives in build.bat: vswhere, PATH, ESP-IDF) ---
Invoke-Native "Toolchain check" { & $BuildBat --check }

# --- Initialize git submodules ---
if (-not (Test-Path (Join-Path $SimulatorDir "lib\lvgl\CMakeLists.txt"))) {
    Write-Host "Initializing git submodules..."
    Invoke-Native "git submodule update" { git -C $ProjectRoot submodule update --init --recursive }
}
Write-Host "[OK] LVGL submodule present" -ForegroundColor Green

# --- Build simulator ---
Write-Host ""
Write-Host "Building simulator..." -ForegroundColor Cyan
Invoke-Native "Simulator build" { & $BuildBat }
$SimExe = Join-Path $BuildDir "lvgl_sim.exe"
if (-not (Test-Path $SimExe)) { Fail "Simulator binary not found at $SimExe" }
Write-Host "[OK] Simulator built: $SimExe" -ForegroundColor Green

# --- Install and build MCP server ---
# --ignore-scripts: the postinstall download is for npm installs only; in a
# checkout the server must use the simulator built above.
Write-Host ""
Write-Host "Building MCP server..." -ForegroundColor Cyan
Push-Location $McpServerDir
try {
    Invoke-Native "npm ci" { npm ci --ignore-scripts }
    Invoke-Native "npm run build" { npm run build }
} finally {
    Pop-Location
}
Write-Host "[OK] MCP server built: $McpServerDir\dist\index.js" -ForegroundColor Green

# --- Smoke test (temp dir, nothing is left in the build dir) ---
Write-Host ""
Write-Host "Running smoke test..." -ForegroundColor Cyan
Invoke-Native "Smoke test" { node (Join-Path $PSScriptRoot "smoke-test.mjs") $SimExe 320 240 }

Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Green
Write-Host ""
$McpEntry = (Join-Path $McpServerDir "dist\index.js") -replace '\\', '/'
Write-Host "Register the server with Claude Code (run inside your ESP32 project):" -ForegroundColor Cyan
Write-Host "  claude mcp add lvgl-simulator -- node `"$McpEntry`""
Write-Host ""
Write-Host "or add this to .mcp.json in your project (Cursor/VS Code use the same shape):" -ForegroundColor Cyan
Write-Host @"
{
  "mcpServers": {
    "lvgl-simulator": {
      "command": "node",
      "args": ["$McpEntry"]
    }
  }
}
"@
