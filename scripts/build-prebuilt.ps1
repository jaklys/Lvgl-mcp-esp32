# Builds the prebuilt LVGL artifacts for Windows x64 (MSVC):
#
#   simulator\prebuilt\windows-x64\
#     lvgl.lib         LVGL, Release, static, /MD, compiled with simulator\lv_conf.h
#     include\         LVGL headers in the lib\lvgl layout (lvgl.h, lv_version.h,
#                      lvgl_private.h, include\**, src\**.h)
#     lv_conf.sha256   SHA-256 of simulator\lv_conf.h (CR bytes removed)
#     lvgl_sim.exe     the simulator built from the same tree with the static
#                      C runtime (/MT), so it runs without the VC++ redistributable
#     BUILD-INFO.txt   platform, LVGL version, compiler, commit
#
# simulator\CMakeLists.txt links lvgl.lib when configured with
# -DLVGL_PREBUILT_DIR=<that dir> and falls back to compiling LVGL when lv_conf.h
# no longer matches lv_conf.sha256. Linux/macOS: scripts/build-prebuilt.sh.
#
# Run it from a Developer PowerShell for VS (cl.exe, cmake and ninja on PATH):
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-prebuilt.ps1 [-OutDir DIR] [-BuildDir DIR] [-Verify]
#
#   -OutDir DIR    default: simulator\prebuilt\windows-x64
#   -BuildDir DIR  default: simulator\build-prebuilt\windows-x64 (wiped first)
#   -Verify        then build the simulator against the prebuilt library,
#                  require byte-identical PNGs from the source build, the
#                  prebuilt link and the shipped lvgl_sim.exe, and check that a
#                  modified lv_conf.h makes CMake fall back to source

param(
    [string]$OutDir = "",
    [string]$BuildDir = "",
    [switch]$Verify
)

$ErrorActionPreference = "Stop"
$Platform = "windows-x64"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SimDir = Join-Path $RepoRoot "simulator"
$LvglDir = Join-Path $SimDir "lib\lvgl"

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}
function Log([string]$Message) { Write-Host "[build-prebuilt] $Message" }

# Runs a native command; stops the script if it exits non-zero.
function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)." }
}

# Runs cmake with all output in $LogFile. Windows PowerShell 5.1 turns
# redirected native stderr (CMake warnings) into errors, so relax the
# preference in this function's scope; the exit code is what counts.
function Invoke-CMakeLogged([string]$LogFile, [string[]]$CMakeArgs) {
    $ErrorActionPreference = "Continue"
    & cmake @CMakeArgs *> $LogFile
    return $LASTEXITCODE
}

