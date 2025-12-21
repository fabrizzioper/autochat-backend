import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from '../users/user.entity';
import { ExcelMetadataEntity } from '../excel/excel-metadata.entity';

@Entity('message_templates')
export class MessageTemplateEntity {
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

  @Column()
  name: string;

  @Column()
  keyword: string; // Palabra clave para activar (ej: "buscar", "info", "claro")

  @Column()
  searchColumn: string; // Columna donde buscar (ej: "ID", "Codigo")

  @Column({ type: 'text' })
  template: string; // Plantilla del mensaje con placeholders como {{Nombre}}, {{Email}}

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

