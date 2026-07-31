@echo off
REM Development mode: electronmon watches main.js / preload.js / renderer/*
REM and restarts (or reloads) the app automatically when they change.
cd /d "%~dp0"
npm run dev
pause
