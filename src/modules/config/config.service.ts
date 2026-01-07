import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigEntity } from './config.entity';

const AUTHORIZED_NUMBER_KEY = 'authorized_number';
const ALLOW_ALL_NUMBERS_KEY = 'allow_all_numbers';
const AUTHORIZATION_MODE_KEY = 'authorization_mode';
const REACTIVE_EXCEL_FILENAME_KEY = 'reactive_excel_filename';

// Modos de autorización: 'all' = todos, 'list' = solo lista, 'none' = ninguno
export type AuthorizationMode = 'all' | 'list' | 'none';

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);

  constructor(
    @InjectRepository(ConfigEntity)
    private readonly repo: Repository<ConfigEntity>,
  ) {}

  async getAuthorizedNumber(userId: number): Promise<string | null> {
    const numbers = await this.getAuthorizedNumbersList(userId);
    return numbers.length > 0 ? numbers[0] : null;
  }

  async setAuthorizedNumber(userId: number, phoneNumber: string): Promise<void> {
    // Si viene un solo número, lo agregamos a la lista
    await this.addAuthorizedNumbers(userId, [phoneNumber]);
  }

  async removeAuthorizedNumber(userId: number): Promise<void> {
    await this.repo.delete({ userId, key: AUTHORIZED_NUMBER_KEY });
  }

  // ==================== MODO DE AUTORIZACIÓN ====================
  
  async getAuthorizationMode(userId: number): Promise<AuthorizationMode> {
    const config = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZATION_MODE_KEY },
    });
    
    // Si no existe, verificar el viejo allowAll para migración
    if (!config) {
      const oldAllowAll = await this.repo.findOne({ 
        where: { userId, key: ALLOW_ALL_NUMBERS_KEY },
      });
      if (oldAllowAll?.value === 'true') {
        return 'all';
      }
      // Por defecto, si no hay configuración, usar 'list' (solo números de la lista)
      return 'list';
    }
    
    return (config.value as AuthorizationMode) || 'list';
  }

  async setAuthorizationMode(userId: number, mode: AuthorizationMode): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZATION_MODE_KEY },
    });
    
    if (existing) {
      existing.value = mode;
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        userId,
        key: AUTHORIZATION_MODE_KEY,
        value: mode,
      });
    }
    
    // También actualizar el viejo allowAll para compatibilidad
    await this.setAllowAllNumbers(userId, mode === 'all');
    
    const modeNames = { all: 'Permitir todos', list: 'Solo lista', none: 'No permitir ninguno' };
    this.logger.log(`[LOG 2] Modo de autorización cambiado a "${modeNames[mode]}" para usuario ${userId}`);
  }

  async isAllowAllNumbers(userId: number): Promise<boolean> {
    const mode = await this.getAuthorizationMode(userId);
    return mode === 'all';
  }

  async setAllowAllNumbers(userId: number, allow: boolean): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: ALLOW_ALL_NUMBERS_KEY },
    });
    
    if (existing) {
      existing.value = allow ? 'true' : 'false';
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        userId,
        key: ALLOW_ALL_NUMBERS_KEY,
        value: allow ? 'true' : 'false',
      });
    }
  }

  async addAuthorizedNumbers(userId: number, phoneNumbers: string[]): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZED_NUMBER_KEY },
    });
    
    const uniqueNumbers = [...new Set(phoneNumbers)].filter(n => n.trim().length > 0);
    const currentNumbers = existing?.value ? existing.value.split(',').filter(n => n.trim().length > 0) : [];
    const allNumbers = [...new Set([...currentNumbers, ...uniqueNumbers])];
    
    if (existing) {
      existing.value = allNumbers.join(',');
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        userId,
        key: AUTHORIZED_NUMBER_KEY,
        value: allNumbers.join(','),
      });
    }
    
    this.logger.log(`[LOG 2] ${uniqueNumbers.length} números agregados para usuario ${userId}`);
  }

  async getAuthorizedNumbersList(userId: number): Promise<string[]> {
    const config = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZED_NUMBER_KEY },
    });
    if (!config?.value) return [];
    return config.value.split(',').map(n => n.trim()).filter(n => n.length > 0);
  }

  async removeAuthorizedNumberFromList(userId: number, phoneNumber: string): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZED_NUMBER_KEY },
    });
    
    if (existing && existing.value) {
      const numbers = existing.value.split(',').map(n => n.trim()).filter(n => n.length > 0 && n !== phoneNumber);
      if (numbers.length > 0) {
        existing.value = numbers.join(',');
        await this.repo.save(existing);
      } else {
        await this.repo.delete({ userId, key: AUTHORIZED_NUMBER_KEY });
      }
    }
  }

  async isAuthorized(userId: number, phoneNumber: string): Promise<boolean> {
    const mode = await this.getAuthorizationMode(userId);
    
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    
    // mode === 'list': verificar en la lista de números autorizados
    const numbers = await this.getAuthorizedNumbersList(userId);
    return numbers.includes(phoneNumber);
  }

  async getUserIdByPhoneNumber(phoneNumber: string, sessionUserId?: number): Promise<number | null> {
    this.logger.log(`🔍 [AUTH] Verificando número ${phoneNumber} para sesión ${sessionUserId}`);
    
    // Si se proporciona un sessionUserId, verificar según el modo configurado
    if (sessionUserId) {
      const mode = await this.getAuthorizationMode(sessionUserId);
      this.logger.log(`🔍 [AUTH] Modo de autorización: "${mode}" para usuario ${sessionUserId}`);
      
      // Modo 'none': no permitir ningún número
      if (mode === 'none') {
        this.logger.log(`❌ [AUTH] Modo "none" - rechazando número ${phoneNumber}`);
        return null;
      }
      
      // Modo 'all': permitir todos los números
      if (mode === 'all') {
        this.logger.log(`✅ [AUTH] Modo "all" - autorizando número ${phoneNumber}`);
        return sessionUserId;
      }
      
      // Modo 'list': verificar si el número está en la lista
      const numbers = await this.getAuthorizedNumbersList(sessionUserId);
      this.logger.log(`🔍 [AUTH] Lista de números autorizados: [${numbers.join(', ')}]`);
      
      if (numbers.includes(phoneNumber)) {
        this.logger.log(`✅ [AUTH] Número ${phoneNumber} está en la lista - autorizando`);
        return sessionUserId;
      }
      
      this.logger.log(`❌ [AUTH] Número ${phoneNumber} NO está en la lista - rechazando`);
      return null;
    }
    
    // Solo si no hay sessionUserId, buscar en todos los usuarios
    const allConfigs = await this.repo.find({ 
      where: { key: AUTHORIZED_NUMBER_KEY },
    });
    
    for (const config of allConfigs) {
      if (config.value) {
        const numbers = config.value.split(',').map(n => n.trim());
        if (numbers.includes(phoneNumber)) {
          return config.userId;
        }
      }
    }
    
    return null;
  }

  // Reactive Excel Filename
  async getReactiveExcelFilename(userId: number): Promise<string | null> {
    const config = await this.repo.findOne({ 
      where: { userId, key: REACTIVE_EXCEL_FILENAME_KEY },
    });
    return config?.value || null;
  }

  async setReactiveExcelFilename(userId: number, filename: string): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: REACTIVE_EXCEL_FILENAME_KEY },
    });
    
    if (existing) {
      existing.value = filename;
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        userId,
        key: REACTIVE_EXCEL_FILENAME_KEY,
        value: filename,
      });
    }
  }

  async removeReactiveExcelFilename(userId: number): Promise<void> {
    await this.repo.delete({ userId, key: REACTIVE_EXCEL_FILENAME_KEY });
  }

  async isReactiveFilename(userId: number, filename: string): Promise<boolean> {
    const reactiveFilename = await this.getReactiveExcelFilename(userId);
    if (!reactiveFilename) return false;
    
    // Comparar sin extensión y en minúsculas
    const normalizedFilename = filename.toLowerCase().replace(/\.xlsx?$/i, '');
    const normalizedReactive = reactiveFilename.toLowerCase().replace(/\.xlsx?$/i, '');
    
    return normalizedFilename.includes(normalizedReactive) || normalizedReactive.includes(normalizedFilename);
  }
}

