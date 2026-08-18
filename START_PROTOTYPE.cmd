@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Universal HTTP Video Studio - V1 Prototype
echo Opening http://127.0.0.1:4173/prototype/
echo.

start "" "http://127.0.0.1:4173/prototype/"
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 4173 --bind 127.0.0.1
) else (
  python -m http.server 4173 --bind 127.0.0.1
)

endlocal