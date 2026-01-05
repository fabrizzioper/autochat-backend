import { Controller, Get, Post, Put, Delete, Body, Param, ParseIntPipe, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { MessageTemplatesService } from './message-templates.service';
import { MessageTemplateEntity } from './message-template.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

interface CreateTemplateDto {
  excelId: number;
  name: string;
  keywords: string[]; // Múltiples palabras clave
  searchColumns: string[]; // Múltiples columnas de búsqueda
  template: string;
}

interface UpdateTemplateDto {
  name?: string;
  keywords?: string[];
  searchColumns?: string[];
  template?: string;
  isActive?: boolean;
}

@Controller('message-templates')
@UseGuards(JwtAuthGuard)
export class MessageTemplatesController {
  constructor(private readonly service: MessageTemplatesService) {}

  @Get()
  async findAll(@GetUser() user: UserEntity): Promise<MessageTemplateEntity[]> {
    return this.service.findAll(user.id);
  }

  @Get(':id')
  async findById(
    @GetUser() user: UserEntity,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<MessageTemplateEntity> {
    return this.service.findById(user.id, id);
  }

  @Post()
  async create(
    @GetUser() user: UserEntity,
    @Body() dto: CreateTemplateDto,
  ): Promise<MessageTemplateEntity> {
    return this.service.create(user.id, dto);
  }

  @Put(':id')
  async update(
    @GetUser() user: UserEntity,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTemplateDto,
  ): Promise<MessageTemplateEntity> {
    return this.service.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @GetUser() user: UserEntity,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.service.delete(user.id, id);
  }
}

