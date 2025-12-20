import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ExcelMetadataEntity } from '../excel/excel-metadata.entity';

@Entity('records')
export class RecordEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'excel_id' })
  excelId: number;

  @ManyToOne(() => ExcelMetadataEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'excel_id' })
  excel: ExcelMetadataEntity;

  // Datos del Excel (31 columnas)
  @Column({ unique: true })
  cui: number;

  @Column({ type: 'text' })
  nombreProyecto: string;

  @Column()
  sector: string;

  @Column()
  entidad: string;

  @Column()
  departamento: string;

  @Column()
  provincia: string;

  @Column()
  distrito: string;

  @Column()
  estadoProyecto: string;

  @Column()
  tipoProyecto: string;

  @Column()
  tieneExpediente: string;

  @Column()
  tieneContrato: string;

  @Column()
  tieneProceso: string;

  @Column({ type: 'bigint' })
  pmi2026: number;

  @Column({ type: 'bigint' })
  costoTotal: number;

  @Column({ type: 'bigint' })
  devengado2024: number;

  @Column()
  porcentajeDevengado2024: number;

  @Column({ type: 'bigint' })
  pim2025: number;

  @Column()
  certificadoPorcentaje: number;

  @Column()
  comprometidoPorcentaje: number;

  @Column()
  devengadoPorcentaje: number;

  @Column({ type: 'bigint' })
  pendienteFinanciar: number;

  @Column()
  enAnexoLey32185: string;

  @Column({ type: 'bigint' })
  montoLey32513: number;

  @Column()
  entidadProgramadora: string;

  @Column()
  porcentajeFinanciadoTotal: number;

  @Column()
  continuidadInversiones: string;

  @Column()
  enCsLey32416: string;

  @Column()
  incorporaciones2024: string;

  @Column()
  incorporaciones2025: string;

  @Column()
  demandasAdicionales: string;

  @Column()
  fechaActualizacion: string;

  @CreateDateColumn()
  createdAt: Date;
}

