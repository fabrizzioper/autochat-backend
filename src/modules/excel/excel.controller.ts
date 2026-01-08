import { Controller, Get, Delete, Post, Put, Param, Query, Body, Req, ParseIntPipe, UseGuards, UseInterceptors, UploadedFile, BadRequestException, SetMetadata } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExcelService } from './excel.service';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { ExcelFormatEntity } from './excel-format.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';
import * as path from 'path';
import * as fs from 'fs/promises';

interface PaginatedResponse {
  data: DynamicRecordEntity[];
  total: number;
  totalPages: number;
  currentPage: number;
}

@Controller('excel')
@UseGuards(JwtAuthGuard)
export class ExcelController {
  constructor(private readonly service: ExcelService) {}

  // ==========================================
  // RUTAS ESTÁTICAS PRIMERO (orden importante)
  // ==========================================

  @Get('metadata')
  async getAllExcelMetadata(@GetUser() user: UserEntity): Promise<ExcelMetadataEntity[]> {
    // Limpiar automáticamente excels vacíos (subidas incompletas)
    await this.service.cleanupEmptyExcels(user.id);
    return this.service.getAllExcelMetadata(user.id);
  }

  @Get('active-process')
  async getActiveProcess(
    @GetUser() user: UserEntity,
  ): Promise<{ hasActiveProcess: boolean; excelId?: number; filename?: string; progress?: number; total?: number; processed?: number; status?: string; message?: string }> {
    return this.service.getActiveProcess(user.id);
  }

