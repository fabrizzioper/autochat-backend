import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigEntity } from './config.entity';

const AUTHORIZED_NUMBER_KEY = 'authorized_number';

@Injectable()
export class ConfigService {
  constructor(
    @InjectRepository(ConfigEntity)
    private readonly repo: Repository<ConfigEntity>,
  ) {}

  async getAuthorizedNumber(): Promise<string | null> {
    const config = await this.repo.findOne({ where: { key: AUTHORIZED_NUMBER_KEY } });
    return config?.value || null;
  }

  async setAuthorizedNumber(phoneNumber: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { key: AUTHORIZED_NUMBER_KEY } });
    
    if (existing) {
      existing.value = phoneNumber;
      await this.repo.save(existing);
    } else {
      await this.repo.save({
        key: AUTHORIZED_NUMBER_KEY,
        value: phoneNumber,
      });
    }
  }

  async removeAuthorizedNumber(): Promise<void> {
    await this.repo.delete({ key: AUTHORIZED_NUMBER_KEY });
  }

  async isAuthorized(phoneNumber: string): Promise<boolean> {
    const authorized = await this.getAuthorizedNumber();
    return authorized === phoneNumber;
  }
}

