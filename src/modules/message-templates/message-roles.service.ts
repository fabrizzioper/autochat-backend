import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageRoleEntity, TextSelection } from './message-role.entity';
import { MessageTemplateEntity } from './message-template.entity';

interface CreateRoleDto {
  messageTemplateId: number;
  roleName: string;
  color?: string;
}

interface UpdateRoleDto {
  roleName?: string;
  selections?: TextSelection[];
  color?: string;
}

interface AddSelectionDto {
  text: string;
  start: number;
  end: number;
}

// Colores predefinidos para roles (se asignan automáticamente)
const ROLE_COLORS = [
  '#3B82F6', // Azul
  '#10B981', // Verde
  '#F59E0B', // Amarillo
  '#EF4444', // Rojo
  '#8B5CF6', // Púrpura
  '#EC4899', // Rosa
  '#06B6D4', // Cyan
  '#F97316', // Naranja
];

@Injectable()
export class MessageRolesService {
  private readonly logger = new Logger(MessageRolesService.name);

  constructor(
    @InjectRepository(MessageRoleEntity)
    private readonly roleRepo: Repository<MessageRoleEntity>,
    @InjectRepository(MessageTemplateEntity)
    private readonly templateRepo: Repository<MessageTemplateEntity>,
  ) {}

  /**
   * Obtener todos los roles de un mensaje
   */
  async findAllByTemplate(userId: number, messageTemplateId: number): Promise<MessageRoleEntity[]> {
    // Verificar que el template pertenece al usuario
    const template = await this.templateRepo.findOne({
      where: { id: messageTemplateId, userId },
    });

    if (!template) {
      throw new NotFoundException('Mensaje no encontrado');
    }

    return this.roleRepo.find({
      where: { messageTemplateId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Obtener un rol por ID
   */
  async findById(userId: number, roleId: number): Promise<MessageRoleEntity> {
    const role = await this.roleRepo.findOne({
      where: { id: roleId },
      relations: ['messageTemplate'],
    });

    if (!role) {
      throw new NotFoundException('Rol no encontrado');
    }

    // Verificar que el mensaje pertenece al usuario
    const template = await this.templateRepo.findOne({
      where: { id: role.messageTemplateId, userId },
    });

    if (!template) {
      throw new NotFoundException('No tienes permiso para ver este rol');
    }

    return role;
  }

  /**
   * Crear un nuevo rol para un mensaje
   */
  async create(userId: number, dto: CreateRoleDto): Promise<MessageRoleEntity> {
    // Verificar que el template pertenece al usuario
    const template = await this.templateRepo.findOne({
      where: { id: dto.messageTemplateId, userId },
    });

    if (!template) {
      throw new NotFoundException('Mensaje no encontrado');
    }

    // Obtener roles existentes para asignar color automáticamente
    const existingRoles = await this.roleRepo.count({
      where: { messageTemplateId: dto.messageTemplateId },
    });

    const color = dto.color || ROLE_COLORS[existingRoles % ROLE_COLORS.length];

    const role = this.roleRepo.create({
      messageTemplateId: dto.messageTemplateId,
      roleName: dto.roleName,
      selections: [],
      color,
    });

    const saved = await this.roleRepo.save(role);
    this.logger.log(`📝 Rol creado: "${dto.roleName}" para mensaje ${dto.messageTemplateId}`);

    return saved;
  }

  /**
   * Actualizar un rol
   */
  async update(userId: number, roleId: number, dto: UpdateRoleDto): Promise<MessageRoleEntity> {
    const role = await this.findById(userId, roleId);

    if (dto.roleName !== undefined) role.roleName = dto.roleName;
    if (dto.selections !== undefined) role.selections = dto.selections;
    if (dto.color !== undefined) role.color = dto.color;

    return this.roleRepo.save(role);
  }

  /**
   * Agregar una selección a un rol
   */
  async addSelection(userId: number, roleId: number, selection: AddSelectionDto): Promise<MessageRoleEntity> {
    const role = await this.findById(userId, roleId);
    
    // Asegurar que selections es un array
    if (!role.selections) role.selections = [];
    
    // Agregar la nueva selección
    role.selections.push({
      text: selection.text,
      start: selection.start,
      end: selection.end,
    });

    return this.roleRepo.save(role);
  }

  /**
   * Eliminar una selección de un rol por índice
   */
  async removeSelection(userId: number, roleId: number, selectionIndex: number): Promise<MessageRoleEntity> {
    const role = await this.findById(userId, roleId);
    
    if (!role.selections || selectionIndex < 0 || selectionIndex >= role.selections.length) {
      throw new NotFoundException('Selección no encontrada');
    }
    
    role.selections.splice(selectionIndex, 1);
    return this.roleRepo.save(role);
  }

  /**
   * Eliminar un rol
   */
  async delete(userId: number, roleId: number): Promise<void> {
    const role = await this.findById(userId, roleId);
    await this.roleRepo.remove(role);
    this.logger.log(`🗑️ Rol eliminado: "${role.roleName}"`);
  }

  /**
   * Obtener el texto combinado de todas las selecciones de un rol
   */
  async getTextForRole(roleId: number): Promise<string | null> {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role || !role.selections || role.selections.length === 0) return null;
    return role.selections.map(s => s.text).join('\n\n');
  }
}
