import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { MessageTemplateEntity } from './message-template.entity';

/**
 * Una selección de texto dentro del mensaje
 */
export interface TextSelection {
  text: string;
  start: number;
  end: number;
}

/**
 * Rol de mensaje - Define las porciones del mensaje que verá un rol específico
 * Cada mensaje puede tener múltiples roles, cada uno con múltiples selecciones del texto
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

  @Column({ type: 'json', default: '[]' })
  selections: TextSelection[]; // Múltiples porciones del mensaje que verá este rol

  @Column({ default: '#3B82F6' })
  color: string; // Color para identificar visualmente (hex)

  @CreateDateColumn()
  createdAt: Date;

  /**
   * Obtiene el texto combinado de todas las selecciones
   */
  getCombinedText(): string {
    if (!this.selections || this.selections.length === 0) return '';
    return this.selections.map(s => s.text).join('\n\n');
  }
}

