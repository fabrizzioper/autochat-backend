import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecordEntity } from './record.entity';

@Injectable()
export class RecordsService {
  constructor(
    @InjectRepository(RecordEntity)
    private readonly repo: Repository<RecordEntity>,
  ) {}

  async findByCui(userId: number, cui: number): Promise<RecordEntity | null> {
    return this.repo.findOne({ where: { userId, cui } });
  }

  formatRecordResponse(record: RecordEntity): string {
    const formatNumber = (value: number | null): string => {
      return value !== null && value !== undefined ? value.toLocaleString('es-PE') : 'N/A';
    };

    const formatPercent = (value: number | null): string => {
      return value !== null && value !== undefined ? `${value}%` : 'N/A';
    };

    return `Respuesta Automática\n` +
      `Datos generales del CUI: ${record.cui} "${record.nombreProyecto || 'N/A'}"\n\n` +
      `INFORMACIÓN DE LA ENTIDAD\n` +
      `• Entidad a cargo del Proyecto: ${record.entidad || 'N/A'}\n\n` +
      `DATOS BÁSICOS DEL PROYECTO\n` +
      `• Función del proyecto / Sector: ${record.sector || 'N/A'}\n` +
      `• Estado del proyecto: ${record.estadoProyecto || 'N/A'}\n` +
      `• Tipo de proyecto: ${record.tipoProyecto || 'N/A'}\n` +
      `• Tiene expediente técnico o documento equivalente: ${record.tieneExpediente || 'N/A'}\n` +
      `• Se registra al menos un contrato relacionado al proyecto: ${record.tieneContrato || 'N/A'}\n` +
      `• Se registra al menos un proceso relacionado al proyecto: ${record.tieneProceso || 'N/A'}\n` +
      `• Se encuentra programado en el PMI: Si (Con un PMI 2026 de S/ ${formatNumber(record.pmi2026)})\n\n` +
      `DATOS PRESUPUESTALES 2025 DEL PROYECTO\n` +
      `• Costo total de la inversión: S/ ${formatNumber(record.costoTotal)}\n` +
      `• Devengado acumulado al 2024: S/ ${formatNumber(record.devengado2024)} (${formatPercent(record.porcentajeDevengado2024)} del costo)\n` +
      `• PIM 2025: S/ ${formatNumber(record.pim2025)} (Certificado ${formatPercent(record.certificadoPorcentaje)}, Comprometido ${formatPercent(record.comprometidoPorcentaje)}, Devengado ${formatPercent(record.devengadoPorcentaje)})\n` +
      `• Pendiente por financiar: S/ ${formatNumber(record.pendienteFinanciar)} (Descontando el PIM 2025)\n` +
      `• El proyecto ${record.enAnexoLey32185 === 'Si' ? '' : 'no '}se encuentra en ningún anexo de la Ley 32185.\n\n` +
      `DATOS PRESUPUESTALES 2026 DEL PROYECTO\n` +
      `• El proyecto cuenta con S/ ${formatNumber(record.montoLey32513)} en la Ley 32513: Ley de Presupuesto 2026. No se encuentra en el Anexo I del mismo.\n` +
      `• Las entidades que programaron a este proyecto son: ${record.entidadProgramadora || 'N/A'} (RO S/ ${formatNumber(record.montoLey32513)})\n` +
      `• (Contando el avance acumulado al 2024, el PIM 2025 y la Ley 32513: Ley de Presupuesto 2026, el proyecto se encuentra financiado en ${formatPercent(record.porcentajeFinanciadoTotal)})\n\n` +
      `DATOS DE TRANSFERENCIAS Y DEMANDAS ADICIONALES\n` +
      `• El proyecto ${record.continuidadInversiones === 'Si' ? '' : 'no '}cuenta con un monto asignado a través de la continuidad de inversiones (Art. 15 y Art. 16).\n` +
      `• El proyecto ${record.enCsLey32416 === 'Si' ? '' : 'no '}es parte del CS de la LEY N 32416.\n` +
      `• El proyecto ${record.incorporaciones2024 === 'Si' ? '' : 'no '}cuenta con incorporaciones por transferencias o créditos suplementarios en el 2024 mediante dispositivos legales.\n` +
      `• A la fecha el proyecto ${record.incorporaciones2025 === 'Si' ? '' : 'no '}cuenta con incorporaciones por transferencias o créditos suplementarios en el 2025 mediante dispositivos legales.\n` +
      `• ${record.demandasAdicionales === 'Si' ? 'Se han recibido' : 'No se han recibido'} solicitudes de demanda adicional para el proyecto en mención.\n` +
      `• Actualizado el ${record.fechaActualizacion || 'N/A'}`;
  }
}

