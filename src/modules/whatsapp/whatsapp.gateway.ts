import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3001'],
    credentials: true,
  },
})
export class WhatsAppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(WhatsAppGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Cliente conectado: ${client.id}`);
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
  }
}

