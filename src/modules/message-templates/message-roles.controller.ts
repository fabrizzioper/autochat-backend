import { Controller, Get, Post, Put, Delete, Body, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { MessageRolesService } from './message-roles.service';
import { MessageRoleEntity, TextSelection } from './message-role.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

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
   * Agregar una selección a un rol
   */
  @Post(':roleId/selection')
  async addSelection(
    @GetUser() user: UserEntity,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() dto: AddSelectionDto,
  ): Promise<MessageRoleEntity> {
    return this.service.addSelection(user.id, roleId, dto);
  }

  /**
   * Eliminar una selección de un rol
   */
  @Delete(':roleId/selection/:index')
  async removeSelection(
    @GetUser() user: UserEntity,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<MessageRoleEntity> {
    return this.service.removeSelection(user.id, roleId, index);
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
