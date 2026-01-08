import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('authorized_numbers')
@Index(['userId', 'phoneNumber'], { unique: true })
export class AuthorizedNumberEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  userId: number;

  @Column()
  phoneNumber: string;

  @Column({ nullable: true })
  dni: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  entityName: string;

  @Column({ nullable: true })
  position: string;

  @Column({ default: true })
  canSendExcel: boolean;

  @Column({ default: true })
  canRequestInfo: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

