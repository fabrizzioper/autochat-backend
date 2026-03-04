@echo off
chcp 65001 >nul 2>&1
title AutoChat Backend - Detener Servicios
color 0C

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║       AutoChat Backend - Deteniendo Servicios            ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

docker compose version >nul 2>&1
if %errorlevel% equ 0 (
    set DC=docker compose
) else (
    set DC=docker-compose
)

echo [INFO] Deteniendo contenedores...
%DC% down
echo.
echo [OK] Todos los servicios detenidos.
echo.
echo     Nota: Los datos de PostgreSQL se conservan en el volumen Docker.
echo     Para borrar TODO (incluida la base de datos):
echo       docker compose down -v
echo.
pause
