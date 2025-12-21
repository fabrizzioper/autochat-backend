import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsAppCredentialsEntity } from './whatsapp-credentials.entity';
import { 
  AuthenticationState, 
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
  initAuthCreds, 
  proto, 
  BufferJSON 
} from '@whiskeysockets/baileys';

@Injectable()
export class WhatsAppCredentialsService {
  private readonly logger = new Logger(WhatsAppCredentialsService.name);

  constructor(
    @InjectRepository(WhatsAppCredentialsEntity)
    private readonly credentialsRepository: Repository<WhatsAppCredentialsEntity>,
  ) {}

  /**
   * Guarda una credencial en la base de datos
   */
  async saveCredential(userId: number, key: string, value: unknown): Promise<void> {
    const serializedValue = JSON.stringify(value, BufferJSON.replacer);
    
    const existing = await this.credentialsRepository.findOne({
      where: { userId, key },
    });

    if (existing) {
      existing.value = serializedValue;
      await this.credentialsRepository.save(existing);
    } else {
      const credential = this.credentialsRepository.create({
        userId,
        key,
        value: serializedValue,
      });
      await this.credentialsRepository.save(credential);
    }
  }

  /**
   * Obtiene una credencial de la base de datos
   */
  async getCredential<T = unknown>(userId: number, key: string): Promise<T | null> {
    const credential = await this.credentialsRepository.findOne({
      where: { userId, key },
    });

    if (!credential) {
      return null;
    }

    return JSON.parse(credential.value, BufferJSON.reviver) as T;
  }

  /**
   * Elimina credenciales de la base de datos
   */
  async deleteCredentials(userId: number, keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.credentialsRepository.delete({ userId, key });
    }
  }

  /**
   * Elimina todas las credenciales de un usuario
   */
  async deleteAllCredentials(userId: number): Promise<void> {
    await this.credentialsRepository.delete({ userId });
    this.logger.log(`Todas las credenciales eliminadas para usuario ${userId}`);
  }

  /**
   * Verifica si un usuario tiene credenciales guardadas
   */
  async hasCredentials(userId: number): Promise<boolean> {
    const count = await this.credentialsRepository.count({
      where: { userId, key: 'creds' },
    });
    return count > 0;
  }

  /**
   * Crea un AuthenticationState compatible con Baileys usando la base de datos
   */
  async useDBAuthState(userId: number): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    // Intentar cargar credenciales existentes
    let creds = await this.getCredential<AuthenticationCreds>(userId, 'creds');
    
    if (!creds) {
      // Si no hay credenciales, crear nuevas
      creds = initAuthCreds();
      this.logger.log(`Nuevas credenciales creadas para usuario ${userId}`);
    } else {
      this.logger.log(`Credenciales cargadas desde BD para usuario ${userId}`);
    }

    const state: AuthenticationState = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          
          for (const id of ids) {
            const key = `${type}-${id}`;
            const value = await this.getCredential(userId, key);
            if (value) {
              if (type === 'app-state-sync-key') {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
              } else {
                data[id] = value as SignalDataTypeMap[T];
              }
            }
          }
          
          return data;
        },
        set: async (data: SignalDataSet) => {
          const tasks: Promise<void>[] = [];
          
          for (const category in data) {
            const categoryData = data[category as keyof SignalDataSet];
            if (categoryData) {
              for (const id in categoryData) {
                const value = categoryData[id];
                const key = `${category}-${id}`;
                
                if (value) {
                  tasks.push(this.saveCredential(userId, key, value));
                } else {
                  tasks.push(this.deleteCredentials(userId, [key]));
                }
              }
            }
          }
          
          await Promise.all(tasks);
        },
      },
    };

    const saveCreds = async () => {
      await this.saveCredential(userId, 'creds', creds);
    };

    return { state, saveCreds };
  }
}
