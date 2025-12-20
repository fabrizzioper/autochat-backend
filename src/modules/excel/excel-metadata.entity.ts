import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { RecordEntity } from '../records/record.entity';

@Entity('excel_metadata')
export class ExcelMetadataEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  filename: string;

  @Column()
  totalRecords: number;

  @Column()
  uploadedBy: string; // Número de teléfono que envió el Excel

  @CreateDateColumn()
  uploadedAt: Date;

  @OneToMany(() => RecordEntity, record => record.excel)
  records: RecordEntity[];
}

