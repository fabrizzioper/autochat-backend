import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from '../users/user.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';

@Entity('excel_metadata')
export class ExcelMetadataEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column()
  filename: string;

  @Column()
  totalRecords: number;

  @Column()
  uploadedBy: string; // Número de teléfono que envió el Excel

  @Column({ type: 'json', nullable: true })
  headers: string[] | null;

  @Column({ default: true })
  isReactive: boolean;

  @CreateDateColumn()
  uploadedAt: Date;

  @OneToMany(() => DynamicRecordEntity, record => record.excel)
  records: DynamicRecordEntity[];
}