  @Get('progress/:excelId')
  async getProgress(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<{ progress: number; total: number; processed: number; status: string }> {
    const excel = await this.service.getExcelById(user.id, excelId);
    return this.service.getProcessingProgress(excelId, user.id, excel?.filename);
  }

  @Post('notify-progress')
  @SetMetadata('isPublic', true)
  async notifyProgress(
    @Body() body: { excelId: number; userId: number; progress: number; total: number; processed: number; status: string; filename?: string; message?: string },
  ): Promise<{ success: boolean }> {
    console.log(`📡 [notify-progress] Excel ${body.excelId} - ${body.status} - ${body.progress?.toFixed(1)}% - ${body.message || ''}`);
    
    // Si Go terminó de insertar, crear índices REALES para las columnas seleccionadas
    if (body.status === 'completed') {
      // Notificar que está indexando
      this.service.notifyProgressViaWebSocket(
        body.userId,
        body.excelId,
        98,
        body.total,
        body.processed,
        'indexing',
        body.filename,
        '🔧 Creando índices para búsqueda rápida...',
      );
      
      // Crear índices reales en PostgreSQL
      await this.service.createRealIndexesForExcel(body.excelId, body.userId);
      
      // Notificar completado con índices (WebSocket al frontend)
      this.service.notifyProgressViaWebSocket(
        body.userId,
        body.excelId,
        100,
        body.total,
        body.processed,
        'completed',
        body.filename,
        `✅ Completado: ${body.total?.toLocaleString()} registros con índices optimizados`,
      );

      // Notificar por WhatsApp al remitente
      await this.service.notifyExcelCompletedViaWhatsApp(body.excelId, body.userId, body.total);
    } else {
      this.service.notifyProgressViaWebSocket(
        body.userId,
        body.excelId,
        body.progress,
        body.total,
        body.processed,
        body.status,
        body.filename,
        body.message,
      );
    }
    return { success: true };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: 200 * 1024 * 1024, // 200MB
    },
  }))
  async uploadExcel(
    @GetUser() user: UserEntity,
    @UploadedFile() file: { originalname: string; buffer: Buffer },
  ): Promise<{ success: boolean; message: string; excelId?: number; headers?: string[]; totalRows?: number; autoProcessing?: boolean; hasFormat?: boolean }> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    const allowedExtensions = ['.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      throw new BadRequestException('El archivo debe ser un Excel (.xlsx o .xls)');
    }

    // Guardar archivo temporalmente
    const tempPath = path.join(process.cwd(), 'temp', `${Date.now()}-${user.id}-${file.originalname}`);
    
    try {
      await fs.mkdir(path.join(process.cwd(), 'temp'), { recursive: true });
      await fs.writeFile(tempPath, file.buffer);

      // NUEVO FLUJO: Solo leer cabeceras, esperar selección
      const result = await this.service.uploadAndReadHeaders(
        tempPath,
        file.originalname,
        user.email || 'Usuario',
        user.id,
      );

      if (!result.success) {
        // Limpiar archivo temporal
        try { await fs.unlink(tempPath); } catch {}
        throw new BadRequestException(result.message);
      }

      // NO eliminamos tempPath aquí - lo necesitamos para continuar después
      return {
        success: true,
        message: result.message,
        excelId: result.excelId,
        headers: result.headers,
        totalRows: result.totalRows,
        autoProcessing: result.autoProcessing, // true si hay formato guardado
        hasFormat: result.hasFormat,
      };
    } catch (error: any) {
      try { await fs.unlink(tempPath); } catch {}
      throw error;
    }
  }

  // NUEVO: Continuar procesamiento después de seleccionar cabeceras
  @Post(':excelId/continue-processing')
  async continueProcessing(
    @GetUser() user: UserEntity,
    @Req() req: any,
    @Param('excelId', ParseIntPipe) excelId: number,
    @Body('selectedHeaders') selectedHeaders: string[],
    @Body('saveFormat') saveFormat?: boolean,
    @Body('formatName') formatName?: string,
  ): Promise<{ success: boolean; message: string; formatId?: number }> {
    if (!selectedHeaders || selectedHeaders.length === 0) {
      throw new BadRequestException('Debes seleccionar al menos una cabecera');
    }

    const authHeader = req.headers.authorization;
    const jwtToken = authHeader?.replace('Bearer ', '') || '';

    return this.service.continueProcessingWithHeaders(
      excelId, 
      user.id, 
      selectedHeaders, 
      jwtToken,
      saveFormat || false,
      formatName,
    );
  }

  // NUEVO: Cancelar upload pendiente
  @Delete(':excelId/cancel-pending')
  async cancelPending(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<{ success: boolean; message: string }> {
    return this.service.cancelPendingUpload(excelId, user.id);
  }

  // Obtener cabeceras indexadas (las que se seleccionaron al subir)
  @Get(':excelId/indexed-headers')
  async getIndexedHeaders(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<{ id: number; headerName: string; indexedAt: string }[]> {
    return this.service.getIndexedHeaders(excelId, user.id);
  }

  // ==========================================
  // RUTAS DINÁMICAS AL FINAL (:excelId)
  // ==========================================

  @Get(':excelId')
  async getExcelById(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<ExcelMetadataEntity | null> {
    return this.service.getExcelById(user.id, excelId);
  }

  @Get(':excelId/records')
  async getRecordsByExcelId(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
    @Query('page', ParseIntPipe) page: number = 1,
    @Query('limit', ParseIntPipe) limit: number = 20,
  ): Promise<PaginatedResponse> {
    const result = await this.service.getDynamicRecordsByExcelId(user.id, excelId, page, limit);
    return {
      ...result,
      currentPage: page,
    };
  }

  @Delete(':excelId')
  async deleteExcel(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<{ success: boolean; message: string }> {
    await this.service.deleteExcel(user.id, excelId);
    return {
      success: true,
      message: 'Excel y formato eliminados correctamente',
    };
  }

  // ============================================================================
  // GESTIÓN DE FORMATOS DE EXCEL
  // ============================================================================

  /**
   * Obtener todos los formatos guardados del usuario
   */
  @Get('formats/all')
  async getAllFormats(
    @GetUser() user: UserEntity,
  ): Promise<ExcelFormatEntity[]> {
    return this.service.getAllFormats(user.id);
  }

  /**
   * Obtener un formato por ID
   */
  @Get('formats/:formatId')
  async getFormatById(
    @GetUser() user: UserEntity,
    @Param('formatId', ParseIntPipe) formatId: number,
  ): Promise<ExcelFormatEntity | null> {
    return this.service.getFormatById(user.id, formatId);
  }

  /**
   * Eliminar un formato
   */
  @Delete('formats/:formatId')
  async deleteFormat(
    @GetUser() user: UserEntity,
    @Param('formatId', ParseIntPipe) formatId: number,
  ): Promise<{ success: boolean; message: string }> {
    return this.service.deleteFormat(user.id, formatId);
  }

  /**
   * Verificar si existe un formato para un archivo
   */
  @Get('formats/check/:filename')
  async checkFormat(
    @GetUser() user: UserEntity,
    @Param('filename') filename: string,
  ): Promise<{ hasFormat: boolean; format?: ExcelFormatEntity }> {
    const format = await this.service.findFormatForFile(user.id, filename);
    return {
      hasFormat: !!format,
      format: format || undefined,
    };
  }
}
