import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import * as XLSX from 'xlsx';

interface ProcessResult {
  success: boolean;
  recordsCount: number;
  message: string;
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

  // Procesar cualquier Excel de forma dinámica
  async processExcelFile(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
  ): Promise<ProcessResult> {
    try {
      // Leer archivo Excel
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      // Obtener como array de arrays para tener control sobre filas
      const rawData = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

      if (rawData.length < 2) {
        return {
          success: false,
          recordsCount: 0,
          message: 'El Excel debe tener al menos una fila de cabeceras y una de datos',
        };
      }

      // Primera fila = cabeceras
      const headers = (rawData[0] as unknown[]).map((h, index) => 
        h ? String(h).trim() : `Columna_${index + 1}`
      );

      // Resto = datos
      const dataRows = rawData.slice(1).filter(row => 
        Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && cell !== '')
      );

      if (dataRows.length === 0) {
        return {
          success: false,
          recordsCount: 0,
          message: 'El Excel no contiene datos',
        };
      }

      // Crear metadata con cabeceras
      const metadata = this.metadataRepo.create({
        userId,
        filename,
        totalRecords: dataRows.length,
        uploadedBy,
        headers,
        isReactive: true,
      });
      const savedMetadata = await this.metadataRepo.save(metadata);

      // Guardar registros dinámicos
      const dynamicRecords = dataRows.map((row, rowIndex) => {
        const rowData: Record<string, unknown> = {};
        headers.forEach((header, colIndex) => {
          rowData[header] = (row as unknown[])[colIndex] ?? null;
        });
        
        return this.dynamicRecordRepo.create({
          userId,
          excelId: savedMetadata.id,
          rowData,
          rowIndex: rowIndex + 1, // 1-indexed para ser más legible
        });
      });

      await this.dynamicRecordRepo.save(dynamicRecords);

      this.logger.log(`✅ Excel procesado: ${dataRows.length} registros con ${headers.length} columnas`);

      return {
        success: true,
        recordsCount: dataRows.length,
        message: `Excel procesado correctamente. ${dataRows.length} registros con ${headers.length} columnas guardados.`,
      };
    } catch (error) {
      this.logger.error(`❌ Error procesando Excel: ${error.message}`);
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
