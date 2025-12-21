import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigEntity } from './config.entity';

const AUTHORIZED_NUMBER_KEY = 'authorized_number';
const REACTIVE_EXCEL_FILENAME_KEY = 'reactive_excel_filename';

@Injectable()
export class ConfigService {
  constructor(
    @InjectRepository(ConfigEntity)
    private readonly repo: Repository<ConfigEntity>,
  ) {}

  async getAuthorizedNumber(userId: number): Promise<string | null> {
    const config = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZED_NUMBER_KEY },
    });
    return config?.value || null;
  }

  async setAuthorizedNumber(userId: number, phoneNumber: string): Promise<void> {
    const existing = await this.repo.findOne({ 
      where: { userId, key: AUTHORIZED_NUMBER_KEY },
    });
    
    if (existing) {
      existing.value = phoneNumber;
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        userId,
        key: AUTHORIZED_NUMBER_KEY,
        value: phoneNumber,
      });
    }
  }

  async removeAuthorizedNumber(userId: number): Promise<void> {
    await this.repo.delete({ userId, key: AUTHORIZED_NUMBER_KEY });
  }

  async isAuthorized(userId: number, phoneNumber: string): Promise<boolean> {
    const authorized = await this.getAuthorizedNumber(userId);
    return authorized === phoneNumber;
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

