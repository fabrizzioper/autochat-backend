import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { ExcelFormatEntity } from './excel-format.entity';
import { env } from '../../config/env';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as XLSX from 'xlsx';
import axios from 'axios';
import { WhatsAppGateway } from '../whatsapp/whatsapp.gateway';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import * as unzipper from 'unzipper';
import * as sax from 'sax';

interface ProcessResult {
  success: boolean;
  recordsCount: number;
  message: string;
  excelId?: number;
}

interface PendingUpload {
  excelId: number;
  userId: number;
  filename: string;
  uploadedBy: string;
  tempPath: string;
  headers: string[];
  totalRows: number;
  createdAt: Date;
  formatId?: number; // Si ya existe un formato para este archivo
}

@Injectable()
export class ExcelService implements OnModuleInit {
  private readonly logger = new Logger(ExcelService.name);
  
  // Mapa de uploads pendientes (esperando selección de cabeceras)
  private pendingUploads = new Map<number, PendingUpload>();

  constructor(
    @InjectRepository(ExcelMetadataEntity)
    private readonly metadataRepo: Repository<ExcelMetadataEntity>,
    @InjectRepository(DynamicRecordEntity)
    private readonly dynamicRecordRepo: Repository<DynamicRecordEntity>,
    @InjectRepository(ExcelFormatEntity)
    private readonly formatRepo: Repository<ExcelFormatEntity>,
    @Inject(forwardRef(() => WhatsAppGateway))
    private readonly gateway: WhatsAppGateway,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsappService: WhatsAppService,
    private readonly dataSource: DataSource,
  ) {}

  // ⚡ Inicialización del módulo - índices se crean por columna al procesar cada Excel
  async onModuleInit() {
    this.logger.log('⚡ ExcelService inicializado - índices por columna se crean al procesar cada Excel');
  }

  // ============================================================================
  // NUEVO FLUJO: FASE 1 - Leer solo cabeceras
  // ============================================================================

  /**
   * Lee solo la primera fila (cabeceras) de un Excel usando Go
   * Timeout de 120s para archivos muy grandes
   */
  async readExcelHeaders(filePath: string): Promise<{ headers: string[]; totalRows: number }> {
    const startTime = Date.now();
    
    // Usar Go para leer cabeceras (lectura directa del ZIP - ultra rápida)
    const response = await axios.post<{
      success: boolean;
      headers: string[];
      totalRows: number;
      duration: string;
      error?: string;
    }>(`${env.EXCEL_PROCESSOR_URL}/read-headers`, {
      file_path: filePath,
    }, {
      timeout: 30000, // 30 segundos máximo (normalmente tarda 1-5s)
    });
    
    if (!response.data.success) {
      throw new Error(response.data.error || 'Error leyendo cabeceras');
    }
    
    const duration = Date.now() - startTime;
    this.logger.log(`⚡ Cabeceras leídas en ${duration}ms (Go: ${response.data.duration}): ${response.data.headers.length} columnas, ~${response.data.totalRows} filas`);
    
    return {
      headers: response.data.headers,
      totalRows: response.data.totalRows,
    };
  }

  /**
   * ⚡ STREAMING: Leer cabeceras directamente del archivo ZIP sin cargar todo en memoria
   */
  private async readHeadersFromZip(filePath: string): Promise<{ headers: string[]; totalRows: number }> {
    const directory = await unzipper.Open.file(filePath);
    
    const sharedStringsFile = directory.files.find(f => f.path === 'xl/sharedStrings.xml');
    const sheetFile = directory.files.find(f => f.path === 'xl/worksheets/sheet1.xml');
    
    if (!sheetFile) {
      throw new Error('No se encontró sheet1.xml');
    }

    // PASO 1: Leer sheet1.xml con streaming para obtener primera fila
    const { cells, totalRows } = await this.readFirstRowFromSheet(sheetFile);
    
    // PASO 2: Identificar qué índices de strings compartidos necesitamos
    const neededIndices = new Set<number>();
    for (const cell of cells) {
      if (cell.type === 's' && cell.value !== undefined) {
        neededIndices.add(parseInt(cell.value, 10));
      }
    }
    
    // PASO 3: Leer SOLO los strings que necesitamos (streaming)
    const sharedStrings = new Map<number, string>();
    if (sharedStringsFile && neededIndices.size > 0) {
      const maxIndex = Math.max(...neededIndices);
      await this.readSharedStringsStreaming(sharedStringsFile, neededIndices, maxIndex, sharedStrings);
    }
    
    // PASO 4: Construir cabeceras
    const rawHeaders: string[] = [];
    for (const cell of cells) {
      let value = '';
      if (cell.type === 's' && cell.value !== undefined) {
        const idx = parseInt(cell.value, 10);
        value = sharedStrings.get(idx) || '';
      } else if (cell.value !== undefined) {
        value = cell.value;
      }
      rawHeaders.push(value);
    }

    // Procesar cabeceras (limpiar, evitar duplicados)
    const seen = new Map<string, number>();
    const headers = rawHeaders.map((col, index) => {
      let header = String(col || '').trim();
      if (!header) {
        header = `Columna_${index + 1}`;
      }
      
      const count = seen.get(header) || 0;
      if (count > 0) {
        header = `${header}_${count + 1}`;
      }
      seen.set(header, count + 1);
      
      return header;
    });

    return { headers, totalRows };
  }

