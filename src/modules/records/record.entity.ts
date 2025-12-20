import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ExcelMetadataEntity } from '../excel/excel-metadata.entity';
import { UserEntity } from '../users/user.entity';

@Entity('records')
export class RecordEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ name: 'excel_id' })
  excelId: number;

  @ManyToOne(() => ExcelMetadataEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'excel_id' })
  excel: ExcelMetadataEntity;

  // Datos del Excel (31 columnas)
  @Column({ unique: true })
  cui: number;

  @Column({ type: 'text', nullable: true })
  nombreProyecto: string;

  @Column({ nullable: true })
  sector: string;

  @Column({ nullable: true })
  entidad: string;

  @Column({ nullable: true })
  departamento: string;

  @Column({ nullable: true })
  provincia: string;

  @Column({ nullable: true })
  distrito: string;

  @Column({ nullable: true })
  estadoProyecto: string;

  @Column({ nullable: true })
  tipoProyecto: string;

  @Column({ nullable: true })
  tieneExpediente: string;

  @Column({ nullable: true })
  tieneContrato: string;

  @Column({ nullable: true })
  tieneProceso: string;

  @Column({ type: 'bigint', nullable: true })
  pmi2026: number;

  @Column({ type: 'bigint', nullable: true })
  costoTotal: number;

  @Column({ type: 'bigint', nullable: true })
  devengado2024: number;

  @Column({ nullable: true })
  porcentajeDevengado2024: number;

  @Column({ type: 'bigint', nullable: true })
  pim2025: number;

  @Column({ nullable: true })
  certificadoPorcentaje: number;

  @Column({ nullable: true })
  comprometidoPorcentaje: number;

  @Column({ nullable: true })
  devengadoPorcentaje: number;

  @Column({ type: 'bigint', nullable: true })
  pendienteFinanciar: number;

  @Column({ nullable: true })
  enAnexoLey32185: string;

  @Column({ type: 'bigint', nullable: true })
  montoLey32513: number;

  @Column({ nullable: true })
  entidadProgramadora: string;

  @Column({ nullable: true })
  porcentajeFinanciadoTotal: number;

  @Column({ nullable: true })
  continuidadInversiones: string;

  @Column({ nullable: true })
  enCsLey32416: string;

  @Column({ nullable: true })
  incorporaciones2024: string;

  @Column({ nullable: true })
  incorporaciones2025: string;

  @Column({ nullable: true })
  demandasAdicionales: string;

  @Column({ nullable: true })
  fechaActualizacion: string;

  @CreateDateColumn()
  createdAt: Date;
}

