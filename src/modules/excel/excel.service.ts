import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { env } from '../../config/env';
import FormData from 'form-data';
import * as fs from 'fs/promises';
import axios from 'axios';

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
  ) {}

  // Enviar archivo al microservicio Python que procesa y guarda todo
  async processExcelFile(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
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

  async getProcessingProgress(excelId: number): Promise<{ progress: number; total: number; processed: number; status: string }> {
    try {
      const response = await axios.get(`${env.EXCEL_PROCESSOR_URL}/progress/${excelId}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Error obteniendo progreso: ${error}`);
      return { progress: 0, total: 0, processed: 0, status: 'error' };
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

  // Buscar en registros dinámicos por valor de columna
  async searchDynamicRecords(
    userId: number,
    excelId: number,
    columnName: string,
    searchValue: string,
  ): Promise<DynamicRecordEntity[]> {
    // Buscar todos los registros del Excel
    const allRecords = await this.dynamicRecordRepo.find({
      where: { userId, excelId },
      order: { rowIndex: 'ASC' },
    });

    // Filtrar por el valor de la columna
    return allRecords.filter(record => {
      const cellValue = record.rowData[columnName];
      if (cellValue === null || cellValue === undefined) return false;
      return String(cellValue).toLowerCase().includes(searchValue.toLowerCase());
    });
  }
}
