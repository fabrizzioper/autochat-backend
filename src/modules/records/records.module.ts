import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecordEntity } from './record.entity';
import { RecordsService } from './records.service';

@Module({
  imports: [TypeOrmModule.forFeature([RecordEntity])],
  providers: [RecordsService],
  exports: [RecordsService],
})
export class RecordsModule {}

