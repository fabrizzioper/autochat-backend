import { Controller, Get, Delete, Post, Param, Query, Body, Req, ParseIntPipe, UseGuards, UseInterceptors, UploadedFile, BadRequestException, SetMetadata } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExcelService } from './excel.service';
import { ExcelMetadataEntity } from './excel-metadata.entity';
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
    @Req() req: any,
    @UploadedFile() file: { originalname: string; buffer: Buffer },
  ): Promise<{ success: boolean; message: string; recordsCount?: number; excelId?: number }> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo');
    }

    const allowedExtensions = ['.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      throw new BadRequestException('El archivo debe ser un Excel (.xlsx o .xls)');
    }

    const authHeader = req.headers.authorization;
    const jwtToken = authHeader?.replace('Bearer ', '') || '';

    const tempPath = path.join(process.cwd(), 'temp', `${Date.now()}-${file.originalname}`);
    
    try {
      await fs.mkdir(path.join(process.cwd(), 'temp'), { recursive: true });
      await fs.writeFile(tempPath, file.buffer);

      const result = await this.service.processExcelFile(
        tempPath,
        file.originalname,
        user.email || 'Usuario',
        user.id,
        jwtToken,
      );

      await fs.unlink(tempPath);

      if (!result.success) {
        throw new BadRequestException(result.message);
      }

      return {
        success: true,
        message: result.message,
        recordsCount: result.recordsCount,
        excelId: result.excelId,
      };
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignorar
      }
      throw error;
    }
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
      message: 'Excel eliminado correctamente',
    };
  }
}
