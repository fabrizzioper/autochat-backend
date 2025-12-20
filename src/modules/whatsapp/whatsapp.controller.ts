import { Controller, Get, Post } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import type { QRCodeData, SessionData, ConnectionInfo } from './types/whatsapp.types';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get('qr')
  async getQRCode(): Promise<QRCodeData> {
    return this.whatsappService.getQRCode();
  }

  @Get('session')
  getSessionStatus(): SessionData {
    return this.whatsappService.getSessionStatus();
  }

  @Get('connection-info')
  getConnectionInfo(): ConnectionInfo | null {
    return this.whatsappService.getConnectionInfo();
  }

  @Post('disconnect')
  async disconnect(): Promise<{ message: string }> {
    await this.whatsappService.disconnect();
    return { message: 'Desconectado exitosamente' };
  }
}

