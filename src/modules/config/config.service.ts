import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigEntity } from './config.entity';
import { AuthorizedNumberEntity } from './authorized-number.entity';
import { CreateAuthorizedNumberDto, UpdateAuthorizedNumberDto } from './dto/authorized-number.dto';

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
    @InjectRepository(AuthorizedNumberEntity)
    private readonly authorizedNumberRepo: Repository<AuthorizedNumberEntity>,
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
      
      // Modo 'list': verificar en la NUEVA tabla de números autorizados
      const authorizedNumber = await this.getAuthorizedNumberByPhone(sessionUserId, phoneNumber);
      
      if (authorizedNumber) {
        this.logger.log(`✅ [AUTH] Número ${phoneNumber} encontrado en tabla V2 - autorizando`);
        return sessionUserId;
      }
      
      // Fallback: También verificar en la lista vieja (para compatibilidad)
      const numbers = await this.getAuthorizedNumbersList(sessionUserId);
      if (numbers.includes(phoneNumber)) {
        this.logger.log(`✅ [AUTH] Número ${phoneNumber} está en la lista legacy - autorizando`);
        return sessionUserId;
      }
      
      this.logger.log(`❌ [AUTH] Número ${phoneNumber} NO está autorizado - rechazando`);
      return null;
    }
    
    // Solo si no hay sessionUserId, buscar en todos los usuarios (ambas tablas)
    // Primero buscar en la nueva tabla
    const allAuthorizedNumbers = await this.authorizedNumberRepo.find({
      where: { phoneNumber },
    });
    
    if (allAuthorizedNumbers.length > 0) {
      return allAuthorizedNumbers[0].userId;
    }
    
    // Fallback: buscar en la tabla vieja
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

  // ==================== CRUD NÚMEROS AUTORIZADOS (Nueva tabla) ====================

  async createAuthorizedNumber(userId: number, dto: CreateAuthorizedNumberDto): Promise<AuthorizedNumberEntity> {
    // Verificar si ya existe el número para este usuario
    const existing = await this.authorizedNumberRepo.findOne({
      where: { userId, phoneNumber: dto.phoneNumber },
    });
    
    if (existing) {
      throw new Error('Este número ya está registrado');
    }

    const newNumber = new AuthorizedNumberEntity();
    newNumber.userId = userId;
    newNumber.phoneNumber = dto.phoneNumber;
    newNumber.dni = dto.dni || '';
    newNumber.firstName = dto.firstName || '';
    newNumber.lastName = dto.lastName || '';
    newNumber.entityName = dto.entityName || '';
    newNumber.position = dto.position || '';
    newNumber.canSendExcel = dto.canSendExcel ?? true;
    newNumber.canRequestInfo = dto.canRequestInfo ?? true;

    const saved = await this.authorizedNumberRepo.save(newNumber);
    this.logger.log(`✅ Número autorizado creado: ${dto.phoneNumber} para usuario ${userId}`);
    return saved;
  }

  async getAllAuthorizedNumbers(userId: number): Promise<AuthorizedNumberEntity[]> {
    return this.authorizedNumberRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async getAuthorizedNumbersPaginated(
    userId: number,
    page: number = 1,
    limit: number = 10,
    search?: string,
  ): Promise<{ data: AuthorizedNumberEntity[]; total: number; page: number; limit: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    
    const queryBuilder = this.authorizedNumberRepo
      .createQueryBuilder('an')
      .where('an.userId = :userId', { userId });

    // Búsqueda por teléfono, nombre, apellido o DNI
    if (search && search.trim()) {
      const searchTerm = `%${search.trim().toLowerCase()}%`;
      queryBuilder.andWhere(
        '(LOWER(an.phoneNumber) LIKE :search OR LOWER(an.firstName) LIKE :search OR LOWER(an.lastName) LIKE :search OR LOWER(an.dni) LIKE :search)',
        { search: searchTerm }
      );
    }

    const [data, total] = await queryBuilder
      .orderBy('an.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getAuthorizedNumberById(userId: number, id: number): Promise<AuthorizedNumberEntity> {
    const entity = await this.authorizedNumberRepo.findOne({
      where: { id, userId },
    });
    
    if (!entity) {
      throw new NotFoundException('Número autorizado no encontrado');
    }
    
    return entity;
  }

  async updateAuthorizedNumber(userId: number, id: number, dto: UpdateAuthorizedNumberDto): Promise<AuthorizedNumberEntity> {
    const entity = await this.getAuthorizedNumberById(userId, id);
    
    // Si se cambia el número, verificar que no exista ya
    if (dto.phoneNumber && dto.phoneNumber !== entity.phoneNumber) {
      const existing = await this.authorizedNumberRepo.findOne({
        where: { userId, phoneNumber: dto.phoneNumber },
      });
      if (existing) {
        throw new Error('Este número ya está registrado');
      }
    }

    Object.assign(entity, dto);
    const updated = await this.authorizedNumberRepo.save(entity);
    this.logger.log(`✏️ Número autorizado actualizado: ${entity.phoneNumber} para usuario ${userId}`);
    return updated;
  }

  async deleteAuthorizedNumber(userId: number, id: number): Promise<void> {
    const entity = await this.getAuthorizedNumberById(userId, id);
    await this.authorizedNumberRepo.remove(entity);
    this.logger.log(`🗑️ Número autorizado eliminado: ${entity.phoneNumber} para usuario ${userId}`);
  }

  // Verificación de permisos específicos
  async getAuthorizedNumberByPhone(userId: number, phoneNumber: string): Promise<AuthorizedNumberEntity | null> {
    return this.authorizedNumberRepo.findOne({
      where: { userId, phoneNumber },
    });
  }

  async canPhoneNumberSendExcel(userId: number, phoneNumber: string): Promise<boolean> {
    const mode = await this.getAuthorizationMode(userId);
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    
    const entity = await this.getAuthorizedNumberByPhone(userId, phoneNumber);
    return entity?.canSendExcel ?? false;
  }

  async canPhoneNumberRequestInfo(userId: number, phoneNumber: string): Promise<boolean> {
    const mode = await this.getAuthorizationMode(userId);
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    
    const entity = await this.getAuthorizedNumberByPhone(userId, phoneNumber);
    return entity?.canRequestInfo ?? false;
  }

  // Actualizar isAuthorized para usar la nueva tabla
  async isAuthorizedV2(userId: number, phoneNumber: string): Promise<boolean> {
    const mode = await this.getAuthorizationMode(userId);
    
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    
    // mode === 'list': verificar en la nueva tabla de números autorizados
    const entity = await this.getAuthorizedNumberByPhone(userId, phoneNumber);
    return entity !== null;
  }
}

