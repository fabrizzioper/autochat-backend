import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { env } from '../../config/env';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as XLSX from 'xlsx';
import axios from 'axios';
import { WhatsAppGateway } from '../whatsapp/whatsapp.gateway';
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
}

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);
  
  // Mapa de uploads pendientes (esperando selección de cabeceras)
  private pendingUploads = new Map<number, PendingUpload>();

  constructor(
    @InjectRepository(ExcelMetadataEntity)
    private readonly metadataRepo: Repository<ExcelMetadataEntity>,
    @InjectRepository(DynamicRecordEntity)
    private readonly dynamicRecordRepo: Repository<DynamicRecordEntity>,
    @Inject(forwardRef(() => WhatsAppGateway))
    private readonly gateway: WhatsAppGateway,
  ) {}

  // ============================================================================
  // NUEVO FLUJO: FASE 1 - Leer solo cabeceras
  // ============================================================================

  /**
   * Lee solo la primera fila (cabeceras) de un Excel
   * ⚡ ULTRA OPTIMIZADO: Lee directamente del ZIP sin parsear todo el archivo
   */
  async readExcelHeaders(filePath: string): Promise<{ headers: string[]; totalRows: number }> {
    const startTime = Date.now();
    
    try {
      // ⚡ MÉTODO RÁPIDO: Leer directamente del ZIP
      const result = await this.readHeadersFromZip(filePath);
      const duration = Date.now() - startTime;
      this.logger.log(`⚡ Cabeceras leídas en ${duration}ms (ZIP): ${result.headers.length} columnas, ~${result.totalRows} filas`);
      return result;
    } catch (error) {
      // Fallback al método tradicional si falla
      this.logger.warn(`⚠️ Fallback a XLSX tradicional: ${error.message}`);
      return this.readHeadersWithXLSX(filePath, startTime);
    }
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
   */
  async uploadAndReadHeaders(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
  ): Promise<{ success: boolean; excelId: number; headers: string[]; totalRows: number; message: string }> {
    try {
      this.logger.log(`📊 Leyendo cabeceras de: ${filename}`);
      
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
        });
      }

      return {
        success: true,
        excelId: savedMetadata.id,
        headers,
        totalRows,
        message: 'Cabeceras leídas correctamente',
      };
    } catch (error: any) {
      this.logger.error(`❌ Error leyendo cabeceras: ${error.message}`);
      return { success: false, excelId: 0, headers: [], totalRows: 0, message: error.message };
    }
  }

  /**
   * FASE 2: Continuar procesamiento con cabeceras seleccionadas
   */
  async continueProcessingWithHeaders(
    excelId: number,
    userId: number,
    selectedHeaders: string[],
    jwtToken?: string,
  ): Promise<{ success: boolean; message: string }> {
    const pending = this.pendingUploads.get(excelId);
    
    if (!pending) {
      return { success: false, message: 'No hay proceso pendiente para este Excel' };
    }
    
    if (pending.userId !== userId) {
      return { success: false, message: 'No tienes permiso para continuar este proceso' };
    }

    try {
      this.logger.log(`▶️ Continuando procesamiento de Excel ${excelId} con ${selectedHeaders.length} cabeceras a indexar`);
      
      // 1. Guardar las cabeceras indexadas en la metadata
      await this.metadataRepo.update(excelId, {
        indexedHeaders: selectedHeaders,
      });
      this.logger.log(`💾 Cabeceras indexadas guardadas: ${selectedHeaders.join(', ')}`);
      
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

      return { success: true, message: 'Procesamiento iniciado correctamente' };
    } catch (error: any) {
      this.logger.error(`❌ Error continuando procesamiento: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Cancelar upload pendiente (cuando el usuario recarga sin seleccionar)
   */
  async cancelPendingUpload(excelId: number, userId: number): Promise<{ success: boolean; message: string }> {
    const pending = this.pendingUploads.get(excelId);
    
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
    return this.metadataRepo.find({ 
      where: { userId },
      order: { uploadedAt: 'DESC' },
    });
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

  async deleteExcel(userId: number, excelId: number): Promise<void> {
    // Verificar que el Excel pertenece al usuario
    const excel = await this.metadataRepo.findOne({ 
      where: { id: excelId, userId },
    });

    if (!excel) {
      throw new Error('Excel no encontrado o no tienes permiso para eliminarlo');
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

  // Buscar en registros dinámicos por valor de columna (soporta múltiples columnas)
  async searchDynamicRecords(
    userId: number,
    excelId: number,
    columnNames: string | string[], // Una o múltiples columnas
    searchValue: string,
  ): Promise<DynamicRecordEntity[]> {
    // Buscar todos los registros del Excel
    const allRecords = await this.dynamicRecordRepo.find({
      where: { userId, excelId },
      order: { rowIndex: 'ASC' },
    });

    const columns = Array.isArray(columnNames) ? columnNames : [columnNames];
    const normalizedSearch = this.normalizeSearchValue(searchValue);

    // Filtrar por el valor en cualquiera de las columnas
    return allRecords.filter(record => {
      return columns.some(columnName => {
        const cellValue = record.rowData[columnName];
        if (cellValue === null || cellValue === undefined) return false;
        const normalizedCell = this.normalizeSearchValue(String(cellValue));
        // Búsqueda flexible: completo o parcial
        return normalizedCell.includes(normalizedSearch) || normalizedSearch.includes(normalizedCell);
      });
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
}
