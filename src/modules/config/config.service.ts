import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigEntity } from './config.entity';

const AUTHORIZED_NUMBER_KEY = 'authorized_number';
const ALLOW_ALL_NUMBERS_KEY = 'allow_all_numbers';
const REACTIVE_EXCEL_FILENAME_KEY = 'reactive_excel_filename';

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

  async isAllowAllNumbers(userId: number): Promise<boolean> {
    const config = await this.repo.findOne({ 
      where: { userId, key: ALLOW_ALL_NUMBERS_KEY },
    });
    return config?.value === 'true';
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
    
    this.logger.log(`[LOG 2] Permitir todos los números ${allow ? 'activado' : 'desactivado'} para usuario ${userId}`);
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
    // Si está en modo "permitir todos", retornar true
    const allowAll = await this.isAllowAllNumbers(userId);
    if (allowAll) return true;
    
    // Si no, verificar en la lista de números autorizados
    const numbers = await this.getAuthorizedNumbersList(userId);
    return numbers.includes(phoneNumber);
  }

  async getUserIdByPhoneNumber(phoneNumber: string): Promise<number | null> {
    const config = await this.repo.findOne({ 
      where: { key: AUTHORIZED_NUMBER_KEY, value: phoneNumber },
    });
    return config?.userId || null;
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

