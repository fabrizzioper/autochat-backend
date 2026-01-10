import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { MessageTemplateEntity } from './message-template.entity';

/**
 * Rol de mensaje - Define una porción del mensaje que verá un rol específico
 * Cada mensaje puede tener múltiples roles, cada uno con una selección diferente del texto
 */
@Entity('message_roles')
@Index(['messageTemplateId'])
export class MessageRoleEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'message_template_id' })
  messageTemplateId: number;

  @ManyToOne(() => MessageTemplateEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_template_id' })
  messageTemplate: MessageTemplateEntity;

  @Column()
  roleName: string; // Nombre del rol (ej: "Coordinador", "Supervisor")

  @Column({ type: 'text' })
  selectedText: string; // La porción del mensaje que verá este rol

  @Column()
  startIndex: number; // Posición inicial de la selección en el template original

  @Column()
  endIndex: number; // Posición final de la selección en el template original

  @Column({ default: '#3B82F6' })
  color: string; // Color para identificar visualmente (hex)

  @CreateDateColumn()
  createdAt: Date;
}

