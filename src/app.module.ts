import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { ConfigModule } from './modules/config/config.module';
import { ExcelModule } from './modules/excel/excel.module';
import { RecordsModule } from './modules/records/records.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    DatabaseModule,
    WhatsAppModule,
    ConfigModule,
    ExcelModule,
    RecordsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
