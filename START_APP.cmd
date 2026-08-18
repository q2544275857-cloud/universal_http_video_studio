@echo off
setlocal
cd /d "%~dp0"
set PORT=4174

curl -s --max-time 2 http://127.0.0.1:%PORT%/api/health >nul 2>&1
if %errorlevel%==0 (
  start "" "http://127.0.0.1:%PORT%"
  exit /b 0
)

netstat -ano | findstr "127.0.0.1:%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo.
  echo [ERROR] Port %PORT% is occupied by another program.
  echo Close that program or run: netstat -ano ^| findstr :%PORT%
  echo Then stop the returned PID with: taskkill /PID PID /F
  echo.
  pause
  exit /b 1
)

start "Universal HTTP Video Studio" cmd /k "node server\index.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
endlocal
