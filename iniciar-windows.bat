@echo off
chcp 65001 >nul 2>&1
title AutoChat Backend - Inicio Local
color 0A

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║      AutoChat Backend - Inicio LOCAL en Windows          ║
echo ║              Docker Desktop requerido                    ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

:: ─────────────────────────────────────────────────────────────
:: PASO 1: Verificar Docker
:: ─────────────────────────────────────────────────────────────
echo [PASO 1/5] Verificando Docker Desktop...

docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Docker Desktop no esta corriendo.
    echo.
    echo     Opciones:
    echo     1. Abre Docker Desktop manualmente y espera a que inicie
    echo     2. Si no lo tienes, descargalo de: https://www.docker.com/products/docker-desktop
    echo.
    echo     Luego vuelve a ejecutar este script.
    echo.
    pause
    exit /b 1
)
echo [OK] Docker Desktop esta corriendo
echo.

:: ─────────────────────────────────────────────────────────────
:: PASO 2: Ir al directorio del proyecto
:: ─────────────────────────────────────────────────────────────
echo [PASO 2/5] Preparando proyecto...

cd /d "%~dp0"
echo [OK] Directorio: %cd%

:: Crear carpetas necesarias si no existen
if not exist "auth_info" mkdir auth_info
if not exist "temp" mkdir temp

:: ─────────────────────────────────────────────────────────────
:: PASO 3: Crear/verificar archivo .env
:: ─────────────────────────────────────────────────────────────
echo [PASO 3/5] Verificando configuracion...

if not exist ".env" (
    echo [INFO] Creando archivo .env con valores por defecto...
    (
        echo PORT=3000
        echo CORS_ORIGINS=http://localhost:5173,http://localhost:3000
        echo JWT_SECRET=mi_super_secreto_jwt_autochat_2025_seguro
        echo DB_HOST=postgres
        echo DB_PORT=5432
        echo DB_USER=root
        echo DB_PASSWORD=password
        echo DB_NAME=autochat_db
        echo DB_SYNC=true
        echo EXCEL_PROCESSOR_URL=http://excel-processor:8001
        echo EXCEL_PROCESSOR_PORT=8001
    ) > .env
    echo [OK] Archivo .env creado
) else (
    echo [OK] Archivo .env encontrado
)
echo.

:: ─────────────────────────────────────────────────────────────
:: PASO 4: Construir y levantar servicios
:: ─────────────────────────────────────────────────────────────
echo [PASO 4/5] Levantando servicios con Docker Compose...
echo.
echo     Esto puede tardar 3-5 minutos la primera vez
echo     (descarga imagenes y compila el proyecto)
echo.

:: Detener contenedores anteriores si existen
docker compose down >nul 2>&1
docker-compose down >nul 2>&1

:: Detectar comando de docker compose
docker compose version >nul 2>&1
if %errorlevel% equ 0 (
    set DC=docker compose
) else (
    docker-compose version >nul 2>&1
    if %errorlevel% equ 0 (
        set DC=docker-compose
    ) else (
        echo [X] docker compose no encontrado.
        echo     Asegurate de tener Docker Desktop actualizado.
        pause
        exit /b 1
    )
)

echo [INFO] Construyendo imagenes...
%DC% build --no-cache
if %errorlevel% neq 0 (
    echo.
    echo [X] Error al construir las imagenes.
    echo     Revisa los errores arriba.
    pause
    exit /b 1
)

echo.
echo [INFO] Iniciando servicios...
%DC% up -d
if %errorlevel% neq 0 (
    echo.
    echo [X] Error al iniciar los servicios.
    echo     Revisa los errores arriba.
    pause
    exit /b 1
)

echo.
echo [OK] Servicios iniciados
echo.

:: ─────────────────────────────────────────────────────────────
:: PASO 5: Verificar que todo esta funcionando
:: ─────────────────────────────────────────────────────────────
echo [PASO 5/5] Verificando servicios (esperando 15 segundos)...
timeout /t 15 /nobreak >nul

echo.
echo === Estado de contenedores ===
%DC% ps
echo.

:: Verificar PostgreSQL
docker exec autochat-postgres pg_isready -U root -d autochat_db >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] PostgreSQL:          Funcionando (puerto 5432)
) else (
    echo [..] PostgreSQL:          Iniciando...
)

:: Verificar Excel Processor (Go)
curl -s -f http://localhost:8001/health >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Excel Processor Go:  Funcionando (puerto 8001)
) else (
    echo [..] Excel Processor Go:  Iniciando...
)

:: Verificar Backend NestJS
curl -s -f http://localhost:3000 >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] NestJS Backend:      Funcionando (puerto 3000)
) else (
    echo [..] NestJS Backend:      Iniciando (puede tardar 30s mas)...
)

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║                 SERVICIOS LEVANTADOS                     ║
echo ╠═══════════════════════════════════════════════════════════╣
echo ║                                                           ║
echo ║  Backend API:      http://localhost:3000                  ║
echo ║  Excel Processor:  http://localhost:8001/health           ║
echo ║  PostgreSQL:       localhost:5432                         ║
echo ║                                                           ║
echo ╠═══════════════════════════════════════════════════════════╣
echo ║  COMANDOS UTILES:                                        ║
echo ║                                                           ║
echo ║  Ver logs:     docker compose logs -f                     ║
echo ║  Detener:      docker compose down                        ║
echo ║  Reiniciar:    docker compose restart                     ║
echo ║  Estado:       docker compose ps                          ║
echo ║                                                           ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.
pause
