"""
Microservicio para procesar archivos Excel de forma rápida y eficiente
Usa pandas para procesamiento optimizado de Excel y guarda directamente en PostgreSQL
Optimizado con execute_values para inserción masiva (más rápido que INSERT)
"""
from fastapi import FastAPI, UploadFile, File, HTTPException, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import os
import tempfile
import logging
from datetime import datetime
import psycopg2
from psycopg2.extras import execute_batch, Json, execute_values
from psycopg2.pool import SimpleConnectionPool
import json
from typing import Optional, Dict
import io
import threading
import httpx
import socketio

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Excel Processor Service")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # En producción, especificar orígenes
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pool de conexiones a PostgreSQL
db_pool: Optional[SimpleConnectionPool] = None

# Diccionario para guardar progreso de procesamiento
processing_progress: Dict[int, Dict] = {}

# URL del backend NestJS para notificar progreso
BACKEND_URL = os.getenv('BACKEND_URL', 'http://localhost:3000')
BACKEND_WS_URL = BACKEND_URL.replace('http://', 'ws://').replace('https://', 'wss://')

# Cliente WebSocket global (se inicializa al arrancar)
socketio_client: Optional[socketio.Client] = None
ws_connected = False

def init_websocket_client():
    """Inicializar cliente WebSocket para conectar al backend"""
    global socketio_client, ws_connected
    try:
        socketio_client = socketio.Client(
            reconnection=True,
            reconnection_attempts=10,
            reconnection_delay=1,
            reconnection_delay_max=5,
        )
        
        @socketio_client.event
        def connect():
            global ws_connected
            ws_connected = True
            logger.info("✅ WebSocket conectado al backend")
        
        @socketio_client.event
        def disconnect():
            global ws_connected
            ws_connected = False
            logger.warning("⚠️ WebSocket desconectado del backend")
        
        # Conectar al backend identificándose como servicio Python
        try:
            socketio_client.connect(
                BACKEND_WS_URL,
                wait_timeout=5,
                headers={
                    'User-Agent': 'python-socketio/excel-processor',
                    'X-Service-Client': 'excel-processor'
                }
            )
            logger.info(f"🔌 WebSocket conectado a {BACKEND_WS_URL}")
        except Exception as e:
            logger.warning(f"⚠️ No se pudo conectar WebSocket: {str(e)}. Usando HTTP como fallback.")
            ws_connected = False
    except Exception as e:
        logger.error(f"❌ Error inicializando WebSocket: {str(e)}")
        socketio_client = None
        ws_connected = False

def notify_backend_progress(excel_id: int, user_id: int, progress_data: Dict, filename: Optional[str] = None, jwt_token: Optional[str] = None):
    """Notificar al backend sobre el progreso del Excel vía WebSocket (no bloquea)"""
    def _notify():
        global socketio_client, ws_connected
        progress_pct = progress_data.get("progress", 0)
        
        try:
            # Intentar usar WebSocket si está conectado
            if socketio_client and ws_connected and socketio_client.connected:
                try:
                    # Emitir evento directamente - el backend lo recibirá y emitirá al room del usuario
                    socketio_client.emit('excel-progress-service', {
                        "excelId": excel_id,
                        "userId": user_id,
                        "progress": progress_pct,
                        "total": progress_data.get("total", 0),
                        "processed": progress_data.get("processed", 0),
                        "status": progress_data.get("status", "processing"),
                        "filename": filename,
                    })
                    # Log solo cada 10% o al completar
                    if progress_pct >= 100 or int(progress_pct) % 10 == 0:
                        logger.info(f"📡 [WS] Progreso enviado: Excel {excel_id} -> {progress_pct:.1f}%")
                    return  # Éxito con WebSocket
                except Exception as ws_err:
                    logger.warning(f"⚠️ [WS] Error enviando: {str(ws_err)}, usando HTTP...")
                    ws_connected = False
            
            # Fallback a HTTP si WebSocket no está disponible
            # Solo usar HTTP si tenemos token JWT (endpoint requiere autenticación)
            if jwt_token:
                response = httpx.post(
                    f"{BACKEND_URL}/excel/notify-progress",
                    json={
                        "excelId": excel_id,
                        "progress": progress_pct,
                        "total": progress_data.get("total", 0),
                        "processed": progress_data.get("processed", 0),
                        "status": progress_data.get("status", "processing"),
                        "filename": filename,
                    },
                    headers={"Authorization": f"Bearer {jwt_token}"},
                    timeout=2.0,
                )
            # Log solo cada 10% o al completar
            if progress_pct >= 100 or int(progress_pct) % 10 == 0:
                logger.info(f"📡 [HTTP] Progreso enviado: Excel {excel_id} -> {progress_pct:.1f}% (status: {response.status_code})")
        except Exception as e:
            # Solo loggear errores importantes
            if progress_pct >= 100:
                logger.error(f"❌ Error notificando progreso final: {str(e)}")
    
    # Ejecutar en thread separado para no bloquear
    threading.Thread(target=_notify, daemon=True).start()

