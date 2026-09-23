@echo off
setlocal EnableExtensions
title Unified Financial Reporting System - Phase 6.7 LOCAL TEST (localhost only)
cd /d "%~dp0"

echo ==============================================================
echo  Unified Financial Reporting System - Phase 6.7
echo  WINDOWS LOCAL TEST PACKAGE - LOCALHOST ONLY
echo  Isolated test database : db\phase67-local-test.db
echo  This package NEVER uses production custom.db.
echo ==============================================================
echo.

rem ---- [1/7] SAFETY GUARD: production database is never allowed --------------
set "DBNAME=phase67-local-test.db"
set "DBPATH=%~dp0db\phase67-local-test.db"
echo %DBPATH% | findstr /i "custom.db" >nul 2>nul
if not errorlevel 1 (
  echo LOCAL TEST SAFETY BLOCK: Production database is not allowed.
  goto fail
)
if not exist "%DBPATH%" (
  echo [ERROR] Isolated test database db\phase67-local-test.db was not found.
  echo         Run RESET-LOCAL-TEST.cmd, or re-extract the ZIP if the backup
  echo         copy is missing too.
  goto fail
)

rem ---- [2/7] Node.js present? ------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js 20.9 or newer from https://nodejs.org/
  echo         then re-run this script.
  goto fail
)

rem ---- [3/7] Node.js version >= 20.9 ? --------------------------------------
set "NODEV="
for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
set "NODEV=%NODEV:v=%"
for /f "tokens=1,2 delims=." %%a in ("%NODEV%") do (
  set "NMAJOR=%%a"
  set "NMINOR=%%b"
)
echo [INFO] Node.js detected: %NODEV%
if %NMAJOR% LSS 20 goto nodeold
if %NMAJOR% EQU 20 if %NMINOR% LSS 9 goto nodeold

rem ---- [4/7] Dependencies from the shipped lockfile (npm only, no Bun) ------
if not exist "node_modules\" (
  echo [INFO] node_modules not found - installing dependencies with npm ci
  echo        versions are locked in package-lock.json - no surprises.
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [WARN] npm ci failed - falling back to npm install ...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
      echo [ERROR] Dependency installation failed. Read the messages above.
      goto fail
    )
  )
) else (
  echo [INFO] node_modules found - skipping dependency installation.
)

rem ---- [5/7] Prisma Client: FUNCTIONAL verify + auto-generate (6.7 fix) ------
rem The 6.2D package only checked that node_modules\.prisma\client existed, so a
rem stale/broken client slipped through and required a manual "prisma generate".
rem Now we probe the client functionally and regenerate automatically when needed.
echo [INFO] Verifying Prisma client (functional probe) ...
call node scripts\verify-prisma-client.js "%DBPATH%"
if errorlevel 1 (
  echo [INFO] Prisma client is missing or stale - generating with the LOCAL
  echo        pinned binary ^(never npx^) ...
  call node_modules\.bin\prisma.cmd generate
  if errorlevel 1 (
    echo [ERROR] prisma generate failed. Read the messages above.
    goto fail
  )
  echo [INFO] Re-verifying Prisma client after generation ...
  call node scripts\verify-prisma-client.js "%DBPATH%"
  if errorlevel 1 (
    echo [ERROR] Prisma client is still not usable after generation.
    echo         Delete the node_modules folder and re-run this script.
    goto fail
  )
)
echo [OK] Prisma client verified - schema models are present.

rem ---- [6/7] Port: prefer 3000, fall back to 3001 - never kill anything ------
set "PORT=3000"
netstat -ano | findstr /c:":3000 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [WARN] Port 3000 is already in use - using port 3001 instead.
  set "PORT=3001"
)

rem ---- Isolated LOCAL TEST environment - process-level, overrides any .env --
set "DBURL=%DBPATH:\=/%"
set "DATABASE_URL=file:%DBURL%"
rem -- TEST-ONLY disposable secret. NEVER use this value in production.
set "NEXTAUTH_SECRET=67-local-test-only-0123456789abcdef0123456789abcdef"
set "NEXTAUTH_URL=http://127.0.0.1:%PORT%"

echo.
echo ==============================================================
echo  [OK] Starting LOCAL TEST server ...
echo  Bind address : 127.0.0.1 only - NOT reachable from the LAN
echo  URL          : http://127.0.0.1:%PORT%
echo  Login        : admin
echo  Password     : Preview-67-Admin!
echo  TEST CREDENTIALS - NOT FOR PRODUCTION
echo  Stop server  : press Ctrl+C in this window.
echo  First start compiles the app - wait for the Ready line.
echo ==============================================================
echo.
call node_modules\.bin\next.cmd dev -H 127.0.0.1 -p %PORT%

echo.
echo [INFO] Local test server stopped.
pause
goto end

:nodeold
echo [ERROR] Node.js 20.9 or newer is required - detected %NODEV%.
echo         Install the current LTS from https://nodejs.org/ and re-run.
goto fail

:fail
echo.
echo [FAILED] Local test startup aborted.
pause
exit /b 1

:end
endlocal
