<#
.SYNOPSIS
    Builds an itch.io-ready zip of the Launch Simulator.

.DESCRIPTION
    itch.io serves an HTML5 game by unzipping the upload and loading index.html from the ARCHIVE
    ROOT - not from a folder inside it. This script stages only the files the game actually needs,
    validates them, and zips the staged *contents* so index.html lands at the root.

    Shipped:      index.html, css/, js/, vendor/
    Not shipped:  legacy/, tools/, tests/, node_modules/, dist/, test-results/, playwright-report/,
                  package.json, playwright.config.js, CLAUDE.md, dotfiles

    Validation is deliberately loud: a zip that is missing vendor/three/three.module.js, or that
    links a stylesheet which is not in the archive, looks fine locally (browser cache, dev server)
    and is dead on itch. Better to fail here.

.PARAMETER Version
    Optional suffix for the zip name, e.g. -Version 1.2.0 produces rocket-sim-itch-1.2.0.zip.

.PARAMETER OutDir
    Where to write the zip. Defaults to dist/ next to this script's parent.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/pack-itch.ps1
    powershell -ExecutionPolicy Bypass -File tools/pack-itch.ps1 -Version 1.2.0
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }

Write-Host "Packing $root for itch.io" -ForegroundColor Cyan

# ---------------------------------------------------------------- validation
$indexPath = Join-Path $root 'index.html'
if (-not (Test-Path $indexPath)) {
    throw "index.html not found at $indexPath - itch.io requires it at the archive root."
}

$threePath = Join-Path $root 'vendor\three\three.module.js'
if (-not (Test-Path $threePath)) {
    throw @"
vendor/three/three.module.js is missing.

The import map in index.html resolves "three" to that file. Without it the published game hangs on
"Loading 3D engine...". Restore it with:

    Invoke-WebRequest -Uri https://unpkg.com/three@0.160.0/build/three.module.js ``
                      -OutFile vendor/three/three.module.js -UseBasicParsing
"@
}

$indexHtml = Get-Content $indexPath -Raw

# Every local asset index.html references must exist. Catches a renamed css file or a stale <link>.
$referenced = @()
foreach ($m in [regex]::Matches($indexHtml, '(?:href|src)="(?!https?:|//|#|data:)([^"]+)"')) {
    $referenced += $m.Groups[1].Value
}
foreach ($m in [regex]::Matches($indexHtml, '"three"\s*:\s*"\./([^"]+)"')) {
    $referenced += $m.Groups[1].Value
}

# The header links out to the other apps in the Delta-v Stack suite (rocket-calc.html,
# rocket-designer.html, mission-log.html). Those live in their own projects and are not part of
# this build, so a missing sibling page is a warning; a missing css/js/vendor asset is fatal.
$missing = @()
$absentSiblings = @()
foreach ($rel in ($referenced | Sort-Object -Unique)) {
    $p = Join-Path $root ($rel -replace '/', '\')
    if (Test-Path $p) { continue }
    if ($rel -match '^[^/]+\.html$') { $absentSiblings += $rel } else { $missing += $rel }
}
if ($missing.Count -gt 0) {
    throw "index.html references files that do not exist:`n  " + ($missing -join "`n  ")
}
if ($absentSiblings.Count -gt 0) {
    Write-Host ("  note: header links to companion pages not in this build (they will 404 on itch): " + ($absentSiblings -join ', ')) -ForegroundColor Yellow
}

# Every module main.js pulls in must exist too - a bad relative path is a blank page on itch.
$jsRoot = Join-Path $root 'js'
$brokenImports = @()
foreach ($file in Get-ChildItem $jsRoot -Recurse -Filter *.js) {
    foreach ($m in [regex]::Matches((Get-Content $file.FullName -Raw), 'from\s+"(\.[^"]+)"')) {
        $target = Join-Path $file.DirectoryName ($m.Groups[1].Value -replace '/', '\')
        if (-not (Test-Path $target)) {
            $brokenImports += "$($file.FullName.Substring($root.Length + 1)) -> $($m.Groups[1].Value)"
        }
    }
}
if ($brokenImports.Count -gt 0) {
    throw "Broken module imports:`n  " + ($brokenImports -join "`n  ")
}

Write-Host "  validated index.html, $($referenced.Count) referenced asset(s), and all module imports" -ForegroundColor DarkGray

# ---------------------------------------------------------------- stage
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("rocket-itch-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
    Copy-Item $indexPath (Join-Path $stage 'index.html')
    foreach ($dir in @('css', 'js', 'vendor')) {
        $src = Join-Path $root $dir
        if (Test-Path $src) { Copy-Item $src -Destination $stage -Recurse }
    }

    # Nothing below should ever reach a published build.
    foreach ($junk in @('*.map', 'Thumbs.db', '.DS_Store')) {
        Get-ChildItem $stage -Recurse -Filter $junk -Force -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    $staged = Get-ChildItem $stage -Recurse -File
    $bytes = ($staged | Measure-Object -Property Length -Sum).Sum

    # ------------------------------------------------------------ zip
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $name = if ($Version) { "rocket-sim-itch-$Version.zip" } else { 'rocket-sim-itch.zip' }
    $zip = Join-Path $OutDir $name
    if (Test-Path $zip) { Remove-Item $zip -Force }

    # Compress the staged CONTENTS (stage\*), not the stage folder, so index.html is at the root.
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

    # ------------------------------------------------------------ verify the archive
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        # Compress-Archive on Windows PowerShell 5.1 writes backslash separators; normalise.
        $entries = $archive.Entries | ForEach-Object { $_.FullName.Replace([char]92, [char]47) }
        if ($entries -notcontains 'index.html') {
            throw "index.html is not at the root of $name - itch.io will not run this archive."
        }
        if (-not ($entries | Where-Object { $_ -like 'vendor/three/three.module.js' })) {
            throw "vendor/three/three.module.js is not in $name."
        }
        $entryCount = $entries.Count
    } finally {
        $archive.Dispose()
    }

    $zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
    $rawMb = [math]::Round($bytes / 1MB, 2)

    Write-Host ""
    Write-Host "  $zip" -ForegroundColor Green
    Write-Host "  $entryCount entries | $rawMb MB uncompressed | $zipMb MB zipped" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Upload to itch.io and tick 'This file will be played in the browser'." -ForegroundColor DarkGray
    Write-Host "  Suggested viewport: 1280 x 720, with 'Fullscreen button' enabled." -ForegroundColor DarkGray
}
finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
