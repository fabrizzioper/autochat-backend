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

  @Get('metadata')
  @UseGuards(JwtAuthGuard)
  async getAllExcelMetadata(@GetUser() user: UserEntity): Promise<ExcelMetadataEntity[]> {
    return this.service.getAllExcelMetadata(user.id);
  }

  @Get(':excelId')
  @UseGuards(JwtAuthGuard)
  async getExcelById(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<ExcelMetadataEntity | null> {
    return this.service.getExcelById(user.id, excelId);
  }

  @Get(':excelId/records')
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
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

  @Get('progress/:excelId')
  @UseGuards(JwtAuthGuard)
  async getProgress(
    @GetUser() user: UserEntity,
    @Param('excelId', ParseIntPipe) excelId: number,
  ): Promise<{ progress: number; total: number; processed: number; status: string }> {
    // Obtener filename del Excel para incluirlo en la notificación
    const excel = await this.service.getExcelById(user.id, excelId);
    return this.service.getProcessingProgress(excelId, user.id, excel?.filename);
  }

  @Post('notify-progress')
  @UseGuards(JwtAuthGuard)
  async notifyProgress(
    @Req() req: any,
    @Body() body: { excelId: number; progress: number; total: number; processed: number; status: string; filename?: string },
  ): Promise<{ success: boolean }> {
    // req.user es UserEntity, tiene 'id' no 'userId'
    const userId = req.user.id;
    this.service.notifyProgressViaWebSocket(
      userId,
      body.excelId,
      body.progress,
      body.total,
      body.processed,
      body.status,
      body.filename,
    );
    return { success: true };
  }

  @Post('upload')
  @UseGuards(JwtAuthGuard)
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

    // Validar que sea un archivo Excel
    const allowedExtensions = ['.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
      throw new BadRequestException('El archivo debe ser un Excel (.xlsx o .xls)');
    }

    // Obtener token JWT del header
    const authHeader = req.headers.authorization;
    const jwtToken = authHeader?.replace('Bearer ', '') || '';

    // Guardar archivo temporalmente
    const tempPath = path.join(process.cwd(), 'temp', `${Date.now()}-${file.originalname}`);
    
    try {
      // Crear directorio temp si no existe
      await fs.mkdir(path.join(process.cwd(), 'temp'), { recursive: true });
      await fs.writeFile(tempPath, file.buffer);

      // Procesar Excel - usar el email del usuario como "uploadedBy"
      const result = await this.service.processExcelFile(
        tempPath,
        file.originalname,
        user.email || 'Usuario',
        user.id,
        jwtToken,
      );

      // Eliminar archivo temporal
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
      // Asegurarse de eliminar el archivo temporal en caso de error
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignorar error si el archivo ya no existe
      }
      throw error;
    }
  }
}
