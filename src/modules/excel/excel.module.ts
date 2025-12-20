import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { RecordEntity } from '../records/record.entity';
import { ExcelService } from './excel.service';
import { ExcelController } from './excel.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExcelMetadataEntity, RecordEntity])],
  providers: [ExcelService],
  controllers: [ExcelController],
  exports: [ExcelService],
})
export class ExcelModule {}

