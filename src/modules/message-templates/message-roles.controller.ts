import { Controller, Get, Post, Put, Delete, Body, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { MessageRolesService } from './message-roles.service';
import { MessageRoleEntity } from './message-role.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

interface CreateRoleDto {
  messageTemplateId: number;
  roleName: string;
  selectedText: string;
  startIndex: number;
  endIndex: number;
  color?: string;
}

interface UpdateRoleDto {
  roleName?: string;
  selectedText?: string;
  startIndex?: number;
  endIndex?: number;
  color?: string;
}

@Controller('message-roles')
@UseGuards(JwtAuthGuard)
export class MessageRolesController {
  constructor(private readonly service: MessageRolesService) {}

  /**
   * Obtener todos los roles de un mensaje
   */
  @Get('template/:templateId')
  async findAllByTemplate(
    @GetUser() user: UserEntity,
    @Param('templateId', ParseIntPipe) templateId: number,
  ): Promise<MessageRoleEntity[]> {
    return this.service.findAllByTemplate(user.id, templateId);
  }

  /**
   * Obtener un rol por ID
   */
  @Get(':roleId')
  async findById(
    @GetUser() user: UserEntity,
    @Param('roleId', ParseIntPipe) roleId: number,
  ): Promise<MessageRoleEntity> {
    return this.service.findById(user.id, roleId);
  }

  /**
   * Crear un nuevo rol
   */
  @Post()
  async create(
    @GetUser() user: UserEntity,
    @Body() dto: CreateRoleDto,
  ): Promise<MessageRoleEntity> {
    return this.service.create(user.id, dto);
  }

  /**
   * Actualizar un rol
   */
  @Put(':roleId')
  async update(
    @GetUser() user: UserEntity,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() dto: UpdateRoleDto,
  ): Promise<MessageRoleEntity> {
    return this.service.update(user.id, roleId, dto);
  }

  /**
   * Eliminar un rol
   */
  @Delete(':roleId')
  async delete(
    @GetUser() user: UserEntity,
    @Param('roleId', ParseIntPipe) roleId: number,
  ): Promise<{ success: boolean; message: string }> {
    await this.service.delete(user.id, roleId);
    return { success: true, message: 'Rol eliminado correctamente' };
  }
}

