import { Injectable, Logger } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  ConnectionState,
  WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import type { QRCodeData, SessionData, ConnectionInfo } from './types/whatsapp.types';
import { WhatsAppGateway } from './whatsapp.gateway';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private socket: WASocket | null = null;
  private qrCodeString: string | null = null;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private phoneNumber: string | null = null;
  private connectionInfo: ConnectionInfo | null = null;
  private gateway: WhatsAppGateway;

  constructor() {
    this.initializeSession();
  }

  setGateway(gateway: WhatsAppGateway) {
    this.gateway = gateway;
  }

  private async initializeSession() {
    try {
      const authPath = path.join(process.cwd(), 'auth_info');
      const { state, saveCreds } = await useMultiFileAuthState(authPath);

      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
      });

      // Manejar actualización de credenciales
      this.socket.ev.on('creds.update', saveCreds);

      // Manejar código QR
      this.socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.logger.log('QR Code generado');
          this.qrCodeString = await QRCode.toDataURL(qr);
          this.connectionStatus = 'connecting';
          
          // Emitir QR por WebSocket
          if (this.gateway) {
            this.gateway.emitQRCode(this.qrCodeString);
          }
        }

        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
          this.logger.log(`Conexión cerrada. Reconectando: ${shouldReconnect}`);
          
          if (shouldReconnect) {
            this.connectionStatus = 'disconnected';
            this.qrCodeString = null;
            this.phoneNumber = null;
            this.initializeSession();
          } else {
            this.connectionStatus = 'disconnected';
            this.qrCodeString = null;
            this.phoneNumber = null;
          }
        } else if (connection === 'open') {
          this.logger.log('Conexión abierta exitosamente');
          this.connectionStatus = 'connected';
          this.qrCodeString = null;
          
          // Obtener número de teléfono y datos de conexión
          if (this.socket && this.socket.user?.id) {
            this.phoneNumber = this.socket.user.id.split(':')[0];
            
            // Capturar información de conexión solo si tenemos el número
            if (this.phoneNumber) {
              this.connectionInfo = {
                phoneNumber: this.phoneNumber,
                platform: 'WEB',
                device: 'Desktop',
                browser: ['Mac OS', 'Chrome', '14.4.1'],
                passive: false,
                connectedAt: new Date(),
                deviceInfo: {
                  os: 'Mac OS',
                  appVersion: '14.4.1',
                  deviceType: 'Desktop',
                },
              };
              
              this.logger.log(`Información de conexión capturada: ${JSON.stringify(this.connectionInfo)}`);
            }
          }
          
          // Emitir estado conectado por WebSocket
          if (this.gateway) {
            this.gateway.emitConnectionStatus('connected', this.phoneNumber || undefined);
          }
        }
      });
    } catch (error) {
      this.logger.error('Error inicializando sesión de WhatsApp', error);
      this.connectionStatus = 'error';
    }
  }

  async getQRCode(): Promise<QRCodeData> {
    // Si ya está conectado, no generar nuevo QR
    if (this.connectionStatus === 'connected') {
      return {
        qrCode: '',
        status: 'connected',
      };
    }

    // Si no hay QR o está desconectado, reinicializar sesión
    if (this.connectionStatus === 'disconnected' || !this.qrCodeString) {
      this.logger.log('Forzando nueva sesión para generar QR');
      
      // Desconectar sesión anterior si existe
      if (this.socket) {
        try {
          await this.socket.logout();
        } catch (e) {
          // Ignorar errores al cerrar
        }
        this.socket = null;
      }
      
      this.qrCodeString = null;
      this.connectionStatus = 'connecting';
      
      // Inicializar nueva sesión
      await this.initializeSession();
      
      // Esperar hasta que se genere el QR (máximo 5 segundos)
      const maxWait = 5000;
      const startTime = Date.now();
      
      while (!this.qrCodeString && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return {
      qrCode: this.qrCodeString || '',
      status: this.connectionStatus,
    };
  }

  getSessionStatus(): SessionData {
    return {
      isConnected: this.connectionStatus === 'connected',
      phoneNumber: this.phoneNumber || undefined,
    };
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      await this.socket.logout();
      this.socket = null;
      this.qrCodeString = null;
      this.connectionStatus = 'disconnected';
      this.phoneNumber = null;
      this.connectionInfo = null;
      this.logger.log('Sesión de WhatsApp desconectada');
    }
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }
}

