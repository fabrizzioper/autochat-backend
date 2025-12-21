import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExcelMetadataEntity } from './excel-metadata.entity';
import { DynamicRecordEntity } from './dynamic-record.entity';
import { ExcelService } from './excel.service';
import { ExcelController } from './excel.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExcelMetadataEntity, DynamicRecordEntity]),
    forwardRef(() => AuthModule),
  ],
  providers: [ExcelService],
  controllers: [ExcelController],
  exports: [ExcelService],
})
export class ExcelModule {}