  /**
   * Lee SOLO la primera fila de sheet1.xml usando streaming SAX
   */
  private readFirstRowFromSheet(sheetFile: unzipper.File): Promise<{ cells: Array<{ type?: string; value?: string }>; totalRows: number }> {
    return new Promise((resolve, reject) => {
      const cells: Array<{ type?: string; value?: string }> = [];
      let totalRows = 0;
      let inFirstRow = false;
      let currentCell: { type?: string; value?: string } | null = null;
      let inValue = false;
      let rowCount = 0;
      
      const parser = sax.createStream(true, { trim: true });
      
      parser.on('opentag', (node) => {
        if (node.name === 'dimension' && node.attributes.ref) {
          // Extraer total de filas de la dimensión
          const match = String(node.attributes.ref).match(/:([A-Z]+)(\d+)/);
          if (match) {
            totalRows = parseInt(match[2], 10) - 1;
          }
        }
        
        if (node.name === 'row') {
          rowCount++;
          if (rowCount === 1) {
            inFirstRow = true;
          } else if (inFirstRow) {
            // Ya pasamos la primera fila, podemos terminar
            parser.removeAllListeners();
            resolve({ cells, totalRows });
          }
        }
        
        if (node.name === 'c' && inFirstRow) {
          currentCell = { type: node.attributes.t as string };
        }
        
        if (node.name === 'v' && currentCell) {
          inValue = true;
        }
      });
      
      parser.on('text', (text) => {
        if (inValue && currentCell) {
          currentCell.value = text;
        }
      });
      
      parser.on('closetag', (name) => {
        if (name === 'v') {
          inValue = false;
        }
        if (name === 'c' && currentCell && inFirstRow) {
          cells.push(currentCell);
          currentCell = null;
        }
        if (name === 'row' && inFirstRow) {
          inFirstRow = false;
          // Terminamos con la primera fila
          parser.removeAllListeners();
          resolve({ cells, totalRows });
        }
      });
      
      parser.on('error', (err) => {
        reject(err);
      });
      
      parser.on('end', () => {
        resolve({ cells, totalRows });
      });
      
      // Pipe del stream del ZIP al parser SAX
      sheetFile.stream().pipe(parser);
    });
  }

