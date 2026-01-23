import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export type MessageDirection = 'incoming' | 'outgoing';
export type MessageType = 'text' | 'excel' | 'search_request' | 'search_response';

@Entity('message_stats')
@Index(['userId', 'authorizedNumberId', 'createdAt'])
export class MessageStatsEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  @Index()
  userId: number;

  @Column()
  @Index()
  authorizedNumberId: number;

  @Column()
  phoneNumber: string;

  @Column()
  direction: MessageDirection;

  @Column()
  messageType: MessageType;

  @Column({ type: 'text', nullable: true })
  details: string;

  @CreateDateColumn()
  createdAt: Date;
}
