import { Controller, Get, Post, Delete, Body, Param, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ConfigService } from './config.service';
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

interface SetReactiveFilenameDto {
  filename: string;
}

interface AuthorizedNumberResponse {
  phoneNumber: string | null;
}

interface AuthorizedNumbersResponse {
  phoneNumbers: string[];
  allowAll: boolean;
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
    const allowAll = await this.service.isAllowAllNumbers(user.id);
    return { phoneNumbers, allowAll };
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

  @Post('allow-all-numbers')
  @HttpCode(HttpStatus.OK)
  async setAllowAllNumbers(
    @GetUser() user: UserEntity,
    @Body() dto: SetAllowAllDto,
  ): Promise<{ message: string }> {
    await this.service.setAllowAllNumbers(user.id, dto.allow);
    return { message: dto.allow ? 'Todos los números están permitidos' : 'Modo permitir todos desactivado' };
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
}