  /**
   * Lee SOLO los strings compartidos que necesitamos usando streaming SAX
   */
  private readSharedStringsStreaming(
    ssFile: unzipper.File,
    neededIndices: Set<number>,
    maxIndex: number,
    result: Map<number, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let currentIndex = 0;
      let inSi = false;
      let inT = false;
      let currentText = '';
      let foundCount = 0;
      const totalNeeded = neededIndices.size;
      
      const parser = sax.createStream(true, { trim: false });
      
      parser.on('opentag', (node) => {
        if (node.name === 'si') {
          inSi = true;
          currentText = '';
        }
        if ((node.name === 't' || node.name === 'r') && inSi) {
          inT = true;
        }
      });
      
      parser.on('text', (text) => {
        if (inT && inSi) {
          currentText += text;
        }
      });
      
      parser.on('closetag', (name) => {
        if (name === 't' || name === 'r') {
          inT = false;
        }
        if (name === 'si') {
          if (neededIndices.has(currentIndex)) {
            result.set(currentIndex, currentText);
            foundCount++;
            
            // Si ya encontramos todos los que necesitamos, terminar
            if (foundCount >= totalNeeded) {
              parser.removeAllListeners();
              resolve();
            }
          }
          currentIndex++;
          inSi = false;
          currentText = '';
          
          // Si ya pasamos el índice máximo, no hay necesidad de seguir
          if (currentIndex > maxIndex) {
            parser.removeAllListeners();
            resolve();
          }
        }
      });
      
      parser.on('error', (err) => {
        reject(err);
      });
      
      parser.on('end', () => {
        resolve();
      });
      
      ssFile.stream().pipe(parser);
    });
  }

  /**
   * Método tradicional con XLSX (fallback)
   */
  private async readHeadersWithXLSX(filePath: string, startTime: number): Promise<{ headers: string[]; totalRows: number }> {
    const workbook = XLSX.readFile(filePath, {
      sheetRows: 1,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
    });

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    const rawHeaders = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] || [];
    
    const seen = new Map<string, number>();
    const headers = rawHeaders.map((col, index) => {
      let header = String(col || '').trim();
      if (!header) {
        header = `Columna_${index + 1}`;
      }
      
      const count = seen.get(header) || 0;
      if (count > 0) {
        header = `${header}_${count + 1}`;
      }
      seen.set(header, count + 1);
      
      return header;
    });

    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const totalRows = Math.max(0, range.e.r);

    const duration = Date.now() - startTime;
    this.logger.log(`📋 Cabeceras leídas en ${duration}ms (XLSX): ${headers.length} columnas, ~${totalRows} filas`);

    return { headers, totalRows };
  }

  /**
   * FASE 1: Subir Excel, leer cabeceras, esperar selección
   * @param fromWhatsApp - Si es true, la selección de cabeceras se hará por WhatsApp (no mostrar modal en frontend)
   */
  async uploadAndReadHeaders(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
    fromWhatsApp: boolean = false,
  ): Promise<{ 
    success: boolean; 
    excelId: number; 
    headers: string[]; 
    totalRows: number; 
    message: string;
    hasFormat?: boolean; // Si existe un formato guardado
    format?: ExcelFormatEntity; // El formato encontrado
    autoProcessing?: boolean; // Si se está procesando automáticamente
  }> {
    try {
      this.logger.log(`📊 Leyendo cabeceras de: ${filename}`);
      
      // 0. Verificar si existe un formato guardado para este archivo
      const existingFormat = await this.findFormatForFile(userId, filename);
      
      if (existingFormat) {
        this.logger.log(`📋 Formato encontrado: "${existingFormat.name}" - Procesando automáticamente`);
        
        // Procesar automáticamente con el formato guardado
        const result = await this.processWithSavedFormat(
          filePath, 
          filename, 
          uploadedBy, 
          userId, 
          existingFormat
        );
        
        if (result.success) {
          return {
            success: true,
            excelId: result.excelId,
            headers: existingFormat.headers,
            totalRows: 0, // Se actualizará al procesar
            message: `Procesando con formato "${existingFormat.name}"`,
            hasFormat: true,
            format: existingFormat,
            autoProcessing: true,
          };
        }
        // Si falla, continuar con flujo normal
      }
      
      // 1. Leer solo las cabeceras (muy rápido)
      const { headers, totalRows } = await this.readExcelHeaders(filePath);
      
      if (headers.length === 0) {
        return { success: false, excelId: 0, headers: [], totalRows: 0, message: 'El Excel no tiene cabeceras' };
      }

      // 2. Crear metadata pendiente (sin registros aún)
      const metadata = this.metadataRepo.create({
        userId,
        filename,
        uploadedBy,
        totalRecords: 0, // Se actualizará después
        headers,
        isReactive: true,
      });
      const savedMetadata = await this.metadataRepo.save(metadata);
      
      // 3. Guardar estado pendiente
      const pendingUpload: PendingUpload = {
        excelId: savedMetadata.id,
        userId,
        filename,
        uploadedBy,
        tempPath: filePath,
        headers,
        totalRows,
        createdAt: new Date(),
      };
      this.pendingUploads.set(savedMetadata.id, pendingUpload);
      
      this.logger.log(`⏸️ Excel ${savedMetadata.id}: Esperando selección de cabeceras (${headers.length} columnas, ~${totalRows} filas)`);
      
      // 4. Notificar al frontend que las cabeceras están listas
      // Si viene de WhatsApp, el frontend NO debe mostrar el modal de selección
      if (this.gateway) {
        this.gateway.emitExcelProgressToUser(userId, {
          excelId: savedMetadata.id,
          progress: 10,
          total: totalRows,
          processed: 0,
          status: 'headers_ready',
          filename,
          message: `Selecciona las cabeceras a indexar (${headers.length} disponibles)`,
          headers, // Enviar cabeceras en el evento
          fromWhatsApp, // Si es true, el frontend NO mostrará el modal
        });
      }

      return {
        success: true,
        excelId: savedMetadata.id,
        headers,
        totalRows,
        message: 'Cabeceras leídas correctamente',
        hasFormat: false,
      };
    } catch (error: any) {
      this.logger.error(`❌ Error leyendo cabeceras: ${error.message}`);
      return { success: false, excelId: 0, headers: [], totalRows: 0, message: error.message };
    }
  }

  /**
   * FASE 2: Continuar procesamiento con cabeceras seleccionadas
   * @param saveFormat - Si es true, guarda la configuración como formato reutilizable
   * @param formatName - Nombre del formato (requerido si saveFormat es true)
   */
  async continueProcessingWithHeaders(
    excelId: number,
    userId: number,
    selectedHeaders: string[],
    jwtToken?: string,
    saveFormat: boolean = false,
    formatName?: string,
  ): Promise<{ success: boolean; message: string; formatId?: number }> {
    const pending = this.pendingUploads.get(excelId);
    
    if (!pending) {
      return { success: false, message: 'No hay proceso pendiente para este Excel' };
    }
    
    if (pending.userId !== userId) {
      return { success: false, message: 'No tienes permiso para continuar este proceso' };
    }

    try {
      this.logger.log(`▶️ Continuando procesamiento de Excel ${excelId} con ${selectedHeaders.length} cabeceras a indexar`);
      
      // 1. Guardar las cabeceras indexadas en la metadata (usando save para asegurar persistencia)
      const metadata = await this.metadataRepo.findOne({ where: { id: excelId } });
      if (!metadata) {
        return { success: false, message: 'Excel no encontrado en la base de datos' };
      }
      
      metadata.indexedHeaders = selectedHeaders;
      await this.metadataRepo.save(metadata);
      this.logger.log(`💾 Cabeceras indexadas guardadas en Excel ${excelId}: ${selectedHeaders.join(', ')}`);
      
      // Verificar que se guardó correctamente
      const verification = await this.metadataRepo.findOne({ where: { id: excelId } });
      this.logger.log(`✅ Verificación: indexedHeaders = ${JSON.stringify(verification?.indexedHeaders)}`);
      
      // 1.5. Guardar formato si se solicitó
      let savedFormat: ExcelFormatEntity | null = null;
      if (saveFormat) {
        const name = formatName || pending.filename.replace(/\.(xlsx|xls)$/i, '');
        savedFormat = await this.saveFormat(
          userId,
          name,
          pending.filename,
          pending.headers,
          selectedHeaders,
          excelId,
        );
        this.logger.log(`💾 Formato guardado: "${savedFormat.name}" (id=${savedFormat.id})`);
      }
      
      // 2. ⚡ Enviar solo el PATH al Go processor (no el archivo completo)
      // Go leerá el archivo directamente desde el path
      const response = await axios.post(
        `${env.EXCEL_PROCESSOR_URL}/process-from-path`,
        {
          excel_id: excelId,
          user_id: userId,
          filename: pending.filename,
          uploaded_by: pending.uploadedBy,
          temp_path: pending.tempPath, // ⚡ Go lee desde este path
          selected_headers: selectedHeaders,
        },
        {
          timeout: 300000,
        }
      );

      // 3. Limpiar estado pendiente (el archivo lo elimina Go)
      this.pendingUploads.delete(excelId);

      return { 
        success: true, 
        message: saveFormat ? `Procesando y formato "${savedFormat?.name}" guardado` : 'Procesamiento iniciado correctamente',
        formatId: savedFormat?.id,
      };
    } catch (error: any) {
      this.logger.error(`❌ Error continuando procesamiento: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Cancelar upload pendiente (cuando el usuario recarga sin seleccionar)
   */
  async cancelPendingUpload(excelId: number, userId: number): Promise<{ success: boolean; message: string }> {
    this.logger.log(`🔴 Cancelando proceso para Excel ${excelId}, usuario ${userId}`);
    
    const pending = this.pendingUploads.get(excelId);
    
    // Intentar cancelar en Go (por si ya empezó a procesar)
    try {
      await axios.delete(`${env.EXCEL_PROCESSOR_URL}/cancel/${excelId}`);
      this.logger.log(`✅ Proceso cancelado en Go para Excel ${excelId}`);
    } catch {
      // Ignorar si no hay proceso activo en Go
    }
    
    if (!pending) {
      // Verificar si existe el metadata y eliminarlo
      const metadata = await this.metadataRepo.findOne({ where: { id: excelId, userId } });
      if (metadata && metadata.totalRecords === 0) {
        await this.metadataRepo.remove(metadata);
        this.logger.log(`🗑️ Metadata pendiente eliminado: Excel ${excelId}`);
        return { success: true, message: 'Upload cancelado' };
      }
      return { success: false, message: 'No hay proceso pendiente para este Excel' };
    }
    
    if (pending.userId !== userId) {
      return { success: false, message: 'No tienes permiso para cancelar este proceso' };
    }

    try {
      // Eliminar archivo temporal
      try {
        await fs.unlink(pending.tempPath);
      } catch {
        // Ignorar
      }
      
      // Eliminar metadata
      const metadata = await this.metadataRepo.findOne({ where: { id: excelId } });
      if (metadata) {
        await this.metadataRepo.remove(metadata);
      }
      
      // Limpiar estado pendiente
      this.pendingUploads.delete(excelId);
      
      this.logger.log(`❌ Upload cancelado: Excel ${excelId}`);
      return { success: true, message: 'Upload cancelado correctamente' };
    } catch (error: any) {
      this.logger.error(`❌ Error cancelando upload: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Verificar si hay un upload pendiente para el usuario
   */
  getPendingUploadForUser(userId: number): PendingUpload | null {
    for (const [, pending] of this.pendingUploads) {
      if (pending.userId === userId) {
        return pending;
      }
    }
    return null;
  }

  /**
   * Limpiar el upload pendiente para un usuario
   */
  clearPendingUploadForUser(userId: number): void {
    for (const [excelId, pending] of this.pendingUploads) {
      if (pending.userId === userId) {
        this.pendingUploads.delete(excelId);
        this.logger.log(`🧹 Limpiado pendingUpload para usuario ${userId}, Excel ${excelId}`);
        return;
      }
    }
  }

  /**
   * Obtener cabeceras indexadas de un Excel
   */
  async getIndexedHeaders(excelId: number, userId: number): Promise<{ id: number; headerName: string; indexedAt: string }[]> {
    const excel = await this.metadataRepo.findOne({ where: { id: excelId, userId } });
    
    if (!excel || !excel.indexedHeaders) {
      return [];
    }

    // Retornar en formato compatible con el frontend
    return excel.indexedHeaders.map((header, index) => ({
      id: index + 1,
      headerName: header,
      indexedAt: excel.uploadedAt?.toISOString() || new Date().toISOString(),
    }));
  }

  // Enviar archivo al microservicio Python que procesa y guarda todo
  async processExcelFile(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
    jwtToken?: string,
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    try {
      this.logger.log(`📊 Enviando archivo a microservicio Python: ${filename}`);
      
      // Leer archivo como buffer
      const fileBuffer = await fs.readFile(filePath);
      
      // Crear FormData para enviar al microservicio Python
      const formData = new FormData();
      formData.append('file', fileBuffer, {
        filename: filename,
        contentType: filename.endsWith('.xlsx') 
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/vnd.ms-excel',
      });
      formData.append('user_id', userId.toString());
      formData.append('uploaded_by', uploadedBy);
      if (jwtToken) {
        formData.append('jwt_token', jwtToken);
      }
      
      // Llamar al microservicio Python (procesa Y guarda en BD)
      this.logger.log(`🚀 Enviando a: ${env.EXCEL_PROCESSOR_URL}/process`);
      
      const response = await axios.post(
        `${env.EXCEL_PROCESSOR_URL}/process`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          timeout: 300000, // 5 minutos timeout para archivos grandes
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );
      
      const { success, message, recordsCount, excelId, processingTime } = response.data;
      
      const endTime = Date.now();
      const totalDuration = ((endTime - startTime) / 1000).toFixed(2);
      
      if (success) {
        this.logger.log(`✅ Excel procesado y guardado por Python en ${totalDuration}s (procesamiento: ${processingTime}s). Excel ID: ${excelId}`);
        return {
          success: true,
          recordsCount: recordsCount,
          message: message,
          excelId: excelId,
        };
      } else {
        return {
          success: false,
          recordsCount: 0,
          message: message || 'Error procesando el Excel',
        };
      }
    } catch (error: any) {
      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(2);
      
      // Manejar errores del microservicio
      if (error.response) {
        this.logger.error(`❌ Error del microservicio después de ${duration}s: ${error.response.data?.detail || error.message}`);
        return {
          success: false,
          recordsCount: 0,
          message: error.response.data?.detail || `Error del microservicio: ${error.message}`,
        };
      }
      
      this.logger.error(`❌ Error enviando archivo al microservicio después de ${duration}s: ${error.message}`);
      this.logger.error(error.stack);
      return {
        success: false,
        recordsCount: 0,
        message: `Error al procesar el Excel: ${error.message}`,
      };
    }
  }

  async getAllExcelMetadata(userId: number): Promise<ExcelMetadataEntity[]> {
    // ⚡ Solo devolver excels que tienen registros (totalRecords > 0)
    // Los excels con 0 registros son subidas incompletas/canceladas
    const excels = await this.metadataRepo.find({ 
      where: { userId },
      order: { uploadedAt: 'DESC' },
    });
    
    // Filtrar los que tienen registros
    return excels.filter(excel => excel.totalRecords > 0);
  }
  
  // Limpiar excels con 0 registros (subidas incompletas)
  // ⚠️ NO eliminar excels que están pendientes o siendo procesados
  async cleanupEmptyExcels(userId: number): Promise<number> {
    const emptyExcels = await this.metadataRepo.find({
      where: { userId, totalRecords: 0 },
    });
    
    if (emptyExcels.length === 0) {
      return 0;
    }
    
    // Filtrar: NO eliminar excels que están pendientes en NestJS
    const pendingExcelIds = new Set<number>();
    for (const [excelId, pending] of this.pendingUploads) {
      if (pending.userId === userId) {
        pendingExcelIds.add(excelId);
      }
    }
    
    // Filtrar: NO eliminar excels que están siendo procesados por Go
    let activeInGo = new Set<number>();
    try {
      const goResponse = await axios.get(`${env.EXCEL_PROCESSOR_URL}/active-process/${userId}`, { timeout: 2000 });
      if (goResponse.data.hasActiveProcess && goResponse.data.excelId) {
        activeInGo.add(goResponse.data.excelId);
      }
    } catch {
      // Ignorar errores de conexión a Go
    }
    
    // Solo eliminar los que NO están pendientes NI procesándose
    const toDelete = emptyExcels.filter(excel => 
      !pendingExcelIds.has(excel.id) && !activeInGo.has(excel.id)
    );
    
    if (toDelete.length > 0) {
      await this.metadataRepo.remove(toDelete);
      this.logger.log(`🗑️ Limpiados ${toDelete.length} excels vacíos para usuario ${userId} (${emptyExcels.length - toDelete.length} omitidos por estar activos)`);
    }
    
    return toDelete.length;
  }

  // Obtener registros dinámicos para Excel
  async getDynamicRecordsByExcelId(
    userId: number,
    excelId: number,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: DynamicRecordEntity[]; total: number; totalPages: number }> {
    const [data, total] = await this.dynamicRecordRepo.findAndCount({
      where: { userId, excelId },
      skip: (page - 1) * limit,
      take: limit,
      order: { rowIndex: 'ASC' },
    });

    return {
      data,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getActiveProcess(userId: number): Promise<{ hasActiveProcess: boolean; excelId?: number; filename?: string; progress?: number; total?: number; processed?: number; status?: string; message?: string; headers?: string[] }> {
    // 1. Primero verificar si hay un upload pendiente en NestJS (esperando selección de cabeceras)
    const pending = this.getPendingUploadForUser(userId);
    if (pending) {
      this.logger.log(`📋 Upload pendiente encontrado para usuario ${userId}: Excel ${pending.excelId}`);
      return {
        hasActiveProcess: true,
        excelId: pending.excelId,
        filename: pending.filename,
        progress: 10,
        total: pending.totalRows,
        processed: 0,
        status: 'headers_ready',
        message: `Selecciona las cabeceras a indexar (${pending.headers.length} disponibles)`,
        headers: pending.headers,
      };
    }

    // 2. Si no hay pendiente, consultar al Go processor
    try {
      this.logger.log(`🔍 Consultando proceso activo en Go para usuario ${userId}...`);
      const response = await axios.get(`${env.EXCEL_PROCESSOR_URL}/active-process/${userId}`);
      const data = response.data;
      
      this.logger.log(`📋 Respuesta de Go: hasActiveProcess=${data.hasActiveProcess}, excelId=${data.excelId}, status=${data.status}`);
      
      // Si hay proceso activo, también emitir por WebSocket para que el frontend lo reciba
      if (data.hasActiveProcess && this.gateway) {
        this.gateway.emitExcelProgressToUser(userId, {
          excelId: data.excelId,
          progress: data.progress || 0,
          total: data.total || 0,
          processed: data.processed || 0,
          status: data.status || 'processing',
          filename: data.filename,
          message: data.message,
        });
      }
      
      return data;
    } catch (error: any) {
      this.logger.error(`Error obteniendo proceso activo: ${error.message}`);
      return { hasActiveProcess: false };
    }
  }

  async getProcessingProgress(excelId: number, userId?: number, filename?: string): Promise<{ progress: number; total: number; processed: number; status: string }> {
    try {
      const response = await axios.get(`${env.EXCEL_PROCESSOR_URL}/progress/${excelId}`);
      const progressData = response.data;
      
      // Emitir evento por WebSocket si hay userId
      if (userId && this.gateway) {
        if (progressData.status === 'not_found') {
          this.gateway.emitExcelProgressNotFoundToUser(userId, excelId);
        } else {
          this.gateway.emitExcelProgressToUser(userId, {
            excelId,
            progress: progressData.progress || 0,
            total: progressData.total || 0,
            processed: progressData.processed || 0,
            status: progressData.status || 'processing',
            filename,
          });
        }
      }
      
      return progressData;
    } catch (error: any) {
      this.logger.error(`Error obteniendo progreso: ${error.message}`);
      
      // Si es error 404 o not_found, emitir evento
      if (userId && this.gateway && (error.response?.status === 404 || error.response?.data?.status === 'not_found')) {
        this.gateway.emitExcelProgressNotFoundToUser(userId, excelId);
      }
      
      return { progress: 0, total: 0, processed: 0, status: 'not_found' };
    }
  }

  // Método para notificar progreso vía WebSocket (llamado por el endpoint de notificación)
  notifyProgressViaWebSocket(
    userId: number,
    excelId: number,
    progress: number,
    total: number,
    processed: number,
    status: string,
    filename?: string,
    message?: string,
  ): void {
    if (this.gateway) {
      if (status === 'not_found') {
        this.gateway.emitExcelProgressNotFoundToUser(userId, excelId);
      } else {
        this.gateway.emitExcelProgressToUser(userId, {
          excelId,
          progress,
          total,
          processed,
          status,
          filename,
          message,
        });
      }
    }
  }

  /**
   * Notificar al remitente por WhatsApp cuando el Excel termine de procesarse
   */
  async notifyExcelCompletedViaWhatsApp(
    excelId: number,
    userId: number,
    totalRecords: number,
  ): Promise<void> {
    try {
      // Obtener metadata del Excel para saber a quién notificar
      const metadata = await this.metadataRepo.findOne({
        where: { id: excelId, userId },
      });

      if (!metadata) {
        this.logger.warn(`⚠️ No se encontró metadata para Excel ${excelId}`);
        return;
      }

      const uploadedBy = metadata.uploadedBy;
      if (!uploadedBy) {
        this.logger.warn(`⚠️ Excel ${excelId} no tiene uploadedBy registrado`);
        return;
      }

      const indexedHeaders = metadata.indexedHeaders || [];
      const columnsText = indexedHeaders.length > 0 
        ? indexedHeaders.join(', ') 
        : 'todas las columnas';

      const message = 
        `✅ *Excel procesado exitosamente*\n\n` +
        `📁 Archivo: ${metadata.filename}\n` +
        `📊 Registros: ${totalRecords.toLocaleString()}\n` +
        `🔍 Columnas indexadas: ${columnsText}\n\n` +
        `_Ya puedes realizar búsquedas enviando mensajes con el formato:_\n` +
        `*columna: valor*`;

      await this.whatsappService.sendNotification(userId, uploadedBy, message);
      this.logger.log(`📱 Notificación de Excel completado enviada a ${uploadedBy}`);
    } catch (error) {
      this.logger.error(`❌ Error notificando por WhatsApp: ${error.message}`);
    }
  }

  async deleteExcel(userId: number, excelId: number): Promise<void> {
    // Verificar que el Excel pertenece al usuario
    const excel = await this.metadataRepo.findOne({ 
      where: { id: excelId, userId },
    });

    if (!excel) {
      throw new Error('Excel no encontrado o no tienes permiso para eliminarlo');
    }

    // ⚡ Eliminar índices asociados a este Excel
    await this.dropIndexesForExcel(excelId);

    // 🗑️ SIEMPRE eliminar el formato asociado (para que vuelva a pedir cabeceras)
    const format = await this.formatRepo.findOne({
      where: { currentExcelId: excelId, userId },
    });
    
    if (format) {
      await this.formatRepo.remove(format);
      this.logger.log(`🗑️ Formato eliminado junto con Excel: ${format.name} (id=${format.id})`);
    }

    // Eliminar registros asociados (se eliminan automáticamente por onDelete: 'CASCADE')
    // Eliminar metadata
    await this.metadataRepo.remove(excel);
  }

  // Obtener un Excel específico
  async getExcelById(userId: number, excelId: number): Promise<ExcelMetadataEntity | null> {
    return this.metadataRepo.findOne({ 
      where: { id: excelId, userId },
    });
  }

  // ⚡ Buscar en registros dinámicos por valor de columna (ULTRA OPTIMIZADO)
  async searchDynamicRecords(
    userId: number,
    excelId: number,
    columnNames: string | string[], // Una o múltiples columnas
    searchValue: string,
  ): Promise<DynamicRecordEntity[]> {
    const columns = Array.isArray(columnNames) ? columnNames : [columnNames];
    const normalizedSearch = searchValue.trim();
    
    if (columns.length === 0 || !normalizedSearch) {
      return [];
    }

    const startTime = Date.now();

    // ⚡ BÚSQUEDA ULTRA RÁPIDA: Usar SQL nativo con índices
    // Escapar nombres de columna para seguridad (evitar SQL injection)
    const escapeColumnName = (col: string) => col.replace(/'/g, "''");
    const lowerSearch = normalizedSearch.toLowerCase();
    
    // ⚡ BÚSQUEDA EXACTA con LOWER() - USA el índice creado sobre LOWER("rowData" ->> 'column')
    const exactConditions = columns.map(col => {
      const safeCol = escapeColumnName(col);
      return `LOWER("rowData" ->> '${safeCol}') = $1`;
    }).join(' OR ');
    
    // Orden optimizado: excel_id primero para usar índice parcial
    const exactQuery = `
      SELECT * FROM dynamic_records 
      WHERE excel_id = $2 
        AND user_id = $3 
        AND (${exactConditions})
      ORDER BY "rowIndex" ASC
      LIMIT 10
    `;

    try {
      // Usar query nativa para máxima velocidad
      const exactResults = await this.dynamicRecordRepo.query(exactQuery, [lowerSearch, excelId, userId]);
      
      if (exactResults.length > 0) {
        const duration = Date.now() - startTime;
        this.logger.log(`⚡ Búsqueda EXACTA completada en ${duration}ms: ${exactResults.length} resultados (índice usado)`);
        return this.mapRawResults(exactResults);
      }
      
      // Si no hay resultados exactos, buscar parcial con LIKE
      const partialConditions = columns.map(col => {
        const safeCol = escapeColumnName(col);
        return `LOWER("rowData" ->> '${safeCol}') LIKE $1`;
      }).join(' OR ');
      
      const partialQuery = `
        SELECT * FROM dynamic_records 
        WHERE excel_id = $2 
          AND user_id = $3 
          AND (${partialConditions})
        ORDER BY "rowIndex" ASC
        LIMIT 10
      `;
      
      const partialResults = await this.dynamicRecordRepo.query(partialQuery, [`%${lowerSearch}%`, excelId, userId]);
      const duration = Date.now() - startTime;
      this.logger.log(`⚡ Búsqueda PARCIAL completada en ${duration}ms: ${partialResults.length} resultados`);
      
      return this.mapRawResults(partialResults);
    } catch (error) {
      this.logger.error(`Error en búsqueda: ${error.message}`);
      return [];
    }
  }
  
  // Mapear resultados raw a entidades
  private mapRawResults(rawResults: any[]): DynamicRecordEntity[] {
    return rawResults.map(row => {
      const record = new DynamicRecordEntity();
      record.id = row.id;
      record.userId = row.user_id;
      record.excelId = row.excel_id;
      record.rowData = row.rowData;
      record.rowIndex = row.rowIndex;
      record.createdAt = row.createdAt;
      return record;
    });
  }

  // Normalizar valor de búsqueda (sin tildes, minúsculas, sin espacios extra)
  private normalizeSearchValue(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .normalize('NFD') // Descompone caracteres con tildes
      .replace(/[\u0300-\u036f]/g, '') // Elimina tildes
      .replace(/\s+/g, ' '); // Normaliza espacios
  }

  // ⚡ CREAR ÍNDICES REALES EN POSTGRESQL para las columnas indexadas
  async createRealIndexesForExcel(excelId: number, userId: number): Promise<void> {
    const startTime = Date.now();
    
    try {
      this.logger.log(`🔧 Buscando metadata para Excel ${excelId}, userId ${userId}...`);
      
      // Obtener las cabeceras indexadas de la metadata (sin filtrar por userId ya que viene de Go)
      let metadata = await this.metadataRepo.findOne({ where: { id: excelId, userId } });
      
      // Si no encuentra con userId, intentar solo con id (por si el userId de Go no coincide)
      if (!metadata) {
        this.logger.warn(`⚠️ No encontrado con userId ${userId}, buscando solo por id...`);
        metadata = await this.metadataRepo.findOne({ where: { id: excelId } });
      }
      
      if (!metadata) {
        this.logger.error(`❌ No existe metadata para Excel ${excelId}`);
        return;
      }
      
      this.logger.log(`📋 Metadata encontrada: id=${metadata.id}, indexedHeaders=${JSON.stringify(metadata.indexedHeaders)}`);
      
      if (!metadata.indexedHeaders || metadata.indexedHeaders.length === 0) {
        this.logger.warn(`⚠️ No hay cabeceras indexadas para Excel ${excelId} (indexedHeaders es null o vacío)`);
        return;
      }

      const indexedHeaders = metadata.indexedHeaders;
      this.logger.log(`🔧 Creando ${indexedHeaders.length} índices reales para Excel ${excelId}: ${indexedHeaders.join(', ')}`);

      // Crear un índice para cada columna seleccionada
      for (const column of indexedHeaders) {
        const indexName = `idx_excel_${excelId}_${column.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        
        try {
          // Crear índice parcial para este Excel y esta columna específica
          // Usamos LOWER para búsquedas case-insensitive
          await this.dataSource.query(`
            CREATE INDEX IF NOT EXISTS "${indexName}" 
            ON dynamic_records ((LOWER("rowData" ->> '${column}')))
            WHERE excel_id = ${excelId};
          `);
          
          this.logger.log(`  ✅ Índice creado: ${indexName}`);
        } catch (indexError: any) {
          this.logger.warn(`  ⚠️ Error creando índice ${indexName}: ${indexError.message}`);
        }
      }

      // ⚡ ANALYZE solo para este Excel específico (mucho más rápido)
      // NO hacer ANALYZE global - es muy lento con millones de registros
      this.logger.log(`  📊 Índices creados (ANALYZE omitido para velocidad)`);

      const duration = Date.now() - startTime;
      this.logger.log(`⚡ ${indexedHeaders.length} índices creados en ${duration}ms para Excel ${excelId}`);
      
    } catch (error: any) {
      this.logger.error(`❌ Error creando índices para Excel ${excelId}: ${error.message}`);
    }
  }

  // Eliminar índices cuando se elimina un Excel
  async dropIndexesForExcel(excelId: number): Promise<void> {
    try {
      // Buscar y eliminar todos los índices de este Excel
      const result = await this.dataSource.query(`
        SELECT indexname FROM pg_indexes 
        WHERE tablename = 'dynamic_records' 
        AND indexname LIKE 'idx_excel_${excelId}_%';
      `);

      for (const row of result) {
        await this.dataSource.query(`DROP INDEX IF EXISTS "${row.indexname}";`);
        this.logger.log(`🗑️ Índice eliminado: ${row.indexname}`);
      }
    } catch (error) {
      this.logger.warn(`⚠️ Error eliminando índices: ${error.message}`);
    }
  }

  // ============================================================================
  // GESTIÓN DE FORMATOS DE EXCEL (Guardar estructura para reutilización)
  // ============================================================================

  /**
   * Extrae el patrón base del nombre del archivo
   * Ej: "inversiones.xlsx" -> "inversiones"
   *     "inversiones_v2.xlsx" -> "inversiones"
   *     "inversiones (1).xlsx" -> "inversiones"
   */
  private extractFilePattern(filename: string): string {
    // Quitar extensión
    let pattern = filename.replace(/\.(xlsx|xls)$/i, '');
    // Quitar sufijos comunes como _v2, _v3, (1), (2), _copy, etc.
    pattern = pattern.replace(/[_\s]*(v\d+|\(\d+\)|copy|copia|nuevo|new|\d{8,})$/i, '');
    // Normalizar: minúsculas y sin espacios extra
    pattern = pattern.toLowerCase().trim();
    return pattern;
  }

  /**
   * Buscar un formato existente para un archivo
   */
  async findFormatForFile(userId: number, filename: string): Promise<ExcelFormatEntity | null> {
    const pattern = this.extractFilePattern(filename);
    
    // Buscar formato que coincida con el patrón
    const format = await this.formatRepo.findOne({
      where: { userId, filePattern: pattern, isActive: true },
    });
    
    if (format) {
      this.logger.log(`📋 Formato encontrado para "${filename}": ${format.name} (id=${format.id})`);
    }
    
    return format;
  }

  /**
   * Crear o actualizar un formato de Excel
   */
  async saveFormat(
    userId: number,
    name: string,
    filename: string,
    headers: string[],
    indexedHeaders: string[],
    excelId: number,
  ): Promise<ExcelFormatEntity> {
    const pattern = this.extractFilePattern(filename);
    
    // Verificar si ya existe un formato con este patrón
    let format = await this.formatRepo.findOne({
      where: { userId, filePattern: pattern },
    });
    
    if (format) {
      // Actualizar formato existente
      format.name = name;
      format.headers = headers;
      format.indexedHeaders = indexedHeaders;
      format.currentExcelId = excelId;
      format.isActive = true;
      format = await this.formatRepo.save(format);
      this.logger.log(`📝 Formato actualizado: ${format.name} (id=${format.id})`);
    } else {
      // Crear nuevo formato
      format = this.formatRepo.create({
        userId,
        name,
        filePattern: pattern,
        headers,
        indexedHeaders,
        currentExcelId: excelId,
        isActive: true,
      });
      format = await this.formatRepo.save(format);
      this.logger.log(`✅ Nuevo formato creado: ${format.name} (id=${format.id})`);
    }
    
    return format;
  }

  /**
   * Obtener todos los formatos de un usuario
   */
  async getAllFormats(userId: number): Promise<ExcelFormatEntity[]> {
    return this.formatRepo.find({
      where: { userId, isActive: true },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Obtener un formato por ID
   */
  async getFormatById(userId: number, formatId: number): Promise<ExcelFormatEntity | null> {
    return this.formatRepo.findOne({
      where: { id: formatId, userId },
    });
  }

  /**
   * Eliminar un formato
   */
  async deleteFormat(userId: number, formatId: number): Promise<{ success: boolean; message: string }> {
    const format = await this.formatRepo.findOne({
      where: { id: formatId, userId },
    });
    
    if (!format) {
      return { success: false, message: 'Formato no encontrado' };
    }
    
    await this.formatRepo.remove(format);
    this.logger.log(`🗑️ Formato eliminado: ${format.name} (id=${formatId})`);
    
    return { success: true, message: 'Formato eliminado correctamente' };
  }

  /**
   * Procesar un archivo con formato guardado (automático)
   * - Elimina el Excel anterior asociado al formato
   * - Crea uno nuevo con la misma configuración
   */
  async processWithSavedFormat(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
    format: ExcelFormatEntity,
  ): Promise<{ success: boolean; excelId: number; message: string }> {
    try {
      this.logger.log(`🔄 Procesando con formato guardado: ${format.name}`);
      
      // 1. Eliminar Excel anterior si existe
      if (format.currentExcelId) {
        const oldExcel = await this.metadataRepo.findOne({ 
          where: { id: format.currentExcelId, userId } 
        });
        
        if (oldExcel) {
          this.logger.log(`🗑️ Eliminando Excel anterior (id=${oldExcel.id}): ${oldExcel.filename}`);
          await this.dropIndexesForExcel(oldExcel.id);
          await this.dynamicRecordRepo.delete({ excelId: oldExcel.id });
          await this.metadataRepo.remove(oldExcel);
        }
      }
      
      // 2. Leer cabeceras del nuevo archivo para verificar que coincidan
      const { headers, totalRows } = await this.readExcelHeaders(filePath);
      
      // 3. Crear nueva metadata
      const metadata = this.metadataRepo.create({
        userId,
        filename,
        uploadedBy,
        totalRecords: 0,
        headers,
        indexedHeaders: format.indexedHeaders,
        isReactive: true,
      });
      const savedMetadata = await this.metadataRepo.save(metadata);
      
      // 4. Actualizar formato con el nuevo Excel
      format.currentExcelId = savedMetadata.id;
      await this.formatRepo.save(format);
      
      // 5. Procesar el archivo con Go
      const response = await axios.post(
        `${env.EXCEL_PROCESSOR_URL}/process-from-path`,
        {
          excel_id: savedMetadata.id,
          user_id: userId,
          filename,
          uploaded_by: uploadedBy,
          temp_path: filePath,
          selected_headers: format.indexedHeaders,
        },
        { timeout: 300000 }
      );
      
      this.logger.log(`✅ Archivo procesado con formato guardado: ${format.name}`);
      
      return {
        success: true,
        excelId: savedMetadata.id,
        message: `Procesando con formato "${format.name}"`,
      };
    } catch (error: any) {
      this.logger.error(`❌ Error procesando con formato guardado: ${error.message}`);
      return { success: false, excelId: 0, message: error.message };
    }
  }
}
