@echo off
setlocal EnableExtensions
title Unified Financial Reporting System - RESET LOCAL TEST DATABASE
cd /d "%~dp0"

echo ==============================================================
echo  RESET LOCAL TEST DATABASE - Phase 6.7
echo  Restores db\phase67-local-test.db from the pristine copy.
echo  Affects ONLY the isolated test database in this package.
echo  It NEVER touches any production database. custom.db is not
echo  part of this package and is never referenced.
echo ==============================================================

if not exist "db\phase67-local-test.backup.db" (
  echo [ERROR] Pristine copy db\phase67-local-test.backup.db not found.
  echo         The package is incomplete - re-extract the ZIP.
  pause
  exit /b 1
)

copy /Y "db\phase67-local-test.backup.db" "db\phase67-local-test.db" >nul
if errorlevel 1 (
  echo [ERROR] Copy failed - check file permissions / antivirus.
  pause
  exit /b 1
)

if exist "db\phase67-local-test.db-wal" del /q "db\phase67-local-test.db-wal"
if exist "db\phase67-local-test.db-shm" del /q "db\phase67-local-test.db-shm"

echo.
echo [OK] Test database restored to the pristine seeded state.
echo      Login: admin   Password: Preview-67-Admin!
pause
endlocal
