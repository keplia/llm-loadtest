@echo off
rem Double-click file ini untuk memasang LLM Load Test di Windows.
rem Butuh install.ps1 di folder yang sama.
setlocal
title LLM Load Test - Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Instalasi gagal. Periksa pesan di atas.
  pause
  exit /b 1
)
echo.
pause
