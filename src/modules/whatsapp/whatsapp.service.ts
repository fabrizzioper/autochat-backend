import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  ConnectionState,
  WASocket,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { QRCodeData, SessionData, ConnectionInfo } from './types/whatsapp.types';
import { WhatsAppGateway } from './whatsapp.gateway';
import { ConfigService } from '../config/config.service';
import { ExcelService } from '../excel/excel.service';
import { RecordsService } from '../records/records.service';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private socket: WASocket | null = null;
  private qrCodeString: string | null = null;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private phoneNumber: string | null = null;
  private connectionInfo: ConnectionInfo | null = null;

  constructor(
    @Inject(forwardRef(() => ConfigService))
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ExcelService))
    private readonly excelService: ExcelService,
    @Inject(forwardRef(() => RecordsService))
    private readonly recordsService: RecordsService,
    @Inject(forwardRef(() => WhatsAppGateway))
    private readonly gateway: WhatsAppGateway,
  ) {
    this.initializeSession();
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
            this.connectionInfo = null;
            
            // Emitir estado desconectado por WebSocket
            if (this.gateway) {
              this.gateway.emitConnectionStatus('disconnected');
            }
            
            // Esperar un poco antes de reintentar
            setTimeout(() => {
              this.initializeSession();
            }, 1000);
          } else {
            this.connectionStatus = 'disconnected';
            this.qrCodeString = null;
            this.phoneNumber = null;
            this.connectionInfo = null;
            
            // Emitir estado desconectado por WebSocket
            if (this.gateway) {
              this.gateway.emitConnectionStatus('disconnected');
            }
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
            
            // Emitir información de conexión completa
            if (this.connectionInfo) {
              this.gateway.server.emit('connection-info', this.connectionInfo);
              this.logger.log('Información de conexión emitida');
            }
          }

          // Registrar listener de mensajes
          this.setupMessageListener();
        }
      });
    } catch (error) {
      this.logger.error('Error inicializando sesión de WhatsApp', error);
      this.connectionStatus = 'error';
    }
  }

  private setupMessageListener() {
    if (!this.socket) return;

    this.socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const senderNumber = msg.key.remoteJid?.split('@')[0] || '';
        
        // Verificar si es número autorizado
        const isAuthorized = await this.configService.isAuthorized(senderNumber);
        if (!isAuthorized) {
          this.logger.log(`Mensaje de número no autorizado: ${senderNumber}`);
          continue;
        }

        // Procesar documento (Excel)
        if (msg.message.documentMessage) {
          await this.handleExcelMessage(msg, senderNumber);
        }
        // Procesar mensaje de texto (búsqueda por CUI)
        else if (msg.message.conversation || msg.message.extendedTextMessage) {
          await this.handleTextMessage(msg, senderNumber);
        }
      }
    });
  }

  private async handleExcelMessage(msg: any, senderNumber: string) {
    try {
      const doc = msg.message.documentMessage;
      const filename = doc.fileName || 'document.xlsx';

      if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
        await this.sendMessage(senderNumber, 'Por favor, envía un archivo Excel válido (.xlsx o .xls)');
        return;
      }

      this.logger.log(`Recibiendo Excel: ${filename} de ${senderNumber}`);

      // Descargar archivo
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const tempPath = path.join(process.cwd(), 'temp', `${Date.now()}-${filename}`);
      
      // Crear directorio temp si no existe
      await fs.mkdir(path.join(process.cwd(), 'temp'), { recursive: true });
      await fs.writeFile(tempPath, buffer);

      // Procesar Excel
      const result = await this.excelService.processExcelFile(tempPath, filename, senderNumber);

      // Eliminar archivo temporal
      await fs.unlink(tempPath);

      // Responder
      await this.sendMessage(senderNumber, result.message);

      this.logger.log(`Excel procesado: ${result.recordsCount} registros`);
    } catch (error) {
      this.logger.error(`Error procesando Excel: ${error.message}`);
      await this.sendMessage(senderNumber, `Error al procesar el Excel: ${error.message}`);
    }
  }

  private async handleTextMessage(msg: any, senderNumber: string) {
    try {
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      
      // Buscar CUI en el mensaje (formato: dame el CUI XXXXXX o solicito el CUI XXXXXX)
      const cuiMatch = text.match(/CUI[:\s]+(\d+)/i);
      
      if (cuiMatch) {
        const cui = parseInt(cuiMatch[1]);
        this.logger.log(`Buscando CUI: ${cui}`);

        const record = await this.recordsService.findByCui(cui);

        if (record) {
          const response = this.recordsService.formatRecordResponse(record);
          await this.sendMessage(senderNumber, response);
        } else {
          await this.sendMessage(senderNumber, `No se encontró información para el CUI ${cui}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error procesando mensaje: ${error.message}`);
    }
  }

  private async sendMessage(phoneNumber: string, message: string): Promise<void> {
    if (!this.socket) {
      throw new Error('Socket no disponible');
    }

    const jid = `${phoneNumber}@s.whatsapp.net`;
    await this.socket.sendMessage(jid, { text: message });
  }

  async getQRCode(): Promise<QRCodeData> {
    // Si ya está conectado, no generar nuevo QR
    if (this.connectionStatus === 'connected') {
      this.logger.log('Ya hay una sesión activa, no se genera QR');
      return {
        qrCode: '',
        status: 'connected',
      };
    }

    // Si hay un QR pendiente, devolverlo
    if (this.connectionStatus === 'connecting' && this.qrCodeString) {
      this.logger.log('Devolviendo QR existente');
      return {
        qrCode: this.qrCodeString,
        status: 'connecting',
      };
    }

    // Solo generar nuevo QR si realmente está desconectado y sin socket activo
    if (this.connectionStatus === 'disconnected' && !this.socket) {
      this.logger.log('Generando nuevo QR - No hay sesión activa');
      
      this.qrCodeString = null;
      this.connectionStatus = 'connecting';
      
      // Eliminar credenciales anteriores para forzar nuevo QR
      const authPath = path.join(process.cwd(), 'auth_info');
      try {
        await fs.rm(authPath, { recursive: true, force: true });
        this.logger.log('Credenciales anteriores eliminadas');
      } catch (e) {
        // Ignorar si no existen
      }
      
      // Inicializar nueva sesión
      await this.initializeSession();
      
      // Esperar hasta que se genere el QR (máximo 10 segundos)
      const maxWait = 10000;
      const startTime = Date.now();
      
      while (!this.qrCodeString && (Date.now() - startTime) < maxWait && this.connectionStatus === 'connecting') {
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
    this.logger.log('🔴 Iniciando desconexión completa (logout)');
    
    if (this.socket) {
      try {
        this.logger.log('Cerrando sesión de WhatsApp...');
        await this.socket.logout();
      } catch (e) {
        this.logger.warn(`Advertencia al hacer logout: ${e.message}`);
      }
      
      this.socket = null;
      this.qrCodeString = null;
      this.connectionStatus = 'disconnected';
      this.phoneNumber = null;
      this.connectionInfo = null;
      
      this.logger.log('Sesión de WhatsApp cerrada');
    }
    
    // Eliminar credenciales SIEMPRE al hacer logout explícito
    const authPath = path.join(process.cwd(), 'auth_info');
    this.logger.log(`Eliminando credenciales en: ${authPath}`);
    
    try {
      const exists = await fs.access(authPath).then(() => true).catch(() => false);
      
      if (exists) {
        await fs.rm(authPath, { recursive: true, force: true });
        this.logger.log('✅ Credenciales eliminadas correctamente');
      } else {
        this.logger.log('⚠️ No hay credenciales para eliminar');
      }
    } catch (e: any) {
      this.logger.error(`❌ Error eliminando credenciales: ${e.message}`);
      this.logger.error(`Stack: ${e.stack}`);
    }
    
    // Emitir estado desconectado
    if (this.gateway) {
      this.gateway.emitConnectionStatus('disconnected');
    }
    
    this.logger.log('🟢 Desconexión completa finalizada');
  }

  getConnectionInfo(): ConnectionInfo | null {
    return this.connectionInfo;
  }
}

