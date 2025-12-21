import { Controller, Get, Delete, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ExcelService } from './excel.service';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserEntity } from '../users/user.entity';

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
  async getAllExcelMetadata(@GetUser() user: UserEntity): Promise<ExcelMetadataEntity[]> {
    return this.service.getAllExcelMetadata(user.id);
  }

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
