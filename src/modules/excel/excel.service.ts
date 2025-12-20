import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { RecordEntity } from '../records/record.entity';
import * as XLSX from 'xlsx';

interface ExcelRow {
  CUI: number;
  NOMBRE_PROYECTO: string;
  SECTOR: string;
  ENTIDAD: string;
  DEPARTAMENTO: string;
  PROVINCIA: string;
  DISTRITO: string;
  ESTADO_PROYECTO: string;
  TIPO_PROYECTO: string;
  TIENE_EXPEDIENTE: string;
  TIENE_CONTRATO: string;
  TIENE_PROCESO: string;
  PMI_2026: number;
  COSTO_TOTAL: number;
  DEVENGADO_2024: number;
  PORCENTAJE_DEVENGADO_2024: number;
  PIM_2025: number;
  CERTIFICADO_PORCENTAJE: number;
  COMPROMETIDO_PORCENTAJE: number;
  DEVENGADO_PORCENTAJE: number;
  PENDIENTE_FINANCIAR: number;
  EN_ANEXO_LEY_32185: string;
  MONTO_LEY_32513: number;
  ENTIDAD_PROGRAMADORA: string;
  PORCENTAJE_FINANCIADO_TOTAL: number;
  CONTINUIDAD_INVERSIONES: string;
  EN_CS_LEY_32416: string;
  INCORPORACIONES_2024: string;
  INCORPORACIONES_2025: string;
  DEMANDAS_ADICIONALES: string;
  FECHA_ACTUALIZACION: string;
}

@Injectable()
export class ExcelService {
  private readonly logger = new Logger(ExcelService.name);

  constructor(
    @InjectRepository(ExcelMetadataEntity)
    private readonly metadataRepo: Repository<ExcelMetadataEntity>,
    @InjectRepository(RecordEntity)
    private readonly recordRepo: Repository<RecordEntity>,
  ) {}

  async processExcelFile(
    filePath: string,
    filename: string,
    uploadedBy: string,
    userId: number,
  ): Promise<{ success: boolean; recordsCount: number; message: string }> {
    try {
      // Leer archivo Excel
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json<ExcelRow>(sheet);

      if (data.length === 0) {
        return {
          success: false,
          recordsCount: 0,
          message: 'El Excel está vacío',
        };
      }

      // Crear metadata
      const metadata = this.metadataRepo.create({
        userId,
        filename,
        totalRecords: data.length,
        uploadedBy,
      });
      const savedMetadata = await this.metadataRepo.save(metadata);

      // Guardar registros
      const records = data.map(row => 
        this.recordRepo.create({
          userId,
          excelId: savedMetadata.id,
          cui: row.CUI,
          nombreProyecto: row.NOMBRE_PROYECTO,
          sector: row.SECTOR,
          entidad: row.ENTIDAD,
          departamento: row.DEPARTAMENTO,
          provincia: row.PROVINCIA,
          distrito: row.DISTRITO,
          estadoProyecto: row.ESTADO_PROYECTO,
          tipoProyecto: row.TIPO_PROYECTO,
          tieneExpediente: row.TIENE_EXPEDIENTE,
          tieneContrato: row.TIENE_CONTRATO,
          tieneProceso: row.TIENE_PROCESO,
          pmi2026: row.PMI_2026,
          costoTotal: row.COSTO_TOTAL,
          devengado2024: row.DEVENGADO_2024,
          porcentajeDevengado2024: row.PORCENTAJE_DEVENGADO_2024,
          pim2025: row.PIM_2025,
          certificadoPorcentaje: row.CERTIFICADO_PORCENTAJE,
          comprometidoPorcentaje: row.COMPROMETIDO_PORCENTAJE,
          devengadoPorcentaje: row.DEVENGADO_PORCENTAJE,
          pendienteFinanciar: row.PENDIENTE_FINANCIAR,
          enAnexoLey32185: row.EN_ANEXO_LEY_32185,
          montoLey32513: row.MONTO_LEY_32513,
          entidadProgramadora: row.ENTIDAD_PROGRAMADORA,
          porcentajeFinanciadoTotal: row.PORCENTAJE_FINANCIADO_TOTAL,
          continuidadInversiones: row.CONTINUIDAD_INVERSIONES,
          enCsLey32416: row.EN_CS_LEY_32416,
          incorporaciones2024: row.INCORPORACIONES_2024,
          incorporaciones2025: row.INCORPORACIONES_2025,
          demandasAdicionales: row.DEMANDAS_ADICIONALES,
          fechaActualizacion: row.FECHA_ACTUALIZACION,
        })
      );

      await this.recordRepo.save(records);

      this.logger.log(`✅ Excel procesado: ${data.length} registros guardados`);

      return {
        success: true,
        recordsCount: data.length,
        message: `Excel procesado correctamente. ${data.length} registros guardados en la base de datos.`,
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

  async getRecordsByExcelId(
    userId: number,
    excelId: number,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: RecordEntity[]; total: number; totalPages: number }> {
    const [data, total] = await this.recordRepo.findAndCount({
      where: { userId, excelId },
      skip: (page - 1) * limit,
      take: limit,
      order: { cui: 'ASC' },
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
}

