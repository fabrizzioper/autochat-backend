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
    // Usar el ID del usuario autenticado para obtener su QR específico
    return this.whatsappService.getQRCode(user.id);
  }

  @Get('session')
  getSessionStatus(@GetUser() user: UserEntity): SessionData {
    // Usar el ID del usuario autenticado para obtener su sesión específica
    return this.whatsappService.getSessionStatus(user.id);
  }

  @Get('connection-info')
  getConnectionInfo(@GetUser() user: UserEntity): ConnectionInfo | null {
    // Usar el ID del usuario autenticado para obtener su información de conexión
    return this.whatsappService.getConnectionInfo(user.id);
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnect(@GetUser() user: UserEntity): Promise<{ message: string }> {
    // Desconectar solo la sesión del usuario autenticado
    await this.whatsappService.disconnect(user.id);
    return { message: 'Desconectado exitosamente' };
  }
}
