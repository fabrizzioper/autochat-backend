import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import makeWASocket, {
  DisconnectReason,
  ConnectionState,
  WASocket,
  downloadMediaMessage,
  WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { QRCodeData, SessionData, ConnectionInfo } from './types/whatsapp.types';
import { WhatsAppGateway } from './whatsapp.gateway';
import { ConfigService } from '../config/config.service';
import { ExcelService } from '../excel/excel.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { MessageTemplatesService } from '../message-templates/message-templates.service';

interface UserSession {
  socket: WASocket | null;
  qrCodeString: string | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  phoneNumber: string | null;
  connectionInfo: ConnectionInfo | null;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  
  // Map para almacenar sesiones por userId
  private userSessions: Map<number, UserSession> = new Map();

  constructor(
    @Inject(forwardRef(() => ConfigService))
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ExcelService))
    private readonly excelService: ExcelService,
    @Inject(forwardRef(() => WhatsAppGateway))
    private readonly gateway: WhatsAppGateway,
    @Inject(forwardRef(() => WhatsAppCredentialsService))
    private readonly credentialsService: WhatsAppCredentialsService,
    @Inject(forwardRef(() => MessageTemplatesService))
    private readonly messageTemplatesService: MessageTemplatesService,
  ) {
    // Ya no cargamos sesiones al arrancar - se cargan cuando el usuario se conecta
  }

  private getUserSession(userId: number): UserSession {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, {
        socket: null,
        qrCodeString: null,
        connectionStatus: 'disconnected',
        phoneNumber: null,
        connectionInfo: null,
      });
    }
    return this.userSessions.get(userId)!;
  }

  /**
   * Intenta cargar una sesión desde la base de datos si existe
   */
  async tryLoadSessionFromDisk(userId: number): Promise<boolean> {
    const session = this.getUserSession(userId);
    
    // Si ya está conectado o conectando, no hacer nada
    if (session.connectionStatus === 'connected' || session.connectionStatus === 'connecting') {
      return session.connectionStatus === 'connected';
    }

    // Verificar si hay credenciales en la BD
    const hasCredentials = await this.credentialsService.hasCredentials(userId);
    
    if (hasCredentials && !session.socket) {
      this.logger.log(`Usuario ${userId} tiene credenciales en BD, intentando cargar sesión...`);
      await this.initializeSession(userId);
      
      // Esperar un poco para que se conecte
      const maxWait = 5000;
      const startTime = Date.now();
      
      while (this.getUserSession(userId).connectionStatus === 'connecting' && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      return this.getUserSession(userId).connectionStatus === 'connected';
    }
    
    return false;
  }

  async initializeSession(userId: number) {
    const session = this.getUserSession(userId);
    
    // Si ya hay un socket activo, no crear otro
    if (session.socket) {
      this.logger.log(`Ya existe un socket para usuario ${userId}`);
      return;
    }
    
    try {
      // Usar el auth state de la base de datos
      const { state, saveCreds } = await this.credentialsService.useDBAuthState(userId);

      session.connectionStatus = 'connecting';

      // Logger silencioso para evitar logs de base64
      const silentLogger = pino({ level: 'silent' });
      
      session.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: silentLogger,
      });

      // Manejar actualización de credenciales
      session.socket.ev.on('creds.update', saveCreds);

      // Manejar código QR
      session.socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.logger.log(`QR Code generado para usuario ${userId}`);
          session.qrCodeString = await QRCode.toDataURL(qr);
          session.connectionStatus = 'connecting';
          
          // Emitir QR por WebSocket solo al usuario específico
          if (this.gateway) {
            this.gateway.emitQRCodeToUser(userId, session.qrCodeString);
          }
        }

        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
          this.logger.log(`Conexión cerrada para usuario ${userId}. Reconectando: ${shouldReconnect}`);
          
          // Limpiar el socket actual
          session.socket = null;
          session.qrCodeString = null;
          session.phoneNumber = null;
          session.connectionInfo = null;
          
          if (shouldReconnect) {
            session.connectionStatus = 'disconnected';
            
            // Emitir estado desconectado por WebSocket
            if (this.gateway) {
              this.gateway.emitConnectionStatusToUser(userId, 'disconnected');
            }
            
            // Esperar un poco antes de reintentar
            setTimeout(() => {
              this.initializeSession(userId);
            }, 2000);
          } else {
            session.connectionStatus = 'disconnected';
            
            // Emitir estado desconectado por WebSocket
            if (this.gateway) {
              this.gateway.emitConnectionStatusToUser(userId, 'disconnected');
            }
          }
        } else if (connection === 'open') {
          this.logger.log(`Conexión abierta exitosamente para usuario ${userId}`);
          session.connectionStatus = 'connected';
          session.qrCodeString = null;
          
          // Obtener número de teléfono y datos de conexión
          if (session.socket && session.socket.user?.id) {
            session.phoneNumber = session.socket.user.id.split(':')[0];
            
            // LOG 1: Número del usuario conectado (cuando escanea QR)
            this.logger.log(`[LOG 1] Usuario ${userId} conectado con número: ${session.phoneNumber}`);
            
            // Capturar información de conexión solo si tenemos el número
            if (session.phoneNumber) {
              session.connectionInfo = {
                phoneNumber: session.phoneNumber,
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
              
              this.logger.log(`Información de conexión capturada para usuario ${userId}: ${JSON.stringify(session.connectionInfo)}`);
            }
          }
          
          // Emitir estado conectado por WebSocket
          if (this.gateway) {
            this.gateway.emitConnectionStatusToUser(userId, 'connected', session.phoneNumber || undefined);
            
            // Emitir información de conexión completa
            if (session.connectionInfo) {
              this.gateway.emitConnectionInfoToUser(userId, session.connectionInfo);
              this.logger.log(`Información de conexión emitida para usuario ${userId}`);
            }
          }

          // Registrar listener de mensajes
          this.setupMessageListener(userId);
        }
      });
    } catch (error) {
      this.logger.error(`Error inicializando sesión de WhatsApp para usuario ${userId}`, error);
      session.connectionStatus = 'error';
      session.socket = null;
    }
  }

  private setupMessageListener(userId: number) {
    const session = this.getUserSession(userId);
    if (!session.socket) return;

    session.socket.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        
        // Para WhatsApp Business, usar remoteJidAlt si está disponible (contiene el número real)
        // En WhatsApp normal, remoteJid ya contiene el número directamente
        const msgKey = msg.key as { remoteJid?: string; remoteJidAlt?: string; participant?: string };
        
        // Determinar el JID efectivo:
        // 1. Si remoteJidAlt existe y es válido (@s.whatsapp.net), usarlo
        // 2. Si remoteJid es @s.whatsapp.net, usarlo directamente
        // 3. Si es @lid sin remoteJidAlt, no podemos procesar
        let effectiveJid = remoteJid;
        
        if (msgKey.remoteJidAlt && msgKey.remoteJidAlt.endsWith('@s.whatsapp.net')) {
          // WhatsApp Business: usar remoteJidAlt
          effectiveJid = msgKey.remoteJidAlt;
        } else if (remoteJid.endsWith('@s.whatsapp.net')) {
          // WhatsApp normal: usar remoteJid directamente
          effectiveJid = remoteJid;
        } else if (remoteJid.endsWith('@lid')) {
          // Es un LID sin remoteJidAlt - no podemos obtener el número real
          // Esto puede pasar cuando el receptor (quien escanea QR) usa WhatsApp normal
          // pero el remitente usa WhatsApp Business
          this.logger.log(`[DEBUG] LID sin remoteJidAlt: ${remoteJid} | key: ${JSON.stringify(msg.key)}`);
          continue;
        }
        
        // Ignorar grupos, newsletters, broadcasts, status
        if (effectiveJid.includes('@g.us') || effectiveJid.includes('@broadcast') || 
            effectiveJid.includes('@newsletter') || effectiveJid === 'status@broadcast') {
          continue;
        }

        // Extraer número de teléfono del JID efectivo
        const senderNumber = effectiveJid.split('@')[0] || '';
        
        // Validar que sea un número de teléfono válido (solo dígitos, 7-15 caracteres)
        if (!/^\d{7,15}$/.test(senderNumber)) {
          continue;
        }
        
        // Verificar si es número autorizado y obtener userId
        const msgUserId = await this.configService.getUserIdByPhoneNumber(senderNumber);
        if (!msgUserId) {
          this.logger.log(`Mensaje de número no autorizado: ${senderNumber}`);
          continue;
        }

        // Procesar documento (Excel)
        if (msg.message.documentMessage) {
          await this.handleExcelMessage(msg, senderNumber, userId);
        }
        // Procesar mensaje de texto (TODO: implementar búsquedas dinámicas en fase 2)
        else if (msg.message.conversation || msg.message.extendedTextMessage) {
          await this.handleTextMessage(msg, senderNumber, userId);
        }
      }
    });
  }

  private async handleExcelMessage(msg: WAMessage, senderNumber: string, userId: number) {
    try {
      const doc = msg.message?.documentMessage;
      if (!doc) return;
      
      const filename = doc.fileName || 'document.xlsx';

      if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
        await this.sendMessage(userId, senderNumber, 'Por favor, envía un archivo Excel válido (.xlsx o .xls)');
        return;
      }

      this.logger.log(`📊 Recibiendo Excel: ${filename} de ${senderNumber} para usuario ${userId}`);

      // Descargar archivo
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const tempPath = path.join(process.cwd(), 'temp', `${Date.now()}-${filename}`);
      
      // Crear directorio temp si no existe
      await fs.mkdir(path.join(process.cwd(), 'temp'), { recursive: true });
      await fs.writeFile(tempPath, buffer);

      // Verificar que el número que envía esté autorizado para ESTE usuario (el de la sesión)
      const isAuthorized = await this.configService.isAuthorized(userId, senderNumber);
      this.logger.log(`🔍 Debug: senderNumber=${senderNumber}, userId=${userId}, isAuthorized=${isAuthorized}`);
      
      if (!isAuthorized) {
        // El número no está autorizado para este usuario, ignorar silenciosamente
        this.logger.log(`📊 Excel de ${senderNumber} ignorado - no autorizado para usuario ${userId}`);
        await fs.unlink(tempPath);
        return;
      }

      // Verificar si hay un nombre de archivo configurado para ESTE usuario
      const reactiveFilename = await this.configService.getReactiveExcelFilename(userId);
      
      // LOG 3: Nombre del Excel permitido
      if (reactiveFilename) {
        this.logger.log(`[LOG 3] Nombre de Excel permitido para usuario ${userId}: "${reactiveFilename}" | Excel recibido: "${filename}"`);
      } else {
        this.logger.log(`[LOG 3] No hay nombre de Excel específico configurado para usuario ${userId} | Procesando cualquier Excel: "${filename}"`);
      }
      
      // Si hay un nombre configurado, verificar que el archivo coincida
      if (reactiveFilename) {
        const isMatch = await this.configService.isReactiveFilename(userId, filename);
        if (!isMatch) {
          // No coincide, ignorar silenciosamente
          this.logger.log(`📊 Excel "${filename}" ignorado - no coincide con "${reactiveFilename}"`);
          await fs.unlink(tempPath);
          return;
        }
      }
      // Si NO hay nombre configurado, procesar cualquier Excel
      // (flujo normal sin filtro)

      // Procesar Excel (siempre dinámico ahora) - usar userId de la sesión
      const result = await this.excelService.processExcelFile(tempPath, filename, senderNumber, userId);

      // Eliminar archivo temporal
      await fs.unlink(tempPath);

      // Responder (LOG 4 se genera en sendMessage)
      await this.sendMessage(userId, senderNumber, result.message);

      // Notificar al frontend a través de WebSocket (al usuario de la sesión)
      if (this.gateway && result.success) {
        this.gateway.emitExcelUploadedToUser(userId, {
          filename,
          recordsCount: result.recordsCount,
        });
      }

      this.logger.log(`✅ Excel procesado: ${result.recordsCount} registros`);
    } catch (error) {
      this.logger.error(`❌ Error procesando Excel: ${error.message}`);
      await this.sendMessage(userId, senderNumber, `Error al procesar el Excel: ${error.message}`);
    }
  }

  private async handleTextMessage(msg: WAMessage, senderNumber: string, userId: number) {
    try {
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
      
      this.logger.log(`📝 Mensaje de texto recibido de ${senderNumber}: ${text.substring(0, 50)}...`);
      
      if (!text) return;

      // Intentar parsear el mensaje en formato "keyword: valor" o "keyword valor"
      const colonMatch = text.match(/^(\S+)\s*:\s*(.+)$/i);
      const spaceMatch = text.match(/^(\S+)\s+(.+)$/);
      
      let keyword: string | null = null;
      let searchValue: string | null = null;
      
      if (colonMatch) {
        keyword = colonMatch[1].toLowerCase();
        searchValue = colonMatch[2].trim();
      } else if (spaceMatch) {
        keyword = spaceMatch[1].toLowerCase();
        searchValue = spaceMatch[2].trim();
      }
      
      if (!keyword || !searchValue) {
        this.logger.log(`Mensaje no tiene formato de búsqueda válido: ${text}`);
        return;
      }

      this.logger.log(`🔍 Buscando keyword="${keyword}" valor="${searchValue}"`);

      // Buscar template activo con esta palabra clave
      const template = await this.messageTemplatesService.findByKeyword(userId, keyword);
      
      if (!template) {
        this.logger.log(`No hay template configurado para keyword "${keyword}"`);
        return;
      }

      // Obtener columnas de búsqueda (soporta múltiples columnas)
      const searchColumns = (template.searchColumns && Array.isArray(template.searchColumns) && template.searchColumns.length > 0)
        ? template.searchColumns
        : [];
      
      this.logger.log(`📋 Template encontrado: "${template.name}" - Buscando en columnas: ${searchColumns.length > 0 ? searchColumns.join(', ') : 'ninguna'}`);
      
      const records = await this.excelService.searchDynamicRecords(
        userId,
        template.excelId,
        searchColumns,
        searchValue
      );

      if (records.length === 0) {
        const columnsText = searchColumns.length > 0 ? searchColumns.join(' o ') : 'columna';
        await this.sendMessage(userId, senderNumber, `❌ No se encontró ningún registro con ${columnsText} = "${searchValue}"`);
        return;
      }

      // Usar el primer registro encontrado
      const record = records[0];
      
      // Procesar la plantilla reemplazando los placeholders
      const responseMessage = this.messageTemplatesService.processTemplate(template.template, record.rowData);
      
      const columnsText = searchColumns.length > 0 ? searchColumns.join('/') : 'columna';
      this.logger.log(`✅ Enviando respuesta para ${columnsText}="${searchValue}"`);
      await this.sendMessage(userId, senderNumber, responseMessage);

    } catch (error) {
      this.logger.error(`Error procesando mensaje de búsqueda: ${error.message}`);
    }
  }

  private async sendMessage(userId: number, phoneNumber: string, message: string): Promise<void> {
    const session = this.getUserSession(userId);
    
    if (!session.socket) {
      throw new Error('Socket no disponible');
    }

    // LOG 4: Número al cual se está enviando mensaje
    this.logger.log(`[LOG 4] Enviando mensaje desde usuario ${userId} (sesión: ${session.phoneNumber}) hacia: ${phoneNumber}`);

    const jid = `${phoneNumber}@s.whatsapp.net`;
    await session.socket.sendMessage(jid, { text: message });
  }

  async getQRCode(userId: number): Promise<QRCodeData> {
    const session = this.getUserSession(userId);
    
    // Si ya está conectado, no generar nuevo QR
    if (session.connectionStatus === 'connected') {
      this.logger.log(`Ya hay una sesión activa para usuario ${userId}, no se genera QR`);
      return {
        qrCode: '',
        status: 'connected',
      };
    }

    // Si hay un QR pendiente, devolverlo
    if (session.connectionStatus === 'connecting' && session.qrCodeString) {
      this.logger.log(`Devolviendo QR existente para usuario ${userId}`);
      return {
        qrCode: session.qrCodeString,
        status: 'connecting',
      };
    }

    // Solo generar nuevo QR si realmente está desconectado y sin socket activo
    if (session.connectionStatus === 'disconnected' || session.connectionStatus === 'error') {
      this.logger.log(`Generando nuevo QR para usuario ${userId} - No hay sesión activa`);
      
      // Limpiar socket anterior si existe
      if (session.socket) {
        try {
          session.socket.end(undefined);
        } catch (e) {
          // Ignorar errores al cerrar
        }
        session.socket = null;
      }
      
      session.qrCodeString = null;
      session.connectionStatus = 'connecting';
      
      // Eliminar credenciales anteriores para forzar nuevo QR
      await this.credentialsService.deleteAllCredentials(userId);
      this.logger.log(`Credenciales anteriores eliminadas de BD para usuario ${userId}`);
      
      // Inicializar nueva sesión
      await this.initializeSession(userId);
      
      // Esperar hasta que se genere el QR (máximo 10 segundos)
      const maxWait = 10000;
      const startTime = Date.now();
      
      while (!session.qrCodeString && (Date.now() - startTime) < maxWait && session.connectionStatus === 'connecting') {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return {
      qrCode: session.qrCodeString || '',
      status: session.connectionStatus,
    };
  }

  getSessionStatus(userId: number): SessionData {
    const session = this.getUserSession(userId);
    return {
      isConnected: session.connectionStatus === 'connected',
      phoneNumber: session.phoneNumber || undefined,
    };
  }

  async disconnect(userId: number): Promise<void> {
    this.logger.log(`🔴 Iniciando desconexión completa (logout) para usuario ${userId}`);
    
    const session = this.getUserSession(userId);
    
    if (session.socket) {
      try {
        this.logger.log(`Cerrando sesión de WhatsApp para usuario ${userId}...`);
        await session.socket.logout();
      } catch (e) {
        this.logger.warn(`Advertencia al hacer logout para usuario ${userId}: ${e.message}`);
      }
      
      session.socket = null;
      session.qrCodeString = null;
      session.connectionStatus = 'disconnected';
      session.phoneNumber = null;
      session.connectionInfo = null;
      
      this.logger.log(`Sesión de WhatsApp cerrada para usuario ${userId}`);
    }
    
    // Eliminar credenciales de la BD
    await this.credentialsService.deleteAllCredentials(userId);
    this.logger.log(`✅ Credenciales eliminadas de BD para usuario ${userId}`);
    
    // Emitir estado desconectado
    if (this.gateway) {
      this.gateway.emitConnectionStatusToUser(userId, 'disconnected');
    }
    
    this.logger.log(`🟢 Desconexión completa finalizada para usuario ${userId}`);
  }

  getConnectionInfo(userId: number): ConnectionInfo | null {
    const session = this.getUserSession(userId);
    return session.connectionInfo;
  }
}
