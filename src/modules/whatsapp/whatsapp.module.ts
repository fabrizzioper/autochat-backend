import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppGateway } from './whatsapp.gateway';
import { ConfigModule } from '../config/config.module';
import { ExcelModule } from '../excel/excel.module';
import { RecordsModule } from '../records/records.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    forwardRef(() => ConfigModule),
    forwardRef(() => ExcelModule),
    forwardRef(() => RecordsModule),
    forwardRef(() => AuthModule),
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppGateway],
  exports: [WhatsAppService, WhatsAppGateway],
})
export class WhatsAppModule {}

