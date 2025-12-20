import { Controller, Get, Post, Delete, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ConfigService } from './config.service';

interface SetNumberDto {
  phoneNumber: string;
}

interface AuthorizedNumberResponse {
  phoneNumber: string | null;
}

@Controller('config')
export class ConfigController {
  constructor(private readonly service: ConfigService) {}

  @Get('authorized-number')
  async getAuthorizedNumber(): Promise<AuthorizedNumberResponse> {
    const phoneNumber = await this.service.getAuthorizedNumber();
    return { phoneNumber };
  }

  @Post('authorized-number')
  @HttpCode(HttpStatus.OK)
  async setAuthorizedNumber(@Body() dto: SetNumberDto): Promise<{ message: string }> {
    await this.service.setAuthorizedNumber(dto.phoneNumber);
    return { message: 'Número autorizado configurado exitosamente' };
  }

  @Delete('authorized-number')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAuthorizedNumber(): Promise<void> {
    await this.service.removeAuthorizedNumber();
  }
}

