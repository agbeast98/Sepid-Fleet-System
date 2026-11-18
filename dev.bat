@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ROOT=%~dp0"

if not "%~1"=="" if /i not "%~1"=="--external-db" (
    echo Usage: dev.bat [--external-db]
    exit /b 2
)

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js is required.
    goto :failed
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>24||(v[0]===24&&v[1]>=7)?0:1)"
if errorlevel 1 (
    echo Node.js 24.7.0 or newer in the Node 24 line is required for secure password hashing.
    goto :failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo npm is required.
    goto :failed
)

if not exist "%ROOT%backend\.env" (
    if /i "%~1"=="--external-db" (
        echo Create backend\.env and set DATABASE_URL for your PostgreSQL server.
        goto :failed
    )
    copy "%ROOT%backend\.env.example" "%ROOT%backend\.env" >nul
    if errorlevel 1 goto :failed
)

call :install "%ROOT%backend" "tsc"
if errorlevel 1 goto :failed
call :install "%ROOT%frontend" "vite"
if errorlevel 1 goto :failed

if /i not "%~1"=="--external-db" (
    set "SEPID_DB_PORT=55432"
    for /f "tokens=1,2 delims==" %%A in ('findstr /b "SEPID_POSTGRES_PORT=" "%ROOT%backend\.env"') do set "SEPID_DB_PORT=%%B"
    if exist "%ROOT%.dev-postgres\PG_VERSION" if exist "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" (
        "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" status -D "%ROOT%.dev-postgres" >nul 2>&1
        if errorlevel 1 (
            echo Starting local PostgreSQL from the project data folder...
            "C:\Program Files\PostgreSQL\16\bin\pg_ctl.exe" -D "%ROOT%.dev-postgres" -l "%ROOT%backend\postgres-dev.log" -o "-h 127.0.0.1 -p !SEPID_DB_PORT!" -w start
            if errorlevel 1 goto :failed
        ) else (
            echo Local PostgreSQL is already running.
        )
        goto :database_ready
    )
    echo Starting local PostgreSQL with Docker...
    docker compose --env-file "%ROOT%backend\.env" -f "%ROOT%backend\compose.yaml" up -d --wait postgres
    if errorlevel 1 goto :failed
)

:database_ready
start "Sepid Backend" /D "%ROOT%backend" "%ComSpec%" /k npm.cmd run dev
if errorlevel 1 goto :failed
start "Sepid Frontend" /D "%ROOT%frontend" "%ComSpec%" /k npm.cmd run dev
if errorlevel 1 goto :failed
exit /b 0

:install
if exist "%~1\node_modules\.bin\%~2.cmd" exit /b 0
pushd "%~1"
if errorlevel 1 exit /b 1
call npm.cmd install
set "INSTALL_RESULT=%errorlevel%"
popd
exit /b %INSTALL_RESULT%

:failed
echo Development startup failed. See the message above.
pause
exit /b 1
