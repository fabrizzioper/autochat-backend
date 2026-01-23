import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export type ActivityType = 'login' | 'logout' | 'session_expired' | 'disconnect' | 'user_updated';

@Entity('user_activity_logs')
@Index(['userId', 'createdAt'])
export class UserActivityLogEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  userId: number;

  @Column()
  activityType: ActivityType;

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ nullable: true })
  userAgent: string;

  @Column({ type: 'text', nullable: true })
  details: string;

  @CreateDateColumn()
  createdAt: Date;
}
