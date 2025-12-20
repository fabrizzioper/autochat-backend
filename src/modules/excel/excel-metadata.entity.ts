import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { RecordEntity } from '../records/record.entity';
import { UserEntity } from '../users/user.entity';

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

  @CreateDateColumn()
  uploadedAt: Date;

  @OneToMany(() => RecordEntity, record => record.excel)
  records: RecordEntity[];
}

