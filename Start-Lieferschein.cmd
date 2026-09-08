@echo off
REM Startet die Lieferschein-Maske auf diesem PC und oeffnet sie im Browser.
title Lieferschein-Maske
start "Lieferschein-Server" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\serve.ps1"
timeout /t 2 >nul
start "" http://localhost:8781/index.html
