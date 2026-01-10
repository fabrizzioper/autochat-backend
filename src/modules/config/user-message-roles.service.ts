import { Injectable, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserMessageRoleEntity } from './user-message-role.entity';
import { AuthorizedNumberEntity } from './authorized-number.entity';

interface AssignRoleDto {
  authorizedNumberId: number;
  messageTemplateId: number;
  messageRoleId: number;
}

@Injectable()
export class UserMessageRolesService {
  private readonly logger = new Logger(UserMessageRolesService.name);

  constructor(
    @InjectRepository(UserMessageRoleEntity)
    private readonly userRoleRepo: Repository<UserMessageRoleEntity>,
    @InjectRepository(AuthorizedNumberEntity)
    private readonly authorizedNumberRepo: Repository<AuthorizedNumberEntity>,
  ) {}

  /**
   * Obtener todos los roles asignados a un usuario
   */
  async findAllByUser(userId: number, authorizedNumberId: number): Promise<UserMessageRoleEntity[]> {
    // Verificar que el número autorizado pertenece al usuario
    const authorizedNumber = await this.authorizedNumberRepo.findOne({
      where: { id: authorizedNumberId, userId },
    });

    if (!authorizedNumber) {
      throw new NotFoundException('Número autorizado no encontrado');
    }

    return this.userRoleRepo.find({
      where: { authorizedNumberId },
      relations: ['messageTemplate', 'messageRole'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Obtener el rol asignado a un usuario para un mensaje específico
   */
  async findByUserAndTemplate(
    authorizedNumberId: number,
    messageTemplateId: number,
  ): Promise<UserMessageRoleEntity | null> {
    return this.userRoleRepo.findOne({
      where: { authorizedNumberId, messageTemplateId },
      relations: ['messageRole'],
    });
  }

  /**
   * Obtener el rol de un número de teléfono para un mensaje
   * Usado al responder mensajes por WhatsApp
   * OPTIMIZADO: Una sola query con JOIN
   */
  async getRoleForPhoneAndTemplate(
    userId: number,
    phoneNumber: string,
    messageTemplateId: number,
  ): Promise<UserMessageRoleEntity | null> {
    // Una sola query con JOIN para obtener el rol directamente
    return this.userRoleRepo
      .createQueryBuilder('umr')
      .innerJoin('umr.authorizedNumber', 'an')
      .innerJoinAndSelect('umr.messageRole', 'mr')
      .where('an.userId = :userId', { userId })
      .andWhere('an.phoneNumber = :phoneNumber', { phoneNumber })
      .andWhere('umr.messageTemplateId = :messageTemplateId', { messageTemplateId })
      .getOne();
  }

  /**
   * Asignar un rol a un usuario para un mensaje
   * Si ya tiene un rol para ese mensaje, lo actualiza
   */
  async assignRole(userId: number, dto: AssignRoleDto): Promise<UserMessageRoleEntity> {
    // Verificar que el número autorizado pertenece al usuario
    const authorizedNumber = await this.authorizedNumberRepo.findOne({
      where: { id: dto.authorizedNumberId, userId },
    });

    if (!authorizedNumber) {
      throw new NotFoundException('Número autorizado no encontrado');
    }

    // Verificar si ya existe una asignación para este usuario y mensaje
    let existing = await this.userRoleRepo.findOne({
      where: {
        authorizedNumberId: dto.authorizedNumberId,
        messageTemplateId: dto.messageTemplateId,
      },
    });

    if (existing) {
      // Actualizar el rol existente
      existing.messageRoleId = dto.messageRoleId;
      const updated = await this.userRoleRepo.save(existing);
      this.logger.log(`📝 Rol actualizado para usuario ${dto.authorizedNumberId}, mensaje ${dto.messageTemplateId}`);
      return updated;
    }

    // Crear nueva asignación
    const assignment = this.userRoleRepo.create({
      authorizedNumberId: dto.authorizedNumberId,
      messageTemplateId: dto.messageTemplateId,
      messageRoleId: dto.messageRoleId,
    });

    const saved = await this.userRoleRepo.save(assignment);
    this.logger.log(`📝 Rol asignado a usuario ${dto.authorizedNumberId} para mensaje ${dto.messageTemplateId}`);

    return saved;
  }

  /**
   * Eliminar asignación de rol
   */
  async removeAssignment(userId: number, assignmentId: number): Promise<void> {
    const assignment = await this.userRoleRepo.findOne({
      where: { id: assignmentId },
      relations: ['authorizedNumber'],
    });

    if (!assignment) {
      throw new NotFoundException('Asignación no encontrada');
    }

    // Verificar que el número autorizado pertenece al usuario
    const authorizedNumber = await this.authorizedNumberRepo.findOne({
      where: { id: assignment.authorizedNumberId, userId },
    });

    if (!authorizedNumber) {
      throw new NotFoundException('No tienes permiso para eliminar esta asignación');
    }

    await this.userRoleRepo.remove(assignment);
    this.logger.log(`🗑️ Asignación de rol eliminada: ${assignmentId}`);
  }

  /**
   * Eliminar asignación por usuario y mensaje
   */
  async removeByUserAndTemplate(
    userId: number,
    authorizedNumberId: number,
    messageTemplateId: number,
  ): Promise<void> {
    // Verificar que el número autorizado pertenece al usuario
    const authorizedNumber = await this.authorizedNumberRepo.findOne({
      where: { id: authorizedNumberId, userId },
    });

    if (!authorizedNumber) {
      throw new NotFoundException('Número autorizado no encontrado');
    }

    await this.userRoleRepo.delete({
      authorizedNumberId,
      messageTemplateId,
    });
  }
}

