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

  async handleConnection(client: Socket) {
    this.logger.log(`Cliente conectado: ${client.id}`);
    
    // Enviar estado actual al cliente que se acaba de conectar
    if (this.whatsappService) {
      const session = this.whatsappService.getSessionStatus();
      if (session.isConnected) {
        // Enviar estado de conexión
        client.emit('connection-status', { 
          status: 'connected', 
          phoneNumber: session.phoneNumber 
        });
        this.logger.log(`Estado inicial enviado a ${client.id}: conectado`);
        
        // Enviar información de conexión completa
        const connectionInfo = this.whatsappService.getConnectionInfo();
        if (connectionInfo) {
          client.emit('connection-info', connectionInfo);
          this.logger.log(`Información de conexión enviada a ${client.id}`);
        }
      }
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente desconectado: ${client.id}`);
  }

  emitQRCode(qrCode: string) {
    this.server.emit('qr-code', { qrCode, status: 'connecting' });
    this.logger.log('QR Code emitido a todos los clientes');
  }

  emitConnectionStatus(status: 'connected' | 'disconnected' | 'error', phoneNumber?: string) {
    this.server.emit('connection-status', { status, phoneNumber });
    this.logger.log(`Estado de conexión emitido: ${status}`);
    
    // Si se conecta, también enviar la información completa
    if (status === 'connected' && this.whatsappService) {
      const connectionInfo = this.whatsappService.getConnectionInfo();
      if (connectionInfo) {
        this.server.emit('connection-info', connectionInfo);
        this.logger.log('Información de conexión emitida a todos los clientes');
      }
    }
  }
}

