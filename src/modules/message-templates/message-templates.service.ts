import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageTemplateEntity } from './message-template.entity';
import { ExcelFormatEntity } from '../excel/excel-format.entity';

interface CreateTemplateDto {
  excelId?: number;
  formatId?: number; // Nuevo: asociar a formato en lugar de Excel
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
  formatId?: number; // Nuevo: migrar a formato
}

@Injectable()
export class MessageTemplatesService {
  private readonly logger = new Logger(MessageTemplatesService.name);

  constructor(
    @InjectRepository(MessageTemplateEntity)
    private readonly repo: Repository<MessageTemplateEntity>,
    @InjectRepository(ExcelFormatEntity)
    private readonly formatRepo: Repository<ExcelFormatEntity>,
  ) {}

  /**
   * Normaliza texto: quita tildes/acentos, convierte a minúsculas
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''); // Quita diacríticos (tildes, etc.)
  }

  async findAll(userId: number): Promise<MessageTemplateEntity[]> {
    return this.repo.find({
      where: { userId },
      relations: ['excel', 'format'],
      order: { createdAt: 'DESC' },
    });
  }

  async findById(userId: number, id: number): Promise<MessageTemplateEntity> {
    const template = await this.repo.findOne({
      where: { id, userId },
      relations: ['excel', 'format'],
    });

    if (!template) {
      throw new NotFoundException('Plantilla no encontrada');
    }

    return template;
  }

  /**
   * Buscar templates por keyword para un Excel o formato específico
   */
  async findByKeyword(userId: number, keyword: string, excelId?: number): Promise<MessageTemplateEntity | null> {
    // Buscar templates activos que tengan esta keyword en su array de keywords
    const templates = await this.repo.find({
      where: { userId, isActive: true },
      relations: ['excel', 'format'],
    });
    
    // Normalizar keyword (quita tildes y convierte a minúsculas)
    const normalizedKeyword = this.normalizeText(keyword);
    
    // Buscar template que tenga esta keyword en su array (comparación normalizada)
    // Y que esté asociado al Excel actual (directamente o a través de un formato)
    return templates.find(template => {
      // Verificar que el keyword coincida
      const keywordMatch = template.keywords && 
        Array.isArray(template.keywords) &&
        template.keywords.some(k => this.normalizeText(k) === normalizedKeyword);
      
      if (!keywordMatch) return false;
      
      // Si se proporciona excelId, verificar que el template esté asociado
      if (excelId) {
        // Asociado directamente al Excel
        if (template.excelId === excelId) return true;
        // Asociado a un formato que tiene este Excel como actual
        if (template.format && template.format.currentExcelId === excelId) return true;
        return false;
      }
      
      return true;
    }) || null;
  }

  /**
   * Buscar templates asociados a un formato
   */
  async findByFormatId(userId: number, formatId: number): Promise<MessageTemplateEntity[]> {
    return this.repo.find({
      where: { userId, formatId, isActive: true },
      relations: ['format'],
      order: { createdAt: 'DESC' },
    });
  }

  async create(userId: number, dto: CreateTemplateDto): Promise<MessageTemplateEntity> {
    let formatId = dto.formatId || null;
    
    // Si solo se proporciona excelId, buscar el formato asociado
    if (!formatId && dto.excelId) {
      const format = await this.formatRepo.findOne({
        where: { userId, currentExcelId: dto.excelId },
      });
      if (format) {
        formatId = format.id;
        this.logger.log(`📝 Formato encontrado para Excel ${dto.excelId}: ${format.name} (id=${format.id})`);
      }
    }
    
    const template = this.repo.create({
      userId,
      excelId: dto.excelId || null,
      formatId,
      name: dto.name,
      keywords: dto.keywords.map(k => k.toLowerCase().trim()).filter(k => k),
      searchColumns: dto.searchColumns.filter(c => c),
      template: dto.template,
    });

    this.logger.log(`📝 Creando template: ${dto.name} (excelId=${dto.excelId}, formatId=${formatId})`);

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
    if (dto.formatId !== undefined) {
      template.formatId = dto.formatId;
      // Si se asocia a un formato, desasociar del Excel específico
      if (dto.formatId) {
        template.excelId = null;
        this.logger.log(`📝 Template ${id} migrado a formato ${dto.formatId}`);
      }
    }

    return this.repo.save(template);
  }

  /**
   * Migrar templates de un Excel a un formato
   * Útil cuando se guarda un formato por primera vez
   */
  async migrateTemplatesToFormat(userId: number, excelId: number, formatId: number): Promise<number> {
    const templates = await this.repo.find({
      where: { userId, excelId },
    });

    if (templates.length === 0) return 0;

    for (const template of templates) {
      template.formatId = formatId;
      template.excelId = null; // Desasociar del Excel específico
      await this.repo.save(template);
    }

    this.logger.log(`📋 ${templates.length} templates migrados de Excel ${excelId} a formato ${formatId}`);
    return templates.length;
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