def get_db_connection():
    """Obtener conexión de la base de datos - usa las mismas variables del .env del backend"""
    global db_pool
    if db_pool is None:
        # Leer variables del .env del backend (mismo archivo)
        db_pool = SimpleConnectionPool(
            1, 20,
            host=os.getenv('DB_HOST', 'localhost'),
            port=int(os.getenv('DB_PORT', 5432)),
            user=os.getenv('DB_USER', 'root'),
            password=os.getenv('DB_PASSWORD', 'password'),
            database=os.getenv('DB_NAME', 'autochat_db')
        )
        logger.info(f"🔌 Conectado a BD: {os.getenv('DB_USER')}@{os.getenv('DB_HOST')}:{os.getenv('DB_PORT')}/{os.getenv('DB_NAME')}")
    return db_pool.getconn()

def return_db_connection(conn):
    """Devolver conexión al pool"""
    db_pool.putconn(conn)

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "ok", "service": "excel-processor"}

@app.get("/progress/{excel_id}")
async def get_progress(excel_id: int):
    """Obtener progreso de procesamiento de un Excel"""
    if excel_id in processing_progress:
        return processing_progress[excel_id]
    return {"progress": 0, "status": "not_found"}

def process_records_background(excel_id: int, user_id: int, all_values: list, total_records: int, tmp_file_path: str, filename: Optional[str] = None, jwt_token: Optional[str] = None):
    """Procesar registros en background después de retornar el excelId"""
    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        
        BATCH_SIZE = 5000
        total_batches = (len(all_values) + BATCH_SIZE - 1) // BATCH_SIZE
        
        for i in range(0, len(all_values), BATCH_SIZE):
            batch_values = all_values[i:i + BATCH_SIZE]
            
            execute_values(
                cur,
                """
                INSERT INTO dynamic_records (user_id, excel_id, "rowData", "rowIndex", "createdAt")
                VALUES %s
                """,
                [(v[0], v[1], v[2], v[3], datetime.now()) for v in batch_values],
                page_size=BATCH_SIZE
            )
            
            # Actualizar progreso después de cada batch
            processed = min(i + BATCH_SIZE, len(all_values))
            progress_pct = min(100, (processed / len(all_values)) * 100)
            progress_data = {
                "progress": round(progress_pct, 1),
                "total": total_records,
                "processed": processed,
                "status": "processing"
            }
            processing_progress[excel_id] = progress_data
            
            # Notificar al backend cada vez que hay progreso (no bloquea)
            notify_backend_progress(excel_id, user_id, progress_data, filename, jwt_token)
            
            # Log cada batch para mejor visibilidad en tiempo real
            batch_num = (i // BATCH_SIZE) + 1
            if batch_num % 5 == 0 or batch_num == total_batches or batch_num == 1:
                logger.info(f"⏳ Progreso: {processed}/{len(all_values)} registros ({progress_pct:.1f}%)")
        
        # Commit final
        conn.commit()
        
        # Marcar como completado
        completed_data = {
            "progress": 100,
            "total": total_records,
            "processed": len(all_values),
            "status": "completed"
        }
        processing_progress[excel_id] = completed_data
        
        # Notificar al backend que está completo
        notify_backend_progress(excel_id, user_id, completed_data, filename, jwt_token)
        
        logger.info(f"✅ Excel {excel_id} procesado completamente: {len(all_values)} registros")
        
    except Exception as e:
        if conn:
            conn.rollback()
        processing_progress[excel_id] = {
            "progress": 0,
            "total": 0,
            "processed": 0,
            "status": "error",
            "error": str(e)
        }
        logger.error(f"❌ Error procesando registros en background para Excel {excel_id}: {str(e)}")
    finally:
        if cur:
            cur.close()
        if conn:
            return_db_connection(conn)
        # Eliminar archivo temporal
        try:
            os.unlink(tmp_file_path)
        except:
            pass

@app.post("/process")
async def process_excel(
    file: UploadFile = File(...),
    user_id: int = Form(...),
    uploaded_by: str = Form(...),
    jwt_token: Optional[str] = Form(None),
    background_tasks: BackgroundTasks = BackgroundTasks()
):
    """
    Procesa un archivo Excel y lo guarda directamente en PostgreSQL
    Retorna el excelId inmediatamente después de crear el metadata para permitir polling del progreso
    
    Args:
        file: Archivo Excel
        user_id: ID del usuario que sube el archivo
        uploaded_by: Nombre/email del usuario que sube el archivo
        jwt_token: Token JWT del usuario para notificaciones al backend
    
    Returns:
        - success: Si el procesamiento fue exitoso
        - message: Mensaje descriptivo
        - recordsCount: Número de registros guardados
        - excelId: ID del Excel guardado en la BD (disponible inmediatamente)
    """
    start_time = datetime.now()
    conn = None
    excel_id = None
    
    try:
        # Validar extensión
        if not file.filename.endswith(('.xlsx', '.xls')):
            raise HTTPException(status_code=400, detail="El archivo debe ser Excel (.xlsx o .xls)")
        
        logger.info(f"📊 Procesando archivo: {file.filename} para usuario {user_id}")
        
        # Guardar archivo temporalmente
        with tempfile.NamedTemporaryFile(delete=False, suffix='.xlsx') as tmp_file:
            content = await file.read()
            tmp_file.write(content)
            tmp_file_path = tmp_file.name
        
        try:
            # Leer Excel con pandas (muy optimizado)
            engine = 'openpyxl' if file.filename.endswith('.xlsx') else 'xlrd'
            
            logger.info(f"📖 Iniciando lectura de Excel: {file.filename} (engine: {engine})")
            logger.info(f"📏 Tamaño del archivo: {len(content)} bytes")
            
            df = pd.read_excel(
                tmp_file_path,
                engine=engine,
                sheet_name=0,
                dtype=str,
                na_values=['', 'NULL', 'null', 'None'],
                keep_default_na=False,
            )
            
            logger.info(f"📋 Archivo leído: {len(df)} filas, {len(df.columns)} columnas")
            
            # Obtener headers
            headers = [str(col).strip() if pd.notna(col) else f"Columna_{i+1}" 
                      for i, col in enumerate(df.columns)]
            
            # Limpiar nombres de columnas duplicados
            seen = {}
            for i, header in enumerate(headers):
                if header in seen:
                    headers[i] = f"{header}_{seen[header]}"
                    seen[header] += 1
                else:
                    seen[header] = 1
            
            # Convertir DataFrame a lista de diccionarios de forma optimizada
            df_cleaned = df.replace(['', 'NULL', 'null', 'None', pd.NA], None)
            records = df_cleaned.to_dict('records')
            
            # Filtrar registros completamente vacíos
            records = [r for r in records if any(v is not None and (not isinstance(v, str) or v.strip()) for v in r.values())]
            
            if not records:
                raise HTTPException(status_code=400, detail="El Excel no contiene datos")
            
            logger.info(f"📊 {len(records)} registros procesados con {len(headers)} columnas")
            
            # Conectar a PostgreSQL
            conn = get_db_connection()
            cur = conn.cursor()
            
            try:
                # Insertar metadata - usar nombres exactos de columnas (TypeORM no convierte a snake_case)
                cur.execute("""
                    INSERT INTO excel_metadata (user_id, filename, "totalRecords", "uploadedBy", headers, "isReactive", "uploadedAt")
                    VALUES (%s, %s, %s, %s, %s, %s, NOW())
                    RETURNING id
                """, (user_id, file.filename, len(records), uploaded_by, Json(headers), True))
                
                excel_id = cur.fetchone()[0]
                logger.info(f"💾 Metadata guardada (ID: {excel_id})")
                
                # Hacer commit inmediato del metadata para que esté disponible
                conn.commit()
                
                # Inicializar progreso ANTES de procesar
                processing_progress[excel_id] = {
                    "progress": 0,
                    "total": len(records),
                    "processed": 0,
                    "status": "processing"
                }
                
                # Preparar datos para procesamiento en background
                total_records = len(records)
                row_index = 1
                all_values = []
                for record in records:
                    cleaned_record = {k: v for k, v in record.items() if v is not None and (not isinstance(v, str) or v.strip())}
                    if cleaned_record:
                        all_values.append((
                            user_id,
                            excel_id,
                            Json(cleaned_record),
                            row_index
                        ))
                        row_index += 1
                
                # IMPORTANTE: Retornar excelId inmediatamente
                # El procesamiento continuará en background
                # El frontend puede empezar a hacer polling inmediatamente
                
                # Procesar registros en background
                background_tasks.add_task(
                    process_records_background,
                    excel_id,
                    user_id,
                    all_values,
                    total_records,
                    tmp_file_path,
                    file.filename,
                    jwt_token
                )
                
                # Retornar inmediatamente con el excelId
                return {
                    "success": True,
                    "message": f"Excel iniciado. Procesando {len(records)} registros en background...",
                    "recordsCount": len(records),
                    "excelId": excel_id,
                    "totalColumns": len(headers),
                    "processingTime": 0,
                    "status": "processing"
                }
                
            except Exception as db_error:
                conn.rollback()
                if excel_id:
                    processing_progress[excel_id] = {
                        "progress": 0,
                        "total": 0,
                        "processed": 0,
                        "status": "error",
                        "error": str(db_error)
                    }
                logger.error(f"❌ Error guardando en BD: {str(db_error)}")
                raise HTTPException(status_code=500, detail=f"Error guardando en base de datos: {str(db_error)}")
            finally:
                cur.close()
                return_db_connection(conn)
                conn = None
                
        except pd.errors.EmptyDataError:
            raise HTTPException(status_code=400, detail="El archivo Excel está vacío")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"❌ Error procesando Excel: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Error al procesar el Excel: {str(e)}")
        finally:
            # No eliminar archivo aquí, se eliminará en background después de procesar
            pass
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error procesando Excel: {str(e)}")
        if conn:
            return_db_connection(conn)
        raise HTTPException(status_code=500, detail=f"Error al procesar el Excel: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    from dotenv import load_dotenv
    import pathlib
    
    # Cargar .env del directorio padre (donde está el backend)
    env_path = pathlib.Path(__file__).parent.parent / '.env'
    if env_path.exists():
        load_dotenv(env_path)
        logger.info(f"📋 Variables de entorno cargadas desde: {env_path}")
    else:
        # Si no existe, intentar cargar desde el directorio actual
        load_dotenv()
        logger.info("📋 Variables de entorno cargadas desde .env del directorio actual")
    
    port = int(os.getenv('EXCEL_PROCESSOR_PORT', 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
