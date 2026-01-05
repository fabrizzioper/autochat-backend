#!/bin/bash
# Script para ejecutar la migración de message_templates en la VM
# Uso: ./run-migration.sh

set -e

echo "🔄 Ejecutando migración de message_templates..."

# Verificar que el archivo de migración existe
if [ ! -f migrate-message-templates.sql ]; then
    echo "❌ Error: migrate-message-templates.sql no encontrado"
    exit 1
fi

# Verificar que PostgreSQL está corriendo
if ! docker ps | grep -q postgres; then
    echo "❌ Error: Contenedor de PostgreSQL no está corriendo"
    echo "   Inicia los servicios con: docker-compose up -d"
    exit 1
fi

# Esperar a que PostgreSQL esté listo
echo "⏳ Esperando a que PostgreSQL esté listo..."
for i in {1..30}; do
    if docker exec postgres pg_isready -U root &>/dev/null; then
        echo "✅ PostgreSQL está listo"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠️  PostgreSQL no está listo, pero continuando..."
    fi
    sleep 1
done

# Ejecutar migración
echo "📝 Ejecutando migración..."
if docker exec -i postgres psql -U root -d autochat_db < migrate-message-templates.sql; then
    echo "✅ Migración ejecutada correctamente"
    echo ""
    echo "📊 Verificando datos migrados:"
    docker exec postgres psql -U root -d autochat_db -c "SELECT id, name, keywords, \"searchColumns\" FROM message_templates LIMIT 5;"
else
    echo "❌ Error ejecutando la migración"
    exit 1
fi

