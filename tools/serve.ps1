<#
.SYNOPSIS
    Serves the project over HTTP for local development.

.DESCRIPTION
    ES modules do not load over file:// - opening index.html by double-clicking gives a CORS error
    and a blank page. This starts a plain static server on the project root so js/main.js and its
    import graph resolve normally, then opens the browser.

    Uses node's http-server if node_modules are installed (npm install), and falls back to a
    minimal built-in .NET HttpListener server if they are not, so the project stays runnable with
    no npm dependency at all.

.PARAMETER Port
    Port to listen on. Default 4173, the same port playwright.config.js uses.

.PARAMETER NoBrowser
    Do not open a browser window.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools/serve.ps1
    powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8080 -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 4173,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/index.html"

if (-not $NoBrowser) {
    Start-Job -ScriptBlock { Start-Sleep -Seconds 2; Start-Process $using:url } | Out-Null
}

if (Test-Path (Join-Path $root 'node_modules\http-server')) {
    Write-Host "Serving $root at $url  (Ctrl+C to stop)" -ForegroundColor Cyan
    Push-Location $root
    try { & npx http-server . -p $Port -c-1 -a 127.0.0.1 }
    finally { Pop-Location }
    return
}

# ---- fallback: no npm install, use .NET's HttpListener ----------------------
Write-Host "Serving $root at $url  (built-in server, Ctrl+C to stop)" -ForegroundColor Cyan

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
    '.woff2'= 'font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if (-not $rel) { $rel = 'index.html' }
        $file = Join-Path $root ($rel -replace '/', '\')

        # Never serve anything outside the project root.
        $full = [System.IO.Path]::GetFullPath($file)
        if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
            $ctx.Response.StatusCode = 404
            $ctx.Response.Close()
            continue
        }

        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $ctx.Response.Headers.Add('Cache-Control', 'no-store')
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $ctx.Response.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Dispose()
}
