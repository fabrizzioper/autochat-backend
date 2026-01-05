import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { env } from '../../config/env';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import axios from 'axios';
import { WhatsAppGateway } from '../whatsapp/whatsapp.gateway';

interface ProcessResult {
  success: boolean;
  recordsCount: number;
  message: string;
  excelId?: number;
}

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    @InjectRepository(ExcelMetadataEntity)
    private readonly metadataRepo: Repository<ExcelMetadataEntity>,
    @InjectRepository(DynamicRecordEntity)
    private readonly dynamicRecordRepo: Repository<DynamicRecordEntity>,
    @Inject(forwardRef(() => WhatsAppGateway))
    private readonly gateway: WhatsAppGateway,
  ) {}

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

  async getActiveProcess(userId: number): Promise<{ hasActiveProcess: boolean; excelId?: number; filename?: string; progress?: number; total?: number; processed?: number; status?: string; message?: string }> {
    try {
      this.logger.log(`🔍 Consultando proceso activo para usuario ${userId}...`);
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
