@echo off
cd /d "%~dp0"
title Tracker Rodu

if not exist "node_modules" (
  echo Installing required components...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Installation failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"
call npm.cmd run dev

echo.
echo The application has stopped.
pause
