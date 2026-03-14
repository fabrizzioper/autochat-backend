@echo off
setlocal enabledelayedexpansion

:: ════════════════════════════════════════════════════
:: Este .bat se llama a si mismo con argumentos para
:: abrir cada servicio en su propia ventana
:: ════════════════════════════════════════════════════

:: Si se llama con argumento, ejecutar el servicio correspondiente
if "%1"=="GO"     goto :RUN_GO
if "%1"=="NESTJS" goto :RUN_NESTJS

:: ─────────────────────────────────────────
:: MAIN: Orquestador principal
:: ─────────────────────────────────────────
echo.
echo  Iniciando servicios en DOS terminales separadas...
echo.

:: Obtener directorio raiz
set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

:: Validaciones
if not exist "C:\Program Files\Go\bin\go.exe" (
    echo [ERROR] No se encontro Go en C:\Program Files\Go\bin\go.exe
    echo Instala Go desde https://go.dev/dl/
    pause & exit /b 1
)
if not exist "%ROOT_DIR%\excel-processor-go" (
    echo [ERROR] No se encontro la carpeta: %ROOT_DIR%\excel-processor-go
    pause & exit /b 1
)

:: Matar procesos anteriores en puertos
echo Verificando puerto 8001...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8001 "') do (
    if not "%%a"=="0" taskkill /PID %%a /F >nul 2>&1 && echo   Proceso anterior en 8001 detenido.
)

echo Verificando puerto 3000...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 "') do (
    if not "%%a"=="0" taskkill /PID %%a /F >nul 2>&1 && echo   Proceso anterior en 3000 detenido.
)

timeout /t 1 /nobreak >nul

:: [1/2] Lanzar Go en nueva ventana (se llama a si mismo con GO)
echo.
echo [1/2] Abriendo terminal para Go Excel Processor...
start "Go Excel Processor" cmd /k ""%~f0" GO "%ROOT_DIR%""

:: Esperar a que Go inicie (hasta 30 segundos)
echo Esperando a que Go inicie...
for /l %%i in (1,1,15) do (
    timeout /t 2 /nobreak >nul
    curl -s http://localhost:8001/health >nul 2>&1
    if !errorlevel! == 0 goto :GO_OK
    echo   Intento %%i/15...
)

echo.
echo [ERROR] Go no responde despues de 30 segundos.
echo Revisa la terminal "Go Excel Processor" para ver el error.
echo.
pause & exit /b 1

:GO_OK
echo  Go Excel Processor iniciado correctamente (puerto 8001)
echo.

:: [2/2] Lanzar NestJS en nueva ventana (se llama a si mismo con NESTJS)
echo [2/2] Abriendo terminal para NestJS...
start "NestJS" cmd /k ""%~f0" NESTJS "%ROOT_DIR%""

echo.
echo  ════════════════════════════════════════════════════
echo   Servicios iniciados en DOS terminales:
echo.
echo     Terminal 1: Go Excel Processor  (puerto 8001) OK
echo     Terminal 2: NestJS              (puerto 3000)
echo.
echo   Para detener: cierra las terminales o Ctrl+C en cada una.
echo  ════════════════════════════════════════════════════
echo.
goto :EOF

:: ─────────────────────────────────────────
:: RUN_GO: Lo que corre en la ventana de Go
:: ─────────────────────────────────────────
:RUN_GO
set "ROOT_DIR=%~2"
title Go Excel Processor - Puerto 8001
set "PATH=%PATH%;C:\Program Files\Go\bin"

cd /d "%ROOT_DIR%\excel-processor-go"

:: Cargar .env
if exist "%ROOT_DIR%\.env" (
    for /f "usebackq tokens=1,2 delims==" %%i in ("%ROOT_DIR%\.env") do (
        set "LINE=%%i"
        if not "!LINE:~0,1!"=="#" set "%%i=%%j"
    )
)

echo.
echo  ===========================================
echo    Go Excel Processor - http://localhost:8001
echo  ===========================================
echo.
"C:\Program Files\Go\bin\go.exe" run .
echo.
echo  Go se detuvo. Presiona una tecla para cerrar.
pause >nul
goto :EOF

:: ─────────────────────────────────────────
:: RUN_NESTJS: Lo que corre en la ventana de NestJS
:: ─────────────────────────────────────────
:RUN_NESTJS
set "ROOT_DIR=%~2"
title NestJS - Puerto 3000

cd /d "%ROOT_DIR%"

echo.
echo  ===========================================
echo    NestJS - http://localhost:3000
echo  ===========================================
echo.
npm run start:dev:nestjs
echo.
echo  NestJS se detuvo. Presiona una tecla para cerrar.
pause >nul
goto :EOF