import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, UseGuards, Query } from '@nestjs/common';
import { UserMessageRolesService } from './user-message-roles.service';
import { UserMessageRoleEntity } from './user-message-role.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

interface AssignRoleDto {
  authorizedNumberId: number;
  messageTemplateId: number;
  messageRoleId: number;
}

@Controller('user-message-roles')
@UseGuards(JwtAuthGuard)
export class UserMessageRolesController {
  constructor(private readonly service: UserMessageRolesService) {}

  /**
   * Obtener todos los roles asignados a un usuario (número autorizado)
   */
  @Get('user/:authorizedNumberId')
  async findAllByUser(
    @GetUser() user: UserEntity,
    @Param('authorizedNumberId', ParseIntPipe) authorizedNumberId: number,
  ): Promise<UserMessageRoleEntity[]> {
    return this.service.findAllByUser(user.id, authorizedNumberId);
  }

  /**
   * Obtener el rol de un usuario para un mensaje específico
   */
  @Get('user/:authorizedNumberId/template/:templateId')
  async findByUserAndTemplate(
    @GetUser() user: UserEntity,
    @Param('authorizedNumberId', ParseIntPipe) authorizedNumberId: number,
    @Param('templateId', ParseIntPipe) templateId: number,
  ): Promise<UserMessageRoleEntity | null> {
    return this.service.findByUserAndTemplate(authorizedNumberId, templateId);
  }

  /**
   * Asignar un rol a un usuario para un mensaje
   */
  @Post()
  async assignRole(
    @GetUser() user: UserEntity,
    @Body() dto: AssignRoleDto,
  ): Promise<UserMessageRoleEntity> {
    return this.service.assignRole(user.id, dto);
  }

  /**
   * Eliminar asignación de rol por ID
   */
  @Delete(':assignmentId')
  async removeAssignment(
    @GetUser() user: UserEntity,
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
  ): Promise<{ success: boolean; message: string }> {
    await this.service.removeAssignment(user.id, assignmentId);
    return { success: true, message: 'Asignación eliminada correctamente' };
  }

  /**
   * Eliminar asignación por usuario y mensaje
   */
  @Delete('user/:authorizedNumberId/template/:templateId')
  async removeByUserAndTemplate(
    @GetUser() user: UserEntity,
    @Param('authorizedNumberId', ParseIntPipe) authorizedNumberId: number,
    @Param('templateId', ParseIntPipe) templateId: number,
  ): Promise<{ success: boolean; message: string }> {
    await this.service.removeByUserAndTemplate(user.id, authorizedNumberId, templateId);
    return { success: true, message: 'Asignación eliminada correctamente' };
  }
}

