import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { env } from '../../config/env';
import * as jwt from 'jsonwebtoken';
import type { ConnectionInfo } from './types/whatsapp.types';

interface AuthenticatedSocket extends Socket {
  userId?: number;
}

@WebSocketGateway({
  cors: {
    origin: env.CORS_ORIGINS,
    credentials: true,
  },
})
export class WhatsAppGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WhatsAppGateway.name);

  constructor(
    @Inject(forwardRef(() => WhatsAppService))
    private whatsappService: WhatsAppService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway inicializado');
  }

  async handleConnection(client: AuthenticatedSocket) {
    this.logger.log(`🔌 Cliente conectando: ${client.id}`);
    
    // Extraer token del handshake
    const token = client.handshake.auth?.token || client.handshake.query?.token;
    
    if (!token) {
      this.logger.warn(`❌ Cliente ${client.id} sin token - Desconectando`);
      client.disconnect();
      return;
    }
    
    let userId: number;
    
    // Verificar token
    try {
      const decoded = jwt.verify(token as string, env.JWT_SECRET) as unknown as { userId: number; email: string };
      userId = decoded.userId;
      
      if (!userId) {
        this.logger.warn(`❌ Token sin userId para ${client.id}`);
        client.disconnect();
        return;
      }
      
      this.logger.log(`✅ Token válido: userId=${decoded.userId}, email=${decoded.email}`);
    } catch (error) {
      this.logger.error(`❌ Token inválido para ${client.id}: ${error.message}`);
      client.disconnect();
      return;
    }
    
    // Guardar userId y unir a room
    client.userId = userId;
    const userRoom = `user_${userId}`;
    client.join(userRoom);
    this.logger.log(`👤 Cliente ${client.id} unido a room ${userRoom}`);
    
    // Enviar estado inicial (sin bloquear ni desconectar por errores)
    this.sendInitialState(client, userId);
  }

  private async sendInitialState(client: AuthenticatedSocket, userId: number) {
    try {
      if (!this.whatsappService) {
        this.logger.warn('WhatsAppService no disponible');
        client.emit('connection-status', { status: 'disconnected' });
        return;
      }

      // Obtener estado actual (sin cargar sesión aquí para no bloquear)
      const session = this.whatsappService.getSessionStatus(userId);
      
      this.logger.log(`📊 Estado para usuario ${userId}: ${session.isConnected ? 'conectado' : 'desconectado'}`);
      
      if (session.isConnected) {
        client.emit('connection-status', { 
          status: 'connected', 
          phoneNumber: session.phoneNumber 
        });
        
        const connectionInfo = this.whatsappService.getConnectionInfo(userId);
        if (connectionInfo) {
          client.emit('connection-info', connectionInfo);
        }
      } else {
        client.emit('connection-status', { status: 'disconnected' });
        
        // Intentar cargar sesión en segundo plano (no bloquear)
        this.tryLoadSessionBackground(userId);
      }
    } catch (error) {
      this.logger.error(`Error enviando estado inicial a ${client.id}: ${error.message}`);
      // NO desconectar - solo enviar estado desconectado
      client.emit('connection-status', { status: 'disconnected' });
    }
  }

  private async tryLoadSessionBackground(userId: number) {
    try {
      this.logger.log(`🔄 Cargando sesión en background para usuario ${userId}...`);
      const loaded = await this.whatsappService.tryLoadSessionFromDisk(userId);
      
      if (loaded) {
        this.logger.log(`✅ Sesión cargada para usuario ${userId}`);
        // La sesión emitirá el estado por sí misma cuando se conecte
      }
    } catch (error) {
      this.logger.error(`Error cargando sesión background: ${error.message}`);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(`🔌 Cliente desconectado: ${client.id} (usuario: ${client.userId || 'desconocido'})`);
  }

  // Métodos para emitir a usuario específico
  emitQRCodeToUser(userId: number, qrCode: string) {
    const userRoom = `user_${userId}`;
    this.server.to(userRoom).emit('qr-code', { qrCode, status: 'connecting' });
    this.logger.log(`📱 QR emitido a usuario ${userId} (${qrCode.length} chars)`);
  }

  emitConnectionStatusToUser(userId: number, status: 'connected' | 'disconnected' | 'error', phoneNumber?: string) {
    const userRoom = `user_${userId}`;
    this.server.to(userRoom).emit('connection-status', { status, phoneNumber });
    this.logger.log(`📡 Estado emitido a usuario ${userId}: ${status}`);
    
    if (status === 'connected' && this.whatsappService) {
      const connectionInfo = this.whatsappService.getConnectionInfo(userId);
      if (connectionInfo) {
        this.server.to(userRoom).emit('connection-info', connectionInfo);
      }
    }
  }

  emitConnectionInfoToUser(userId: number, info: ConnectionInfo) {
    const userRoom = `user_${userId}`;
    this.server.to(userRoom).emit('connection-info', info);
    this.logger.log(`📊 Info emitida a usuario ${userId}`);
  }

  emitExcelUploadedToUser(userId: number, data: { filename: string; recordsCount: number }) {
    const userRoom = `user_${userId}`;
    this.server.to(userRoom).emit('excel-uploaded', data);
    this.logger.log(`📄 Excel uploaded emitido a usuario ${userId}`);
  }

  // Métodos legacy (deprecated)
  emitQRCode(qrCode: string) {
    this.logger.warn('emitQRCode deprecated');
  }

  emitConnectionStatus(status: 'connected' | 'disconnected' | 'error', phoneNumber?: string) {
    this.logger.warn('emitConnectionStatus deprecated');
  }
}
