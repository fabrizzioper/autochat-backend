import { Controller, Get, Post, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';
import type { QRCodeData, SessionData, ConnectionInfo } from './types/whatsapp.types';

@Controller('whatsapp')
@UseGuards(JwtAuthGuard)
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get('qr')
  async getQRCode(@GetUser() user: UserEntity): Promise<QRCodeData> {
    return this.whatsappService.getQRCode();
  }

  @Get('session')
  getSessionStatus(@GetUser() user: UserEntity): SessionData {
    return this.whatsappService.getSessionStatus();
  }

  @Get('connection-info')
  getConnectionInfo(@GetUser() user: UserEntity): ConnectionInfo | null {
    return this.whatsappService.getConnectionInfo();
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect(@GetUser() user: UserEntity): Promise<{ message: string }> {
    await this.whatsappService.disconnect();
    return { message: 'Desconectado exitosamente' };
  }
}

