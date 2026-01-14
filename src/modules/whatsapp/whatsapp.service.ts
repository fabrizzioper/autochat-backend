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
import { UserMessageRolesService } from '../config/user-message-roles.service';
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

// Información de un Excel pendiente de guardar formato
interface PendingFormatSave {
  excelId: number;
  filename: string;
  headers: string[];
  indexedHeaders: string[];
  senderNumber: string;
  createdAt: Date;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  
  // Map para almacenar sesiones por userId
  private userSessions: Map<number, UserSession> = new Map();
  
  // Map para Excel pendientes de guardar formato (userId -> PendingFormatSave)
  private pendingFormatSaves: Map<number, PendingFormatSave> = new Map();

  constructor(
    @Inject(forwardRef(() => ConfigService))
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => UserMessageRolesService))
    private readonly userMessageRolesService: UserMessageRolesService,
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
        
        // Verificar si es número autorizado (pasando el userId de la sesión para considerar allowAll)
        const msgUserId = await this.configService.getUserIdByPhoneNumber(senderNumber, userId);
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

      // Verificar permisos para enviar Excel
      const mode = await this.configService.getAuthorizationMode(userId);
      
      if (mode === 'list') {
        // Verificar si el número está en la nueva tabla
        const authorizedNumber = await this.configService.getAuthorizedNumberByPhone(userId, senderNumber);
        
        if (!authorizedNumber) {
          // Número NO está en la lista - ignorar silenciosamente
          this.logger.log(`📊 Excel de ${senderNumber} ignorado - número no está en la lista`);
          await fs.unlink(tempPath);
          return;
        }
        
        if (!authorizedNumber.canSendExcel) {
          // Número ESTÁ en la lista pero sin permiso de Excel
          this.logger.log(`📊 Excel de ${senderNumber} rechazado - no tiene permiso canSendExcel`);
          await fs.unlink(tempPath);
          await this.sendMessage(userId, senderNumber, '⚠️ No tienes permiso para enviar archivos Excel.');
          return;
        }
        
        this.logger.log(`🔍 Debug: senderNumber=${senderNumber}, userId=${userId}, canSendExcel=true`);
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

      // NUEVO FLUJO: Primero leer cabeceras y esperar selección del usuario
      // fromWhatsApp=true indica que la selección se hará por WhatsApp, no por el frontend
      const uploadResult = await this.excelService.uploadAndReadHeaders(
        tempPath,
        filename,
        senderNumber,
        userId,
        true, // fromWhatsApp: el frontend NO debe mostrar modal de selección
      );

      if (!uploadResult.success) {
        await fs.unlink(tempPath).catch(() => {});
        await this.sendMessage(userId, senderNumber, uploadResult.message);
        return;
      }

      // Si hay un formato guardado y se está procesando automáticamente
      if (uploadResult.autoProcessing && uploadResult.format) {
        const formatName = uploadResult.format.name;
        const indexedHeaders = uploadResult.format.indexedHeaders;
        
        const autoMessage = 
          `📊 *Excel detectado con formato guardado*\n\n` +
          `📁 Archivo: ${filename}\n` +
          `💾 Formato: ${formatName}\n` +
          `🔍 Columnas indexadas: ${indexedHeaders.join(', ')}\n\n` +
          `_Procesando automáticamente... Recibirás una notificación cuando termine._`;
        
        await this.sendMessage(userId, senderNumber, autoMessage);
        this.logger.log(`📋 Excel procesado automáticamente con formato "${formatName}"`);
        return;
      }

      // Construir mensaje con cabeceras enumeradas
      const headers = uploadResult.headers || [];
      let headersList = '📊 *Excel recibido correctamente*\n\n';
      headersList += `📁 Archivo: ${filename}\n`;
      headersList += `📝 Filas: ~${uploadResult.totalRows?.toLocaleString() || 'N/A'}\n\n`;
      headersList += '*Columnas disponibles:*\n';
      
      headers.forEach((header, index) => {
        headersList += `${index + 1}. ${header}\n`;
      });
      
      headersList += '\n📌 *Responde con los números de las columnas que deseas indexar para búsqueda rápida*\n';
      headersList += 'Ejemplo: 1, 3, 5\n\n';
      headersList += '_O escribe "cancelar" para cancelar el proceso_';

      await this.sendMessage(userId, senderNumber, headersList);
      this.logger.log(`📋 Cabeceras enviadas a ${senderNumber}, esperando selección de columnas`);

      // El frontend será notificado automáticamente a través del sistema de progreso
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

      // PASO 0: Verificar si hay un formato pendiente de guardar
      const pendingFormat = this.pendingFormatSaves.get(userId);
      if (pendingFormat && pendingFormat.senderNumber === senderNumber) {
        const lowerText = text.toLowerCase().trim();
        
        // Usuario responde "no" - no guardar, pero sí procesar
        if (lowerText === 'no' || lowerText === 'no guardar') {
          await this.sendMessage(userId, senderNumber, '👍 Entendido, no se guardará el formato.');
          this.logger.log(`📋 Usuario ${userId} decidió no guardar el formato`);
          
          // Ahora sí procesar el Excel
          const confirmMessage = `✅ *Procesando Excel*\n\n📁 Archivo: ${pendingFormat.filename}\n🔍 Columnas indexadas: ${pendingFormat.indexedHeaders.join(', ')}\n\n_El proceso continuará en segundo plano. Recibirás una notificación cuando termine._`;
          await this.sendMessage(userId, senderNumber, confirmMessage);
          
          await this.excelService.continueProcessingWithHeaders(
            pendingFormat.excelId,
            userId,
            pendingFormat.indexedHeaders,
          );
          
          this.pendingFormatSaves.delete(userId);
          return;
        }
        
        // Usuario responde "guardar" o "guardar [nombre]"
        if (lowerText.startsWith('guardar')) {
          const customName = text.slice(7).trim(); // Remover "guardar " del inicio
          const formatName = customName || pendingFormat.filename.replace(/\.(xlsx|xls)$/i, '');
          
          // Guardar el formato
          const savedFormat = await this.excelService.saveFormat(
            userId,
            formatName,
            pendingFormat.filename,
            pendingFormat.headers,
            pendingFormat.indexedHeaders,
            pendingFormat.excelId,
          );
          
          const successMessage = 
            `💾 *Formato guardado exitosamente*\n\n` +
            `📋 Nombre: ${savedFormat.name}\n` +
            `📁 Archivo: ${pendingFormat.filename}\n` +
            `🔍 Columnas: ${pendingFormat.indexedHeaders.join(', ')}\n\n` +
            `_La próxima vez que subas este archivo, se procesará automáticamente._`;
          
          await this.sendMessage(userId, senderNumber, successMessage);
          this.logger.log(`💾 Formato "${savedFormat.name}" guardado por usuario ${userId}`);
          
          // Ahora sí procesar el Excel
          const confirmMessage = `✅ *Procesando Excel*\n\n📁 Archivo: ${pendingFormat.filename}\n🔍 Columnas indexadas: ${pendingFormat.indexedHeaders.join(', ')}\n\n_El proceso continuará en segundo plano. Recibirás una notificación cuando termine._`;
          await this.sendMessage(userId, senderNumber, confirmMessage);
          
          await this.excelService.continueProcessingWithHeaders(
            pendingFormat.excelId,
            userId,
            pendingFormat.indexedHeaders,
          );
          
          this.pendingFormatSaves.delete(userId);
          return;
        }
        
        // Si llegó aquí, el mensaje no es ni "guardar" ni "no", limpiar el pendiente después de 5 min
        const ageMinutes = (Date.now() - pendingFormat.createdAt.getTime()) / 1000 / 60;
        if (ageMinutes > 5) {
          this.pendingFormatSaves.delete(userId);
        }
      }

      // PASO 1: Verificar si hay un Excel pendiente esperando selección de columnas
      const pendingUpload = this.excelService.getPendingUploadForUser(userId);
      
      if (pendingUpload) {
        // Verificar si el mensaje es para cancelar
        if (text.toLowerCase() === 'cancelar') {
          await this.excelService.cancelPendingUpload(pendingUpload.excelId, userId);
          await this.sendMessage(userId, senderNumber, '❌ Proceso cancelado. El Excel ha sido eliminado.');
          this.logger.log(`🚫 Usuario ${userId} canceló el proceso del Excel ${pendingUpload.excelId}`);
          return;
        }

        // Verificar si el mensaje contiene números (selección de columnas)
        const numbersOnly = text.replace(/[,\s]+/g, ' ').trim();
        const numbers = numbersOnly.split(' ')
          .map(n => parseInt(n, 10))
          .filter(n => !isNaN(n) && n > 0);

        if (numbers.length > 0) {
          // Validar que los números estén en rango
          const maxColumn = pendingUpload.headers.length;
          const invalidNumbers = numbers.filter(n => n > maxColumn);
          
          if (invalidNumbers.length > 0) {
            await this.sendMessage(
              userId, 
              senderNumber, 
              `⚠️ Los números ${invalidNumbers.join(', ')} están fuera de rango. Solo hay ${maxColumn} columnas.\n\nIntenta de nuevo con números del 1 al ${maxColumn}.`
            );
            return;
          }

          // Convertir números a nombres de columnas
          const selectedHeaders = numbers.map(n => pendingUpload.headers[n - 1]);
          
          this.logger.log(`📌 Columnas seleccionadas para indexar: ${selectedHeaders.join(', ')}`);
          
          // NO procesar todavía - guardar estado pendiente y preguntar si guardar
          this.pendingFormatSaves.set(userId, {
            excelId: pendingUpload.excelId,
            filename: pendingUpload.filename,
            headers: pendingUpload.headers,
            indexedHeaders: selectedHeaders,
            senderNumber,
            createdAt: new Date(),
          });
          
          // NO limpiar pendingUpload aquí - lo necesita continueProcessingWithHeaders
          // Se limpiará automáticamente cuando se procese el Excel
          
          // Preguntar si quiere guardar formato (el procesamiento ocurrirá después de la respuesta)
          const formatQuestion = 
            `💾 *¿Guardar configuración?*\n\n` +
            `📁 Archivo: ${pendingUpload.filename}\n` +
            `🔍 Columnas seleccionadas: ${selectedHeaders.join(', ')}\n\n` +
            `Si guardas este formato, la próxima vez que subas este archivo se procesará automáticamente.\n\n` +
            `📌 Responde:\n` +
            `• *guardar* - Guardar con nombre automático\n` +
            `• *guardar [nombre]* - Guardar con nombre personalizado\n` +
            `• *no* - No guardar\n\n` +
            `_Ej: guardar Inversiones MEF_`;
          
          await this.sendMessage(userId, senderNumber, formatQuestion);
          return;
        }
      }

      // PASO 2: Si no hay upload pendiente o no son números, procesar como búsqueda normal
      
      // Primero verificar permisos para solicitar información
      const searchMode = await this.configService.getAuthorizationMode(userId);
      
      if (searchMode === 'list') {
        const authorizedNumber = await this.configService.getAuthorizedNumberByPhone(userId, senderNumber);
        
        if (!authorizedNumber) {
          // Número NO está en la lista - ignorar silenciosamente
          this.logger.log(`🔍 Mensaje de ${senderNumber} ignorado - número no está en la lista`);
          return;
        }
        
        if (!authorizedNumber.canRequestInfo) {
          // Número ESTÁ en la lista pero sin permiso de búsqueda
          this.logger.log(`🔍 Mensaje de ${senderNumber} rechazado - no tiene permiso canRequestInfo`);
          await this.sendMessage(userId, senderNumber, '⚠️ No tienes permiso para solicitar información.');
          return;
        }
      } else if (searchMode === 'none') {
        // Modo ninguno - ignorar
        return;
      }
      
      // COMANDO "ayuda" o "lista" - listar solo nombres de respuestas
      const helpCommands = ['ayuda', 'help', 'lista', 'respuestas', 'comandos', 'menu'];
      const normalizedText = text.trim().toLowerCase();
      
      if (helpCommands.includes(normalizedText)) {
        const allTemplates = await this.messageTemplatesService.findAll(userId);
        const activeTemplates = allTemplates.filter(t => t.isActive);
        
        if (activeTemplates.length === 0) {
          await this.sendMessage(userId, senderNumber, '📋 No hay respuestas configuradas.');
          return;
        }
        
        let helpMessage = '📋 *Respuestas disponibles:*\n\n';
        activeTemplates.forEach((t, idx) => {
          helpMessage += `${idx + 1}. *${t.name}*\n`;
        });
        helpMessage += '\n💡 _Escribe el nombre del mensaje para ver las columnas de búsqueda_';
        
        await this.sendMessage(userId, senderNumber, helpMessage);
        return;
      }
      
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
      
      // Si solo hay una palabra o varias palabras sin ":", buscar por nombre de respuesta
      if (!searchValue) {
        const searchTerm = text.trim().toLowerCase();
        const allTemplates = await this.messageTemplatesService.findAll(userId);
        
        // Buscar template por nombre (normalizado sin tildes)
        const normalizeForSearch = (str: string) => str
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        
        const normalizedSearch = normalizeForSearch(searchTerm);
        const foundTemplate = allTemplates.find(t => 
          t.isActive && normalizeForSearch(t.name) === normalizedSearch
        );
        
        if (foundTemplate && foundTemplate.searchColumns && foundTemplate.keywords) {
          // Agrupar palabras clave por columna
          const columnKeywordsMap = new Map<string, string[]>();
          
          for (let i = 0; i < foundTemplate.searchColumns.length; i++) {
            const col = foundTemplate.searchColumns[i];
            const kw = foundTemplate.keywords[i];
            if (col && kw) {
              if (!columnKeywordsMap.has(col)) {
                columnKeywordsMap.set(col, []);
              }
              columnKeywordsMap.get(col)!.push(kw);
            }
          }
          
          let detailMessage = `📋 *${foundTemplate.name}*\n\n`;
          detailMessage += `🔍 *Columnas de búsqueda:*\n`;
          
          let colIdx = 1;
          const examples: string[] = [];
          columnKeywordsMap.forEach((keywords, column) => {
            detailMessage += `  ${colIdx}. ${column} → ${keywords.join(', ')}\n`;
            examples.push(`${keywords[0]}: valor`);
            colIdx++;
          });
          
          detailMessage += `\n💡 *Ejemplos:*\n${examples.slice(0, 2).join('\n')}`;
          
          await this.sendMessage(userId, senderNumber, detailMessage);
          return;
        }
        
        // Si no encontró por nombre, buscar por keyword
        const helpTemplate = await this.messageTemplatesService.findByKeyword(userId, searchTerm);
        
        if (helpTemplate && helpTemplate.searchColumns && helpTemplate.keywords) {
          // Agrupar palabras clave por columna
          const columnKeywordsMap = new Map<string, string[]>();
          
          for (let i = 0; i < helpTemplate.searchColumns.length; i++) {
            const col = helpTemplate.searchColumns[i];
            const kw = helpTemplate.keywords[i];
            if (col && kw) {
              if (!columnKeywordsMap.has(col)) {
                columnKeywordsMap.set(col, []);
              }
              columnKeywordsMap.get(col)!.push(kw);
            }
          }
          
          let detailMessage = `📋 *${helpTemplate.name}*\n\n`;
          detailMessage += `🔍 *Columnas de búsqueda:*\n`;
          
          let colIdx = 1;
          const examples: string[] = [];
          columnKeywordsMap.forEach((keywords, column) => {
            detailMessage += `  ${colIdx}. ${column} → ${keywords.join(', ')}\n`;
            examples.push(`${keywords[0]}: valor`);
            colIdx++;
          });
          
          detailMessage += `\n💡 *Ejemplos:*\n${examples.slice(0, 2).join('\n')}`;
          
          await this.sendMessage(userId, senderNumber, detailMessage);
          return;
        }
      }
      
      if (!keyword || !searchValue) {
        // Si hay un upload pendiente, recordar al usuario que seleccione columnas
        if (pendingUpload) {
          await this.sendMessage(
            userId, 
            senderNumber, 
            `📌 Tienes un Excel pendiente de indexar.\n\nResponde con los números de las columnas a indexar (ej: 1, 3, 5)\nO escribe "cancelar" para cancelar el proceso.`
          );
        } else {
          this.logger.log(`Mensaje no tiene formato de búsqueda válido: ${text}`);
        }
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
      
      // Determinar qué Excel usar: directo del template o del formato asociado
      let excelIdToUse: number | null = template.excelId;
      if (!excelIdToUse && template.format && template.format.currentExcelId) {
        excelIdToUse = template.format.currentExcelId;
        this.logger.log(`📋 Usando Excel del formato "${template.format.name}": ${excelIdToUse}`);
      }
      
      if (!excelIdToUse) {
        this.logger.warn(`⚠️ Template "${template.name}" no tiene Excel asociado`);
        await this.sendMessage(userId, senderNumber, `❌ El template "${template.name}" no tiene datos cargados. Sube el archivo Excel primero.`);
        return;
      }
      
      this.logger.log(`📋 Template encontrado: "${template.name}" - Buscando en columnas: ${searchColumns.length > 0 ? searchColumns.join(', ') : 'ninguna'}`);
      
      const records = await this.excelService.searchDynamicRecords(
        userId,
        excelIdToUse,
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
      
      // Verificar si el usuario tiene un rol asignado para este mensaje
      const userRole = await this.userMessageRolesService.getRoleForPhoneAndTemplate(
        userId,
        senderNumber,
        template.id,
      );
      
      let templateToUse = template.template;
      
      // Si tiene rol asignado, usar solo las porciones del mensaje que le corresponden
      if (userRole && userRole.messageRole && userRole.messageRole.selections?.length > 0) {
        // Combinar todas las selecciones del rol
        templateToUse = userRole.messageRole.selections.map(s => s.text).join('\n\n');
        this.logger.log(`👤 Usuario ${senderNumber} tiene rol "${userRole.messageRole.roleName}" - usando ${userRole.messageRole.selections.length} selección(es)`);
      }
      
      // Procesar la plantilla reemplazando los placeholders
      const numericColumns = template.numericColumns || [];
      const responseMessage = this.messageTemplatesService.processTemplate(templateToUse, record.rowData, numericColumns);
      
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

  /**
   * Método público para enviar notificaciones de WhatsApp (usado por ExcelService)
   */
  async sendNotification(userId: number, phoneNumber: string, message: string): Promise<boolean> {
    try {
      await this.sendMessage(userId, phoneNumber, message);
      return true;
    } catch (error) {
      this.logger.error(`❌ Error enviando notificación a ${phoneNumber}: ${error.message}`);
      return false;
    }
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
