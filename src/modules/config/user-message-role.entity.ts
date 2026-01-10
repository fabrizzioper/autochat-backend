import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { AuthorizedNumberEntity } from './authorized-number.entity';
import { MessageTemplateEntity } from '../message-templates/message-template.entity';
import { MessageRoleEntity } from '../message-templates/message-role.entity';

/**
 * Asignación de rol a usuario por mensaje
 * Un usuario puede tener diferentes roles para diferentes mensajes
 * Si no tiene rol asignado para un mensaje, recibe el mensaje completo
 */
@Entity('user_message_roles')
@Index(['authorizedNumberId', 'messageTemplateId'], { unique: true }) // Un usuario solo puede tener un rol por mensaje
export class UserMessageRoleEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'authorized_number_id' })
  authorizedNumberId: number;

  @ManyToOne(() => AuthorizedNumberEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'authorized_number_id' })
  authorizedNumber: AuthorizedNumberEntity;

  @Column({ name: 'message_template_id' })
  messageTemplateId: number;

  @ManyToOne(() => MessageTemplateEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_template_id' })
  messageTemplate: MessageTemplateEntity;

  @Column({ name: 'message_role_id' })
  messageRoleId: number;

  @ManyToOne(() => MessageRoleEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'message_role_id' })
  messageRole: MessageRoleEntity;

  @CreateDateColumn()
  createdAt: Date;
}

