#!/bin/bash

# Script para iniciar el microservicio de procesamiento de Excel
# Usa el .env del backend (directorio padre)

echo "🚀 Iniciando Excel Processor Service..."

# Cargar variables de entorno del .env del backend (directorio padre)
ENV_FILE="../.env"
if [ -f "$ENV_FILE" ]; then
    echo "📋 Cargando variables de entorno desde $ENV_FILE"
    export $(cat "$ENV_FILE" | grep -v '^#' | xargs)
else
    echo "⚠️  No se encontró $ENV_FILE, usando variables por defecto"
fi

# Verificar variables de entorno requeridas
if [ -z "$DB_HOST" ]; then
    echo "⚠️  DB_HOST no configurado, usando localhost por defecto"
    export DB_HOST=${DB_HOST:-localhost}
fi
if [ -z "$DB_PORT" ]; then
    export DB_PORT=${DB_PORT:-5432}
fi
if [ -z "$DB_USER" ]; then
    export DB_USER=${DB_USER:-root}
fi
if [ -z "$DB_PASSWORD" ]; then
    export DB_PASSWORD=${DB_PASSWORD:-password}
fi
if [ -z "$DB_NAME" ]; then
    export DB_NAME=${DB_NAME:-autochat_db}
fi

# Puerto del microservicio (por defecto 8001)
if [ -z "$EXCEL_PROCESSOR_PORT" ]; then
    export EXCEL_PROCESSOR_PORT=${EXCEL_PROCESSOR_PORT:-8001}
fi

echo "🔌 Conectando a BD: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo "🌐 Puerto del servicio: $EXCEL_PROCESSOR_PORT"

# Verificar si existe el entorno virtual
if [ ! -d "venv" ]; then
    echo "📦 Creando entorno virtual..."
    python3 -m venv venv
fi

# Activar entorno virtual
echo "🔧 Activando entorno virtual..."
source venv/bin/activate

# Instalar dependencias si no están instaladas
if [ ! -f "venv/.installed" ]; then
    echo "📥 Instalando dependencias..."
    pip install -r requirements.txt
    touch venv/.installed
fi

# Iniciar el servicio
echo "✅ Iniciando servicio en http://localhost:8001"
echo "📊 Health check: http://localhost:8001/health"
echo ""
python main.py

