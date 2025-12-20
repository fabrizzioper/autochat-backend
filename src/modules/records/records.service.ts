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

  async findByCui(cui: number): Promise<RecordEntity | null> {
    return this.repo.findOne({ where: { cui } });
  }

  formatRecordResponse(record: RecordEntity): string {
    return `Respuesta Automática\n` +
      `Datos generales del CUI: ${record.cui} "${record.nombreProyecto}"\n\n` +
      `INFORMACIÓN DE LA ENTIDAD\n` +
      `• Entidad a cargo del Proyecto: ${record.entidad}\n\n` +
      `DATOS BÁSICOS DEL PROYECTO\n` +
      `• Función del proyecto / Sector: ${record.sector}\n` +
      `• Estado del proyecto: ${record.estadoProyecto}\n` +
      `• Tipo de proyecto: ${record.tipoProyecto}\n` +
      `• Tiene expediente técnico o documento equivalente: ${record.tieneExpediente}\n` +
      `• Se registra al menos un contrato relacionado al proyecto: ${record.tieneContrato}\n` +
      `• Se registra al menos un proceso relacionado al proyecto: ${record.tieneProceso}\n` +
      `• Se encuentra programado en el PMI: Si (Con un PMI 2026 de S/ ${record.pmi2026.toLocaleString('es-PE')})\n\n` +
      `DATOS PRESUPUESTALES 2025 DEL PROYECTO\n` +
      `• Costo total de la inversión: S/ ${record.costoTotal.toLocaleString('es-PE')}\n` +
      `• Devengado acumulado al 2024: S/ ${record.devengado2024.toLocaleString('es-PE')} (${record.porcentajeDevengado2024}% del costo)\n` +
      `• PIM 2025: S/ ${record.pim2025.toLocaleString('es-PE')} (Certificado ${record.certificadoPorcentaje}%, Comprometido ${record.comprometidoPorcentaje}%, Devengado ${record.devengadoPorcentaje}%)\n` +
      `• Pendiente por financiar: S/ ${record.pendienteFinanciar.toLocaleString('es-PE')} (Descontando el PIM 2025)\n` +
      `• El proyecto ${record.enAnexoLey32185 === 'Si' ? '' : 'no '}se encuentra en ningún anexo de la Ley 32185.\n\n` +
      `DATOS PRESUPUESTALES 2026 DEL PROYECTO\n` +
      `• El proyecto cuenta con S/ ${record.montoLey32513.toLocaleString('es-PE')} en la Ley 32513: Ley de Presupuesto 2026. No se encuentra en el Anexo I del mismo.\n` +
      `• Las entidades que programaron a este proyecto son: ${record.entidadProgramadora} (RO S/ ${record.montoLey32513.toLocaleString('es-PE')})\n` +
      `• (Contando el avance acumulado al 2024, el PIM 2025 y la Ley 32513: Ley de Presupuesto 2026, el proyecto se encuentra financiado en ${record.porcentajeFinanciadoTotal}%)\n\n` +
      `DATOS DE TRANSFERENCIAS Y DEMANDAS ADICIONALES\n` +
      `• El proyecto ${record.continuidadInversiones === 'Si' ? '' : 'no '}cuenta con un monto asignado a través de la continuidad de inversiones (Art. 15 y Art. 16).\n` +
      `• El proyecto ${record.enCsLey32416 === 'Si' ? '' : 'no '}es parte del CS de la LEY N 32416.\n` +
      `• El proyecto ${record.incorporaciones2024 === 'Si' ? '' : 'no '}cuenta con incorporaciones por transferencias o créditos suplementarios en el 2024 mediante dispositivos legales.\n` +
      `• A la fecha el proyecto ${record.incorporaciones2025 === 'Si' ? '' : 'no '}cuenta con incorporaciones por transferencias o créditos suplementarios en el 2025 mediante dispositivos legales.\n` +
      `• ${record.demandasAdicionales === 'Si' ? 'Se han recibido' : 'No se han recibido'} solicitudes de demanda adicional para el proyecto en mención.\n` +
      `• Actualizado el ${record.fechaActualizacion}`;
  }
}

