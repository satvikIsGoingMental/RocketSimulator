@echo off
REM ============================================================================
REM start.bat - local dev convenience only. Not part of the itch.io build
REM (tools/pack-itch.ps1 only ever stages index.html, css/, js/, vendor/).
REM
REM Assumes Node.js/npm is already installed. If npm can't be found, or the
REM serve command fails, this prints what to do next instead of guessing.
REM ============================================================================
setlocal

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo   npm was not found on your PATH.
    echo   Install Node.js ^(which includes npm^) from https://nodejs.org,
    echo   then run start.bat again.
    echo.
    pause
    exit /b 1
)

echo Starting local server at http://127.0.0.1:4173 ...
echo.

call npm run serve
if errorlevel 1 (
    echo.
    echo   npm run serve failed. Try running:
    echo.
    echo       npm install
    echo.
    echo   then run start.bat again.
    echo.
    pause
    exit /b 1
)

endlocal
