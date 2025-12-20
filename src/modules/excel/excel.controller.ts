import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { ExcelService } from './excel.service';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { RecordEntity } from '../records/record.entity';

interface PaginatedResponse {
  data: RecordEntity[];
  total: number;
  totalPages: number;
  currentPage: number;
}

@Controller('excel')
export class ExcelController {
  constructor(private readonly service: ExcelService) {}

  @Get('metadata')
  async getAllExcelMetadata(): Promise<ExcelMetadataEntity[]> {
    return this.service.getAllExcelMetadata();
  }

  @Get(':excelId/records')
  async getRecordsByExcelId(
    @Param('excelId', ParseIntPipe) excelId: number,
    @Query('page', ParseIntPipe) page: number = 1,
    @Query('limit', ParseIntPipe) limit: number = 20,
  ): Promise<PaginatedResponse> {
    const result = await this.service.getRecordsByExcelId(excelId, page, limit);
    return {
      ...result,
      currentPage: page,
    };
  }
}

