import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { UserEntity } from '../users/user.entity';

@Entity('dynamic_records')
export class DynamicRecordEntity {
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

  @Column({ type: 'json' })
  rowData: Record<string, unknown>;

  @Column()
  rowIndex: number;

  @CreateDateColumn()
  createdAt: Date;
}