function Resolve-Full([string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

# Must match _lvgl_text_sha256 in simulator\lib\lvgl_prebuilt.cmake.
function Get-TextSha256([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $list = New-Object System.Collections.Generic.List[byte] ($bytes.Length)
    foreach ($b in $bytes) { if ($b -ne 13) { $list.Add($b) } }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($list.ToArray())
    } finally { $sha.Dispose() }
    return ([System.BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
}

if (-not $OutDir) { $OutDir = Join-Path $SimDir "prebuilt\$Platform" }
if (-not $BuildDir) { $BuildDir = Join-Path $SimDir "build-prebuilt\$Platform" }
$OutDir = Resolve-Full $OutDir
$BuildDir = Resolve-Full $BuildDir

foreach ($tool in @("cl", "cmake", "ninja")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "$tool not found on PATH. Run this script from a Developer PowerShell for VS (x64) with CMake and Ninja."
    }
}
if (-not (Test-Path (Join-Path $LvglDir "CMakeLists.txt"))) {
    Fail "LVGL sources missing in $LvglDir (run: git submodule update --init --recursive)"
}

Log "Platform:   $Platform"
Log "Output:     $OutDir"
Log "Build dir:  $BuildDir"

$common = @("-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_C_COMPILER=cl", "-DCMAKE_CXX_COMPILER=cl")

if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
$mdDir = Join-Path $BuildDir "md"
$mtDir = Join-Path $BuildDir "mt"

# 1. lvgl.lib with the default dynamic C runtime (/MD), which is what every
#    later simulator build links with. lvgl_sim too, for -Verify.
Log "Building LVGL (/MD) in $mdDir"
Invoke-Native "configure (/MD)" { cmake -S $SimDir -B $mdDir @common "-DLVGL_PREBUILT_DIR=" }
Invoke-Native "build (/MD)" { cmake --build $mdDir --parallel --target lvgl_sim }

# 2. lvgl_sim.exe with the static C runtime (/MT): runs on machines without
#    Visual Studio or the VC++ redistributable (UI JSON mode, first render).
#    lib\lvgl declares an old cmake_minimum_required, so CMP0091 (honor
#    CMAKE_MSVC_RUNTIME_LIBRARY) must be defaulted to NEW explicitly.
Log "Building lvgl_sim.exe (/MT) in $mtDir"
Invoke-Native "configure (/MT)" {
    cmake -S $SimDir -B $mtDir @common "-DLVGL_PREBUILT_DIR=" `
        "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW" "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
}
Invoke-Native "build (/MT)" { cmake --build $mtDir --parallel --target lvgl_sim }

$lib = Join-Path $mdDir "lib\lvgl\lvgl.lib"
if (-not (Test-Path $lib)) {
    $found = Get-ChildItem -Path $mdDir -Recurse -Filter "lvgl.lib" | Select-Object -First 1
    if (-not $found) { Fail "lvgl.lib not found in $mdDir" }
    $lib = $found.FullName
}
$simMd = Join-Path $mdDir "lvgl_sim.exe"
$simMt = Join-Path $mtDir "lvgl_sim.exe"
if (-not (Test-Path $simMd) -or -not (Test-Path $simMt)) { Fail "lvgl_sim.exe missing in $BuildDir" }

$dumpbin = Get-Command dumpbin -ErrorAction SilentlyContinue
if ($dumpbin) {
    $deps = & dumpbin /nologo /dependents $simMt | Out-String
    if ($deps -match "(?i)vcruntime|msvcp|ucrtbase") {
        Write-Host $deps
        Fail "lvgl_sim.exe (/MT) still depends on the dynamic C runtime"
    }
}

# --- Assemble the output directory ---
$stage = "$OutDir.tmp"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
$incDir = Join-Path $stage "include"
New-Item -ItemType Directory -Force -Path $incDir | Out-Null
Copy-Item $lib (Join-Path $stage "lvgl.lib")
Copy-Item $simMt (Join-Path $stage "lvgl_sim.exe")

# Headers with the same layout as lib\lvgl, so "lvgl.h", "src/..." and
# "lvgl/..." resolve exactly as they do against the source tree.
foreach ($f in @("lvgl.h", "lv_version.h", "lvgl_private.h")) {
    $p = Join-Path $LvglDir $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $incDir $f) }
}
foreach ($sub in @("src", "include")) {
    & robocopy (Join-Path $LvglDir $sub) (Join-Path $incDir $sub) "*.h" "*.hpp" /S /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy of $sub headers failed (exit code $LASTEXITCODE)" }
}
$global:LASTEXITCODE = 0

$confSha = Get-TextSha256 (Join-Path $SimDir "lv_conf.h")
[System.IO.File]::WriteAllText((Join-Path $stage "lv_conf.sha256"), "$confSha  lv_conf.h`n")

$verHeader = Get-Content (Join-Path $LvglDir "include\lvgl\lv_version.h")
function Get-VersionField([string]$Name) {
    $m = $verHeader | Select-String -Pattern "^#define LVGL_VERSION_$Name\s+(\d+)" | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return "?"
}
$lvglVersion = "$(Get-VersionField 'MAJOR').$(Get-VersionField 'MINOR').$(Get-VersionField 'PATCH')"
$clVersion = "cl"
$clLog = Join-Path $BuildDir "cl-version.txt"
$ErrorActionPreference = "Continue"
& cl *> $clLog
$ErrorActionPreference = "Stop"
$clFirst = Get-Content $clLog -ErrorAction SilentlyContinue | Where-Object { $_ -match "\S" } | Select-Object -First 1
if ($clFirst) { $clVersion = "$clFirst".Trim() }
$commit = "unknown"
try {
    $c = & git -C $RepoRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { $commit = "$c".Trim() }
} catch { $commit = "unknown" }
$global:LASTEXITCODE = 0
$info = @(
    "platform: $Platform",
    "lvgl: $lvglVersion",
    "compiler: $clVersion",
    "generator: Ninja",
    "lvgl.lib runtime: /MD (MultiThreadedDLL)",
    "lvgl_sim.exe runtime: /MT (static)",
    "commit: $commit",
    "lv_conf.h sha256: $confSha",
    "built: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
)
[System.IO.File]::WriteAllText((Join-Path $stage "BUILD-INFO.txt"), (($info -join "`n") + "`n"))

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
$parent = Split-Path -Parent $OutDir
if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
Move-Item $stage $OutDir

Log "LVGL $lvglVersion prebuilt for ${Platform}:"
Get-ChildItem $OutDir | Format-Table Name, Length -AutoSize | Out-String | Write-Host
$headerCount = (Get-ChildItem -Recurse -File (Join-Path $OutDir "include")).Count
Log "$headerCount headers"

if (-not $Verify) { exit 0 }

# --- Verify ---
$vDir = "$BuildDir-verify"
if (Test-Path $vDir) { Remove-Item -Recurse -Force $vDir }
New-Item -ItemType Directory -Force -Path $vDir | Out-Null
$vBuild = Join-Path $vDir "build"
Log "Verify: configure + build against the prebuilt library in $vBuild"
$cfgLog = Join-Path $vDir "configure.log"
$rc = Invoke-CMakeLogged $cfgLog (@("-S", $SimDir, "-B", $vBuild) + $common + @("-DLVGL_PREBUILT_DIR=$OutDir"))
if ($rc -ne 0) { Get-Content $cfgLog | Write-Host; Fail "configure with LVGL_PREBUILT_DIR failed" }
if (-not (Select-String -Path $cfgLog -Pattern "LVGL_PREBUILT: using" -Quiet)) {
    Get-Content $cfgLog | Write-Host
    Fail "configure did not use the prebuilt library"
}
Invoke-Native "verify build" { cmake --build $vBuild --parallel --target lvgl_sim }
if (Test-Path (Join-Path $vBuild "lib\lvgl")) {
    $objs = Get-ChildItem -Recurse -File -Path (Join-Path $vBuild "lib\lvgl") -Filter "*.obj" -ErrorAction SilentlyContinue
    if ($objs) { Fail "the verify build compiled LVGL sources although the prebuilt library was selected" }
}

function Invoke-Render([string]$Exe, [string]$Prefix) {
    & $Exe --width 320 --height 240 --time-ms 330 --output-png "$Prefix.png" --output-json "$Prefix.json"
    if ($LASTEXITCODE -ne 0) { Fail "$Exe exited with $LASTEXITCODE" }
    return [System.IO.File]::ReadAllBytes("$Prefix.png")
}
function Test-SameBytes([byte[]]$A, [byte[]]$B) {
    if ($A.Length -ne $B.Length) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
    return $true
}
$pngSource = Invoke-Render $simMd (Join-Path $vDir "source")
$pngPrebuilt = Invoke-Render (Join-Path $vBuild "lvgl_sim.exe") (Join-Path $vDir "prebuilt")
$pngShipped = Invoke-Render (Join-Path $OutDir "lvgl_sim.exe") (Join-Path $vDir "shipped")
if (-not (Test-SameBytes $pngSource $pngPrebuilt)) { Fail "PNG from the prebuilt-linked simulator differs from the source build" }
if (-not (Test-SameBytes $pngSource $pngShipped)) { Fail "PNG from the shipped lvgl_sim.exe differs from the source build" }
Log "Verify: source build, prebuilt link and shipped lvgl_sim.exe render identical PNGs"

Log "Verify: a modified lv_conf.h must fall back to the source build"
$modConf = Join-Path $vDir "lv_conf.h"
Copy-Item (Join-Path $SimDir "lv_conf.h") $modConf
Add-Content -Path $modConf -Value "`n/* modified by build-prebuilt.ps1 -Verify */"
$fbLog = Join-Path $vDir "fallback.log"
$rc = Invoke-CMakeLogged $fbLog (@("-S", $SimDir, "-B", (Join-Path $vDir "fallback")) + $common + @("-DLVGL_PREBUILT_DIR=$OutDir", "-DLV_BUILD_CONF_PATH=$modConf"))
if ($rc -ne 0) { Get-Content $fbLog | Write-Host; Fail "configure with a modified lv_conf.h failed" }
if (-not (Select-String -Path $fbLog -Pattern "LVGL_PREBUILT: not using" -Quiet)) {
    Get-Content $fbLog | Write-Host
    Fail "a modified lv_conf.h did not trigger the fallback"
}
Log "Verify: OK"
Remove-Item -Recurse -Force $vDir
exit 0
