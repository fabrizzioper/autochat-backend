import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from '../users/user.entity';
import { ExcelMetadataEntity } from '../excel/excel-metadata.entity';
import { ExcelFormatEntity } from '../excel/excel-format.entity';

@Entity('message_templates')
export class MessageTemplateEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ name: 'excel_id', nullable: true })
  excelId: number | null;

  @ManyToOne(() => ExcelMetadataEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'excel_id' })
  excel: ExcelMetadataEntity | null;

  @Column({ name: 'format_id', nullable: true })
  formatId: number | null;

  @ManyToOne(() => ExcelFormatEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'format_id' })
  format: ExcelFormatEntity | null;

  @Column()
  name: string;

  @Column({ type: 'json' })
  keywords: string[]; // Palabras clave para activar (ej: ["buscar", "info", "consulta"])

  @Column({ type: 'json' })
  searchColumns: string[]; // Columnas donde buscar (ej: ["CODIGO", "SNIP", "NOMBRE_INVERSION"])

  @Column({ type: 'json', default: '[]' })
  numericColumns: string[]; // Columnas que deben formatearse como números (ej: 2384723.34 → 2,384,723.34)

  @Column({ type: 'text' })
  template: string; // Plantilla del mensaje con placeholders como {{Nombre}}, {{Email}}

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

