import { Controller, Get, Post, Delete, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ConfigService } from './config.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

interface SetNumberDto {
  phoneNumber: string;
}

interface AuthorizedNumberResponse {
  phoneNumber: string | null;
}

@Controller('config')
@UseGuards(JwtAuthGuard)
export class ConfigController {
  constructor(private readonly service: ConfigService) {}

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

  @Delete('authorized-number')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAuthorizedNumber(@GetUser() user: UserEntity): Promise<void> {
    await this.service.removeAuthorizedNumber(user.id);
  }
}

