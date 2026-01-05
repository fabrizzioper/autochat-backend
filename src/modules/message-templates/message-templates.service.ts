import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageTemplateEntity } from './message-template.entity';

interface CreateTemplateDto {
  excelId: number;
  name: string;
  keywords: string[]; // Múltiples palabras clave
  searchColumns: string[]; // Múltiples columnas de búsqueda
  template: string;
}

interface UpdateTemplateDto {
  name?: string;
  keywords?: string[];
  searchColumns?: string[];
  template?: string;
  isActive?: boolean;
}

@Injectable()
export class MessageTemplatesService {
  constructor(
    @InjectRepository(MessageTemplateEntity)
    private readonly repo: Repository<MessageTemplateEntity>,
  ) {}

  async findAll(userId: number): Promise<MessageTemplateEntity[]> {
    return this.repo.find({
      where: { userId },
      relations: ['excel'],
      order: { createdAt: 'DESC' },
    });
  }

  async findById(userId: number, id: number): Promise<MessageTemplateEntity> {
    const template = await this.repo.findOne({
      where: { id, userId },
      relations: ['excel'],
    });

    if (!template) {
      throw new NotFoundException('Plantilla no encontrada');
    }

    return template;
  }

  async findByKeyword(userId: number, keyword: string): Promise<MessageTemplateEntity | null> {
    // Buscar templates activos que tengan esta keyword en su array de keywords
    const templates = await this.repo.find({
      where: { userId, isActive: true },
      relations: ['excel'],
    });
    
    const normalizedKeyword = keyword.toLowerCase().trim();
    
    // Buscar template que tenga esta keyword en su array
    return templates.find(template => 
      template.keywords && 
      Array.isArray(template.keywords) &&
      template.keywords.some(k => k.toLowerCase().trim() === normalizedKeyword)
    ) || null;
  }

  async create(userId: number, dto: CreateTemplateDto): Promise<MessageTemplateEntity> {
    const template = this.repo.create({
      userId,
      excelId: dto.excelId,
      name: dto.name,
      keywords: dto.keywords.map(k => k.toLowerCase().trim()).filter(k => k),
      searchColumns: dto.searchColumns.filter(c => c),
      template: dto.template,
    });

    return this.repo.save(template);
  }

  async update(userId: number, id: number, dto: UpdateTemplateDto): Promise<MessageTemplateEntity> {
    const template = await this.findById(userId, id);

    if (dto.name !== undefined) template.name = dto.name;
    if (dto.keywords !== undefined) {
      template.keywords = dto.keywords.map(k => k.toLowerCase().trim()).filter(k => k);
    }
    if (dto.searchColumns !== undefined) {
      template.searchColumns = dto.searchColumns.filter(c => c);
    }
    if (dto.template !== undefined) template.template = dto.template;
    if (dto.isActive !== undefined) template.isActive = dto.isActive;

    return this.repo.save(template);
  }

  async delete(userId: number, id: number): Promise<void> {
    const template = await this.findById(userId, id);
    await this.repo.remove(template);
  }

  // Procesar una plantilla reemplazando los placeholders con datos reales
  processTemplate(template: string, rowData: Record<string, unknown>): string {
    let result = template;
    
    // Reemplazar todos los {{campo}} con los valores del rowData
    const placeholderRegex = /\{\{([^}]+)\}\}/g;
    
    result = result.replace(placeholderRegex, (match, fieldName) => {
      const value = rowData[fieldName.trim()];
      if (value === null || value === undefined) return '-';
      if (typeof value === 'number') {
        return value.toLocaleString('es-PE');
      }
      return String(value);
    });

    return result;
  }
}

