# Excel Processor Service

Microservicio en Python para procesar archivos Excel de forma rápida y eficiente.

## Instalación

```bash
# Crear entorno virtual
python3 -m venv venv
source venv/bin/activate  # En Windows: venv\Scripts\activate

# Instalar dependencias
pip install -r requirements.txt
```

## Configuración

**IMPORTANTE**: Este microservicio usa el mismo `.env` del backend NestJS.

No necesitas crear un `.env` separado. El microservicio lee automáticamente el `.env` del directorio padre (`autochat-backend/.env`).

Las variables que usa son:
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (mismas que el backend)
- `EXCEL_PROCESSOR_PORT` (opcional, por defecto 8001)

## Ejecutar

```bash
python main.py
```

O con uvicorn directamente:

```bash
uvicorn main:app --host 0.0.0.0 --port 8001
```

## Endpoints

### POST /process
Procesa un archivo Excel y retorna los datos estructurados.

**Request:**
- Form-data con campo `file` (archivo Excel)

**Response:**
```json
{
  "success": true,
  "headers": ["Columna1", "Columna2", ...],
  "records": [
    {"Columna1": "valor1", "Columna2": "valor2", ...},
    ...
  ],
  "total_records": 100,
  "total_columns": 80,
  "processing_time": 2.5,
  "filename": "archivo.xlsx"
}
```

### GET /health
Health check del servicio.

## Docker (Opcional)

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
```

