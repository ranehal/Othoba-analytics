@echo off
setlocal
cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=both"

if /i "%MODE%"=="scraper"   goto :scraper
if /i "%MODE%"=="dashbrd"   goto :dashboard
if /i "%MODE%"=="dashboard" goto :dashboard
if /i "%MODE%"=="both"      goto :both

echo Usage: runall.bat [scraper ^| dashbrd ^| both]
echo   (no argument = both)
exit /b 1

:scraper
echo.
echo  ============================================
echo   CartUp Price Tracker - daily snapshot
echo   scope: featured  ^(14 channels + flash + mega^)
echo  ============================================
echo.
echo [runall] running scraper (Python)...
python scraper.py --scope=featured --quiet=true
if errorlevel 1 goto :error
echo.
echo  ============================================
echo   Done. Data written to data\products.json
echo   + data\history.json + data\daily\YYYY-MM-DD.json
echo  ============================================
echo.
exit /b 0

:dashboard
echo.
echo  ============================================
echo   CartUp Price Tracker - dashboard
echo  ============================================
echo.
echo [runall] starting dashboard at http://localhost:3000 ...
start "CartUp Dashboard" cmd /c "npx --yes serve -l 3000 ."
timeout /t 3 >nul
start "" "http://localhost:3000"
exit /b 0

:both
call :scraper
if errorlevel 1 goto :error
call :dashboard
exit /b 0

:error
echo.
echo  [runall] ERROR: failed with exit code %errorlevel%
echo.
pause
exit /b 1
