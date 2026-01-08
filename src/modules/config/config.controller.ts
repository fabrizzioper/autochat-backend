import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, HttpStatus, UseGuards, BadRequestException } from '@nestjs/common';
import { ConfigService, AuthorizationMode } from './config.service';
import { CreateAuthorizedNumberDto, UpdateAuthorizedNumberDto } from './dto/authorized-number.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

interface SetNumberDto {
  phoneNumber: string;
}

interface AddNumbersDto {
  phoneNumbers: string[];
}

interface SetAllowAllDto {
  allow: boolean;
}

interface SetAuthorizationModeDto {
  mode: AuthorizationMode;
}

interface SetReactiveFilenameDto {
  filename: string;
}

interface AuthorizedNumberResponse {
  phoneNumber: string | null;
}

interface AuthorizedNumbersResponse {
  phoneNumbers: string[];
  mode: AuthorizationMode;
  allowAll: boolean; // mantener para compatibilidad
}

interface ReactiveFilenameResponse {
  filename: string | null;
}

@Controller('config')
@UseGuards(JwtAuthGuard)
export class ConfigController {
  constructor(private readonly service: ConfigService) {}

  // IMPORTANTE: Las rutas más específicas deben ir ANTES de las más generales
  @Get('authorized-numbers')
  async getAuthorizedNumbers(@GetUser() user: UserEntity): Promise<AuthorizedNumbersResponse> {
    console.log('GET /config/authorized-numbers llamado para usuario:', user.id);
    const phoneNumbers = await this.service.getAuthorizedNumbersList(user.id);
    const mode = await this.service.getAuthorizationMode(user.id);
    return { phoneNumbers, mode, allowAll: mode === 'all' };
  }

  @Get('authorized-number')
  async getAuthorizedNumber(@GetUser() user: UserEntity): Promise<AuthorizedNumberResponse> {
    const phoneNumber = await this.service.getAuthorizedNumber(user.id);
    return { phoneNumber };
  }

  @Post('authorized-number')
  @HttpCode(HttpStatus.OK)
  async setAuthorizedNumber(
    @GetUser() user: UserEntity,
    @Body() dto: SetNumberDto,
  ): Promise<{ message: string }> {
    await this.service.setAuthorizedNumber(user.id, dto.phoneNumber);
    return { message: 'Número autorizado configurado exitosamente' };
  }

  @Post('authorized-numbers')
  @HttpCode(HttpStatus.OK)
  async addAuthorizedNumbers(
    @GetUser() user: UserEntity,
    @Body() dto: AddNumbersDto,
  ): Promise<{ message: string }> {
    await this.service.addAuthorizedNumbers(user.id, dto.phoneNumbers);
    return { message: 'Números autorizados agregados exitosamente' };
  }

  @Post('authorization-mode')
  @HttpCode(HttpStatus.OK)
  async setAuthorizationMode(
    @GetUser() user: UserEntity,
    @Body() dto: SetAuthorizationModeDto,
  ): Promise<{ message: string }> {
    await this.service.setAuthorizationMode(user.id, dto.mode);
    const messages = {
      all: 'Todos los números están permitidos',
      list: 'Solo números de la lista están permitidos',
      none: 'No se permite ningún número',
    };
    return { message: messages[dto.mode] };
  }

  // Mantener para compatibilidad con código viejo
  @Post('allow-all-numbers')
  @HttpCode(HttpStatus.OK)
  async setAllowAllNumbers(
    @GetUser() user: UserEntity,
    @Body() dto: SetAllowAllDto,
  ): Promise<{ message: string }> {
    // Convertir el viejo allow a nuevo modo
    const mode: AuthorizationMode = dto.allow ? 'all' : 'list';
    await this.service.setAuthorizationMode(user.id, mode);
    return { message: dto.allow ? 'Todos los números están permitidos' : 'Solo números de la lista están permitidos' };
  }

  @Delete('authorized-number')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAuthorizedNumber(@GetUser() user: UserEntity): Promise<void> {
    await this.service.removeAuthorizedNumber(user.id);
  }

  @Delete('authorized-number/:phoneNumber')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAuthorizedNumberFromList(
    @GetUser() user: UserEntity,
    @Param('phoneNumber') phoneNumber: string,
  ): Promise<void> {
    await this.service.removeAuthorizedNumberFromList(user.id, decodeURIComponent(phoneNumber));
  }

  // Reactive Excel Filename
  @Get('reactive-filename')
  async getReactiveFilename(@GetUser() user: UserEntity): Promise<ReactiveFilenameResponse> {
    const filename = await this.service.getReactiveExcelFilename(user.id);
    return { filename };
  }

  @Post('reactive-filename')
  @HttpCode(HttpStatus.OK)
  async setReactiveFilename(
    @GetUser() user: UserEntity,
    @Body() dto: SetReactiveFilenameDto,
  ): Promise<{ message: string }> {
    await this.service.setReactiveExcelFilename(user.id, dto.filename);
    return { message: 'Nombre de archivo reactivo configurado exitosamente' };
  }

  @Delete('reactive-filename')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeReactiveFilename(@GetUser() user: UserEntity): Promise<void> {
    await this.service.removeReactiveExcelFilename(user.id);
  }

  // ==================== CRUD NÚMEROS AUTORIZADOS V2 (Nueva tabla) ====================

  @Get('authorized-numbers-v2')
  async getAllAuthorizedNumbersV2(
    @GetUser() user: UserEntity,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const pageNum = parseInt(page || '1', 10) || 1;
    const limitNum = parseInt(limit || '10', 10) || 10;
    
    const result = await this.service.getAuthorizedNumbersPaginated(
      user.id,
      pageNum,
      Math.min(limitNum, 100), // máximo 100 por página
      search,
    );
    
    const mode = await this.service.getAuthorizationMode(user.id);
    
    return {
      ...result,
      mode,
    };
  }

  @Get('authorized-numbers-v2/:id')
  async getAuthorizedNumberV2ById(
    @GetUser() user: UserEntity,
    @Param('id') id: string,
  ) {
    return this.service.getAuthorizedNumberById(user.id, parseInt(id, 10));
  }

  @Post('authorized-numbers-v2')
  @HttpCode(HttpStatus.CREATED)
  async createAuthorizedNumberV2(
    @GetUser() user: UserEntity,
    @Body() dto: CreateAuthorizedNumberDto,
  ) {
    try {
      const created = await this.service.createAuthorizedNumber(user.id, dto);
      return { message: 'Número autorizado creado exitosamente', data: created };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Put('authorized-numbers-v2/:id')
  @HttpCode(HttpStatus.OK)
  async updateAuthorizedNumberV2(
    @GetUser() user: UserEntity,
    @Param('id') id: string,
    @Body() dto: UpdateAuthorizedNumberDto,
  ) {
    try {
      const updated = await this.service.updateAuthorizedNumber(user.id, parseInt(id, 10), dto);
      return { message: 'Número autorizado actualizado exitosamente', data: updated };
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Delete('authorized-numbers-v2/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAuthorizedNumberV2(
    @GetUser() user: UserEntity,
    @Param('id') id: string,
  ): Promise<void> {
    await this.service.deleteAuthorizedNumber(user.id, parseInt(id, 10));
  }
}

