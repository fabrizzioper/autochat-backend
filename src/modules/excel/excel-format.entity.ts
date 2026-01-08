import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserEntity } from '../users/user.entity';

/**
 * ExcelFormatEntity - Guarda la estructura/configuración de un Excel para reutilización
 * 
 * Cuando un usuario sube un archivo y elige "Guardar Formato", se almacena:
 * - El patrón del nombre del archivo (ej: "inversiones")
 * - Las cabeceras del Excel
 * - Las columnas seleccionadas para indexar
 * 
 * Beneficios:
 * - La próxima vez que se sube un archivo con el mismo nombre, se usa esta configuración
 * - Los message_templates se asocian al formato, no al Excel específico
 * - Permite eliminar y recrear el Excel sin perder la configuración de mensajes
 */
@Entity('excel_formats')
export class ExcelFormatEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column()
  name: string; // Nombre descriptivo del formato (ej: "Inversiones MEF")

  @Column({ name: 'file_pattern' })
  filePattern: string; // Patrón del nombre del archivo (ej: "inversiones" para inversiones.xlsx, inversiones_v2.xlsx, etc.)

  @Column({ type: 'json' })
  headers: string[]; // Todas las cabeceras del Excel

  @Column({ type: 'json', name: 'indexed_headers' })
  indexedHeaders: string[]; // Columnas seleccionadas para búsqueda rápida

  @Column({ name: 'current_excel_id', type: 'int', nullable: true })
  currentExcelId: number | null; // ID del Excel actualmente activo para este formato

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

